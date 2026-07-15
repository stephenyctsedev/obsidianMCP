// vault.js — all filesystem logic for the Obsidian vault.
// Every path argument is validated to stay inside VAULT_ROOT and to avoid
// dot-prefixed segments (so `.obsidian`, `.trash`, `.git`, etc. are never
// listed, read, written, or searched).

import { promises as fs } from "node:fs";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

// VAULT_PATH is the mounted directory (which may hold several Obsidian vaults);
// VAULT_NAME optionally selects one vault subfolder inside it (e.g. "Memory").
// Leave VAULT_NAME empty to treat the mount itself as the vault root.
const VAULT_ROOT = path.resolve(
  process.env.VAULT_PATH || "/vault",
  process.env.VAULT_NAME || ""
);

// Directories/files whose name begins with "." are hidden vault internals.
function hasHiddenSegment(relPath) {
  return relPath
    .split(/[\\/]+/)
    .some((seg) => seg.length > 0 && seg.startsWith("."));
}

// Resolve a caller-supplied relative path to an absolute path inside the vault.
// Throws on traversal escapes, dot-segments, or (when requireMd) non-.md files.
function resolveInVault(relPath, { requireMd = true } = {}) {
  if (typeof relPath !== "string" || relPath.trim() === "") {
    throw new Error("path must be a non-empty string");
  }
  const normalized = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (hasHiddenSegment(normalized)) {
    throw new Error("access to dot-prefixed (hidden) paths is not allowed");
  }
  const abs = path.resolve(VAULT_ROOT, normalized);
  const rel = path.relative(VAULT_ROOT, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("path escapes the vault root");
  }
  if (requireMd && !abs.toLowerCase().endsWith(".md")) {
    throw new Error("path must point to a .md file");
  }
  return abs;
}

// Recursively collect .md files under `dir`, skipping dot-directories.
async function walkMarkdown(dir) {
  const out = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return out;
    throw err;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue; // skip hidden
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walkMarkdown(full)));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      out.push(full);
    }
  }
  return out;
}

function toVaultRelative(abs) {
  return path.relative(VAULT_ROOT, abs).split(path.sep).join("/");
}

// list_notes(folder?) — return relative paths of every .md file, optionally
// restricted to a subfolder.
export async function listNotes(folder) {
  let base = VAULT_ROOT;
  if (folder && folder.trim() !== "") {
    base = resolveInVault(folder, { requireMd: false });
  }
  const files = await walkMarkdown(base);
  return files.map(toVaultRelative).sort();
}

// read_note(path) — full content of a note.
export async function readNote(relPath) {
  const abs = resolveInVault(relPath);
  return await fs.readFile(abs, "utf8");
}

// write_note(path, content) — create or overwrite, making parent folders.
export async function writeNote(relPath, content) {
  const abs = resolveInVault(relPath);
  if (typeof content !== "string") throw new Error("content must be a string");
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
  return toVaultRelative(abs);
}

// append_note(path, content) — append to an EXISTING note. Errors if missing.
export async function appendNote(relPath, content) {
  const abs = resolveInVault(relPath);
  if (typeof content !== "string") throw new Error("content must be a string");
  try {
    await fs.access(abs);
  } catch {
    throw new Error(`note does not exist: ${toVaultRelative(abs)} (use write_note to create it)`);
  }
  await fs.appendFile(abs, content, "utf8");
  return toVaultRelative(abs);
}

// delete_note(path) — move an existing note to .trash/ (recoverable), never a
// hard delete. Preserves the note's subfolder under .trash and appends an
// epoch-ms suffix so repeated deletes of the same name never collide.
export async function deleteNote(relPath) {
  const abs = resolveInVault(relPath); // validates: in-vault, non-dot, .md
  try {
    await fs.access(abs);
  } catch {
    throw new Error(`note does not exist: ${toVaultRelative(abs)}`);
  }
  const rel = toVaultRelative(abs); // e.g. inbox/note.md
  const dir = path.posix.dirname(rel); // inbox  (or ".")
  const base = path.posix.basename(rel, ".md"); // note
  const stampedName = `${base}.${Date.now()}.md`; // note.1720449600000.md
  const trashRelDir = dir === "." ? ".trash" : path.posix.join(".trash", dir);
  const trashAbs = path.resolve(VAULT_ROOT, trashRelDir, stampedName);
  await fs.mkdir(path.dirname(trashAbs), { recursive: true });
  await fs.rename(abs, trashAbs);
  return path.relative(VAULT_ROOT, trashAbs).split(path.sep).join("/");
}

// move_note(fromRel, toRel) — rename/move an existing note within the vault.
// Validates BOTH paths, errors if source missing or destination exists, creates
// parent folders, then renames. Returns { from, to } as vault-relative paths.
export async function moveNote(fromRel, toRel) {
  const fromAbs = resolveInVault(fromRel); // validates: in-vault, non-dot, .md
  const toAbs = resolveInVault(toRel); // validates: in-vault, non-dot, .md

  // Check if source exists.
  try {
    await fs.access(fromAbs);
  } catch {
    throw new Error(`note does not exist: ${toVaultRelative(fromAbs)}`);
  }

  // Check if source and destination resolve to the same path.
  if (fromAbs === toAbs) {
    throw new Error("source and destination are the same");
  }

  // Check if destination already exists.
  try {
    await fs.access(toAbs);
    throw new Error(`destination already exists: ${toVaultRelative(toAbs)}`);
  } catch (err) {
    if (err.message.startsWith("destination already exists:")) {
      throw err;
    }
    // ENOENT is expected — destination should not exist
  }

  // Create destination's parent folders.
  await fs.mkdir(path.dirname(toAbs), { recursive: true });

  // Rename the file.
  await fs.rename(fromAbs, toAbs);

  return { from: toVaultRelative(fromAbs), to: toVaultRelative(toAbs) };
}

// replace_text(path, oldText, newText, replaceAll?) — targeted find-and-replace
// within an EXISTING note. By default oldText must occur EXACTLY once (a 0-match
// or an ambiguous multi-match errors out so the caller can supply more context);
// set replaceAll to swap every occurrence. Matching is literal (not regex).
// Returns { relPath, count } where count is the number of replacements made.
export async function replaceText(relPath, oldText, newText, replaceAll = false) {
  const abs = resolveInVault(relPath);
  if (typeof oldText !== "string" || oldText === "") {
    throw new Error("old_text must be a non-empty string");
  }
  if (typeof newText !== "string") {
    throw new Error("new_text must be a string");
  }
  let text;
  try {
    text = await fs.readFile(abs, "utf8");
  } catch {
    throw new Error(`note does not exist: ${toVaultRelative(abs)} (use write_note to create it)`);
  }

  // Count occurrences without regex (oldText is literal, may contain metachars).
  let count = 0;
  for (let i = text.indexOf(oldText); i !== -1; i = text.indexOf(oldText, i + oldText.length)) {
    count++;
  }

  if (count === 0) {
    throw new Error(`old_text not found in ${toVaultRelative(abs)}`);
  }
  if (count > 1 && !replaceAll) {
    throw new Error(
      `old_text occurs ${count} times in ${toVaultRelative(abs)}; ` +
        `supply more surrounding context to match a single spot, or set replace_all=true`
    );
  }

  const updated = replaceAll
    ? text.split(oldText).join(newText)
    : text.replace(oldText, newText); // safe: literal string replaces first only
  await fs.writeFile(abs, updated, "utf8");
  return { relPath: toVaultRelative(abs), count: replaceAll ? count : 1 };
}

// search_notes(query) — case-insensitive substring search across all .md files.
// Returns [{ path, snippet }] with ~120 chars of context around the first hit.
export async function searchNotes(query) {
  if (typeof query !== "string" || query.trim() === "") {
    throw new Error("query must be a non-empty string");
  }
  const needle = query.toLowerCase();
  const files = await walkMarkdown(VAULT_ROOT);
  const results = [];
  for (const file of files) {
    let text;
    try {
      text = await fs.readFile(file, "utf8");
    } catch {
      continue;
    }
    const idx = text.toLowerCase().indexOf(needle);
    if (idx === -1) continue;
    const start = Math.max(0, idx - 40);
    const end = Math.min(text.length, idx + query.length + 80);
    let snippet = text.slice(start, end).replace(/\s+/g, " ").trim();
    if (start > 0) snippet = "…" + snippet;
    if (end < text.length) snippet = snippet + "…";
    results.push({ path: toVaultRelative(file), snippet });
  }
  return results;
}

// recent_changes(folder?, limit?) — notes sorted by modification time, newest
// first. Uses filesystem mtime, so it also reflects edits synced in from
// devices, and works whether or not git versioning is enabled.
export async function recentChanges(folder, limit = 20) {
  // Clamp limit the same way noteHistory does
  const clampedLimit = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 100) : 20;

  let base = VAULT_ROOT;
  if (folder && folder.trim() !== "") {
    base = resolveInVault(folder, { requireMd: false });
  }

  const files = await walkMarkdown(base);

  // fs.stat each file for mtime; skip on failure
  const statsPromises = files.map(async (file) => {
    try {
      const stat = await fs.stat(file);
      return { path: file, mtime: stat.mtime };
    } catch {
      return null;
    }
  });

  const stats = await Promise.all(statsPromises);
  const validStats = stats.filter((s) => s !== null);

  // Sort by mtime descending (newest first), take top `clampedLimit`
  validStats.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  const results = validStats.slice(0, clampedLimit);

  return results.map((s) => ({
    path: toVaultRelative(s.path),
    mtime: s.mtime.toISOString(),
  }));
}

// Split a note into { frontmatter: string|null, body: string }. A frontmatter
// block is a leading "---\n...\n---\n" fence at the very start of the file.
// Rules: the file must START with `---` on its own first line (allow `---\r\n` too);
// the closing fence is the next line that is exactly `---` (or `---\r`). If there is
// no valid opening+closing fence, return { frontmatter: null, body: text }. `frontmatter`
// is the raw YAML text between the fences (no fences included); `body` is everything
// after the closing fence line (including any leading newline handling).
function splitFrontmatter(text) {
  // Check if file starts with ---
  if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) {
    return { frontmatter: null, body: text };
  }

  // Determine the opening fence line ending (either \r\n or \n)
  const hasOpeningCRLF = text.startsWith("---\r\n");
  const openingLineEnd = hasOpeningCRLF ? 5 : 4; // position after "---\n" or "---\r\n"

  // Search for closing fence: a line that is exactly "---" (possibly with \r)
  let closingIdx = -1;
  let pos = openingLineEnd;

  while (pos < text.length) {
    // Find the next newline
    const nextNewline = text.indexOf("\n", pos);
    if (nextNewline === -1) {
      // No more newlines, closing fence not found
      break;
    }

    // Extract the line (without the newline, but possibly including \r)
    let line = text.slice(pos, nextNewline);
    if (line.endsWith("\r")) {
      line = line.slice(0, -1);
    }

    // Check if this line is exactly ---
    if (line === "---") {
      // We found the closing fence
      closingIdx = nextNewline; // position of the \n after the closing ---
      break;
    }

    // Move to the next line
    pos = nextNewline + 1;
  }

  if (closingIdx === -1) {
    // No closing fence found
    return { frontmatter: null, body: text };
  }

  // Extract frontmatter (between opening and closing fences, no fences)
  const frontmatter = text.slice(openingLineEnd, pos);

  // Extract body (everything after the closing fence's newline)
  const bodyStart = closingIdx + 1;
  const body = text.slice(bodyStart);

  return { frontmatter, body };
}

// get_frontmatter(path) — parsed YAML frontmatter of a note, or null if none.
export async function getFrontmatter(relPath) {
  const abs = resolveInVault(relPath);
  let text;
  try {
    text = await fs.readFile(abs, "utf8");
  } catch {
    throw new Error(`note does not exist: ${toVaultRelative(abs)}`);
  }

  const { frontmatter } = splitFrontmatter(text);
  if (frontmatter === null) return null;

  try {
    return parseYaml(frontmatter);
  } catch (err) {
    throw new Error(`invalid YAML frontmatter in ${toVaultRelative(abs)}: ${err.message}`);
  }
}

// update_frontmatter(path, key, value) — set or remove ONE top-level key.
// value is null to delete; otherwise it's a JSON value.
export async function updateFrontmatter(relPath, key, value) {
  if (typeof key !== "string" || key.trim() === "") {
    throw new Error("key must be a non-empty string");
  }

  const abs = resolveInVault(relPath);
  let text;
  try {
    text = await fs.readFile(abs, "utf8");
  } catch {
    throw new Error(`note does not exist: ${toVaultRelative(abs)}`);
  }

  const { frontmatter, body } = splitFrontmatter(text);

  // Parse existing frontmatter or default to empty object
  let data;
  if (frontmatter === null) {
    data = {};
  } else {
    try {
      data = parseYaml(frontmatter);
    } catch (err) {
      throw new Error(`invalid YAML frontmatter in ${toVaultRelative(abs)}: ${err.message}`);
    }
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      throw new Error(
        `frontmatter is not a YAML mapping in ${toVaultRelative(abs)}`
      );
    }
  }

  // Update the key
  if (value === null) {
    delete data[key];
  } else {
    data[key] = value;
  }

  // Re-serialize: if the resulting object has no keys, write body without frontmatter block;
  // otherwise write ---\n${stringifyYaml(data)}---\n + body.
  // Note: stringifyYaml output ends with a trailing newline already, hence ---\n directly after it.
  let newText;
  if (Object.keys(data).length === 0) {
    newText = body;
  } else {
    newText = `---\n${stringifyYaml(data)}---\n${body}`;
  }

  await fs.writeFile(abs, newText, "utf8");
  return { relPath: toVaultRelative(abs), action: value === null ? "removed" : "set" };
}

// Validate a caller-supplied path the same way the read/write tools do (in-vault,
// no dot-segments, must be .md) and return it normalized to a vault-relative,
// forward-slash form suitable for `git` pathspecs. Throws on any violation.
// Exists so git.js can sanitize a path BEFORE handing it to a git subprocess.
export function assertVaultPath(relPath) {
  const abs = resolveInVault(relPath); // throws on traversal / dot / non-.md
  return toVaultRelative(abs);
}

export const vaultRoot = VAULT_ROOT;

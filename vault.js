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

// Clamp a caller-supplied result limit to [1, 100], falling back to `def`.
function clampLimit(limit, def) {
  return Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 100) : def;
}

// Serialize all vault MUTATIONS through one queue, mirroring git.js's serial().
// move_note/undelete_note use a check-then-rename sequence ("destination must
// not exist" → rename) that would otherwise race a concurrent write to the same
// path — POSIX rename silently overwrites — so mutations never interleave.
let mutationQueue = Promise.resolve();
function locked(fn) {
  const run = mutationQueue.then(fn, fn);
  mutationQueue = run.then(() => {}, () => {});
  return run;
}

// Throw unless nothing exists at `abs`. Only ENOENT counts as "free": any other
// fs.access failure (EACCES, ELOOP, …) is re-thrown, so a permission problem is
// never mistaken for a missing file (fs.rename would then silently overwrite).
async function assertDestinationFree(abs, relLabel) {
  try {
    await fs.access(abs);
  } catch (err) {
    if (err.code === "ENOENT") return;
    throw err;
  }
  throw new Error(`destination already exists: ${relLabel}`);
}

// Resolve a caller-supplied path that must live INSIDE .trash/. Unlike
// resolveInVault, the leading ".trash" segment is allowed — but only that one;
// every other segment must still be non-hidden, and the path must stay inside
// the vault and end in .md.
function resolveInTrash(relPath) {
  if (typeof relPath !== "string" || relPath.trim() === "") {
    throw new Error("path must be a non-empty string");
  }
  const normalized = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const segments = normalized.split("/");

  // First segment must be exactly .trash
  if (segments.length === 0 || segments[0] !== ".trash") {
    throw new Error("path must start with .trash/");
  }

  // Every segment after .trash must be non-hidden
  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.length > 0 && seg.startsWith(".")) {
      throw new Error("access to dot-prefixed (hidden) paths is not allowed");
    }
  }

  // Must end in .md
  if (!normalized.toLowerCase().endsWith(".md")) {
    throw new Error("path must point to a .md file");
  }

  // Resolve against vault root and verify it stays inside .trash
  const abs = path.resolve(VAULT_ROOT, normalized);
  const trashDirAbs = path.resolve(VAULT_ROOT, ".trash");
  const rel = path.relative(trashDirAbs, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("path escapes the vault root");
  }

  return abs;
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
export function writeNote(relPath, content) {
  const abs = resolveInVault(relPath);
  if (typeof content !== "string") throw new Error("content must be a string");
  return locked(async () => {
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf8");
    return toVaultRelative(abs);
  });
}

// append_note(path, content) — append to an EXISTING note. Errors if missing.
export function appendNote(relPath, content) {
  const abs = resolveInVault(relPath);
  if (typeof content !== "string") throw new Error("content must be a string");
  return locked(async () => {
    try {
      await fs.access(abs);
    } catch {
      throw new Error(`note does not exist: ${toVaultRelative(abs)} (use write_note to create it)`);
    }
    await fs.appendFile(abs, content, "utf8");
    return toVaultRelative(abs);
  });
}

// delete_note(path) — move an existing note to .trash/ (recoverable), never a
// hard delete. Preserves the note's subfolder under .trash and appends an
// epoch-ms suffix so repeated deletes of the same name never collide.
export function deleteNote(relPath) {
  const abs = resolveInVault(relPath); // validates: in-vault, non-dot, .md
  return locked(async () => {
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
  });
}

// move_note(fromRel, toRel) — rename/move an existing note within the vault.
// Validates BOTH paths, errors if source missing or destination exists, creates
// parent folders, then renames. Returns { from, to } as vault-relative paths.
export function moveNote(fromRel, toRel) {
  const fromAbs = resolveInVault(fromRel); // validates: in-vault, non-dot, .md
  const toAbs = resolveInVault(toRel); // validates: in-vault, non-dot, .md
  const from = toVaultRelative(fromAbs);
  const to = toVaultRelative(toAbs);

  if (fromAbs === toAbs) {
    throw new Error("source and destination are the same");
  }

  return locked(async () => {
    try {
      await fs.access(fromAbs);
    } catch {
      throw new Error(`note does not exist: ${from}`);
    }
    await assertDestinationFree(toAbs, to);
    await fs.mkdir(path.dirname(toAbs), { recursive: true });
    await fs.rename(fromAbs, toAbs);
    return { from, to };
  });
}

// Reverse deleteNote's naming for a vault-relative ".trash/..." path: strip the
// prefix, drop the epoch-ms stamp if present, and return the note's pre-delete
// vault path plus when it was trashed (trashedAt is null when the name carries
// no stamp, e.g. a file dropped into .trash by hand or by Obsidian itself).
// Single source of truth for listTrash AND undeleteNote, so the path that
// list_trash displays is always the one undelete_note restores to.
function parseTrashPath(vaultRelPath) {
  const rel = vaultRelPath.slice(".trash/".length);
  const dir = path.posix.dirname(rel);
  const ext = path.posix.extname(rel); // ".md"
  const nameWithoutExt = path.posix.basename(rel, ext); // e.g. "note.1720449600000"

  let base = nameWithoutExt;
  let trashedAt = null;
  const lastDotIdx = nameWithoutExt.lastIndexOf(".");
  if (lastDotIdx > 0) {
    const maybeEpoch = nameWithoutExt.slice(lastDotIdx + 1);
    if (/^\d+$/.test(maybeEpoch)) {
      base = nameWithoutExt.slice(0, lastDotIdx);
      trashedAt = new Date(parseInt(maybeEpoch, 10)).toISOString();
    }
  }

  const original = dir === "." ? `${base}${ext}` : `${dir}/${base}${ext}`;
  return { original, trashedAt };
}

// list_trash() — every trashed note: its .trash path plus when it was trashed.
// walkMarkdown only filters entries INSIDE the directory it's given, so passing
// the .trash dir itself works — hidden entries within .trash are still skipped.
export async function listTrash() {
  const trashDirAbs = path.resolve(VAULT_ROOT, ".trash");
  const files = await walkMarkdown(trashDirAbs);

  const entries = files.map((abs) => {
    const vaultRelPath = toVaultRelative(abs); // e.g. ".trash/inbox/note.1720449600000.md"
    const { original, trashedAt } = parseTrashPath(vaultRelPath);
    return { path: vaultRelPath, original, trashedAt };
  });

  // Sort: newest-trashed first (null trashedAt last, then by path)
  entries.sort((a, b) => {
    if (a.trashedAt === null && b.trashedAt === null) {
      return a.path.localeCompare(b.path);
    }
    if (a.trashedAt === null) return 1;
    if (b.trashedAt === null) return -1;
    return b.trashedAt.localeCompare(a.trashedAt);
  });

  return entries;
}

// undelete_note(trash_path, to?) — move a note out of .trash back into the vault.
export function undeleteNote(trashRelPath, toRel) {
  const trashAbs = resolveInTrash(trashRelPath);
  const trashVaultRel = toVaultRelative(trashAbs);

  // Destination: explicit `to`, or the reconstructed original path — computed
  // by the same parseTrashPath that list_trash displays, so they always agree.
  const destVaultRel = toRel
    ? toVaultRelative(resolveInVault(toRel))
    : parseTrashPath(trashVaultRel).original;
  const destAbs = resolveInVault(destVaultRel); // validates: in-vault, non-dot, .md

  return locked(async () => {
    try {
      await fs.access(trashAbs);
    } catch {
      throw new Error(`note does not exist: ${trashVaultRel}`);
    }
    await assertDestinationFree(destAbs, destVaultRel);
    await fs.mkdir(path.dirname(destAbs), { recursive: true });
    await fs.rename(trashAbs, destAbs);
    return { from: trashVaultRel, to: destVaultRel };
  });
}

// replace_text(path, oldText, newText, replaceAll?) — targeted find-and-replace
// within an EXISTING note. By default oldText must occur EXACTLY once (a 0-match
// or an ambiguous multi-match errors out so the caller can supply more context);
// set replaceAll to swap every occurrence. Matching is literal (not regex).
// Returns { relPath, count } where count is the number of replacements made.
export function replaceText(relPath, oldText, newText, replaceAll = false) {
  const abs = resolveInVault(relPath);
  if (typeof oldText !== "string" || oldText === "") {
    throw new Error("old_text must be a non-empty string");
  }
  if (typeof newText !== "string") {
    throw new Error("new_text must be a string");
  }
  return locked(async () => {
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
  });
}

// search_notes(query, folder?, limit?) — case-insensitive substring search.
// Scans .md files in sorted path order (optionally within one subfolder) and
// returns { hits, truncated }: up to `limit` matching files, each with a match
// count and up to 3 snippets, plus a flag that is true when at least one MORE
// matching file exists beyond the cap (so callers know the list is incomplete).
export async function searchNotes(query, folder, limit = 20) {
  if (typeof query !== "string" || query.trim() === "") {
    throw new Error("query must be a non-empty string");
  }

  const clampedLimit = clampLimit(limit, 20);

  let base = VAULT_ROOT;
  if (folder && folder.trim() !== "") {
    base = resolveInVault(folder, { requireMd: false });
  }

  const needle = query.toLowerCase();
  // Sorted so which files "win" under the cap is deterministic, not readdir order.
  const files = (await walkMarkdown(base)).sort();
  const hits = [];
  let truncated = false;

  for (const file of files) {
    let text;
    try {
      text = await fs.readFile(file, "utf8");
    } catch {
      continue;
    }

    const lowerText = text.toLowerCase();
    const snippets = [];
    let matchCount = 0;
    let searchPos = 0;

    // Count total matches and collect up to 3 snippets
    for (let idx = lowerText.indexOf(needle, searchPos); idx !== -1; idx = lowerText.indexOf(needle, searchPos)) {
      matchCount++;
      if (snippets.length < 3) {
        const start = Math.max(0, idx - 40);
        const end = Math.min(text.length, idx + query.length + 80);
        let snippet = text.slice(start, end).replace(/\s+/g, " ").trim();
        if (start > 0) snippet = "…" + snippet;
        if (end < text.length) snippet = snippet + "…";
        snippets.push(snippet);
      }
      searchPos = idx + query.length;
    }

    if (matchCount > 0) {
      if (hits.length >= clampedLimit) {
        truncated = true; // found a matching file beyond the cap — stop here
        break;
      }
      hits.push({ path: toVaultRelative(file), matchCount, snippets });
    }
  }

  return { hits, truncated };
}

// recent_changes(folder?, limit?) — notes sorted by modification time, newest
// first. Uses filesystem mtime, so it also reflects edits synced in from
// devices, and works whether or not git versioning is enabled.
export async function recentChanges(folder, limit = 20) {
  const clampedLimit = clampLimit(limit, 20);

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
export function updateFrontmatter(relPath, key, value) {
  if (typeof key !== "string" || key.trim() === "") {
    throw new Error("key must be a non-empty string");
  }
  const abs = resolveInVault(relPath);

  return locked(async () => {
    let text;
    try {
      text = await fs.readFile(abs, "utf8");
    } catch {
      throw new Error(`note does not exist: ${toVaultRelative(abs)}`);
    }

    const { frontmatter, body } = splitFrontmatter(text);

    // Parse existing frontmatter or default to empty object. An EMPTY block
    // ("---\n---\n", a common placeholder) parses to null — treat it as {} so
    // setting the first key works instead of erroring.
    let data;
    if (frontmatter === null) {
      data = {};
    } else {
      try {
        data = parseYaml(frontmatter) ?? {};
      } catch (err) {
        throw new Error(`invalid YAML frontmatter in ${toVaultRelative(abs)}: ${err.message}`);
      }
      if (typeof data !== "object" || Array.isArray(data)) {
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

    // Re-serialize: no keys left → drop the block entirely; otherwise rebuild
    // the fences in the note's own line-ending style so a CRLF note doesn't
    // come back with mixed endings. stringifyYaml already ends with a newline,
    // hence the closing fence directly after it.
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    let newText;
    if (Object.keys(data).length === 0) {
      newText = body;
    } else {
      const yamlText =
        eol === "\n" ? stringifyYaml(data) : stringifyYaml(data).replace(/\n/g, eol);
      newText = `---${eol}${yamlText}---${eol}${body}`;
    }

    await fs.writeFile(abs, newText, "utf8");
    return { relPath: toVaultRelative(abs), action: value === null ? "removed" : "set" };
  });
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

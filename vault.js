// vault.js — all filesystem logic for the Obsidian vault.
// Every path argument is validated to stay inside VAULT_ROOT and to avoid
// dot-prefixed segments (so `.obsidian`, `.trash`, `.git`, etc. are never
// listed, read, written, or searched).

import { promises as fs } from "node:fs";
import path from "node:path";

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

export const vaultRoot = VAULT_ROOT;

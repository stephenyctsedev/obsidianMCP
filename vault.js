// vault.js — all filesystem logic for the Obsidian vault.
// Every path argument is validated to stay inside VAULT_ROOT and to avoid
// dot-prefixed segments (so `.obsidian`, `.trash`, `.git`, etc. are never
// listed, read, written, or searched).

import { promises as fs } from "node:fs";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  extractBaseBlocks,
  extractBaseEmbeds,
  parseBaseSpec,
  inferFolderScope,
  runBase,
  renderBaseResult,
} from "./bases.js";

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
function resolveInVault(relPath, { requireMd = true, allowedExts = [".md"] } = {}) {
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
  if (requireMd && !allowedExts.some((ext) => abs.toLowerCase().endsWith(ext))) {
    throw new Error(`path must point to a ${allowedExts.join(" or ")} file`);
  }
  return abs;
}

// Recursively collect .md files under `dir`, skipping dot-directories.
function walkMarkdown(dir) {
  return walkByExt(dir, [".md"]);
}

// Recursively collect files with one of `exts` under `dir`, skipping dot-dirs.
async function walkByExt(dir, exts) {
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
      out.push(...(await walkByExt(full, exts)));
    } else if (entry.isFile() && exts.some((ext) => entry.name.toLowerCase().endsWith(ext))) {
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

// list_notes caps. Unlike search/recent (clampLimit, max 100) a listing is a
// navigation aid, so it gets a roomier ceiling — but never an unbounded one:
// every path costs the caller context, so a vault that grows to thousands of
// notes must not be able to blow the window in a single call.
const LIST_DEFAULT_LIMIT = 200;
const LIST_MAX_LIMIT = 1000;

function clampListLimit(limit) {
  return Number.isFinite(limit) && limit > 0
    ? Math.min(Math.floor(limit), LIST_MAX_LIMIT)
    : LIST_DEFAULT_LIMIT;
}

// Compile a shell-style glob into a case-insensitive RegExp: `*` matches within
// one path segment, `**` crosses segments, `?` is a single non-slash character.
// Everything else is literal.
function globToRegExp(glob) {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i++;
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`, "i");
}

// Collapse a flat file list into an `ls`-style view `depth` levels below the
// listing scope: paths within the depth stay as files, anything deeper folds
// into its ancestor folder carrying a recursive file count. Folders sort first.
function collapseToDepth(relPaths, prefixLen, depth) {
  const folders = new Map(); // folder path -> file count
  const files = [];
  for (const p of relPaths) {
    const segments = p.slice(prefixLen).split("/");
    if (segments.length <= depth) {
      files.push({ type: "file", path: p });
      continue;
    }
    const folder = p.slice(0, prefixLen) + segments.slice(0, depth).join("/");
    folders.set(folder, (folders.get(folder) ?? 0) + 1);
  }
  const folderEntries = [...folders]
    .map(([p, count]) => ({ type: "folder", path: p, count }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return [...folderEntries, ...files];
}

// list_notes(folder?, { includeBases, pattern, depth, limit, offset }) — the
// vault's .md files (plus .base files when asked) as relative paths.
//
// The result is ALWAYS capped: `total` reports how many entries matched so the
// caller can tell a short list from a truncated one, and `offset` pages through
// the rest. `pattern` filters by glob and `depth` collapses deep subtrees into
// folder counts — both exist so a large vault can be navigated without paying
// for every path in it.
export async function listNotes(
  folder,
  { includeBases = false, pattern, depth, limit, offset } = {}
) {
  let base = VAULT_ROOT;
  if (folder && folder.trim() !== "") {
    base = resolveInVault(folder, { requireMd: false });
  }

  if (depth != null && (!Number.isInteger(depth) || depth < 1)) {
    throw new Error("depth must be an integer >= 1");
  }
  const clampedLimit = clampListLimit(limit);
  const clampedOffset = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0;

  const exts = includeBases ? [".md", ".base"] : [".md"];
  // Sorted so which entries "win" under the cap is deterministic, not readdir order.
  const files = (await walkByExt(base, exts)).map(toVaultRelative).sort();

  // Length of the scope prefix, so `pattern` and `depth` see paths relative to
  // `folder` rather than to the vault root ("" scope => prefixLen 0).
  const baseRel = toVaultRelative(base);
  const prefixLen = baseRel === "" ? 0 : baseRel.length + 1;

  let matched = files;
  if (pattern != null) {
    if (typeof pattern !== "string" || pattern.trim() === "") {
      throw new Error("pattern must be a non-empty string");
    }
    const re = globToRegExp(pattern.trim());
    // A pattern without "/" matches the file name alone; one with "/" matches
    // the whole scope-relative path.
    const byName = !pattern.includes("/");
    matched = files.filter((p) =>
      re.test(byName ? p.slice(p.lastIndexOf("/") + 1) : p.slice(prefixLen))
    );
  }

  const entries =
    depth != null
      ? collapseToDepth(matched, prefixLen, depth)
      : matched.map((p) => ({ type: "file", path: p }));

  const page = entries.slice(clampedOffset, clampedOffset + clampedLimit);
  return {
    entries: page,
    total: entries.length,
    offset: clampedOffset,
    limit: clampedLimit,
    truncated: clampedOffset + page.length < entries.length,
  };
}

// read_note(path, { resolve }) — full content of a note. When the note embeds
// a base (a ```base block or an `![[X.base]]` embed) and `resolve` is on, the
// data that base renders is appended after the note text, so ONE call returns
// both the note and the rows a human sees in Obsidian. Pass resolve:false to
// get the file exactly as stored (e.g. before editing it).
export async function readNote(relPath, { resolve = true } = {}) {
  const abs = resolveInVault(relPath);
  const text = await fs.readFile(abs, "utf8");
  if (!resolve) return text;
  const resolved = await resolveBaseData(text);
  return resolved ? `${text}${text.endsWith("\n") ? "" : "\n"}\n${resolved}` : text;
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

// list_trash({ limit, offset }) — trashed notes, newest first: each one's
// .trash path plus when it was trashed. Capped like every other listing (the
// entries are two lines each, so the search/recent ceiling fits better than
// list_notes'); `total` reports the full count and `offset` pages back through
// older deletions.
// walkMarkdown only filters entries INSIDE the directory it's given, so passing
// the .trash dir itself works — hidden entries within .trash are still skipped.
export async function listTrash({ limit, offset } = {}) {
  const clampedLimit = clampLimit(limit, 20);
  const clampedOffset = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0;

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

  const page = entries.slice(clampedOffset, clampedOffset + clampedLimit);
  return {
    entries: page,
    total: entries.length,
    offset: clampedOffset,
    limit: clampedLimit,
    truncated: clampedOffset + page.length < entries.length,
  };
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
// --- Bases (embedded query) resolution -------------------------------------

// Ceiling on how many notes one base query may scan when it isn't scoped to a
// folder, so a whole-vault base can't turn one read_note into an unbounded read.
const MAX_BASE_SCAN = 5000;

const RESOLVED_HEADER =
  "<!-- obsidian-mcp: the section below is DATA resolved from the base query " +
  "above (frontmatter of the notes it selects). It is NOT part of the note " +
  "file — never write it back. Call read_note with resolve=false for the raw file. -->";

// Frontmatter `tags:` as a flat list, without leading "#".
function normalizeTags(raw) {
  if (raw === null || raw === undefined) return [];
  const list = Array.isArray(raw) ? raw : String(raw).split(/[,\s]+/);
  return list
    .map((t) => String(t).trim().replace(/^#/, ""))
    .filter((t) => t !== "");
}

// One note as the base evaluator sees it: file metadata + parsed frontmatter.
async function toNoteRecord(abs) {
  let text;
  let stat;
  try {
    [text, stat] = await Promise.all([fs.readFile(abs, "utf8"), fs.stat(abs)]);
  } catch {
    return null; // vanished mid-walk, or unreadable — skip it
  }
  const relPath = toVaultRelative(abs);
  const { frontmatter } = splitFrontmatter(text);
  let properties = {};
  let error = null;
  if (frontmatter !== null) {
    try {
      const parsed = parseYaml(frontmatter);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) properties = parsed;
    } catch (err) {
      error = err.message; // invalid YAML: the note still exists, it just has no usable props
    }
  }
  const slash = relPath.lastIndexOf("/");
  return {
    path: relPath,
    name: relPath.slice(slash + 1).replace(/\.md$/i, ""),
    folder: slash === -1 ? "" : relPath.slice(0, slash),
    ext: "md",
    size: stat.size,
    mtime: stat.mtime,
    ctime: stat.birthtime || stat.ctime,
    tags: normalizeTags(properties.tags ?? properties.tag),
    properties,
    error,
  };
}

// collect_notes(folder?) — every note in scope with its parsed frontmatter.
// This is what a base query runs against.
export async function collectNotes(folder, { max = MAX_BASE_SCAN } = {}) {
  let base = VAULT_ROOT;
  if (folder && folder.trim() !== "") {
    base = resolveInVault(folder, { requireMd: false });
  }
  const files = (await walkMarkdown(base)).sort();
  const truncated = files.length > max;
  const capped = files.slice(0, max);

  const notes = [];
  for (let i = 0; i < capped.length; i += 32) {
    const batch = await Promise.all(capped.slice(i, i + 32).map(toNoteRecord));
    for (const note of batch) if (note) notes.push(note);
  }
  return { notes, truncated };
}

// Locate a `![[X.base]]` embed target: exact vault path first, then basename.
async function findBaseFile(target) {
  const wanted = target.replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase();
  const files = await walkByExt(VAULT_ROOT, [".base"]);
  const rels = files.map(toVaultRelative).sort();
  const exact = rels.find((rel) => rel.toLowerCase() === wanted);
  if (exact) return exact;
  const leaf = wanted.slice(wanted.lastIndexOf("/") + 1);
  return rels.find((rel) => rel.slice(rel.lastIndexOf("/") + 1).toLowerCase() === leaf) || null;
}

// Run one base definition and render it. `cache` reuses a folder scan across
// several bases in the same note.
async function resolveOneBase(yamlText, source, viewFilter, cache) {
  let spec;
  try {
    spec = parseBaseSpec(yamlText);
  } catch (err) {
    return `### Base data — ${source}\n\n(could not parse the base definition: ${err.message})`;
  }

  const scope = inferFolderScope(spec.filters);
  const key = scope ?? "";
  if (!cache.has(key)) {
    try {
      cache.set(key, await collectNotes(scope ?? undefined));
    } catch (err) {
      return `### Base data — ${source}\n\n(could not scan ${scope || "the vault"}: ${err.message})`;
    }
  }
  const { notes, truncated } = cache.get(key);

  const result = runBase(spec, notes);
  if (truncated) {
    result.warnings.push(
      `only the first ${notes.length} notes in scope were scanned (cap: ${MAX_BASE_SCAN}) — rows may be missing`
    );
  }
  return renderBaseResult(result, { source, scanned: notes.length, scope, viewFilter });
}

// Resolve every base embedded in a note's text, or null if it embeds none.
async function resolveBaseData(text) {
  const blocks = extractBaseBlocks(text);
  const embeds = extractBaseEmbeds(text);
  if (!blocks.length && !embeds.length) return null;

  const cache = new Map();
  const sections = [];

  for (const block of blocks) {
    sections.push(await resolveOneBase(block.yaml, `base block (line ${block.line})`, null, cache));
  }
  for (const embed of embeds) {
    let found;
    try {
      found = await findBaseFile(embed.target);
    } catch {
      found = null;
    }
    if (!found) {
      sections.push(`### Base data — ${embed.raw}\n\n(no "${embed.target}" file found in the vault)`);
      continue;
    }
    let yamlText;
    try {
      yamlText = await fs.readFile(path.resolve(VAULT_ROOT, found), "utf8");
    } catch (err) {
      sections.push(`### Base data — ${found}\n\n(could not read the base file: ${err.message})`);
      continue;
    }
    sections.push(await resolveOneBase(yamlText, found, embed.view, cache));
  }

  return [RESOLVED_HEADER, ...sections].join("\n\n");
}

// read_base(path, view?) — a standalone `.base` file: its definition plus the
// data it renders. `view` limits the output to one named view.
export async function readBase(relPath, view) {
  const abs = resolveInVault(relPath, { allowedExts: [".base"] });
  let text;
  try {
    text = await fs.readFile(abs, "utf8");
  } catch {
    throw new Error(`base file does not exist: ${toVaultRelative(abs)}`);
  }
  const rendered = await resolveOneBase(
    text,
    toVaultRelative(abs),
    view && view.trim() !== "" ? view.trim() : null,
    new Map()
  );
  return `${text.trim()}\n\n${RESOLVED_HEADER}\n\n${rendered}`;
}

export function assertVaultPath(relPath) {
  const abs = resolveInVault(relPath); // throws on traversal / dot / non-.md
  return toVaultRelative(abs);
}

export const vaultRoot = VAULT_ROOT;

// git.js — optional LOCAL git versioning of the vault. Never pushes anywhere.
// Best-effort: a commit failure never breaks a tool call. All git operations
// are serialized to avoid .git/index.lock races.
//
//   A) commitPath()  — per-file commit after each write/append/delete tool call
//   C) snapshotAll()  — periodic whole-vault snapshot (captures device edits too)
//   D) noteHistory() / showNoteAtRef() — read-only history + old-version lookup
//      powering the note_history and restore_note tools

import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { vaultRoot, assertVaultPath } from "./vault.js";

export const gitEnabled = /^true$/i.test(process.env.GIT_VERSIONING || "");
const AUTHOR_NAME = process.env.GIT_AUTHOR_NAME || "obsidian-mcp";
const AUTHOR_EMAIL = process.env.GIT_AUTHOR_EMAIL || "obsidian-mcp@localhost";
const SNAPSHOT_MINUTES = parseInt(process.env.GIT_SNAPSHOT_MINUTES || "0", 10);

// Run git in the vault. `-c safe.directory` avoids "dubious ownership" refusals
// without needing a writable HOME for global config.
function git(args) {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-C", vaultRoot, "-c", `safe.directory=${vaultRoot}`, ...args],
      { maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) =>
        err ? reject(new Error((stderr || err.message).toString().trim())) : resolve(stdout)
    );
  });
}

// Serialize all git ops so overlapping tool calls never collide on the index.
let queue = Promise.resolve();
function serial(fn) {
  const run = queue.then(fn, fn);
  queue = run.then(() => {}, () => {});
  return run;
}

const GITIGNORE = `.obsidian/\n.trash/\n.makemd/\n.space/\n.claudian/\n`;

export async function initGitRepo() {
  if (!gitEnabled) return;
  try {
    await git(["rev-parse", "--is-inside-work-tree"]);
  } catch {
    await git(["init"]);
  }
  await git(["config", "user.name", AUTHOR_NAME]);
  await git(["config", "user.email", AUTHOR_EMAIL]);
  const gi = path.join(vaultRoot, ".gitignore");
  try {
    await fs.access(gi);
  } catch {
    await fs.writeFile(gi, GITIGNORE, "utf8");
  }
  console.log(`git versioning enabled (repo: ${vaultRoot})`);
}

// A) Best-effort commit of a single vault-relative path. Never throws.
export async function commitPath(relPath, action) {
  if (!gitEnabled) return;
  return serial(async () => {
    try {
      await git(["add", "-A", "--", relPath]); // stages add/modify OR deletion
      const status = await git(["status", "--porcelain", "--", relPath]);
      if (!status.trim()) return; // nothing changed → no commit
      const msg = `${action}: ${relPath} @ ${new Date().toISOString()}`;
      await git(["commit", "-m", msg, "--", relPath]);
    } catch (err) {
      console.error(`git commit failed for ${relPath}: ${err.message}`);
    }
  });
}

// C) Best-effort whole-vault snapshot. Never throws.
export async function snapshotAll() {
  if (!gitEnabled) return;
  return serial(async () => {
    try {
      await git(["add", "-A"]);
      const status = await git(["status", "--porcelain"]);
      if (!status.trim()) return; // nothing changed since last snapshot
      const msg = `snapshot @ ${new Date().toISOString()}`;
      await git(["commit", "-m", msg]);
    } catch (err) {
      console.error(`git snapshot failed: ${err.message}`);
    }
  });
}

// --- Read/restore helpers (D) ----------------------------------------------
// These power the note_history and restore_note tools. They never mutate the
// working tree themselves (restore is done by writing content back through the
// normal vault path so it re-commits as a fresh version, not a git reset).

function assertGitEnabled() {
  if (!gitEnabled) {
    throw new Error("git versioning is disabled (set GIT_VERSIONING=true to enable history/restore)");
  }
}

// Return the commit history that touched a single note, newest first.
// Uses --follow so renames are tracked across history. Returns
// [{ hash, shortHash, date, subject }]; empty array if the note has no history.
export async function noteHistory(relPath, limit = 10) {
  assertGitEnabled();
  const safe = assertVaultPath(relPath); // in-vault, non-dot, .md
  const n = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 100) : 10;
  // Unit separator (\x1f) between fields, record separator (\x1e) between commits —
  // neither can appear in git's %H/%cI/%s output, so parsing is unambiguous.
  const fmt = "%H\x1f%cI\x1f%s\x1e";
  const out = await git([
    "log",
    `-n`,
    String(n),
    "--follow",
    `--format=${fmt}`,
    "--",
    safe,
  ]);
  return out
    .split("\x1e")
    .map((rec) => rec.replace(/^\n/, "").trim())
    .filter(Boolean)
    .map((rec) => {
      const [hash, date, subject] = rec.split("\x1f");
      return { hash, shortHash: hash.slice(0, 8), date, subject };
    });
}

// Return the content of a note as it existed at a given commit ref, without
// touching the working tree. Throws if the ref or path didn't exist there.
export async function showNoteAtRef(relPath, ref) {
  assertGitEnabled();
  const safe = assertVaultPath(relPath); // validate BEFORE handing path to git
  if (typeof ref !== "string" || !/^[0-9a-zA-Z._/-]+$/.test(ref)) {
    throw new Error("ref must be a valid git commit hash or ref name");
  }
  try {
    return await git(["show", `${ref}:${safe}`]);
  } catch (err) {
    throw new Error(`could not read ${safe} at ${ref}: ${err.message}`);
  }
}

// Hook for a future diff tool: unified diff of a note between an old ref and the
// current working tree. Wired up but intentionally NOT registered as an MCP tool
// yet (see README) — export kept so enabling it later is a one-line change.
export async function diffNoteAtRef(relPath, ref) {
  assertGitEnabled();
  const safe = assertVaultPath(relPath);
  if (typeof ref !== "string" || !/^[0-9a-zA-Z._/-]+$/.test(ref)) {
    throw new Error("ref must be a valid git commit hash or ref name");
  }
  return await git(["diff", ref, "--", safe]);
}

// Start the periodic snapshot timer (C). Runs an immediate baseline first.
export function startSnapshotTimer() {
  if (!gitEnabled || !(SNAPSHOT_MINUTES > 0)) return;
  snapshotAll(); // baseline now so history doesn't start with a gap
  const timer = setInterval(snapshotAll, SNAPSHOT_MINUTES * 60 * 1000);
  timer.unref?.(); // don't keep the process alive just for snapshots
  console.log(`git snapshots every ${SNAPSHOT_MINUTES} min`);
}

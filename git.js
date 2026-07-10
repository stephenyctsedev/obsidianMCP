// git.js — optional LOCAL git versioning of the vault. Never pushes anywhere.
// Best-effort: a commit failure never breaks a tool call. All git operations
// are serialized to avoid .git/index.lock races.
//
//   A) commitPath()  — per-file commit after each write/append/delete tool call
//   C) snapshotAll()  — periodic whole-vault snapshot (captures device edits too)

import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { vaultRoot } from "./vault.js";

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

// Start the periodic snapshot timer (C). Runs an immediate baseline first.
export function startSnapshotTimer() {
  if (!gitEnabled || !(SNAPSHOT_MINUTES > 0)) return;
  snapshotAll(); // baseline now so history doesn't start with a gap
  const timer = setInterval(snapshotAll, SNAPSHOT_MINUTES * 60 * 1000);
  timer.unref?.(); // don't keep the process alive just for snapshots
  console.log(`git snapshots every ${SNAPSHOT_MINUTES} min`);
}

// Run with: npm test   (node --test)
//
// Covers list_trash's cap and paging in vault.js: the trash grows with every
// delete_note, so like list_notes it must never return everything at once.

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// --- fixture vault ---------------------------------------------------------

const vaultRoot = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-mcp-trash-"));
const trashDir = path.join(vaultRoot, ".trash");
await fs.mkdir(path.join(trashDir, "inbox"), { recursive: true });

// Epoch-ms stamps, oldest first — deleteNote's naming convention.
const EPOCH = Date.UTC(2026, 0, 1);
for (let i = 0; i < 25; i++) {
  await fs.writeFile(path.join(trashDir, `note-${i}.${EPOCH + i * 1000}.md`), "x", "utf8");
}
// One in a subfolder, and one with no stamp (dropped in by hand or by Obsidian).
await fs.writeFile(path.join(trashDir, "inbox", `nested.${EPOCH + 99000}.md`), "x", "utf8");
await fs.writeFile(path.join(trashDir, "unstamped.md"), "x", "utf8");

process.env.VAULT_PATH = vaultRoot;
process.env.VAULT_NAME = "";
const { listTrash } = await import("../vault.js");

test("defaults to 20 entries, newest first, and reports the true total", async () => {
  const result = await listTrash();
  assert.equal(result.entries.length, 20);
  assert.equal(result.total, 27);
  assert.equal(result.truncated, true);
  assert.equal(result.limit, 20);
  // Newest deletion first: the nested note carries the largest stamp.
  assert.equal(result.entries[0].path, `.trash/inbox/nested.${EPOCH + 99000}.md`);
  assert.equal(result.entries[0].original, "inbox/nested.md");
  assert.ok(result.entries[0].trashedAt > result.entries[1].trashedAt);
});

test("offset pages through the rest and the last page is not truncated", async () => {
  const first = await listTrash();
  const second = await listTrash({ offset: 20 });
  assert.equal(second.entries.length, 7);
  assert.equal(second.truncated, false);
  const seen = [...first.entries, ...second.entries].map((e) => e.path);
  assert.equal(new Set(seen).size, 27);
});

test("an unstamped trash file still lists, with a null deletion time, sorted last", async () => {
  const all = await listTrash({ limit: 100 });
  const last = all.entries.at(-1);
  assert.equal(last.path, ".trash/unstamped.md");
  assert.equal(last.original, "unstamped.md");
  assert.equal(last.trashedAt, null);
});

test("limit is clamped to 100 and bad values fall back to the default", async () => {
  assert.equal((await listTrash({ limit: 99999 })).limit, 100);
  assert.equal((await listTrash({ limit: 0 })).limit, 20);
  assert.equal((await listTrash({ limit: "5" })).limit, 20);
});

test("an offset past the end returns nothing but still reports the total", async () => {
  const result = await listTrash({ offset: 500 });
  assert.deepEqual(result.entries, []);
  assert.equal(result.total, 27);
  assert.equal(result.truncated, false);
});

test("an empty trash reports a zero total", async () => {
  const emptyRoot = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-mcp-trash-empty-"));
  process.env.VAULT_PATH = emptyRoot;
  // vault.js resolves VAULT_ROOT at import time, so use a fresh module instance.
  const fresh = await import(`../vault.js?empty=${Date.now()}`);
  const result = await fresh.listTrash();
  assert.deepEqual(result.entries, []);
  assert.equal(result.total, 0);
  assert.equal(result.truncated, false);
  process.env.VAULT_PATH = vaultRoot;
  await fs.rm(emptyRoot, { recursive: true, force: true });
});

test.after(async () => {
  await fs.rm(vaultRoot, { recursive: true, force: true });
});

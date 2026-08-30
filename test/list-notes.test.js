// Run with: npm test   (node --test)
//
// Covers list_notes' scalability surface in vault.js: the cap that keeps a
// growing vault from returning every path at once, plus the `pattern`, `depth`
// and `offset` controls that let a caller narrow instead of paging blindly.

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// --- fixture vault ---------------------------------------------------------

const vaultRoot = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-mcp-list-"));

async function writeNote(rel, body = "# note\n") {
  const abs = path.join(vaultRoot, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, body, "utf8");
}

await writeNote("Root note.md");
await writeNote("Daily/2026-01-01.md");
await writeNote("Daily/2026-01-02.md");
await writeNote("Daily/2025/2025-12-31.md");
await writeNote("Projects/Alpha/Spec.md");
await writeNote("Projects/Alpha/Notes/Deep.md");
await writeNote("Projects/Beta/Spec.md");
await writeNote("Projects/Overview.base", "filters: {}\n");
// A hidden folder must stay invisible to every listing mode.
await writeNote(".obsidian/workspace.md");

process.env.VAULT_PATH = vaultRoot;
process.env.VAULT_NAME = "";
const { listNotes } = await import("../vault.js");

const paths = (result) => result.entries.map((e) => e.path);

// --- default listing -------------------------------------------------------

test("lists every note recursively, sorted, skipping hidden folders", async () => {
  const result = await listNotes();
  assert.deepEqual(paths(result), [
    "Daily/2025/2025-12-31.md",
    "Daily/2026-01-01.md",
    "Daily/2026-01-02.md",
    "Projects/Alpha/Notes/Deep.md",
    "Projects/Alpha/Spec.md",
    "Projects/Beta/Spec.md",
    "Root note.md",
  ]);
  assert.equal(result.total, 7);
  assert.equal(result.truncated, false);
  assert.ok(result.entries.every((e) => e.type === "file"));
});

test("include_bases adds .base files", async () => {
  assert.ok(paths(await listNotes(undefined, { includeBases: true })).includes("Projects/Overview.base"));
});

test("folder scopes the listing", async () => {
  assert.deepEqual(paths(await listNotes("Daily")), [
    "Daily/2025/2025-12-31.md",
    "Daily/2026-01-01.md",
    "Daily/2026-01-02.md",
  ]);
});

// --- the cap ---------------------------------------------------------------

test("the result is capped and reports the true total", async () => {
  const result = await listNotes(undefined, { limit: 3 });
  assert.equal(result.entries.length, 3);
  assert.equal(result.total, 7);
  assert.equal(result.truncated, true);
});

test("offset pages through the rest, and the last page is not truncated", async () => {
  const first = await listNotes(undefined, { limit: 3 });
  const second = await listNotes(undefined, { limit: 3, offset: 3 });
  const third = await listNotes(undefined, { limit: 3, offset: 6 });
  assert.equal(second.truncated, true);
  assert.equal(third.truncated, false);
  assert.deepEqual(
    [...paths(first), ...paths(second), ...paths(third)],
    paths(await listNotes())
  );
});

test("limit is clamped to the 1000 ceiling and bad values fall back to the default", async () => {
  assert.equal((await listNotes(undefined, { limit: 99999 })).limit, 1000);
  assert.equal((await listNotes(undefined, { limit: 0 })).limit, 200);
  assert.equal((await listNotes(undefined, { limit: "20" })).limit, 200);
  assert.equal((await listNotes()).limit, 200);
});

test("an offset past the end returns nothing but still reports the total", async () => {
  const result = await listNotes(undefined, { offset: 100 });
  assert.deepEqual(result.entries, []);
  assert.equal(result.total, 7);
  assert.equal(result.truncated, false);
});

// --- pattern ---------------------------------------------------------------

test("a pattern without a slash matches the file name anywhere in the tree", async () => {
  assert.deepEqual(paths(await listNotes(undefined, { pattern: "Spec.md" })), [
    "Projects/Alpha/Spec.md",
    "Projects/Beta/Spec.md",
  ]);
  assert.deepEqual(paths(await listNotes(undefined, { pattern: "2026-*.md" })), [
    "Daily/2026-01-01.md",
    "Daily/2026-01-02.md",
  ]);
});

test("a pattern with a slash matches the path below the listed folder", async () => {
  assert.deepEqual(paths(await listNotes(undefined, { pattern: "Projects/*/Spec.md" })), [
    "Projects/Alpha/Spec.md",
    "Projects/Beta/Spec.md",
  ]);
  // "*" stops at a separator; "**" crosses it.
  assert.deepEqual(paths(await listNotes(undefined, { pattern: "Projects/*/*.md" })), [
    "Projects/Alpha/Spec.md",
    "Projects/Beta/Spec.md",
  ]);
  assert.deepEqual(paths(await listNotes(undefined, { pattern: "Projects/**/*.md" })), [
    "Projects/Alpha/Notes/Deep.md",
    "Projects/Alpha/Spec.md",
    "Projects/Beta/Spec.md",
  ]);
  // Paths are relative to `folder`, not the vault root.
  assert.deepEqual(paths(await listNotes("Projects", { pattern: "Alpha/*.md" })), [
    "Projects/Alpha/Spec.md",
  ]);
});

test("pattern matching is case-insensitive and treats dots literally", async () => {
  assert.deepEqual(paths(await listNotes(undefined, { pattern: "spec.MD" })), [
    "Projects/Alpha/Spec.md",
    "Projects/Beta/Spec.md",
  ]);
  // "." is literal — it must not match the space in "Root note.md" the way the
  // regex any-char would, while "?" is the wildcard that does.
  assert.deepEqual(paths(await listNotes(undefined, { pattern: "Root.note.md" })), []);
  assert.deepEqual(paths(await listNotes(undefined, { pattern: "?oot note.md" })), [
    "Root note.md",
  ]);
});

test("a pattern matching nothing is an empty result, not an error", async () => {
  const result = await listNotes(undefined, { pattern: "nope-*.md" });
  assert.deepEqual(result.entries, []);
  assert.equal(result.total, 0);
});

test("an empty pattern is rejected", async () => {
  await assert.rejects(() => listNotes(undefined, { pattern: "  " }), /non-empty string/);
});

// --- depth -----------------------------------------------------------------

test("depth=1 collapses subtrees into folders with recursive note counts", async () => {
  const result = await listNotes(undefined, { depth: 1 });
  assert.deepEqual(result.entries, [
    { type: "folder", path: "Daily", count: 3 },
    { type: "folder", path: "Projects", count: 3 },
    { type: "file", path: "Root note.md" },
  ]);
  assert.equal(result.total, 3);
});

test("depth=2 expands one level further", async () => {
  assert.deepEqual(await listNotes(undefined, { depth: 2 }).then((r) => r.entries), [
    { type: "folder", path: "Daily/2025", count: 1 },
    { type: "folder", path: "Projects/Alpha", count: 2 },
    { type: "folder", path: "Projects/Beta", count: 1 },
    { type: "file", path: "Daily/2026-01-01.md" },
    { type: "file", path: "Daily/2026-01-02.md" },
    { type: "file", path: "Root note.md" },
  ]);
});

test("depth counts levels below the listed folder, not the vault root", async () => {
  assert.deepEqual(await listNotes("Projects", { depth: 1 }).then((r) => r.entries), [
    { type: "folder", path: "Projects/Alpha", count: 2 },
    { type: "folder", path: "Projects/Beta", count: 1 },
  ]);
});

test("depth deeper than the tree lists plain files", async () => {
  const result = await listNotes(undefined, { depth: 9 });
  assert.ok(result.entries.every((e) => e.type === "file"));
  assert.deepEqual(paths(result), paths(await listNotes()));
});

test("depth combines with pattern, counting only matching notes", async () => {
  assert.deepEqual(
    await listNotes(undefined, { depth: 1, pattern: "Spec.md" }).then((r) => r.entries),
    [{ type: "folder", path: "Projects", count: 2 }]
  );
});

test("depth is capped by limit like any other listing", async () => {
  const result = await listNotes(undefined, { depth: 1, limit: 1 });
  assert.equal(result.entries.length, 1);
  assert.equal(result.total, 3);
  assert.equal(result.truncated, true);
});

test("a non-positive or fractional depth is rejected", async () => {
  await assert.rejects(() => listNotes(undefined, { depth: 0 }), /depth must be/);
  await assert.rejects(() => listNotes(undefined, { depth: 1.5 }), /depth must be/);
});

test.after(async () => {
  await fs.rm(vaultRoot, { recursive: true, force: true });
});

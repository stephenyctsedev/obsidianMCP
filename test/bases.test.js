// Run with: npm test   (node --test)
//
// Covers the Bases evaluator (bases.js) and the read paths in vault.js that
// resolve an embedded base into the data it renders.

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  extractBaseBlocks,
  extractBaseEmbeds,
  evalCondition,
  matchFilter,
  inferFolderScope,
  runBase,
} from "../bases.js";

// --- fixture vault ---------------------------------------------------------

const vaultRoot = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-mcp-test-"));
const items = path.join(vaultRoot, "Travel", "Packing Data");
await fs.mkdir(items, { recursive: true });

async function writeItem(name, body) {
  await fs.writeFile(path.join(items, `${name}.md`), body, "utf8");
}

await writeItem("Go pro", "---\nlocation: Carry On\npacked: true\nprice: 300\n---\n");
await writeItem("air tag", "---\nlocation: Carry On\npacked: false\nremark: buy battery\nprice: 30\n---\n");
await writeItem("杯麵", "---\nlocation:\n  - Checked Baggage\npacked: false\n---\n");
await writeItem("no packed prop", "---\nlocation: Carry On\n---\n");
await writeItem("broken yaml", "---\nlocation: [unclosed\n---\n");

const baseYaml = `filters:
  and:
    - file.inFolder("Travel/Packing Data")
properties:
  location:
    displayName: Location
views:
  - type: table
    name: All Items
    groupBy:
      property: location
    order:
      - file.name
      - location
      - packed
    sort:
      - property: packed
        direction: ASC
  - type: table
    name: Still To Pack
    filters:
      and:
        - packed == false
    order:
      - file.name
`;

await fs.writeFile(
  path.join(vaultRoot, "Travel", "Packing list.md"),
  `---\ntags:\n  - Keep/Pinned\n---\n\n# Packing\n\n\`\`\`base\n${baseYaml}\`\`\`\n`,
  "utf8"
);
await fs.writeFile(path.join(vaultRoot, "Travel", "Plain note.md"), "# Nothing here\n", "utf8");
await fs.writeFile(path.join(vaultRoot, "Travel", "Packing.base"), baseYaml, "utf8");
await fs.writeFile(
  path.join(vaultRoot, "Travel", "Embed host.md"),
  "# Host\n\n![[Packing.base#Still To Pack]]\n",
  "utf8"
);

process.env.VAULT_PATH = vaultRoot;
process.env.VAULT_NAME = "";
const vault = await import("../vault.js");

// A note record shaped like collectNotes() produces, for the pure unit tests.
function note(overrides = {}) {
  return {
    path: "Travel/Packing Data/air tag.md",
    name: "air tag",
    folder: "Travel/Packing Data",
    ext: "md",
    size: 100,
    mtime: new Date("2026-01-02T03:04:05Z"),
    ctime: new Date("2026-01-01T00:00:00Z"),
    tags: ["Keep/Pinned"],
    properties: { location: "Carry On", packed: false, price: 30 },
    ...overrides,
  };
}

const ctx = { warn: () => {} };

// --- source extraction -----------------------------------------------------

test("extractBaseBlocks finds fenced base blocks and ignores other languages", () => {
  const text = "intro\n\n```base\nfilters: a\n```\n\n```js\nnot a base\n```\n\n~~~base\nfilters: b\n~~~\n";
  const blocks = extractBaseBlocks(text);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].yaml, "filters: a");
  assert.equal(blocks[1].yaml, "filters: b");
});

test("extractBaseEmbeds finds .base embeds with an optional view", () => {
  const embeds = extractBaseEmbeds("![[Packing.base]] and ![[Sub/Other.base#My View|alias]]");
  assert.deepEqual(
    embeds.map((e) => [e.target, e.view]),
    [["Packing.base", null], ["Sub/Other.base", "My View"]]
  );
});

// --- expressions -----------------------------------------------------------

test("comparison operators", () => {
  assert.equal(evalCondition('location == "Carry On"', note(), ctx), true);
  assert.equal(evalCondition('location != "Carry On"', note(), ctx), false);
  assert.equal(evalCondition("price > 10", note(), ctx), true);
  assert.equal(evalCondition("price >= 30", note(), ctx), true);
  assert.equal(evalCondition("price < 10", note(), ctx), false);
  assert.equal(evalCondition("packed == false", note(), ctx), true);
  assert.equal(evalCondition("packed == true", note(), ctx), false);
});

test("an unset property is falsy, empty, and never equal to a real value", () => {
  const bare = note({ properties: { location: "Carry On" } });
  assert.equal(evalCondition("packed == false", bare, ctx), true);
  assert.equal(evalCondition("packed == true", bare, ctx), false);
  assert.equal(evalCondition('packed == "anything"', bare, ctx), false);
  assert.equal(evalCondition("packed.isEmpty()", bare, ctx), true);
  assert.equal(evalCondition("packed.isNotEmpty()", bare, ctx), false);
  assert.equal(evalCondition("packed", bare, ctx), false);
  assert.equal(evalCondition("!packed", bare, ctx), true);
});

test("list properties match element-wise", () => {
  const multi = note({ properties: { location: ["Carry On", "Checked Baggage"] } });
  assert.equal(evalCondition('location == "Checked Baggage"', multi, ctx), true);
  assert.equal(evalCondition('location.contains("checked")', multi, ctx), true);
  assert.equal(evalCondition('location.containsAll("Carry", "Checked")', multi, ctx), true);
  assert.equal(evalCondition('location.containsAny("Nowhere", "Carry")', multi, ctx), true);
});

test("file functions and properties", () => {
  assert.equal(evalCondition('file.inFolder("Travel")', note(), ctx), true);
  assert.equal(evalCondition('file.inFolder("Travel/Packing Data")', note(), ctx), true);
  assert.equal(evalCondition('file.inFolder("Other")', note(), ctx), false);
  assert.equal(evalCondition('file.hasTag("Keep")', note(), ctx), true); // nested tag
  assert.equal(evalCondition('file.hasTag("Keep/Pinned")', note(), ctx), true);
  assert.equal(evalCondition('file.hasTag("Other")', note(), ctx), false);
  assert.equal(evalCondition('file.hasProperty("price")', note(), ctx), true);
  assert.equal(evalCondition('file.hasProperty("nope")', note(), ctx), false);
  assert.equal(evalCondition('file.name == "air tag"', note(), ctx), true);
  assert.equal(evalCondition('file.ext == "md"', note(), ctx), true);
});

test("boolean composition, in expressions and in filter trees", () => {
  assert.equal(evalCondition('packed == false && price > 10', note(), ctx), true);
  assert.equal(evalCondition('packed == true || price > 10', note(), ctx), true);
  assert.equal(evalCondition('(packed == true) || (price < 10)', note(), ctx), false);

  assert.equal(matchFilter({ and: ["packed == false", "price > 10"] }, note(), ctx), true);
  assert.equal(matchFilter({ or: ["packed == true", "price > 10"] }, note(), ctx), true);
  assert.equal(matchFilter({ not: ["packed == true"] }, note(), ctx), true);
  assert.equal(matchFilter({ not: ["packed == false"] }, note(), ctx), false);
});

test("unsupported syntax is reported, not silently dropped", () => {
  const warnings = [];
  const warnCtx = { warn: (m) => warnings.push(m) };
  assert.equal(evalCondition('date(file.mtime) > date("2020-01-01")', note(), warnCtx), false);
  assert.ok(warnings.some((w) => w.includes("not supported")));
});

// --- scope inference -------------------------------------------------------

test("inferFolderScope reads folders off unconditional and-chains only", () => {
  assert.equal(
    inferFolderScope({ and: ['file.inFolder("Travel/Packing Data")', "packed == false"] }),
    "Travel/Packing Data"
  );
  assert.equal(inferFolderScope({ or: ['file.inFolder("Travel")', "packed"] }), null);
  assert.equal(inferFolderScope("packed == false"), null);
  assert.equal(inferFolderScope(undefined), null);
});

// --- query execution -------------------------------------------------------

test("runBase filters, sorts, groups and labels columns", async () => {
  const { notes } = await vault.collectNotes("Travel/Packing Data");
  const spec = (await import("../bases.js")).parseBaseSpec(baseYaml);
  const result = runBase(spec, notes);

  assert.equal(result.matched, 5);
  const [all, todo] = result.views;

  assert.equal(all.name, "All Items");
  assert.equal(all.groupBy, "location");
  assert.equal(all.columns[0].ref, "file.path"); // always addressable
  assert.ok(all.columns.some((c) => c.label === "Location (location)")); // raw key kept

  const carryOn = all.groups.find((g) => g.key === "Carry On");
  assert.equal(carryOn.count, 3);
  assert.equal(carryOn.rows[0][1], "air tag"); // packed ASC → false first

  // packed == false, plus the two notes with no usable `packed` value
  assert.deepEqual(todo.rows.map((r) => r.at(-1)).sort(), [
    "air tag",
    "broken yaml",
    "no packed prop",
    "杯麵",
  ]);
});

test("runBase caps rows per view and reports the cap", async () => {
  const { notes } = await vault.collectNotes("Travel/Packing Data");
  const result = runBase({ views: [{ type: "table", name: "Capped", limit: 2 }] }, notes);
  assert.equal(result.views[0].rows.length, 2);
  assert.equal(result.views[0].total, 5);
  assert.equal(result.views[0].truncated, true);
});

test("formulas are flagged as unevaluated", async () => {
  const { notes } = await vault.collectNotes("Travel/Packing Data");
  const result = runBase({ formulas: { total: "price * 2" }, views: [] }, notes);
  assert.ok(result.warnings.some((w) => w.includes("formulas")));
});

// --- vault integration -----------------------------------------------------

test("collectNotes parses frontmatter and survives invalid YAML", async () => {
  const { notes, truncated } = await vault.collectNotes("Travel/Packing Data");
  assert.equal(truncated, false);
  assert.equal(notes.length, 5);
  const broken = notes.find((n) => n.name === "broken yaml");
  assert.ok(broken.error, "invalid YAML should be recorded, not thrown");
  assert.deepEqual(broken.properties, {});
});

test("read_note returns the note AND the base data in one call", async () => {
  const out = await vault.readNote("Travel/Packing list.md");
  assert.ok(out.includes("```base"), "raw note is preserved");
  assert.ok(out.includes("NOT part of the note file"), "resolved data is marked as generated");
  assert.ok(out.includes("#### All Items"));
  assert.ok(out.includes("#### Still To Pack"));
  assert.ok(out.includes("Travel/Packing Data/air tag.md"));
  assert.ok(out.includes("5 notes matched"));
});

test("read_note with resolve=false returns the file byte-for-byte", async () => {
  const raw = await vault.readNote("Travel/Packing list.md", { resolve: false });
  const onDisk = await fs.readFile(path.join(vaultRoot, "Travel", "Packing list.md"), "utf8");
  assert.equal(raw, onDisk);
});

test("a note without a base is returned unchanged", async () => {
  const out = await vault.readNote("Travel/Plain note.md");
  assert.equal(out, "# Nothing here\n");
});

test("read_note resolves ![[X.base]] embeds, honouring the view in the link", async () => {
  const out = await vault.readNote("Travel/Embed host.md");
  assert.ok(out.includes("Travel/Packing.base"));
  assert.ok(out.includes("#### Still To Pack"));
  assert.ok(!out.includes("#### All Items"), "the embed asked for one view only");
});

test("read_base runs a standalone .base file", async () => {
  const out = await vault.readBase("Travel/Packing.base");
  assert.ok(out.includes("#### All Items"));
  assert.ok(out.includes("#### Still To Pack"));

  const single = await vault.readBase("Travel/Packing.base", "All Items");
  assert.ok(!single.includes("#### Still To Pack"));

  await assert.rejects(() => vault.readBase("Travel/Packing list.md"), /\.base file/);
});

test("list_notes can include .base files", async () => {
  const withoutBases = await vault.listNotes("Travel");
  assert.ok(!withoutBases.includes("Travel/Packing.base"));
  const withBases = await vault.listNotes("Travel", { includeBases: true });
  assert.ok(withBases.includes("Travel/Packing.base"));
});

test.after(async () => {
  await fs.rm(vaultRoot, { recursive: true, force: true });
});

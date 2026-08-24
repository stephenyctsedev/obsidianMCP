// bases.js — a small evaluator for Obsidian "Bases" queries.
//
// A note that embeds a base (a ```base fenced block, or an `![[Something.base]]`
// embed) contains only the QUERY; the data it displays lives in the frontmatter
// of the notes the query selects. Reading such a note therefore returns none of
// the data a human sees in Obsidian. This module runs the query, so one
// read_note can return the note *and* the rows it renders.
//
// The Bases language is only partially implemented — deliberately. Supported:
//
//   filters      and / or / not nesting, plain-string leaves, view-level filters
//   operators    == != > >= < <= , && || , leading !
//   file props   file.name file.path file.folder file.ext file.size
//                file.mtime file.ctime file.tags
//   note props   `note.x`, bare `x`, nested `x.y`
//   functions    file.inFolder() file.hasTag() file.hasProperty()
//                .contains() .containsAny() .containsAll() .startsWith()
//                .endsWith() .isEmpty() .isNotEmpty()
//   views        table / list / cards (all rendered as a table), order, sort,
//                groupBy / group_by, limit, properties[].displayName
//
// Anything else (formulas, summaries, date arithmetic, link()/if()/date() …) is
// NOT evaluated: it is reported in a `warnings` list rather than silently
// dropped, so a caller never mistakes a partial answer for a complete one.
//
// Empty-value semantics: an unset/blank property is "empty". `empty == false`
// is TRUE (empty is falsy, matching how Obsidian treats unchecked checkboxes),
// `empty == <anything non-empty>` is false, and empty values sort last.

import { parse as parseYaml } from "yaml";

// Hard cap on rows rendered per view, so one read_note can never dump a
// 10k-note vault into the conversation. Views may set a smaller `limit`.
export const MAX_ROWS_PER_VIEW = 200;

// --- Source extraction -----------------------------------------------------

// Find ```base fenced blocks. Returns the raw YAML inside each, with the
// 1-based line number of the opening fence (used to label the results).
export function extractBaseBlocks(text) {
  const out = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const open = /^\s{0,3}(`{3,}|~{3,})\s*base\b.*$/i.exec(lines[i]);
    if (!open) continue;
    const marker = open[1][0];
    const minLen = open[1].length;
    const closeRe = new RegExp(`^\\s{0,3}\\${marker}{${minLen},}\\s*$`);
    const body = [];
    let j = i + 1;
    for (; j < lines.length && !closeRe.test(lines[j]); j++) body.push(lines[j]);
    out.push({ yaml: body.join("\n"), line: i + 1 });
    i = j;
  }
  return out;
}

// Find `![[Name.base]]` / `![[Name.base#View Name]]` embeds.
export function extractBaseEmbeds(text) {
  const out = [];
  const re = /!\[\[([^\]|#\n]+?\.base)(?:#([^\]|\n]+))?(?:\|[^\]\n]*)?\]\]/gi;
  for (const m of text.matchAll(re)) {
    out.push({ target: m[1].trim(), view: m[2] ? m[2].trim() : null, raw: m[0] });
  }
  return out;
}

export function parseBaseSpec(yamlText) {
  const spec = parseYaml(yamlText ?? "");
  if (spec === null || spec === undefined) return {};
  if (typeof spec !== "object" || Array.isArray(spec)) {
    throw new Error("base definition must be a YAML mapping");
  }
  return spec;
}

// --- Value helpers ---------------------------------------------------------

function isEmpty(v) {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return v.trim() === "";
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

function toBool(v) {
  if (isEmpty(v)) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "false" || s === "no" || s === "0") return false;
    return true;
  }
  return true;
}

function asNumber(v) {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function asTime(v) {
  if (v instanceof Date) return v.getTime();
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v.trim())) {
    const t = Date.parse(v.trim());
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

function looseEquals(a, b) {
  if (Array.isArray(a) && !Array.isArray(b)) return a.some((x) => looseEquals(x, b));
  if (Array.isArray(b) && !Array.isArray(a)) return b.some((x) => looseEquals(a, x));
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => looseEquals(x, b[i]));
  }
  if (isEmpty(a) && isEmpty(b)) return true;
  // An unset property compared against a boolean behaves like `false`, so an
  // item that never got a `packed:` value still counts as "not packed".
  if (typeof a === "boolean" || typeof b === "boolean") return toBool(a) === toBool(b);
  if (isEmpty(a) || isEmpty(b)) return false;
  const na = asNumber(a);
  const nb = asNumber(b);
  if (na !== null && nb !== null) return na === nb;
  return String(a) === String(b);
}

// Ordering used by both `>`-style operators and sort/groupBy. Returns null when
// the two values aren't comparable, so callers can fall back to string order.
function compareValues(a, b) {
  const ea = isEmpty(a);
  const eb = isEmpty(b);
  if (ea || eb) return ea && eb ? 0 : ea ? 1 : -1; // empties last
  const na = asNumber(a);
  const nb = asNumber(b);
  if (na !== null && nb !== null) return na < nb ? -1 : na > nb ? 1 : 0;
  const ta = asTime(a);
  const tb = asTime(b);
  if (ta !== null && tb !== null) return ta < tb ? -1 : ta > tb ? 1 : 0;
  if (typeof a === "boolean" || typeof b === "boolean") {
    const ba = toBool(a);
    const bb = toBool(b);
    return ba === bb ? 0 : ba ? 1 : -1;
  }
  return String(stringify(a)).localeCompare(String(stringify(b)));
}

// Flatten a value to the single-line text a table cell shows.
export function stringify(v) {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(stringify).filter((s) => s !== "").join(", ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

// --- Expression evaluation -------------------------------------------------

// Split `expr` on the first top-level occurrence of any operator in `ops`
// (ignoring anything inside quotes, parens or brackets).
function splitTopLevel(expr, ops) {
  let depth = 0;
  let quote = null;
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === "(" || ch === "[") { depth++; continue; }
    if (ch === ")" || ch === "]") { depth--; continue; }
    if (depth !== 0) continue;
    for (const op of ops) {
      if (expr.startsWith(op, i)) {
        // `>` must not swallow the `>` of `>=`, and `!` is not `!=`.
        if ((op === ">" || op === "<") && expr[i + 1] === "=") continue;
        return { left: expr.slice(0, i), op, right: expr.slice(i + op.length) };
      }
    }
  }
  return null;
}

function splitArgs(argText) {
  const args = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let i = 0; i < argText.length; i++) {
    const ch = argText[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    else if (ch === "," && depth === 0) {
      args.push(argText.slice(start, i));
      start = i + 1;
    }
  }
  if (argText.trim() !== "") args.push(argText.slice(start));
  return args.map((a) => a.trim()).filter((a) => a !== "");
}

// Is `expr` wrapped in one pair of parens that spans the whole string?
function isFullyWrapped(expr) {
  if (!expr.startsWith("(") || !expr.endsWith(")")) return false;
  let depth = 0;
  let quote = null;
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return i === expr.length - 1;
    }
  }
  return false;
}

function fileProp(note, key, ctx) {
  switch (key) {
    case "name":
    case "basename":
    case "title":
      return note.name;
    case "path":
      return note.path;
    case "folder":
    case "parent":
      return note.folder;
    case "ext":
    case "extension":
      return note.ext;
    case "size":
      return note.size;
    case "mtime":
      return note.mtime;
    case "ctime":
      return note.ctime;
    case "tags":
      return note.tags;
    default:
      ctx.warn(`file.${key} is not supported — treated as empty`);
      return undefined;
  }
}

function propValue(note, ref, ctx) {
  const parts = ref.split(".");
  if (parts[0] === "this") parts.shift();
  if (parts[0] === "file") return fileProp(note, parts.slice(1).join(".") || "path", ctx);
  if (parts[0] === "formula" || parts[0] === "formulas") {
    ctx.warn(`formulas are not evaluated (${ref}) — treated as empty`);
    return undefined;
  }
  if (parts[0] === "note" || parts[0] === "properties") parts.shift();
  let cur = note.properties;
  for (const part of parts) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    cur = cur[part];
  }
  return cur;
}

const LITERALS = new Map([
  ["true", true],
  ["false", false],
  ["null", null],
  ["none", null],
  ["empty", ""],
]);

function callMethod(target, targetExpr, method, args, note, ctx) {
  const first = args.length ? args[0] : undefined;
  switch (method) {
    case "inFolder": {
      if (targetExpr !== "file") break;
      const folder = String(first ?? "").replace(/^\/+|\/+$/g, "");
      if (folder === "") return true;
      return note.path === `${folder}/${note.path.split("/").pop()}`
        ? true
        : note.path.startsWith(`${folder}/`);
    }
    case "hasTag":
      if (targetExpr !== "file") break;
      // Nested tags count: hasTag("Keep") matches a note tagged Keep/Pinned.
      return args.some((a) => {
        const needle = String(a).replace(/^#/, "").toLowerCase();
        return (note.tags || []).some((t) => {
          const tag = String(t).toLowerCase();
          return tag === needle || tag.startsWith(`${needle}/`);
        });
      });
    case "hasProperty":
      if (targetExpr !== "file") break;
      return !isEmpty(propValue(note, String(first ?? ""), ctx));
    case "isEmpty":
    case "isNull":
      return isEmpty(target);
    case "isNotEmpty":
      return !isEmpty(target);
    case "isTruthy":
      return toBool(target);
    case "contains":
      return containsValue(target, first);
    case "containsAny":
      return args.some((a) => containsValue(target, a));
    case "containsAll":
      return args.every((a) => containsValue(target, a));
    case "startsWith":
      return stringify(target).toLowerCase().startsWith(String(first ?? "").toLowerCase());
    case "endsWith":
      return stringify(target).toLowerCase().endsWith(String(first ?? "").toLowerCase());
    case "toLowerCase":
    case "lower":
      return stringify(target).toLowerCase();
    case "toUpperCase":
    case "upper":
      return stringify(target).toUpperCase();
    default:
      break;
  }
  ctx.warn(`${targetExpr}.${method}() is not supported — treated as empty`);
  return undefined;
}

function containsValue(target, needle) {
  const n = String(needle ?? "").toLowerCase();
  if (Array.isArray(target)) {
    return target.some((x) => stringify(x).toLowerCase().includes(n));
  }
  return stringify(target).toLowerCase().includes(n);
}

// Evaluate an expression to a VALUE (literal, property, or method call).
function evalValue(expr, note, ctx) {
  const src = expr.trim();
  if (src === "") return undefined;
  if (isFullyWrapped(src)) return evalValue(src.slice(1, -1), note, ctx);

  const quoted = /^"((?:[^"\\]|\\.)*)"$|^'((?:[^'\\]|\\.)*)'$/.exec(src);
  if (quoted) return (quoted[1] ?? quoted[2]).replace(/\\(.)/g, "$1");
  if (/^-?\d+(\.\d+)?$/.test(src)) return Number(src);
  if (LITERALS.has(src.toLowerCase())) return LITERALS.get(src.toLowerCase());
  if (/^\[.*\]$/.test(src)) return splitArgs(src.slice(1, -1)).map((a) => evalValue(a, note, ctx));

  // method call: <target>.<name>( ... )  — the call must close at the very end
  const call = /^(.*?)\.?([A-Za-z_][\w]*)\s*\(([\s\S]*)\)$/.exec(src);
  if (call && isCallShaped(src)) {
    const [, targetExpr, method, argText] = call;
    const args = splitArgs(argText).map((a) => evalValue(a, note, ctx));
    if (targetExpr === "") {
      ctx.warn(`${method}() is not supported — treated as empty`);
      return undefined;
    }
    const target = targetExpr === "file" ? undefined : evalValue(targetExpr, note, ctx);
    return callMethod(target, targetExpr, method, args, note, ctx);
  }

  if (/^[A-Za-z_$][\w$]*(\.[\w$]+)*$/u.test(src) || /^[^\s()"'.]+(\.[^\s()"'.]+)*$/u.test(src)) {
    return propValue(note, src, ctx);
  }

  ctx.warn(`could not parse expression: ${src}`);
  return undefined;
}

// True when the trailing "(...)" of `src` is the argument list of a call that
// starts at the top level (rules out `a == (b)` reaching the call branch).
function isCallShaped(src) {
  if (!src.endsWith(")")) return false;
  const open = src.indexOf("(");
  if (open <= 0) return false;
  return /^[^\s"'()]+$/u.test(src.slice(0, open));
}

// Evaluate an expression to a BOOLEAN (a filter leaf).
export function evalCondition(expr, note, ctx) {
  let src = String(expr ?? "").trim();
  if (src === "") return true;
  if (isFullyWrapped(src)) return evalCondition(src.slice(1, -1), note, ctx);

  const or = splitTopLevel(src, ["||"]);
  if (or) return evalCondition(or.left, note, ctx) || evalCondition(or.right, note, ctx);
  const and = splitTopLevel(src, ["&&"]);
  if (and) return evalCondition(and.left, note, ctx) && evalCondition(and.right, note, ctx);

  const cmp = splitTopLevel(src, ["==", "!=", ">=", "<=", ">", "<"]);
  if (cmp) {
    const left = evalValue(cmp.left, note, ctx);
    const right = evalValue(cmp.right, note, ctx);
    switch (cmp.op) {
      case "==":
        return looseEquals(left, right);
      case "!=":
        return !looseEquals(left, right);
      default: {
        const c = compareValues(left, right);
        if (isEmpty(left) || isEmpty(right)) return false;
        return cmp.op === ">" ? c > 0 : cmp.op === ">=" ? c >= 0 : cmp.op === "<" ? c < 0 : c <= 0;
      }
    }
  }

  if (src.startsWith("!") && !src.startsWith("!=")) {
    return !evalCondition(src.slice(1), note, ctx);
  }
  return toBool(evalValue(src, note, ctx));
}

// Evaluate a `filters:` tree (string leaf, list, or and/or/not mapping).
export function matchFilter(filter, note, ctx) {
  if (filter === null || filter === undefined) return true;
  if (typeof filter === "boolean") return filter;
  if (typeof filter === "string") return evalCondition(filter, note, ctx);
  if (Array.isArray(filter)) return filter.every((f) => matchFilter(f, note, ctx));
  if (typeof filter === "object") {
    const keys = Object.keys(filter);
    let ok = true;
    for (const key of keys) {
      const branch = Array.isArray(filter[key]) ? filter[key] : [filter[key]];
      if (key === "and") ok = ok && branch.every((f) => matchFilter(f, note, ctx));
      else if (key === "or") ok = ok && branch.some((f) => matchFilter(f, note, ctx));
      else if (key === "not") ok = ok && !branch.some((f) => matchFilter(f, note, ctx));
      else {
        ctx.warn(`unknown filter key "${key}" — ignored`);
      }
    }
    return ok;
  }
  return true;
}

// --- Scope inference -------------------------------------------------------

// Folder every matching note must live in, read off `file.inFolder("…")` leaves
// that sit in an unconditional `and` chain. Used to avoid walking the whole
// vault; it can only ever narrow the scan, never change which rows match.
export function inferFolderScope(filter) {
  const found = [];
  const visit = (f) => {
    if (typeof f === "string") {
      const m = /^\s*file\.inFolder\(\s*["']([^"']*)["']\s*\)\s*$/.exec(f);
      if (m) found.push(m[1].replace(/^\/+|\/+$/g, ""));
      return;
    }
    if (Array.isArray(f)) { f.forEach(visit); return; }
    if (f && typeof f === "object" && Array.isArray(f.and)) f.and.forEach(visit);
    else if (f && typeof f === "object" && f.and) visit(f.and);
  };
  visit(filter);
  if (!found.length) return null;
  // Deepest folder wins — an `and` of two folders can only match the nested one.
  return found.sort((a, b) => b.split("/").length - a.split("/").length)[0];
}

// --- Query execution -------------------------------------------------------

function normalizeRef(ref) {
  const s = String(ref).trim();
  return s.startsWith("note.") ? s.slice(5) : s;
}

function viewColumns(view, spec, rows, ctx) {
  const declared = view.order || view.columns || view.properties;
  let refs;
  if (Array.isArray(declared) && declared.length) {
    refs = declared.map(normalizeRef);
  } else {
    const seen = new Set();
    for (const key of Object.keys(spec.properties || {})) seen.add(normalizeRef(key));
    for (const row of rows) for (const key of Object.keys(row.properties || {})) seen.add(key);
    refs = [...seen];
  }
  // Always expose the note's path so a caller can act on a row it sees.
  if (!refs.includes("file.path")) refs = ["file.path", ...refs];
  return refs.map((ref) => {
    const meta = (spec.properties || {})[ref] || (spec.properties || {})[`note.${ref}`];
    if (ref.startsWith("formula.")) ctx.warn(`column ${ref} is a formula — not evaluated`);
    // The header keeps the raw property key even when the base renames it, so a
    // caller that acts on a row (update_frontmatter …) uses the real key.
    const display = meta && meta.displayName ? String(meta.displayName) : null;
    return { ref, label: display && display !== ref ? `${display} (${ref})` : ref };
  });
}

function sortRows(rows, sortSpec, ctx) {
  const rules = (Array.isArray(sortSpec) ? sortSpec : sortSpec ? [sortSpec] : [])
    .map((s) =>
      typeof s === "string"
        ? { ref: normalizeRef(s), desc: false }
        : { ref: normalizeRef(s.property || s.column || s.ref || ""), desc: /desc/i.test(String(s.direction || "")) }
    )
    .filter((r) => r.ref !== "");
  if (!rules.length) return rows;
  return [...rows].sort((a, b) => {
    for (const rule of rules) {
      const c = compareValues(propValue(a, rule.ref, ctx), propValue(b, rule.ref, ctx));
      if (c !== 0) return rule.desc ? -c : c;
    }
    return 0;
  });
}

// Run one base spec over `notes`. Returns one result per view.
export function runBase(spec, notes, { rowLimit = MAX_ROWS_PER_VIEW } = {}) {
  const warnings = new Set();
  const ctx = { warn: (msg) => warnings.add(msg) };

  if (spec.formulas) ctx.warn("formulas: defined in this base are not evaluated");
  if (spec.summaries) ctx.warn("summaries: defined in this base are not computed");

  const base = notes.filter((n) => matchFilter(spec.filters, n, ctx));

  const rawViews = Array.isArray(spec.views) && spec.views.length
    ? spec.views
    : [{ type: "table", name: "All" }];

  const views = rawViews.map((view, idx) => {
    const rows = base.filter((n) => matchFilter(view.filters, n, ctx));
    const groupRef = view.groupBy || view.group_by || null;
    const groupProp = groupRef
      ? normalizeRef(typeof groupRef === "string" ? groupRef : groupRef.property || "")
      : null;
    const groupDesc = groupRef && typeof groupRef === "object" && /desc/i.test(String(groupRef.direction || ""));

    let ordered = sortRows(rows, view.sort, ctx);
    const limit = Math.min(
      Number.isFinite(view.limit) && view.limit > 0 ? Math.floor(view.limit) : rowLimit,
      rowLimit
    );
    const total = ordered.length;
    const truncated = total > limit;
    ordered = ordered.slice(0, limit);

    const columns = viewColumns(view, spec, ordered, ctx);
    const render = (note) =>
      columns.map((c) => stringify(propValue(note, c.ref, ctx)));

    let groups = null;
    if (groupProp) {
      const byKey = new Map();
      for (const note of ordered) {
        const raw = propValue(note, groupProp, ctx);
        const values = Array.isArray(raw) && raw.length ? raw : [raw];
        for (const value of values) {
          const key = stringify(value) || "(empty)";
          if (!byKey.has(key)) byKey.set(key, { key, value, notes: [] });
          byKey.get(key).notes.push(note);
        }
      }
      groups = [...byKey.values()].sort((a, b) => {
        const c = compareValues(a.value, b.value);
        return groupDesc ? -c : c;
      });
      groups = groups.map((g) => ({ key: g.key, rows: g.notes.map(render), count: g.notes.length }));
    }

    return {
      name: view.name || `View ${idx + 1}`,
      type: view.type || "table",
      groupBy: groupProp,
      columns,
      rows: ordered.map(render),
      groups,
      total,
      truncated,
      limit,
    };
  });

  return { views, matched: base.length, warnings: [...warnings] };
}

// --- Rendering -------------------------------------------------------------

function cell(text) {
  return String(text).replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

function table(columns, rows) {
  const header = `| ${columns.map((c) => cell(c.label)).join(" | ")} |`;
  const divider = `| ${columns.map(() => "---").join(" | ")} |`;
  const body = rows.map((r) => `| ${r.map(cell).join(" | ")} |`);
  return [header, divider, ...body].join("\n");
}

// Render a runBase() result as markdown.
export function renderBaseResult(result, { source, scanned, scope, viewFilter } = {}) {
  const out = [];
  const scopeText = scope ? `scope: ${scope}/` : "scope: whole vault";
  out.push(
    `### Base data — ${source || "base"}\n` +
      `${result.matched} note${result.matched === 1 ? "" : "s"} matched ` +
      `(${scanned} scanned, ${scopeText})`
  );

  const views = viewFilter
    ? result.views.filter((v) => v.name.toLowerCase() === viewFilter.toLowerCase())
    : result.views;
  if (viewFilter && !views.length) {
    out.push(
      `(no view named "${viewFilter}" — available: ${result.views.map((v) => v.name).join(", ") || "none"})`
    );
  }

  for (const view of views) {
    const bits = [view.type];
    if (view.groupBy) bits.push(`grouped by ${view.groupBy}`);
    bits.push(
      view.truncated
        ? `showing ${view.rows.length} of ${view.total} rows`
        : `${view.total} row${view.total === 1 ? "" : "s"}`
    );
    out.push(`#### ${view.name} (${bits.join(", ")})`);
    if (!view.rows.length) {
      out.push("(no matching notes)");
      continue;
    }
    if (view.groups) {
      for (const group of view.groups) {
        out.push(`**${group.key}** — ${group.count}`);
        out.push(table(view.columns, group.rows));
      }
    } else {
      out.push(table(view.columns, view.rows));
    }
  }

  if (result.warnings.length) {
    out.push(
      `> Not evaluated (results may be incomplete):\n` +
        result.warnings.map((w) => `> - ${w}`).join("\n")
    );
  }
  return out.join("\n\n");
}

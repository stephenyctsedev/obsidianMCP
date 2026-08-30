// server.js — Streamable HTTP MCP server exposing Obsidian vault tools.
//
//   POST /mcp     MCP Streamable HTTP endpoint (OAuth 2.1 bearer-token protected)
//   GET  /health  Unauthenticated health check for DSM / uptime monitoring
//
// Authorization is a minimal single-user OAuth 2.1 server (see oauth.js):
// dynamic client registration, authorization code + PKCE, refresh tokens —
// the same flow claude.ai's custom-connector UI speaks natively. A static
// `Authorization: Bearer <MCP_AUTH_TOKEN>` header still works too, for
// non-interactive clients like Claude Code.
//
// Every tool call is written to an append-only audit log (metadata only,
// never note content).

import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";

import {
  listNotes,
  readNote,
  readBase,
  writeNote,
  appendNote,
  replaceText,
  deleteNote,
  moveNote,
  searchNotes,
  recentChanges,
  getFrontmatter,
  updateFrontmatter,
  listTrash,
  undeleteNote,
  vaultRoot,
} from "./vault.js";
import {
  initGitRepo,
  startSnapshotTimer,
  commitPath,
  commitPaths,
  noteHistory,
  showNoteAtRef,
  noteDiff,
} from "./git.js";
import { createOAuthProvider } from "./oauth.js";

const PORT = parseInt(process.env.PORT || "8787", 10);
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || "";
const AUDIT_LOG_PATH = process.env.AUDIT_LOG_PATH || "/data/audit.log";
const OAUTH_STORE_PATH = process.env.OAUTH_STORE_PATH || "/data/oauth-store.json";
const PUBLIC_URL = process.env.PUBLIC_URL || "";

if (!AUTH_TOKEN) {
  console.error("FATAL: MCP_AUTH_TOKEN is not set. Refusing to start.");
  process.exit(1);
}
if (!PUBLIC_URL) {
  console.error(
    "FATAL: PUBLIC_URL is not set (e.g. https://obsidianmcp.your-domain.example.com). " +
      "It's required as the OAuth issuer/resource URL. Refusing to start."
  );
  process.exit(1);
}

const issuerUrl = new URL(PUBLIC_URL);
const resourceServerUrl = new URL("/mcp", PUBLIC_URL);
const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resourceServerUrl);

const oauthProvider = createOAuthProvider({
  storePath: OAUTH_STORE_PATH,
  loginPassword: AUTH_TOKEN,
  legacyToken: AUTH_TOKEN,
});

// --- Audit log -------------------------------------------------------------

async function audit({ tool, notePath, toPath, status, error }) {
  const line =
    JSON.stringify({
      ts: new Date().toISOString(),
      tool,
      path: notePath ?? null,
      ...(toPath ? { to: toPath } : {}), // destination for move_note / undelete_note
      status, // "success" | "failure"
      ...(error ? { error: String(error).slice(0, 300) } : {}),
    }) + "\n";
  try {
    await fs.mkdir(path.dirname(AUDIT_LOG_PATH), { recursive: true });
    await fs.appendFile(AUDIT_LOG_PATH, line, "utf8");
  } catch (err) {
    // Never let audit failures break a tool call — surface to stderr instead.
    console.error("audit log write failed:", err.message);
  }
}

// Wrap a tool handler: run it, audit success/failure, and format the MCP reply.
// The audit line's `path` is the call's most identifying argument: an explicit
// note path first, then the search query, then a move source, then a folder
// scope — so a folder-scoped search still records what was searched for. Blank
// strings are skipped (`??` alone would keep folder: ""). `to` is logged as its
// own field when present so moves/restores record their destination too.
function withAudit(tool, run) {
  return async (args) => {
    const notePath =
      [args?.path, args?.query, args?.from, args?.folder].find(
        (v) => typeof v === "string" && v.trim() !== ""
      ) ?? null;
    const toPath = typeof args?.to === "string" && args.to.trim() !== "" ? args.to : null;
    try {
      const text = await run(args);
      await audit({ tool, notePath, toPath, status: "success" });
      return { content: [{ type: "text", text }] };
    } catch (err) {
      await audit({ tool, notePath, toPath, status: "failure", error: err.message });
      return {
        isError: true,
        content: [{ type: "text", text: `Error: ${err.message}` }],
      };
    }
  };
}

// --- MCP server definition -------------------------------------------------

function buildMcpServer() {
  const server = new McpServer({ name: "obsidian-mcp", version: "1.0.0" });

  server.registerTool(
    "list_notes",
    {
      title: "List notes",
      description:
        "List markdown (.md) files in the vault as relative vault paths. The listing is capped (default 200, max 1000) and reports the total, so on a large vault narrow it instead of paging blindly: `folder` scopes to a subtree, `pattern` filters by filename glob, and `depth` gives an `ls`-style view that collapses deeper subtrees into folders with note counts (start with depth=1 to see the vault's shape). To find notes BY CONTENT use search_notes, and for the latest edits use recent_changes — neither needs a full listing first. Set include_bases to also list Obsidian Bases (.base) files, which read_base can run.",
      inputSchema: {
        folder: z
          .string()
          .optional()
          .describe("Optional subfolder (relative vault path) to list within."),
        include_bases: z
          .boolean()
          .optional()
          .describe("Also list .base (Obsidian Bases) files. Default false."),
        pattern: z
          .string()
          .optional()
          .describe(
            'Glob filter: "*" matches within a path segment, "**" across segments, "?" one character. A pattern without "/" matches the file name (e.g. "2026-*.md"); one with "/" matches the path below `folder` (e.g. "Travel/**/*.md"). Case-insensitive.'
          ),
        depth: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Show only this many levels below the listed folder; anything deeper is collapsed into a folder entry with its note count. Omit to list every note recursively."
          ),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Max entries to return (default 200, max 1000)."),
        offset: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("Skip this many entries — page through a listing larger than `limit`."),
      },
    },
    withAudit("list_notes", async ({ folder, include_bases, pattern, depth, limit, offset }) => {
      const result = await listNotes(folder, {
        includeBases: include_bases === true,
        pattern,
        depth,
        limit,
        offset,
      });
      if (!result.total) {
        const where = folder && folder.trim() !== "" ? ` in ${folder}` : "";
        return pattern
          ? `(no notes matching "${pattern}"${where})`
          : `(no markdown notes found${where})`;
      }
      let text = result.entries
        .map((e) =>
          e.type === "folder"
            ? `${e.path}/  (${e.count} ${e.count === 1 ? "note" : "notes"})`
            : e.path
        )
        .join("\n");
      const to = result.offset + result.entries.length;
      if (result.truncated || result.offset > 0) {
        text += `\n\n(showing ${result.offset + 1}-${to} of ${result.total}`;
        text += result.truncated
          ? ` — pass offset=${to} for more, or narrow with folder/pattern, or pass depth=1 for a folder overview)`
          : ")";
      }
      return text;
    })
  );

  server.registerTool(
    "read_note",
    {
      title: "Read note",
      description:
        "Return the full content of a note by its relative vault path. If the note embeds an Obsidian Base (a ```base block or an ![[X.base]] embed), the DATA that base renders — the frontmatter of the notes it selects, filtered, sorted and grouped as its views define — is appended after the note text, so one call returns everything the note shows in Obsidian instead of just the query. The appended section is marked and is NOT part of the file: pass resolve=false to get the file exactly as stored (do that before editing a note).",
      inputSchema: {
        path: z.string().describe("Relative vault path to the .md note."),
        resolve: z
          .boolean()
          .optional()
          .describe(
            "Resolve embedded base queries into their data. Default true; set false for the raw file."
          ),
      },
    },
    withAudit("read_note", async ({ path: p, resolve }) => await readNote(p, { resolve: resolve !== false }))
  );

  server.registerTool(
    "read_base",
    {
      title: "Read base",
      description:
        "Run a standalone Obsidian Bases file (.base) and return its definition plus the data it renders: one table per view, with the notes it selects and their properties. Use list_notes with include_bases to find .base files.",
      inputSchema: {
        path: z.string().describe("Relative vault path to the .base file."),
        view: z
          .string()
          .optional()
          .describe("Optional view name to render on its own (default: every view)."),
      },
    },
    withAudit("read_base", async ({ path: p, view }) => await readBase(p, view))
  );

  server.registerTool(
    "write_note",
    {
      title: "Write note",
      description:
        "Create or overwrite a note at the given relative vault path. Parent folders are created automatically.",
      inputSchema: {
        path: z.string().describe("Relative vault path to the .md note."),
        content: z.string().describe("Full markdown content to write."),
      },
    },
    withAudit("write_note", async ({ path: p, content }) => {
      const written = await writeNote(p, content);
      await commitPath(written, "write_note");
      return `Wrote ${content.length} chars to ${written}`;
    })
  );

  server.registerTool(
    "append_note",
    {
      title: "Append to note",
      description:
        "Append content to an existing note without overwriting it. Fails if the note does not exist.",
      inputSchema: {
        path: z.string().describe("Relative vault path to an existing .md note."),
        content: z.string().describe("Markdown content to append."),
      },
    },
    withAudit("append_note", async ({ path: p, content }) => {
      const appended = await appendNote(p, content);
      await commitPath(appended, "append_note");
      return `Appended ${content.length} chars to ${appended}`;
    })
  );

  server.registerTool(
    "replace_text",
    {
      title: "Replace text in note",
      description:
        "Find-and-replace literal text within an existing note. By default old_text must occur exactly once (0 matches or an ambiguous match errors out — supply more surrounding context); set replace_all to swap every occurrence. Matching is literal, not regex. Fails if the note does not exist.",
      inputSchema: {
        path: z.string().describe("Relative vault path to an existing .md note."),
        old_text: z
          .string()
          .describe("Exact text to find. Include enough context to match a single spot."),
        new_text: z.string().describe("Text to replace it with (may be empty to delete)."),
        replace_all: z
          .boolean()
          .optional()
          .describe("Replace every occurrence instead of requiring a unique match (default false)."),
      },
    },
    withAudit("replace_text", async ({ path: p, old_text, new_text, replace_all }) => {
      const { relPath, count } = await replaceText(p, old_text, new_text, replace_all ?? false);
      await commitPath(relPath, "replace_text");
      return `Replaced ${count} occurrence${count === 1 ? "" : "s"} in ${relPath}`;
    })
  );

  server.registerTool(
    "delete_note",
    {
      title: "Delete note",
      description:
        "Delete a note by moving it to the vault's .trash/ folder (recoverable, not a hard delete). Fails if the note does not exist.",
      inputSchema: {
        path: z.string().describe("Relative vault path to the .md note to delete."),
      },
    },
    withAudit("delete_note", async ({ path: p }) => {
      const trashed = await deleteNote(p);
      await commitPath(p, "delete_note");
      return `Moved ${p} to ${trashed}`;
    })
  );

  server.registerTool(
    "move_note",
    {
      title: "Move / rename note",
      description:
        "Move or rename a note within the vault. Fails if the source does not exist or the destination already exists. Parent folders of the destination are created automatically. Note: links in other notes pointing at the old path are NOT rewritten.",
      inputSchema: {
        from: z.string().describe("Relative vault path of the existing .md note."),
        to: z.string().describe("New relative vault path for the note."),
      },
    },
    withAudit("move_note", async ({ from, to }) => {
      const result = await moveNote(from, to);
      await commitPaths([result.from, result.to], "move_note");
      return `Moved ${result.from} -> ${result.to}`;
    })
  );

  server.registerTool(
    "list_trash",
    {
      title: "List trashed notes",
      description:
        "List notes currently in the vault's .trash/ folder (where delete_note moves them), newest first, with each note's original path and deletion time. Returns up to `limit` entries (default 20, max 100) and reports the total, so page back through older deletions with `offset`. Use undelete_note to restore one.",
      inputSchema: {
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Max entries to return (default 20, max 100)."),
        offset: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("Skip this many entries — page through a trash larger than `limit`."),
      },
    },
    withAudit("list_trash", async ({ limit, offset }) => {
      const result = await listTrash({ limit, offset });
      if (result.total === 0) {
        return "(trash is empty)";
      }
      let text = result.entries
        .map((entry) => `${entry.path}\n  original: ${entry.original}  trashed: ${entry.trashedAt ?? "unknown"}`)
        .join("\n\n");
      const to = result.offset + result.entries.length;
      if (result.truncated || result.offset > 0) {
        text += `\n\n(showing ${result.offset + 1}-${to} of ${result.total}`;
        text += result.truncated ? ` — pass offset=${to} for older deletions)` : ")";
      }
      return text;
    })
  );

  server.registerTool(
    "undelete_note",
    {
      title: "Restore note from trash",
      description:
        "Move a note out of .trash/ back into the vault. By default it returns to its original path (the .trash timestamp suffix is stripped); pass `to` to restore it somewhere else. Fails if the destination already exists.",
      inputSchema: {
        path: z.string().describe("Trash path of the note (starts with .trash/), as returned by list_trash."),
        to: z
          .string()
          .optional()
          .describe("Optional different destination (relative vault path)."),
      },
    },
    withAudit("undelete_note", async ({ path: p, to }) => {
      const result = await undeleteNote(p, to);
      await commitPath(result.to, "undelete_note");
      return `Restored ${result.from} -> ${result.to}`;
    })
  );

  server.registerTool(
    "search_notes",
    {
      title: "Search notes",
      description:
        "Case-insensitive substring search across .md files, optionally within a subfolder. Returns up to `limit` matching files (default 20), each with a match count and up to 3 snippets.",
      inputSchema: {
        query: z.string().describe("Text to search for."),
        folder: z
          .string()
          .optional()
          .describe("Optional subfolder (relative vault path) to search within."),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Max matching files to return (default 20, max 100)."),
      },
    },
    withAudit("search_notes", async ({ query, folder, limit }) => {
      const { hits, truncated } = await searchNotes(query, folder, limit ?? 20);
      if (!hits.length) {
        if (folder && folder.trim() !== "") {
          return `No matches for "${query}" in ${folder}.`;
        }
        return `No matches for "${query}".`;
      }
      let text = hits
        .map((h) => {
          const matchText = h.matchCount === 1 ? "match" : "matches";
          const snippetLines = h.snippets.map((s) => `  ${s}`).join("\n");
          return `${h.path}  (${h.matchCount} ${matchText})\n${snippetLines}`;
        })
        .join("\n\n");
      if (truncated) {
        text += `\n\n(capped at ${hits.length} files — more matching files exist; raise limit or narrow with folder)`;
      }
      return text;
    })
  );

  server.registerTool(
    "recent_changes",
    {
      title: "Recently changed notes",
      description:
        "List the most recently modified notes, newest first, based on filesystem modification time (so edits synced from other devices count too). Optionally restrict to a subfolder.",
      inputSchema: {
        folder: z
          .string()
          .optional()
          .describe("Optional subfolder (relative vault path) to look within."),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Max notes to return (default 20, max 100)."),
      },
    },
    withAudit("recent_changes", async ({ folder, limit }) => {
      const results = await recentChanges(folder, limit ?? 20);
      if (!results.length) return "(no markdown notes found)";
      return results.map((r) => `${r.mtime}  ${r.path}`).join("\n");
    })
  );

  server.registerTool(
    "get_frontmatter",
    {
      title: "Get frontmatter",
      description:
        "Return a note's parsed YAML frontmatter as JSON, or null if the note has no frontmatter block.",
      inputSchema: {
        path: z.string().describe("Relative vault path to the .md note."),
      },
    },
    withAudit("get_frontmatter", async ({ path: p }) => {
      const fm = await getFrontmatter(p);
      return JSON.stringify(fm, null, 2);
    })
  );

  server.registerTool(
    "update_frontmatter",
    {
      title: "Update frontmatter",
      description:
        "Set or remove a single top-level key in a note's YAML frontmatter. Pass value as a JSON value to set it, or null to remove the key. Creates the frontmatter block if missing; removes it when the last key is removed. The note body is left untouched, but YAML formatting/comments inside the frontmatter are normalized.",
      inputSchema: {
        path: z.string().describe("Relative vault path to the .md note."),
        key: z.string().describe("Top-level frontmatter key to set or remove."),
        value: z
          .union([
            z.string(),
            z.number(),
            z.boolean(),
            z.array(z.any()),
            z.record(z.any()),
            z.null(),
          ])
          .describe("New value (JSON). Pass null to remove the key."),
      },
    },
    withAudit("update_frontmatter", async ({ path: p, key, value }) => {
      const { relPath, action } = await updateFrontmatter(p, key, value);
      await commitPath(relPath, "update_frontmatter");
      return `${action === "removed" ? "Removed" : "Set"} frontmatter key "${key}" in ${relPath}`;
    })
  );

  server.registerTool(
    "note_history",
    {
      title: "Note history",
      description:
        "List the git version history for a single note, newest first. Returns each version's commit hash, timestamp, and action. Requires git versioning to be enabled on the server. Use the returned hash with restore_note to roll back.",
      inputSchema: {
        path: z.string().describe("Relative vault path to the .md note."),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Max number of versions to return (default 10, max 100)."),
      },
    },
    withAudit("note_history", async ({ path: p, limit }) => {
      const history = await noteHistory(p, limit ?? 10);
      if (!history.length) return `No version history found for ${p}.`;
      return history
        .map((h) => `${h.shortHash}  ${h.date}  ${h.subject}`)
        .join("\n");
    })
  );

  server.registerTool(
    "note_diff",
    {
      title: "Diff note version",
      description:
        "Show what changed to a note as a unified diff, with a stat summary. With only `ref`, shows what that single commit (hash from note_history) changed. Set `against` to another commit hash to compare two versions, or to \"now\" to compare that version against the current note. `ref` is always the older/base side. Large diffs are truncated. Requires git versioning to be enabled on the server.",
      inputSchema: {
        path: z.string().describe("Relative vault path to the .md note."),
        ref: z
          .string()
          .describe("Base commit hash to diff from (from note_history)."),
        against: z
          .string()
          .optional()
          .describe(
            'What to diff against: omit to see only what `ref` itself changed; another commit hash to compare two versions; or "now" to compare `ref` against the current note.'
          ),
      },
    },
    withAudit("note_diff", async ({ path: p, ref, against }) => {
      return await noteDiff(p, ref, against);
    })
  );

  server.registerTool(
    "restore_note",
    {
      title: "Restore note version",
      description:
        "Restore a note to an earlier version from git history. Fetches the note's content as it existed at the given commit hash (from note_history) and writes it back as a NEW version — the intervening history is preserved, never discarded. Requires git versioning to be enabled on the server.",
      inputSchema: {
        path: z.string().describe("Relative vault path to the .md note to restore."),
        ref: z
          .string()
          .describe("Commit hash of the version to restore (from note_history)."),
      },
    },
    withAudit("restore_note", async ({ path: p, ref }) => {
      const content = await showNoteAtRef(p, ref); // validates path + ref, no mutation
      const written = await writeNote(p, content); // validates again, then overwrites
      await commitPath(written, `restore_note (from ${ref.slice(0, 8)})`);
      return `Restored ${written} to its version at ${ref.slice(0, 8)} (${content.length} chars).`;
    })
  );

  return server;
}

// --- HTTP app --------------------------------------------------------------

const app = express();

// Behind the DSM reverse proxy (single trusted hop) — needed for correct
// client IPs (X-Forwarded-For) in the OAuth endpoints' rate limiting.
app.set("trust proxy", 1);

// OAuth 2.1 authorization server + protected-resource metadata. Installs
// /authorize, /token, /register, /revoke, and the /.well-known discovery
// endpoints. Must be mounted at the app root — see oauth.js.
app.use(
  mcpAuthRouter({
    provider: oauthProvider,
    issuerUrl,
    resourceServerUrl,
    resourceName: "Obsidian Vault",
    scopesSupported: ["mcp"],
  })
);

app.use(express.json({ limit: "8mb" }));

// Health check — intentionally unauthenticated.
app.get("/health", (_req, res) => {
  res.json({ status: "ok", vault: vaultRoot });
});

// Bearer-token auth for the MCP endpoint: accepts either an OAuth access
// token issued via the /authorize + /token flow, or the static
// MCP_AUTH_TOKEN as a legacy long-lived token (see oauth.js verifyAccessToken).
const requireAuth = requireBearerAuth({ verifier: oauthProvider, resourceMetadataUrl });

// Stateless Streamable HTTP: a fresh server + transport per request.
app.post("/mcp", requireAuth, async (req, res) => {
  const server = buildMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request error:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// Stateless mode does not support server-initiated streams or session deletion.
const methodNotAllowed = (_req, res) =>
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed." },
    id: null,
  });
app.get("/mcp", requireAuth, methodNotAllowed);
app.delete("/mcp", requireAuth, methodNotAllowed);

await initGitRepo();
startSnapshotTimer();

createServer(app).listen(PORT, () => {
  console.log(`obsidian-mcp listening on :${PORT}`);
  console.log(`vault root: ${vaultRoot}`);
  console.log(`audit log:  ${AUDIT_LOG_PATH}`);
});

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
  writeNote,
  appendNote,
  replaceText,
  deleteNote,
  moveNote,
  searchNotes,
  getFrontmatter,
  updateFrontmatter,
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

async function audit({ tool, notePath, status, error }) {
  const line =
    JSON.stringify({
      ts: new Date().toISOString(),
      tool,
      path: notePath ?? null,
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
function withAudit(tool, run) {
  return async (args) => {
    const notePath = args?.path ?? args?.folder ?? args?.query ?? args?.from ?? null;
    try {
      const text = await run(args);
      await audit({ tool, notePath, status: "success" });
      return { content: [{ type: "text", text }] };
    } catch (err) {
      await audit({ tool, notePath, status: "failure", error: err.message });
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
        "List markdown (.md) files in the vault, optionally filtered to a subfolder. Returns relative vault paths.",
      inputSchema: {
        folder: z
          .string()
          .optional()
          .describe("Optional subfolder (relative vault path) to list within."),
      },
    },
    withAudit("list_notes", async ({ folder }) => {
      const files = await listNotes(folder);
      return files.length ? files.join("\n") : "(no markdown notes found)";
    })
  );

  server.registerTool(
    "read_note",
    {
      title: "Read note",
      description: "Return the full content of a note by its relative vault path.",
      inputSchema: {
        path: z.string().describe("Relative vault path to the .md note."),
      },
    },
    withAudit("read_note", async ({ path: p }) => await readNote(p))
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
    "search_notes",
    {
      title: "Search notes",
      description:
        "Case-insensitive substring search across all .md files. Returns matching file paths with a short snippet.",
      inputSchema: {
        query: z.string().describe("Text to search for."),
      },
    },
    withAudit("search_notes", async ({ query }) => {
      const hits = await searchNotes(query);
      if (!hits.length) return `No matches for "${query}".`;
      return hits.map((h) => `${h.path}\n  ${h.snippet}`).join("\n\n");
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

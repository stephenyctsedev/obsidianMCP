// server.js — Streamable HTTP MCP server exposing Obsidian vault tools.
//
//   POST /mcp     MCP Streamable HTTP endpoint (Bearer-token protected)
//   GET  /health  Unauthenticated health check for DSM / uptime monitoring
//
// Every tool call is written to an append-only audit log (metadata only,
// never note content).

import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import {
  listNotes,
  readNote,
  writeNote,
  appendNote,
  searchNotes,
  vaultRoot,
} from "./vault.js";

const PORT = parseInt(process.env.PORT || "8787", 10);
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || "";
const AUDIT_LOG_PATH = process.env.AUDIT_LOG_PATH || "/data/audit.log";

if (!AUTH_TOKEN) {
  console.error("FATAL: MCP_AUTH_TOKEN is not set. Refusing to start.");
  process.exit(1);
}

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
    const notePath = args?.path ?? args?.folder ?? args?.query ?? null;
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
      return `Appended ${content.length} chars to ${appended}`;
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

  return server;
}

// --- HTTP app --------------------------------------------------------------

const app = express();
app.use(express.json({ limit: "8mb" }));

// Health check — intentionally unauthenticated.
app.get("/health", (_req, res) => {
  res.json({ status: "ok", vault: vaultRoot });
});

// Bearer-token auth for the MCP endpoint (constant-time comparison).
// Accepts the token either in the Authorization header (preferred) or as a
// ?token= query parameter — the query form is for clients like the claude.ai
// custom-connector UI, which has no field for a custom header.
function requireAuth(req, res, next) {
  const header = req.get("authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  const queryToken = typeof req.query.token === "string" ? req.query.token : "";
  const provided = (match ? match[1] : "") || queryToken;
  const a = Buffer.from(provided);
  const b = Buffer.from(AUTH_TOKEN);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) {
    return res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized" },
      id: null,
    });
  }
  next();
}

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

createServer(app).listen(PORT, () => {
  console.log(`obsidian-mcp listening on :${PORT}`);
  console.log(`vault root: ${vaultRoot}`);
  console.log(`audit log:  ${AUDIT_LOG_PATH}`);
});

# obsidian-mcp

A lightweight remote **MCP server** for reading and writing markdown notes in an
Obsidian vault — no Obsidian app required. It talks **Streamable HTTP** so it can
run on the NAS and be reached over the internet as a Claude custom connector.

## Tools

| Tool | Signature | Behavior |
|------|-----------|----------|
| `list_notes` | `(folder?)` | List `.md` files, optionally within a subfolder. |
| `read_note` | `(path)` | Return the full content of a note. |
| `write_note` | `(path, content)` | Create or overwrite a note (parent folders auto-created). |
| `append_note` | `(path, content)` | Append to an **existing** note (fails if missing). |
| `search_notes` | `(query)` | Case-insensitive substring search; returns paths + snippets. |

Any path or folder whose name starts with `.` (e.g. `.obsidian`, `.trash`) is
refused — those internals are never listed, read, written, or searched.
Paths are also confined to the vault root (no `../` escapes), and only `.md`
files are accepted.

## Endpoints

- `POST /mcp` — MCP Streamable HTTP endpoint. **Requires** `Authorization: Bearer <MCP_AUTH_TOKEN>`; anything else gets `401`.
- `GET /health` — unauthenticated, returns `{"status":"ok", ...}`.

**Internal port: `8787`.**

## Security

- **Bearer token** via `MCP_AUTH_TOKEN` (env only — never hardcoded, never committed). Missing/mismatched header → `401`. Comparison is constant-time.
- **Audit log** at `/data/audit.log` (bind-mounted, survives restarts). One JSON line per tool call: `ts, tool, path, status(success|failure), error?`. **Note content is never logged** — metadata only.

## Setup & run (on the NAS)

```bash
# 1. Create your secrets file
cp .env.example .env

# 2. Generate a token and put it in .env as MCP_AUTH_TOKEN
openssl rand -hex 32

# 3. Confirm your Synology uid/gid own the vault, and set PUID/PGID in .env
id stephenyctse        # -> uid=PUID gid=PGID

# 4. Build and start
docker-compose up -d --build
```

The vault is bind-mounted read-write from `/volume1/homes/stephenyctse/obsidian`
→ `/vault` (edit `docker-compose.yml` if your path differs). The audit log
persists in `./data/audit.log` next to the compose file.

Quick checks:

```bash
curl http://localhost:8787/health
# {"status":"ok","vault":"/vault"}

# 401 without a token:
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:8787/mcp
```

## DSM Reverse Proxy rule

Control Panel → **Login Portal → Advanced → Reverse Proxy → Create**:

| Field | Value |
|-------|-------|
| Source protocol | HTTPS |
| Source hostname | `obsidianmcp.sharecloud-me.synology.me` |
| Source port | `443` |
| Destination protocol | HTTP |
| Destination hostname | `localhost` |
| Destination port | `8787` |

Result: `https://obsidianmcp.sharecloud-me.synology.me` → `http://localhost:8787`.
Make sure the subdomain's TLS certificate covers `obsidianmcp.` (a wildcard for
`*.sharecloud-me.synology.me`, or add it to the cert's SAN list).

> Tip: on the **Custom Header** tab of the reverse-proxy rule, enable
> **WebSocket** header pass-through — harmless for HTTP and useful if a client
> upgrades the connection.

## Add to Claude

The MCP URL is:

```
https://obsidianmcp.sharecloud-me.synology.me/mcp
```

In Claude: **Settings → Connectors → Add connector → Remote**, paste the URL,
and supply the bearer token (`Authorization: Bearer <MCP_AUTH_TOKEN>`).

## Rebuild after changes

```bash
docker-compose up -d --build
# view the audit trail:
tail -f data/audit.log
```

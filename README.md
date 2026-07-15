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
| `replace_text` | `(path, old_text, new_text, replace_all?)` | Literal find-and-replace within an **existing** note. `old_text` must match exactly once unless `replace_all` is set; fails if missing or not found. |
| `delete_note` | `(path)` | Move a note to `.trash/` (recoverable, not a hard delete); fails if missing. |
| `move_note` | `(from, to)` | Move/rename a note (destination must not exist; parent folders auto-created; links in other notes are not rewritten). |
| `search_notes` | `(query, folder?, limit?)` | Case-insensitive substring search, optionally scoped to a subfolder; returns up to limit files (default 20, max 100) with match counts and up to 3 snippets each. |
| `recent_changes` | `(folder?, limit?)` | Most recently modified notes (filesystem mtime, newest first; default 20, max 100). |
| `get_frontmatter` | `(path)` | Parsed YAML frontmatter as JSON (null if none). |
| `update_frontmatter` | `(path, key, value)` | Set or remove (value=null) one top-level frontmatter key; creates/removes the block as needed; body untouched. |
| `note_history` | `(path, limit?)` | List a note's git version history (newest first): commit hash, timestamp, action. Requires `GIT_VERSIONING`. |
| `note_diff` | `(path, ref, against?)` | Unified diff (with a stat summary) for a note. `ref` alone = what that one commit changed; `against` = another hash to compare two versions, or `"now"` to compare against the current note. Large diffs are truncated. Requires `GIT_VERSIONING`. |
| `restore_note` | `(path, ref)` | Restore a note to an earlier version (`ref` = hash from `note_history`), written back as a **new** version so history is preserved. Requires `GIT_VERSIONING`. |

Any path or folder whose name starts with `.` (e.g. `.obsidian`, `.trash`) is
refused — those internals are never listed, read, written, or searched.
Paths are also confined to the vault root (no `../` escapes), and only `.md`
files are accepted.

### Deleting notes & Remotely Save

`delete_note` never hard-deletes — it **moves** the note into the vault's
`.trash/` folder (subfolder preserved, an epoch-ms suffix added to avoid
collisions), so it's recoverable from File Station. Because `.trash` is a
dot-folder, the deleted note immediately disappears from `list_notes`,
`read_note`, and `search_notes`.

⚠️ **Deletions may not propagate to your devices.** With Remotely Save in
**Bidirectional (default)** mode, deletions are *not* synced (only the
*"…And Delete"* modes propagate them). A device that still holds the note
locally will **re-upload it** on its next sync, resurrecting it on the NAS. To
make a deletion stick everywhere, also delete it on a device, or switch
Remotely Save to an "…And Delete" mode (which then lets remote deletions wipe
local files — use with care).

## Endpoints

- `POST /mcp` — MCP Streamable HTTP endpoint. **Requires** an `Authorization: Bearer <token>` header — either an OAuth access token (see below) or `MCP_AUTH_TOKEN` directly; anything else gets `401`.
- `GET /health` — unauthenticated, returns `{"status":"ok", ...}`.
- OAuth endpoints — `/authorize`, `/token`, `/register`, `/revoke`, and the `/.well-known/oauth-authorization-server` + `/.well-known/oauth-protected-resource/mcp` discovery documents. See [Auth](#auth) below.

**Internal port: `8787`.**

## Auth

The server implements a minimal **OAuth 2.1 authorization server** — the same flow the claude.ai custom-connector UI and Claude Desktop/mobile speak natively: metadata discovery, dynamic client registration (RFC 7591), authorization code + PKCE, and refresh tokens. There's exactly one "user" — whoever knows `MCP_AUTH_TOKEN` — so approving a client is just typing that password into a consent page; no separate accounts.

Flow, when a client (e.g. claude.ai) adds this server as a connector:

1. It fetches `/.well-known/oauth-protected-resource/mcp` to find the authorization server, then `/.well-known/oauth-authorization-server` for endpoint URLs.
2. It self-registers via `POST /register` (no auth required — this is standard for dynamic client registration) and gets back a `client_id`.
3. It opens `/authorize` in a browser. This server renders a small login page; type in `MCP_AUTH_TOKEN` to approve. On success it redirects back to the client with an authorization code.
4. The client exchanges the code (+ PKCE verifier) at `POST /token` for an access token (1 hour) and a refresh token (rotated on each use, valid up to 90 days of inactivity).
5. Every `/mcp` call after that sends `Authorization: Bearer <access_token>` — no more manual token pasting.

Registered clients and issued tokens are persisted to `OAUTH_STORE_PATH` (default `/data/oauth-store.json`, next to the audit log) so a container restart doesn't force every connected client to re-authorize.

Non-interactive clients (Claude Code, curl, scripts) can skip all of this and send `Authorization: Bearer <MCP_AUTH_TOKEN>` directly — `verifyAccessToken` accepts it as a long-lived legacy token alongside real OAuth access tokens.

`PUBLIC_URL` (e.g. `https://obsidianmcp.your-domain.example.com`) must be set — it's used as the OAuth issuer and resource-server identifier, and must match the hostname clients actually reach the server at.

## Security

- **OAuth 2.1** for interactive clients (see [Auth](#auth)); access tokens expire in 1 hour, refresh tokens rotate on every use and expire after 90 days of inactivity. The `/authorize` consent page shows the client's redirect destination so you can spot a spoofed connector before approving. `MCP_AUTH_TOKEN` gates the consent page and doubles as a static bearer token for non-interactive clients. Never hardcoded, never committed; password comparisons are constant-time.
- **Audit log** at `/data/audit.log` (bind-mounted, survives restarts). One JSON line per tool call: `ts, tool, path, status(success|failure), error?`. **Note content is never logged** — metadata only.
- The OAuth endpoints are rate-limited (built into the SDK's auth handlers). The app runs with `trust proxy` enabled for the single DSM reverse-proxy hop in front of it, so rate limiting keys on the real client IP.

## Version history (optional)

Set `GIT_VERSIONING=true` to keep a **local** git history of the vault on the NAS. Two mechanisms, both best-effort (a git failure never breaks a tool call), all commits serialized:

- **Per-file (A):** each `write_note` / `append_note` / `replace_text` / `delete_note` commits the touched file — message `write_note: Infra/Foo.md @ 2026-07-08T14:03:12Z`.
- **Snapshot (C):** every `GIT_SNAPSHOT_MINUTES` (0 = off) a whole-vault `git add -A` snapshot runs — this also captures edits made on your phone/PC. A baseline snapshot runs at startup.

With versioning on, three read/restore tools become useful:

- **`note_history(path, limit?)`** returns a note's commits newest-first (`--follow`, so renames are tracked), each as `shortHash  timestamp  action`.
- **`note_diff(path, ref, against?)`** shows a unified diff with a `--stat` summary. With just `ref` it shows what that one commit changed (`git show`); set `against` to another hash to compare two versions, or to `"now"` to compare that version against the current note. `ref` is always the older/base side, and large diffs are truncated so they never flood the model's context.
- **`restore_note(path, ref)`** fetches the note's content at `ref` (a hash from `note_history`) and writes it back as a **new** commit — like `delete_note`'s `.trash` approach, it's non-destructive: nothing in between is discarded, so you can also "un-restore". It never does a `git reset`/`checkout` on the working tree.

When `GIT_VERSIONING` is off, all three return a clear "git versioning is disabled" error.

Notes:
- **Never pushed anywhere** — history stays on the NAS. Your notes don't leave the box.
- The `.git` folder lives inside the vault, but it's a **dot-folder**, so Remotely Save doesn't sync it to your devices and the MCP tools never expose it.
- `.obsidian/`, `.trash/`, and other dot-folders are git-ignored automatically.
- Browse history on the NAS: `git -C /volume1/homes/youruser/obsidian/Memory log --oneline`, or `git -C … log -- Infra/Foo.md` for one note.

Requires the image built with git (already in the Dockerfile). Defaults are **off**, so existing behavior is unchanged until you set the env vars.

## Setup & run (on the NAS)

```bash
# 1. Create your secrets file
cp .env.example .env

# 2. Generate a token and put it in .env as MCP_AUTH_TOKEN
openssl rand -hex 32

# 3. Set PUBLIC_URL in .env to the HTTPS hostname this service is reachable
#    at (must match the DSM reverse-proxy rule below), e.g.:
#    PUBLIC_URL=https://obsidianmcp.your-domain.example.com

# 4. Confirm your Synology uid/gid own the vault, and set PUID/PGID in .env
id youruser        # -> uid=PUID gid=PGID

# 5. Pull the published image and start
docker-compose pull && docker-compose up -d
```

> `docker-compose.yml` uses the published image
> `ghcr.io/stephenyctsedev/obsidianmcp:latest` by default. To build from local
> source instead, comment out the `image:` line and uncomment `build: .`, then
> run `docker-compose up -d --build`.

The Obsidian folder is bind-mounted read-write from
`/volume1/homes/youruser/obsidian` → `/vault` (edit `docker-compose.yml` if
your path differs). `VAULT_NAME` (in `.env`) selects which vault subfolder is
served — the active vault root is `/vault/<VAULT_NAME>` (default `Memory`), so
tool paths are relative to that vault (e.g. `Infra/NAS-Runbook.md`). Leave
`VAULT_NAME` blank to serve the mount itself. The audit log and OAuth
client/token store persist in `./data/` next to the compose file.

Quick checks:

```bash
curl http://localhost:8787/health
# {"status":"ok","vault":"/vault"}

# 401 without a token:
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:8787/mcp

# OAuth discovery document (should return JSON, not an error):
curl http://localhost:8787/.well-known/oauth-authorization-server
```

## DSM Reverse Proxy rule

Control Panel → **Login Portal → Advanced → Reverse Proxy → Create**:

| Field | Value |
|-------|-------|
| Source protocol | HTTPS |
| Source hostname | `obsidianmcp.your-domain.example.com` |
| Source port | `443` |
| Destination protocol | HTTP |
| Destination hostname | `localhost` |
| Destination port | `8787` |

Result: `https://obsidianmcp.your-domain.example.com` → `http://localhost:8787`.
Make sure the subdomain's TLS certificate covers `obsidianmcp.` (a wildcard for
`*.your-domain.example.com`, or add it to the cert's SAN list).

> Tip: on the **Custom Header** tab of the reverse-proxy rule, enable
> **WebSocket** header pass-through — harmless for HTTP and useful if a client
> upgrades the connection.

## Add to Claude

**Settings → Connectors → Add custom connector.** Just give it the `/mcp` URL —
no token in the URL, no OAuth fields to fill in:

```
https://obsidianmcp.your-domain.example.com/mcp
```

Claude discovers the OAuth endpoints automatically, self-registers as a
client, and opens the `/authorize` login page in a browser — enter
`MCP_AUTH_TOKEN` there once to approve it. After that, Claude holds a refresh
token and re-authenticates silently; you won't see the login page again
unless the connector is removed and re-added, or the token store is wiped.

For **Claude Code** or scripts that set custom headers directly, skip OAuth
entirely and send the token as a header:

```
Authorization: Bearer <MCP_AUTH_TOKEN>
```

> Security note: `MCP_AUTH_TOKEN` is the password for the `/authorize`
> consent page as well as a standing bearer token — treat it like any other
> credential (never in URLs, never committed) and rotate it if it leaks.
> Rotating it immediately revokes the ability to approve *new* OAuth clients
> and the legacy header path, but does **not** revoke already-issued OAuth
> access/refresh tokens — restart the container (or delete `OAUTH_STORE_PATH`)
> to invalidate those too.

## Update after a new release

```bash
docker-compose pull && docker-compose up -d
# view the audit trail:
tail -f data/audit.log
```

## CI/CD — publish an image on a version tag

`.github/workflows/docker-publish.yml` builds a **`linux/amd64`** image (for
Synology Container Manager, which is x86-64) and pushes it to **GitHub
Container Registry** whenever you push a `v*` tag. No secrets to configure — it
uses the built-in `GITHUB_TOKEN`. (Add `linux/arm64` back to the `platforms:`
line only if you deploy to an ARM host — it cross-builds under QEMU, slower.)

Cut a release:

```bash
git tag v1.0.0
git push origin v1.0.0
```

This publishes:

```
ghcr.io/stephenyctsedev/obsidianmcp:1.0.0
ghcr.io/stephenyctsedev/obsidianmcp:1.0
ghcr.io/stephenyctsedev/obsidianmcp:latest
```

> The package is **private** by default. Either make it public in the repo's
> Packages settings, or `docker login ghcr.io` on the NAS with a Personal
> Access Token (scope `read:packages`) before pulling.

### Run the published image on the NAS

`docker-compose.yml` already points at the registry image, so after a new tag
builds just pull and restart:

```bash
docker-compose pull && docker-compose up -d
```

Pin to a specific version for reproducible deploys by changing the tag in
`docker-compose.yml`, e.g. `ghcr.io/stephenyctsedev/obsidianmcp:1.0.0`.

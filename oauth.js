// oauth.js — minimal single-user OAuth 2.1 authorization server for the MCP
// endpoint, implementing @modelcontextprotocol/sdk's OAuthServerProvider
// interface: dynamic client registration (RFC 7591), authorization code +
// PKCE, refresh tokens, and revocation.
//
// This is deliberately NOT a general-purpose auth server: there is exactly
// one "user" (whoever holds MCP_AUTH_TOKEN), and approving a client's
// authorization request just means typing that password into the consent
// page. Registered clients, issued tokens, and pending codes are persisted
// to a single JSON file so a container restart doesn't force every
// connected client (e.g. the claude.ai connector) to re-authorize.

import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const ACCESS_TOKEN_TTL_SECONDS = 60 * 60; // 1 hour
const AUTH_CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function constantTimeEqual(a, b) {
  const bufA = Buffer.from(String(a ?? ""));
  const bufB = Buffer.from(String(b ?? ""));
  if (bufA.length !== bufB.length) {
    // Still run a comparison of equal length to avoid leaking length via timing.
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[c]);
}

// --- Persistent store --------------------------------------------------
//
// Plain JSON file, rewritten atomically (write to temp + rename) on every
// mutation. Small scale (a handful of clients/tokens for a personal
// server), so no need for anything fancier.

class OAuthStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.clients = new Map();
    this.codes = new Map();
    this.accessTokens = new Map();
    this.refreshTokens = new Map();
    this._saving = Promise.resolve();
  }

  async load() {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const data = JSON.parse(raw);
      this.clients = new Map(data.clients || []);
      this.accessTokens = new Map(data.accessTokens || []);
      this.refreshTokens = new Map(data.refreshTokens || []);
      // Authorization codes are short-lived; don't bother restoring stale ones.
    } catch (err) {
      if (err.code !== "ENOENT") {
        console.error("oauth store: failed to load, starting empty:", err.message);
      }
    }
    this._pruneExpired();
  }

  _pruneExpired() {
    const nowSeconds = Date.now() / 1000;
    for (const [code, data] of this.codes) {
      if (data.expiresAt < Date.now()) this.codes.delete(code);
    }
    for (const [token, data] of this.accessTokens) {
      if (data.expiresAt < nowSeconds) this.accessTokens.delete(token);
    }
  }

  // Best-effort persistence: never let a write failure break a request.
  save() {
    this._saving = this._saving.then(() => this._writeNow()).catch((err) => {
      console.error("oauth store: save failed:", err.message);
    });
    return this._saving;
  }

  async _writeNow() {
    this._pruneExpired();
    const data = {
      clients: [...this.clients],
      accessTokens: [...this.accessTokens],
      refreshTokens: [...this.refreshTokens],
    };
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data), "utf8");
    await fs.rename(tmp, this.filePath);
  }
}

// --- Provider ------------------------------------------------------------

export function createOAuthProvider({ storePath, loginPassword, legacyToken }) {
  const store = new OAuthStore(storePath);
  const loadPromise = store.load();

  const clientsStore = {
    async getClient(clientId) {
      await loadPromise;
      return store.clients.get(clientId);
    },
    async registerClient(client) {
      await loadPromise;
      store.clients.set(client.client_id, client);
      await store.save();
      return client;
    },
  };

  function renderLoginPage({ client, params, error }) {
    const hidden = (name, value) =>
      value === undefined ? "" : `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;
    const clientName = client.client_name || client.client_id;
    return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize ${escapeHtml(clientName)} — obsidian-mcp</title>
<style>
  body { font-family: system-ui, sans-serif; background: #16181d; color: #e6e6e6; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
  .card { background: #22252b; border-radius: 12px; padding: 32px; width: 320px; box-shadow: 0 8px 24px rgba(0,0,0,0.4); }
  h1 { font-size: 18px; margin: 0 0 8px; }
  p { font-size: 14px; color: #a8adb8; margin: 0 0 20px; }
  input[type=password] { width: 100%; box-sizing: border-box; padding: 10px 12px; border-radius: 8px; border: 1px solid #3a3f4a; background: #16181d; color: #e6e6e6; font-size: 14px; margin-bottom: 16px; }
  button { width: 100%; padding: 10px 12px; border-radius: 8px; border: none; background: #6a8dff; color: #0b0d10; font-weight: 600; font-size: 14px; cursor: pointer; }
  button:hover { background: #8aa4ff; }
  .error { color: #ff8080; font-size: 13px; margin: -8px 0 16px; }
</style>
</head>
<body>
  <form class="card" method="post">
    <h1>Authorize access</h1>
    <p><strong>${escapeHtml(clientName)}</strong> wants to read and write notes in your Obsidian vault.</p>
    ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
    ${hidden("client_id", client.client_id)}
    ${hidden("redirect_uri", params.redirectUri)}
    ${hidden("response_type", "code")}
    ${hidden("code_challenge", params.codeChallenge)}
    ${hidden("code_challenge_method", "S256")}
    ${hidden("scope", (params.scopes || []).join(" "))}
    ${hidden("state", params.state)}
    ${hidden("resource", params.resource ? params.resource.toString() : undefined)}
    <input type="password" name="password" placeholder="Password" autofocus autocomplete="current-password" required>
    <button type="submit">Authorize</button>
  </form>
</body>
</html>`;
  }

  const provider = {
    clientsStore,

    async authorize(client, params, res) {
      await loadPromise;
      const req = res.req;
      if (req.method === "POST" && typeof req.body?.password === "string") {
        if (!constantTimeEqual(req.body.password, loginPassword)) {
          res.status(401).type("html").send(renderLoginPage({ client, params, error: "Incorrect password." }));
          return;
        }
        const code = crypto.randomBytes(32).toString("hex");
        store.codes.set(code, {
          clientId: client.client_id,
          codeChallenge: params.codeChallenge,
          redirectUri: params.redirectUri,
          scopes: params.scopes || [],
          resource: params.resource ? params.resource.toString() : undefined,
          expiresAt: Date.now() + AUTH_CODE_TTL_MS,
        });
        const target = new URL(params.redirectUri);
        target.searchParams.set("code", code);
        if (params.state !== undefined) target.searchParams.set("state", params.state);
        res.redirect(302, target.toString());
        return;
      }
      res.status(200).type("html").send(renderLoginPage({ client, params }));
    },

    async challengeForAuthorizationCode(client, authorizationCode) {
      await loadPromise;
      const data = store.codes.get(authorizationCode);
      if (!data || data.expiresAt < Date.now()) {
        throw new Error("Invalid or expired authorization code");
      }
      if (data.clientId !== client.client_id) {
        throw new Error("Authorization code was not issued to this client");
      }
      return data.codeChallenge;
    },

    async exchangeAuthorizationCode(client, authorizationCode) {
      await loadPromise;
      const data = store.codes.get(authorizationCode);
      if (!data || data.expiresAt < Date.now()) {
        throw new Error("Invalid or expired authorization code");
      }
      if (data.clientId !== client.client_id) {
        throw new Error("Authorization code was not issued to this client");
      }
      store.codes.delete(authorizationCode);
      return await issueTokens(client, data.scopes, data.resource);
    },

    async exchangeRefreshToken(client, refreshToken, scopes) {
      await loadPromise;
      const data = store.refreshTokens.get(refreshToken);
      if (!data) {
        throw new Error("Invalid refresh token");
      }
      if (data.clientId !== client.client_id) {
        throw new Error("Refresh token was not issued to this client");
      }
      store.refreshTokens.delete(refreshToken); // rotate on use
      return await issueTokens(client, scopes || data.scopes, data.resource);
    },

    async verifyAccessToken(token) {
      await loadPromise;
      const data = store.accessTokens.get(token);
      if (data) {
        if (data.expiresAt < Date.now() / 1000) {
          throw new Error("Access token expired");
        }
        return {
          token,
          clientId: data.clientId,
          scopes: data.scopes,
          expiresAt: data.expiresAt,
          resource: data.resource ? new URL(data.resource) : undefined,
        };
      }
      // Legacy static-token fallback, for non-interactive clients (Claude Code,
      // scripts) that send `Authorization: Bearer <MCP_AUTH_TOKEN>` directly
      // instead of going through the OAuth flow.
      if (legacyToken && constantTimeEqual(token, legacyToken)) {
        return {
          token,
          clientId: "static-token",
          scopes: ["mcp"],
          expiresAt: Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60,
        };
      }
      throw new Error("Invalid or expired token");
    },

    async revokeToken(_client, { token }) {
      await loadPromise;
      const hadAccess = store.accessTokens.delete(token);
      const hadRefresh = store.refreshTokens.delete(token);
      if (hadAccess || hadRefresh) await store.save();
    },
  };

  async function issueTokens(client, scopes, resource) {
    const accessToken = `mcp_at_${crypto.randomBytes(32).toString("hex")}`;
    const refreshToken = `mcp_rt_${crypto.randomBytes(32).toString("hex")}`;
    const expiresAt = Math.floor(Date.now() / 1000) + ACCESS_TOKEN_TTL_SECONDS;
    store.accessTokens.set(accessToken, { clientId: client.client_id, scopes, resource, expiresAt });
    store.refreshTokens.set(refreshToken, { clientId: client.client_id, scopes, resource });
    await store.save();
    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: refreshToken,
      scope: scopes.join(" "),
    };
  }

  return provider;
}

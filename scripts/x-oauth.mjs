#!/usr/bin/env node
// ---------------------------------------------------------------------------
// One-time X OAuth 2.0 bootstrap (Authorization Code + PKCE)
//
// Runs the interactive login flow locally to obtain the initial refresh token
// the worker needs. Zero dependencies — uses only Node built-ins.
//
// Usage:
//   X_CLIENT_ID=... [X_CLIENT_SECRET=...] npm run oauth
//
// Prerequisite: in your X app's "User authentication settings", set the
// callback URI to exactly:   http://localhost:8080/callback
// (or override the port with OAUTH_PORT).
// ---------------------------------------------------------------------------

import http from "node:http";
import crypto from "node:crypto";
import { exec } from "node:child_process";

const CLIENT_ID = process.env.X_CLIENT_ID;
const CLIENT_SECRET = process.env.X_CLIENT_SECRET || undefined;
const PORT = Number(process.env.OAUTH_PORT || 8080);
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
const SCOPES = ["tweet.read", "users.read", "bookmark.read", "offline.access"];

const AUTHORIZE_URL = "https://x.com/i/oauth2/authorize";
const TOKEN_URL = "https://api.x.com/2/oauth2/token";

if (!CLIENT_ID) {
  console.error("Error: X_CLIENT_ID is required.");
  console.error("Usage: X_CLIENT_ID=... [X_CLIENT_SECRET=...] npm run oauth");
  process.exit(1);
}

const base64url = (buf) =>
  buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const codeVerifier = base64url(crypto.randomBytes(64));
const codeChallenge = base64url(crypto.createHash("sha256").update(codeVerifier).digest());
const stateToken = base64url(crypto.randomBytes(24));

const authUrl = new URL(AUTHORIZE_URL);
authUrl.search = new URLSearchParams({
  response_type: "code",
  client_id: CLIENT_ID,
  redirect_uri: REDIRECT_URI,
  scope: SCOPES.join(" "),
  state: stateToken,
  code_challenge: codeChallenge,
  code_challenge_method: "S256",
}).toString();

async function exchangeCode(code) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    client_id: CLIENT_ID,
    code_verifier: codeVerifier,
  });
  const headers = { "Content-Type": "application/x-www-form-urlencoded" };
  if (CLIENT_SECRET) {
    headers.Authorization =
      "Basic " + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
  }
  const res = await fetch(TOKEN_URL, { method: "POST", headers, body });
  if (!res.ok) {
    throw new Error(`Token exchange failed ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname !== "/callback") {
    res.writeHead(404).end();
    return;
  }

  const code = url.searchParams.get("code");
  const returnedState = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  const finish = (message) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<html><body style="font-family:system-ui;padding:3rem">
      <h2>${message}</h2><p>You can close this tab and return to your terminal.</p>
      </body></html>`);
  };

  if (error) {
    finish(`Authorization failed: ${error}`);
    console.error(`\nAuthorization error: ${error}`);
    server.close();
    process.exit(1);
  }
  if (returnedState !== stateToken) {
    finish("State mismatch — aborting.");
    console.error("\nState mismatch — possible CSRF, aborting.");
    server.close();
    process.exit(1);
  }

  try {
    const token = await exchangeCode(code);
    finish("✅ Authorized! Refresh token captured.");
    console.log("\n──────────────────────────────────────────────────────────");
    console.log("✅ Success. Your bootstrap refresh token:\n");
    console.log(token.refresh_token);
    console.log("\nSet it on the worker with:\n");
    console.log(`  ntn workers env set X_REFRESH_TOKEN=${token.refresh_token}`);
    console.log("\nOr store it as the X_REFRESH_TOKEN GitHub Actions secret.");
    console.log(`Granted scopes: ${token.scope}`);
    console.log("──────────────────────────────────────────────────────────\n");
  } catch (err) {
    finish("Token exchange failed — see terminal.");
    console.error(`\n${err.message}`);
  } finally {
    server.close();
    process.exit(0);
  }
});

server.listen(PORT, () => {
  console.log(`\nOpen this URL in your browser to authorize (redirect: ${REDIRECT_URI}):\n`);
  console.log(authUrl.toString() + "\n");
  const opener =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  exec(`${opener} "${authUrl.toString()}"`, () => {});
});

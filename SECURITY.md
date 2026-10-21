# MCPHub security notes

## Deploying

```bash
# Docker (single image: API + dashboard; data in /data)
docker build -t mcphub .
docker run -p 3001:3001 -v mcphub-data:/data -e MCPHUB_ENCRYPTION_KEY="$(openssl rand -base64 32)" \
  -e MCPHUB_PUBLIC_URL=https://mcphub.example.com -e MCPHUB_TRUST_PROXY=1 mcphub

# or PM2 on a VM
npm ci && npm run build
npx pm2 start ecosystem.config.cjs
```

Run behind a TLS-terminating reverse proxy (Caddy, nginx, a cloud load balancer). In production the server
serves the built dashboard itself, so proxy everything to it. See `packages/server/.env.example` for all settings.

The server refuses to start in production without `MCPHUB_ENCRYPTION_KEY` (32 bytes, base64), without an https
`MCPHUB_PUBLIC_URL` (the OAuth issuer), or with `MCPHUB_COOKIE_SECURE=false`. Back up the key with the database: without it, stored upstream credentials
cannot be decrypted. Behind a proxy, set `MCPHUB_TRUST_PROXY` (hop count) so rate limits key on real client
IPs, and `MCPHUB_PUBLIC_URL` to the dashboard origin.

Run one instance only: MCP sessions and rate-limit counters are in process memory.

### First run / existing data

- The first account registered becomes the operator. After that, sign-up is closed unless `MCPHUB_ALLOW_SIGNUP=true`.
  Register before exposing the server.
- Apps created before authentication existed have no owner. The operator sees a "Claim apps" banner on the
  dashboard (or run `npm run assign-orphans -w packages/server -- you@example.com`).
- Plaintext credentials from earlier versions are encrypted automatically at startup.

## Security model

| Area | Control |
|---|---|
| Dashboard auth | Email + password (scrypt N=2^17), optional TOTP two-factor (RFC 6238, secret encrypted at rest, codes single-use). Session: random 256-bit token in an HttpOnly, SameSite=Lax, Secure cookie; only its SHA-256 is stored. |
| CSRF | `Sec-Fetch-Site` + `Origin` verification on state-changing requests; no wildcard CORS. |
| Authorization | Every app, tool, log and token query is scoped by owner/app; other users' resources return 404. |
| MCP auth | OAuth 2.1 authorization server per the MCP spec: protected-resource metadata per app (RFC 9728), dynamic client registration, PKCE S256 only, resource indicators (RFC 8707) bound to one app the approving user owns, single-use 5-minute codes, 1-hour access tokens, rotating 30-day refresh tokens with replay detection (replay revokes the grant), `iss` in redirects (RFC 9207), client secrets encrypted at rest. Consent page requires a dashboard session. Optional static API tokens (`mcph_…`) for headless use. All tokens stored hashed and checked on every request. Streamable HTTP (`/mcp/:appId`) is stateless; legacy SSE (`/mcp/:appId/sse`) sessions are bound to app + token. `Origin` validated (DNS-rebinding defence). Tokens in query strings are rejected. Revoking a token or deleting an app closes its live SSE sessions. |
| Credentials at rest | AES-256-GCM, app id bound as associated data. Never returned by the API; scrubbed from tool output and logs. |
| SSRF | Destination IPs validated at connect time inside the HTTP agent (covers DNS rebinding, redirects and IP literals). Only globally routable unicast addresses are allowed; private, loopback, link-local, CGNAT, metadata, NAT64/6to4/Teredo and IPv4-mapped forms are blocked. Proxy env vars are ignored. Applies to tool calls and OpenAPI imports. |
| Request shaping | Upstream URL must stay on the base origin and under the base path. Tool arguments are validated against the tool's JSON Schema (Ajv). Header names/values validated; transport, proxy and credential headers can't be overridden. Size limits on bodies, arguments, specs and responses. Tool calls follow redirects only within the same origin. |
| Abuse | Rate limits per app, per client, per IP for auth, plus caps on concurrent SSE connections. |
| Playground | Optional (`ANTHROPIC_API_KEY` on the server). Runs a Claude tool-use loop for the app owner; tool calls go through the same validated, SSRF-guarded, rate-limited, logged path as MCP. The upstream credential is never sent to the model. |
| Logs | Sensitive keys and token-like values redacted; payloads truncated; 30-day / 1000-per-app retention. |
| Reliability | WAL + busy timeout. Async errors handled per request; unexpected process-level errors exit for the process manager to restart. Graceful shutdown on SIGTERM. |

## Known gaps

- Claude.ai / Claude Desktop custom connectors need a public HTTPS deployment to reach the OAuth endpoints; locally, use Claude Code or mcp-remote.
- Dynamic client registration is open (rate-limited per IP), as MCP clients require; clients without a live grant are purged after 30 days.
- No email verification or self-service password reset (both need an email provider). Operators reset passwords with
  `npm run reset-password -w packages/server -- <email> [--disable-2fa]`, which signs the user out everywhere.
- Single-node design: legacy SSE sessions and rate limits are in memory (Streamable HTTP itself is stateless).
- Upstream responses are passed to the model as-is (minus the credential), so API content can attempt prompt injection.
  Tools carry MCP annotations (`readOnlyHint` for GET, `destructiveHint` for DELETE/PUT) so clients can require
  confirmation for writes; this reduces, but cannot eliminate, the risk.
- Dev-only advisories remain in Tailwind 3's glob/file-watching dependencies (fix needs a Tailwind 4 migration). They don't affect
  the production build output; `npm audit --omit=dev` is clean. Vite is on 8.

## Rotating the encryption key

Stop the server, then:

```bash
MCPHUB_ENCRYPTION_KEY=<current> MCPHUB_NEW_ENCRYPTION_KEY="$(openssl rand -base64 32)" npm run rotate-key -w packages/server
```

It backs up the database, verifies every secret decrypts with the current key, and re-encrypts all of them in
one transaction (nothing changes if any check fails). Then switch `MCPHUB_ENCRYPTION_KEY` to the new key.

## Tests

`npm test -w packages/server` (56 tests) covers authentication, cross-tenant authorization, CSRF, credential storage,
exposure and rotation, SSRF (internal targets, IPv4/IPv6 forms, DNS rebinding, redirects, proxy env), MCP token and
session isolation, revocation, expiry and connection caps over Streamable HTTP and SSE, the OAuth flow, rate limits,
argument validation, log redaction/retention, ownerless-app claiming, hostile (self-referencing) specs, TOTP two-factor, operator password reset and the playground loop (against a local stand-in for the Claude API;
real-model behaviour is not covered).
Path-containment rules for tool paths have no dedicated test file yet; the Docker image has not been built in CI.

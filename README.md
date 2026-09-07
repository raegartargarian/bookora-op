# OpenAI API relay

A tiny, transparent relay to `https://api.openai.com`. Bookora's API server runs
on an **Iranian VPS that cannot reach OpenAI** — filtered on the way out, and
geo-blocked by OpenAI on the way in. This proxy, hosted abroad on a free
platform, sits in the middle:

```
backend (Iran VPS) ──HTTPS──▶ this proxy (abroad) ──HTTPS──▶ api.openai.com
```

It forwards the whole `/v1/...` path straight through, preserves status codes and
OpenAI's error JSON verbatim, and **streams SSE responses back untouched** so
`stream: true` works end to end.

**No API key is stored here.** The key travels in the `Authorization` header on
every request, from the backend, and is forwarded as-is — exactly the way the
sibling Telegram proxy forwards the bot token in the URL. A request that arrives
without an `Authorization` header is rejected with 401; the proxy has nothing to
fall back on, by design. Compromising the proxy host does not leak the key,
because the key is never written to its disk or its env.

Used by `backend/src/workers/blog/` (the AI blog pipeline) and the
procedure-encyclopedia / landing-page copy generators.

---

## ⚠️ Pick a host that's actually reachable from Iran

The relay only works if the Iran VPS can reach it. Based on current (2025–2026)
reports from Iranian networks:

| Host | Reachable from Iran? | Notes |
|------|----------------------|-------|
| **Deno Deploy** (`deno.dev`) | ✅ **Best** | No filtering reports; GitHub signup (no card → sidesteps sanctions). Streams fine, no hard request timeout. **Recommended.** |
| Cloudflare Worker | ⚠️ only on a **custom domain** | `*.workers.dev` is filtered in Iran since 2023; free-Worker limits tightened in 2025. Streaming works. |
| Netlify | ❌ risky | Documented "not accessible from Iran" reports, **and** synchronous functions time out at ~10s — too short for a blog-post generation. Fallback only. |
| Vercel | ❌ | OFAC-blocks Iranian signup. |

**The single biggest reliability lever is a custom domain.** Front whichever host
you pick with a subdomain of your own domain — `ai.bookora.net` — so the VPS
connects to a clean, un-blocklisted hostname instead of a filtered `*.deno.dev` /
`*.workers.dev` / `*.netlify.app`. Point a CNAME at the host, add the domain in
the host's dashboard, and use that hostname everywhere below.

This folder ships three deploy targets — `deno/main.ts` (recommended),
`worker.js` (Cloudflare), and `netlify/functions/proxy.mjs` — all functionally
identical.

---

## Where this lives

The proxy is the one piece of Bookora that must sit **outside** Iran, and Deno
Deploy builds from GitHub — so it is published to a second repository with this
folder at the root:

| | |
|---|---|
| Monorepo (source of truth) | `gitlab.com/bookora/bookora` → `openai-proxy/` |
| Deploy repo (Deno Deploy watches this) | `github.com/raegartargarian/bookora-op` → root |

Edit here, in the monorepo. The deploy repo is a `git subtree` split, never a
place to commit into directly — hand-edits there will collide with the next
split. To publish a change, from the repo root:

```bash
git subtree push --prefix=openai-proxy proxy main
```

`proxy` is the GitHub remote (`git@github.com:raegartargarian/bookora-op.git`).
Because the split is derived from monorepo history, the same commits reproduce
byte-for-byte every time, and the push stays a fast-forward.

Paths shift by one level across the boundary: `openai-proxy/deno/main.ts` here
is `deno/main.ts` in the deploy repo, which is the entrypoint Deno Deploy wants.

---

## Option A — Deno Deploy (recommended)

### Live deployment

| | |
|---|---|
| Org / app | `raegartargarian` / `bookora-op` |
| URL | `https://bookora-op.raegartargarian.deno.net` |
| Region | `eu` |
| Console | <https://console.deno.com/raegartargarian/bookora-op> |

Verified end to end after deploy: missing `x-proxy-secret` → 403, missing
`Authorization` → 401, `GET /v1/models` → 200 with 125 models, `POST
/v1/chat/completions` on `gpt-4.1-mini` → 200, and a model off the allowlist →
403 `model_not_allowed`.

### Deploy

Use the **`deno deploy` subcommand**, not classic `deployctl`. Deno Deploy's
current platform issues `ddp_` tokens that `deployctl` 1.13 rejects with «the
bearer token is invalid» — the same token authenticates fine against the new
CLI. `deno deploy whoami --json` tells you which account you are on.

```bash
cd openai-proxy/deno
deno deploy --org raegartargarian --app bookora-op --prod --json --non-interactive
```

The app was created with:

```bash
deno deploy create --json --non-interactive --org raegartargarian \
  --app bookora-op --source local --entrypoint main.ts --region eu
```

`--source local` uploads this directory, so a deploy does **not** wait on the
GitHub repo. Push-to-deploy from `github.com/raegartargarian/bookora-op` can be
wired in the console instead; either way the entrypoint is `main.ts` relative to
the app directory.

### A custom domain is required for production, not cosmetic

`deno.net` did **not** resolve on the dev machine's resolver during deploy —
`dig` returned an empty answer, while `8.8.8.8` resolved the same name to
`69.67.170.170`, and a request forced to that IP completed a TLS handshake and
returned 200 in ~0.4 s. So the name is blocked at the DNS layer while the
address itself is reachable.

That is the failure mode `ai.bookora.net` exists to avoid: a CNAME under a domain
we control resolves through our own DNS and never asks a resolver about
`deno.net`. **Add the custom domain in the console and point `ai.bookora.net` at
it before the VPS depends on this**, then set `OPENAI_BASE_URL` to
`https://ai.bookora.net/v1`. Until then the backend is pointed at the raw
`.deno.net` hostname, which resolves from some networks and not others.

### Env vars (Project → Settings → Environment Variables)

| Var | Required | Meaning |
|---|---|---|
| `PROXY_SECRET` | **yes — the guard fails closed** | Shared guard. Must match `OPENAI_PROXY_SECRET` on the backend. Sent as the `x-proxy-secret` header. If it is unset or blank the relay refuses every request with **503 `proxy_not_configured`**, logs `[bookora-openai-proxy] FATAL` once, and `/healthz` answers **503 `misconfigured`** — it never serves unauthenticated. Serving without it would be an open, anonymising relay to `api.openai.com` on our hostname, at a public URL. |
| `ALLOWED_MODELS` | no | Comma-separated model allowlist, e.g. `gpt-4.1-mini,gpt-4.1`. When set, a JSON body whose `model` is not on the list gets 403. Leave unset to allow every model. |
| `MAX_BODY_BYTES` | no | Request-body cap, default `2097152` (2 MiB). Over the cap → 413. |
| `UPSTREAM_TIMEOUT_MS` | no | How long to wait for OpenAI's **response headers**, default `60000`. The timer is cleared the moment headers arrive, so a long streaming generation is never truncated. |

Generate the secret with `openssl rand -hex 32`.

Already set on the live app: `PROXY_SECRET` (stored as a secret, so its value is
write-only — the API returns `null` for it) and `ALLOWED_MODELS=gpt-4.1,gpt-4.1-mini`,
which matches the backend's `OPENAI_MODEL=gpt-4.1`. Widening `OPENAI_MODEL` means
widening `ALLOWED_MODELS` too, or the proxy returns 403 for the new model.

```bash
deno deploy env add --secret PROXY_SECRET "$(openssl rand -hex 32)" \
  --org raegartargarian --app bookora-op
deno deploy env list --org raegartargarian --app bookora-op
```

Env changes apply to the running revision — the deploy that set `PROXY_SECRET`
started returning 403 for unauthenticated calls without a rebuild.

### Test

```bash
curl -sS https://ai.bookora.net/v1/chat/completions \
  -H "x-proxy-secret: $OPENAI_PROXY_SECRET" \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"gpt-4.1-mini","messages":[{"role":"user","content":"سلام"}]}'
```

Streaming (you should see `data:` chunks arrive one by one, not all at once):

```bash
curl -N -sS https://ai.bookora.net/v1/chat/completions \
  -H "x-proxy-secret: $OPENAI_PROXY_SECRET" \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"gpt-4.1-mini","stream":true,"messages":[{"role":"user","content":"یک جمله بنویس"}]}'
```

Liveness, no secret needed: `curl https://ai.bookora.net/healthz` → `{"status":"ok",…}`.
It is also the misconfiguration alarm: with `PROXY_SECRET` unset it answers **503**
`{"status":"misconfigured",…}`, so an uptime ping catches the open-relay case
before a bill does.

---

## Option B — Cloudflare Worker (custom domain required)

`worker.js` is the whole thing.

1. `npm i -g wrangler && wrangler login` (or paste the file into the dashboard's
   "Quick edit").
2. `npx wrangler deploy worker.js`, then add a **route on a custom domain** —
   `*.workers.dev` is filtered in Iran, so use `ai.bookora.net`.
3. `wrangler secret put PROXY_SECRET` (and optionally set `ALLOWED_MODELS`,
   `MAX_BODY_BYTES`, `UPSTREAM_TIMEOUT_MS` as vars).
4. Backend: `OPENAI_BASE_URL=https://ai.bookora.net/v1` — no path prefix.

Same curl test as above.

---

## Option C — Netlify (last resort)

Reachability from Iran is unreliable **and** free synchronous functions are
capped at ~10s, which is not enough for a full blog draft. Use it only to
unblock development, and prefer Deno Deploy for production.

1. `npx netlify-cli deploy --prod` from this folder, or connect the repo with
   base directory `openai-proxy`.
2. Site → Environment variables: `PROXY_SECRET` (+ the optional ones).
3. The function is routed at `/ai/*` (see its `config.path` and `netlify.toml`),
   so the base URL **includes `/ai`**:
   ```ini
   OPENAI_BASE_URL=https://<your-site>.netlify.app/ai/v1
   ```
4. Test:
   ```bash
   curl -sS https://<your-site>.netlify.app/ai/v1/models \
     -H "x-proxy-secret: $OPENAI_PROXY_SECRET" \
     -H "Authorization: Bearer $OPENAI_API_KEY"
   ```

---

## How the backend uses it

`backend/.env` (validated in `backend/src/config/env.schema.ts`):

```ini
OPENAI_BASE_URL=https://ai.bookora.net/v1     # this proxy, INCLUDING /v1
OPENAI_API_KEY=sk-proj-...                   # the real OpenAI key — only the VPS holds it
OPENAI_PROXY_SECRET=<same value as PROXY_SECRET on the proxy>
OPENAI_MODEL=gpt-4.1-mini                    # default model for blog/SEO generation
```

The official `openai` SDK takes `baseURL` verbatim and appends `/chat/completions`,
`/responses`, `/embeddings`, `/models` — which is why `OPENAI_BASE_URL` ends with
`/v1`, matching the shape of the real `https://api.openai.com/v1`:

```ts
new OpenAI({
  apiKey: config.openai.apiKey,
  baseURL: config.openai.baseUrl,
  defaultHeaders: { 'x-proxy-secret': config.openai.proxySecret },
});
```

Set `OPENAI_BASE_URL=https://api.openai.com/v1` and drop the secret header to run
against OpenAI directly from a machine that can reach it (e.g. a dev laptop) —
nothing else changes.

---

## What the relay does, precisely

| Concern | Behaviour |
|---|---|
| Path | Forwards from the first `/v1/` segment onward, verbatim, plus the query string. Works whether the host hands over `/v1/…`, `/ai/v1/…` or `/.netlify/functions/proxy/v1/…`. Anything else → 404. |
| Guard | `x-proxy-secret` compared in constant time against `PROXY_SECRET`. Mismatch → 403 before any upstream call. The header is stripped and never reaches OpenAI. **Fails closed**: an unset/blank `PROXY_SECRET` → 503 `proxy_not_configured` for every request, never a pass-through. |
| Key | `Authorization` is forwarded untouched. Missing → 401 `missing_authorization`. Nothing is stored. |
| Request headers | Allowlisted: `authorization`, `content-type`, `accept`, `openai-organization`, `openai-project`, `openai-beta`, `idempotency-key`, `user-agent`. `host`/`x-forwarded-*` never leak upstream. |
| Request body | Raw bytes (`arrayBuffer`, never `.text()`), so multipart/binary uploads survive. Capped at `MAX_BODY_BYTES` → 413. |
| Response | `ReadableStream` passed straight through — no buffering, no re-encoding. Upstream `content-type` is preserved (so `text/event-stream` stays SSE), plus `cache-control: no-cache, no-transform` and `x-accel-buffering: no` to stop any proxy in the path from buffering. Stale `content-encoding`/`content-length` are dropped, since the runtime already decoded the body. |
| Status & errors | Upstream status and OpenAI's error JSON are relayed verbatim, so the backend's existing 401/429/400 handling still works. |
| Timeouts | `UPSTREAM_TIMEOUT_MS` bounds the wait for response **headers** only; once they arrive the timer is cleared so long generations stream to completion. Timeout → 504 `upstream_timeout`; connection failure → 502 `upstream_unreachable`. |
| Proxy's own errors | Always OpenAI-shaped: `{"error":{"message":"…","type":"proxy_error","param":null,"code":"…"}}`. Codes: `proxy_not_configured`, `invalid_proxy_secret`, `unknown_path`, `missing_authorization`, `payload_too_large`, `model_not_allowed`, `upstream_timeout`, `upstream_unreachable`. |

---

## Tests

Path forwarding, the secret guard, key forwarding, the model allowlist, the body
cap, SSE passthrough and the 502 path are all covered. No dependencies, no
network — `globalThis.fetch` is stubbed.

```bash
# Deno build
cd deno && deno test --allow-env main_test.ts

# Cloudflare + Netlify builds
npm test          # node --test "test/**/*.test.mjs"
```

---

## Files

```
deno/main.ts                  Deno Deploy entrypoint (recommended target)
deno/main_test.ts             Deno tests
deno/deno.jsonc               tasks, fmt/lint config, deployctl hints
worker.js                     Cloudflare Worker, single file
netlify/functions/proxy.mjs   Netlify Functions v2 (Web Request/Response, streams)
netlify.toml                  publish dir + /ai/* routing
public/index.html             noindex placeholder page
test/worker.test.mjs          node:test suite for the Worker + Netlify builds
```

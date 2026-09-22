/**
 * Deno Deploy entrypoint — a transparent relay to the OpenAI API.
 *
 * Bookora's API server runs on an Iranian VPS that cannot reach
 * `api.openai.com` (both the filtering on the way out and OpenAI's own
 * geo-blocking on the way in). This proxy — hosted abroad — sits in the middle:
 *
 *   backend (Iran VPS) ──HTTPS──▶ this proxy (abroad) ──HTTPS──▶ api.openai.com
 *
 * It forwards the whole `/v1/...` path through, preserves status codes and
 * OpenAI's error JSON verbatim, and streams SSE responses back byte-for-byte
 * without buffering.
 *
 * The backend drives the Responses API in background mode: `POST /v1/responses`
 * with `background:true` returns an id within seconds, then `GET
 * /v1/responses/{id}` is polled and `POST /v1/responses/{id}/cancel` is sent on
 * its own deadline. Every exchange is short, so no single request comes near
 * this relay's header timeout or the hosting platform's request cutoff. Those
 * paths need no special handling: any `/v1/*` path and method is forwarded.
 *
 * **No API key is stored here.** The key travels in the `Authorization` header
 * on every request, from the backend, and is forwarded untouched. A request
 * without that header is rejected with 401 — the proxy has nothing to fall back
 * on, by design.
 *
 * Deploy:
 *   - Dashboard: https://dash.deno.com → New Project → deploy this file from Git.
 *   - or CLI:  deployctl deploy --project=<name> openai-proxy/deno/main.ts
 *
 * Env vars to set in the Deno project:
 *   - PROXY_SECRET        REQUIRED guard; matches OPENAI_PROXY_SECRET on the
 *                         backend. The guard fails CLOSED: without it the relay
 *                         refuses every request with 503 and `/healthz` reports
 *                         `misconfigured`, because a relay that serves without a
 *                         secret is an open relay to api.openai.com on our
 *                         hostname.
 *   - ALLOWED_MODELS      optional comma-separated model allowlist. Entries are
 *                         exact ids, or a prefix ending in `*` (`gpt-5*` matches
 *                         `gpt-5`, `gpt-5-mini`, `gpt-5-2025-08-07`). It must list
 *                         BOTH the backend's primary and fallback model, e.g.
 *                         `gpt-5*,gpt-4.1`, or the fallback is refused with 403.
 *   - MAX_BODY_BYTES      optional request-body cap (default 2097152 = 2 MiB)
 *   - FETCH_ALLOWED_HOSTS  optional host allowlist for `/fetch` (`*.example.com` ok)
 *   - FETCH_MAX_BODY_BYTES optional cap for `/fetch` responses (default 15 MiB)
 *   - TELEGRAM_MAX_BODY_BYTES optional cap for `/telegram/*` uploads (default 10 MiB)
 *   - UPSTREAM_TIMEOUT_MS optional time to wait for upstream response HEADERS
 *                         (default 120000). Once headers arrive the timer is
 *                         cleared so long streaming generations are never cut.
 *                         Background create/poll/cancel answer in seconds; the
 *                         generous default only covers the backend's synchronous
 *                         fallback for an account that rejects `background`.
 *
 * Backend wiring:
 *   OPENAI_BASE_URL=https://ai.bookora.net/v1
 *   OPENAI_API_KEY=sk-...
 *   OPENAI_PROXY_SECRET=<same value as PROXY_SECRET>
 */

const UPSTREAM_ORIGIN = "https://api.openai.com";

/**
 * ── TELEGRAM ─────────────────────────────────────────────────────────────────
 *
 * `api.telegram.org` is filtered from the VPS too, so the blog autopost to the
 * `@bookora_smart` channel rides this same relay:
 *
 *   POST /telegram/bot<token>/<method>  ──▶  https://api.telegram.org/bot<token>/<method>
 *
 * Behind the SAME `x-proxy-secret` guard as `/v1/*`, and narrower than it: only
 * the Bot API methods the backend actually calls are forwarded, so a leaked
 * secret cannot turn this into a general Telegram relay. The bot token travels
 * in the path from the backend and is never stored here — the same stance as
 * the OpenAI key. Photos are uploaded as multipart bytes (Telegram's servers
 * cannot fetch an image from an Iranian host), so the body cap is its own:
 * `TELEGRAM_MAX_BODY_BYTES`, default 10 MiB — Bot API `sendPhoto` allows 10 MB.
 */
const TELEGRAM_ORIGIN = "https://api.telegram.org";
const TELEGRAM_PATH = /^\/telegram\/(bot\d+:[A-Za-z0-9_-]+)\/([A-Za-z]+)$/;
export const TELEGRAM_METHODS = new Set([
  "getMe",
  "getChat",
  "sendMessage",
  "sendPhoto",
  // The daily quiz (a native quiz poll) and the share button retarget.
  "sendPoll",
  "editMessageReplyMarkup",
]);
const DEFAULT_TELEGRAM_MAX_BODY_BYTES = 10 * 1024 * 1024;

/** `/telegram/bot<token>/<method>` → the upstream path, or null when not allowed. */
export function resolveTelegramPath(pathname: string): string | null {
  const match = TELEGRAM_PATH.exec(pathname);
  if (!match) return null;
  const [, bot, method] = match;
  if (!TELEGRAM_METHODS.has(method)) return null;
  return `/${bot}/${method}`;
}

/**
 * ── SOURCE FETCH ─────────────────────────────────────────────────────────────
 *
 * The blog pipeline reads RSS feeds, articles and their hero images from
 * international beauty sites, some of which are filtered from the VPS. The
 * backend tries direct first and falls back here:
 *
 *   GET /fetch?url=<urlencoded https URL>   ──▶  that URL, body passed through
 *
 * Behind the same `x-proxy-secret`. GET only, https only, no IP literals or
 * localhost, redirects followed but re-checked, body capped by
 * `FETCH_MAX_BODY_BYTES` (default 15 MiB). `FETCH_ALLOWED_HOSTS` (optional,
 * comma-separated, `*.example.com` allowed) narrows it further.
 */
const DEFAULT_FETCH_MAX_BODY_BYTES = 15 * 1024 * 1024;

export function isFetchTargetAllowed(
  raw: string | null,
  allowedHosts: string | undefined,
): URL | null {
  if (!raw) return null;
  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return null;
  }
  if (target.protocol !== "https:" || target.username || target.password) return null;
  const host = target.hostname.toLowerCase();
  if (
    host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") ||
    /^[\d.]+$/.test(host) || host.includes(":") || host.startsWith("[")
  ) {
    return null;
  }
  const allow = (allowedHosts ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  if (allow.length > 0) {
    const ok = allow.some((entry) =>
      entry.startsWith("*.")
        ? host === entry.slice(2) || host.endsWith(entry.slice(1))
        : host === entry
    );
    if (!ok) return null;
  }
  return target;
}

async function relayFetch(request: Request, url: URL, env: EnvSource): Promise<Response> {
  if (request.method !== "GET") {
    return apiError(405, "Method not allowed.", "method_not_allowed");
  }
  let target = isFetchTargetAllowed(url.searchParams.get("url"), env.get("FETCH_ALLOWED_HOSTS"));
  if (!target) return apiError(400, "url must be an allowed https URL.", "invalid_url");

  const maxBodyBytes = positiveInt(env.get("FETCH_MAX_BODY_BYTES"), DEFAULT_FETCH_MAX_BODY_BYTES);
  const timeoutMs = positiveInt(env.get("UPSTREAM_TIMEOUT_MS"), DEFAULT_TIMEOUT_MS);
  const signal = AbortSignal.timeout(timeoutMs);
  const headers = {
    "user-agent": "Mozilla/5.0 (compatible; BookoraBot/1.0; +https://bookora.net)",
    "accept": request.headers.get("accept") ?? "*/*",
  };
  try {
    // Redirects by hand so every hop passes the same target check.
    for (let hop = 0; hop < 5; hop++) {
      const upstream = await fetch(target.href, { headers, redirect: "manual", signal });
      const location = upstream.headers.get("location");
      if (upstream.status >= 300 && upstream.status < 400 && location) {
        const next = isFetchTargetAllowed(
          new URL(location, target).href,
          env.get("FETCH_ALLOWED_HOSTS"),
        );
        if (!next) return apiError(400, "Redirect to a disallowed URL.", "invalid_redirect");
        target = next;
        continue;
      }
      const declared = Number(upstream.headers.get("content-length") ?? "0");
      if (Number.isFinite(declared) && declared > maxBodyBytes) {
        return apiError(413, `Upstream body exceeds ${maxBodyBytes} bytes.`, "payload_too_large");
      }
      const body = await upstream.arrayBuffer();
      if (body.byteLength > maxBodyBytes) {
        return apiError(413, `Upstream body exceeds ${maxBodyBytes} bytes.`, "payload_too_large");
      }
      return new Response(body, {
        status: upstream.status,
        headers: {
          "content-type": upstream.headers.get("content-type") ?? "application/octet-stream",
          "x-final-url": target.href,
          "cache-control": "no-store",
        },
      });
    }
    return apiError(508, "Too many redirects.", "too_many_redirects");
  } catch (err) {
    return apiError(502, `Fetch failed: ${(err as Error).message}`, "upstream_unreachable");
  }
}

async function relayTelegram(request: Request, url: URL, env: EnvSource): Promise<Response> {
  const upstreamPath = resolveTelegramPath(url.pathname);
  if (!upstreamPath) {
    return apiError(404, "Not an allowed Telegram Bot API call.", "unknown_path");
  }
  if (request.method !== "POST" && request.method !== "GET") {
    return apiError(405, "Method not allowed.", "method_not_allowed");
  }
  const maxBodyBytes = positiveInt(
    env.get("TELEGRAM_MAX_BODY_BYTES"),
    DEFAULT_TELEGRAM_MAX_BODY_BYTES,
  );
  let body: ArrayBuffer | null = null;
  if (request.method === "POST") {
    body = await request.arrayBuffer();
    if (body.byteLength > maxBodyBytes) {
      return apiError(413, `Request body exceeds ${maxBodyBytes} bytes.`, "payload_too_large");
    }
  }
  const headers = new Headers();
  const contentType = request.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);

  const timeoutMs = positiveInt(env.get("UPSTREAM_TIMEOUT_MS"), DEFAULT_TIMEOUT_MS);
  try {
    const upstream = await fetch(`${TELEGRAM_ORIGIN}${upstreamPath}${url.search}`, {
      method: request.method,
      headers,
      body: body && body.byteLength > 0 ? body : undefined,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Telegram answers small JSON; buffer it and pass the status through.
    return new Response(await upstream.arrayBuffer(), {
      status: upstream.status,
      headers: {
        "content-type": upstream.headers.get("content-type") ?? "application/json",
        "cache-control": "no-store",
      },
    });
  } catch (err) {
    return apiError(
      502,
      `Telegram upstream failed: ${(err as Error).message}`,
      "upstream_unreachable",
    );
  }
}

const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Request headers we relay upstream. An allowlist rather than a blocklist:
 * `host`, `x-proxy-secret`, `x-forwarded-*` and friends must never leak to
 * OpenAI, and hop-by-hop headers must not be re-sent.
 */
const FORWARDED_REQUEST_HEADERS = [
  "authorization",
  "content-type",
  "accept",
  "openai-organization",
  "openai-project",
  "openai-beta",
  "idempotency-key",
  "user-agent",
];

/**
 * Response headers we must NOT copy: the runtime already decoded the body, so
 * a stale `content-encoding`/`content-length` would make the client fail to
 * parse it, and hop-by-hop headers are meaningless on a new connection.
 */
const STRIPPED_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
]);

export interface EnvSource {
  get(key: string): string | undefined;
}

/** Constant-time string comparison, so the guard can't be probed by timing. */
export function safeEqual(a: unknown, b: unknown): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const enc = new TextEncoder();
  const left = enc.encode(a);
  const right = enc.encode(b);
  let diff = left.length ^ right.length;
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}

/** An OpenAI-shaped error body, so the backend's error handling still works. */
/**
 * Read the shared secret, treating unset/blank as unset.
 *
 * The guard **fails closed**. It used to be `if (secret && !safeEqual(...))`,
 * which meant a deploy that forgot the variable relayed for anyone who found
 * the hostname — and the deploy target is a public Deno Deploy URL. Refusing to
 * serve is strictly better than serving unauthenticated: the operator sees a
 * dead relay immediately, instead of an OpenAI bill later.
 */
export function configuredSecret(raw: string | undefined): string | null {
  return typeof raw === "string" && raw.trim().length > 0 ? raw : null;
}

const MISCONFIGURED_MESSAGE =
  "This relay is not configured: PROXY_SECRET is unset. It refuses to serve rather than " +
  "act as an open relay to api.openai.com.";

let warnedUnconfigured = false;

/** Loud once per instance rather than silent on every request. */
export function warnIfUnconfigured(env: EnvSource): boolean {
  const configured = configuredSecret(env.get("PROXY_SECRET")) !== null;
  if (!configured && !warnedUnconfigured) {
    warnedUnconfigured = true;
    console.error(`[bookora-openai-proxy] FATAL: ${MISCONFIGURED_MESSAGE}`);
  }
  return configured;
}

export function apiError(
  status: number,
  message: string,
  code: string,
  type = "proxy_error",
): Response {
  return Response.json(
    { error: { message, type, param: null, code } },
    { status, headers: { "cache-control": "no-store" } },
  );
}

/**
 * Forward the whole OpenAI path. We slice from the first `/v1/` segment, which
 * makes the same code correct on every host: Deno/Cloudflare see the path
 * verbatim (`/v1/chat/completions`), while Netlify may hand us `/ai/v1/...` or
 * `/.netlify/functions/proxy/v1/...` — all three contain `/v1/`.
 */
export function resolveUpstreamPath(pathname: string): string | null {
  const idx = pathname.indexOf("/v1/");
  if (idx === -1) return null;
  return pathname.slice(idx);
}

export function pickForwardedHeaders(source: Headers): Headers {
  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = source.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

export function parseAllowedModels(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0),
  );
}

/**
 * Whether `model` passes the allowlist. An empty allowlist allows everything.
 * Entries match exactly, except an entry ending in `*`, which matches any id
 * starting with the text before it — so `gpt-5*` admits dated snapshots and the
 * `-mini` variant without also admitting `gpt-4.1-mini`. The prefix is literal
 * text, not a family boundary (`gpt-5*` would also admit a future `gpt-50`), so
 * keep prefixes specific.
 */
export function isModelAllowed(model: string, allowed: Set<string>): boolean {
  if (allowed.size === 0) return true;
  for (const entry of allowed) {
    if (entry.endsWith("*")) {
      if (model.startsWith(entry.slice(0, -1))) return true;
    } else if (entry === model) {
      return true;
    }
  }
  return false;
}

/**
 * When an allowlist is configured, read the `model` field out of a JSON body.
 * Returns the model name, or `null` when the body carries none (embeddings via
 * form data, `/v1/models`, a background poll `GET /v1/responses/{id}`, its
 * body-less `POST …/cancel`) — those are let through untouched.
 */
export function extractModel(
  bodyBytes: BufferSource | null,
  contentType: string | null,
): string | null {
  if (!bodyBytes || bodyBytes.byteLength === 0) return null;
  if (!contentType || !contentType.toLowerCase().includes("json")) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bodyBytes));
    const model = parsed?.model;
    return typeof model === "string" ? model : null;
  } catch {
    return null;
  }
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

const INDEX_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex">
<title>Bookora OpenAI relay</title></head>
<body style="font:15px/1.6 system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem">
<h1>Bookora OpenAI relay</h1>
<p>Forwards <code>/v1/*</code> to <code>api.openai.com</code>. No UI, no stored keys.</p>
<p>Health check: <code>/healthz</code></p>
</body></html>`;

export async function handleRequest(request: Request, env: EnvSource): Promise<Response> {
  const url = new URL(request.url);

  // Unauthenticated, cheap, and never touches upstream — safe for uptime pings.
  if (url.pathname === "/" || url.pathname === "/index.html") {
    return new Response(INDEX_HTML, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  const secret = configuredSecret(env.get("PROXY_SECRET"));
  if (secret === null) warnIfUnconfigured(env);

  // The health check is the deployment's own alarm: it must not answer "ok"
  // while the guard is disabled, or the misconfiguration stays invisible.
  if (url.pathname === "/healthz") {
    return secret === null
      ? Response.json(
        { status: "misconfigured", upstream: UPSTREAM_ORIGIN, error: MISCONFIGURED_MESSAGE },
        { status: 503, headers: { "cache-control": "no-store" } },
      )
      : Response.json({ status: "ok", upstream: UPSTREAM_ORIGIN });
  }

  if (secret === null) {
    return apiError(503, MISCONFIGURED_MESSAGE, "proxy_not_configured");
  }
  if (!safeEqual(request.headers.get("x-proxy-secret"), secret)) {
    return apiError(403, "Forbidden: missing or invalid x-proxy-secret.", "invalid_proxy_secret");
  }

  if (url.pathname.startsWith("/telegram/")) {
    return relayTelegram(request, url, env);
  }
  if (url.pathname === "/fetch") {
    return relayFetch(request, url, env);
  }

  const upstreamPath = resolveUpstreamPath(url.pathname);
  if (!upstreamPath) {
    return apiError(404, "Not an OpenAI API path — expected /v1/...", "unknown_path");
  }

  if (!request.headers.get("authorization")) {
    return apiError(
      401,
      "Missing Authorization header. This proxy stores no API key; the caller must send it.",
      "missing_authorization",
      "invalid_request_error",
    );
  }

  const maxBodyBytes = positiveInt(env.get("MAX_BODY_BYTES"), DEFAULT_MAX_BODY_BYTES);
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
    return apiError(413, `Request body exceeds ${maxBodyBytes} bytes.`, "payload_too_large");
  }

  let bodyBytes: ArrayBuffer | null = null;
  if (request.method !== "GET" && request.method !== "HEAD") {
    // Raw bytes — `.text()` would corrupt multipart/binary uploads.
    bodyBytes = await request.arrayBuffer();
    if (bodyBytes.byteLength > maxBodyBytes) {
      return apiError(413, `Request body exceeds ${maxBodyBytes} bytes.`, "payload_too_large");
    }
  }

  const allowedModels = parseAllowedModels(env.get("ALLOWED_MODELS"));
  if (allowedModels.size > 0) {
    const model = extractModel(bodyBytes, request.headers.get("content-type"));
    if (model && !isModelAllowed(model, allowedModels)) {
      return apiError(
        403,
        `Model '${model}' is not allowed by this proxy.`,
        "model_not_allowed",
      );
    }
  }

  const target = `${UPSTREAM_ORIGIN}${upstreamPath}${url.search}`;
  const init: RequestInit = {
    method: request.method,
    headers: pickForwardedHeaders(request.headers),
    redirect: "manual",
  };
  if (bodyBytes && bodyBytes.byteLength > 0) init.body = bodyBytes;

  const timeoutMs = positiveInt(env.get("UPSTREAM_TIMEOUT_MS"), DEFAULT_TIMEOUT_MS);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  init.signal = controller.signal;

  let upstream: Response;
  try {
    upstream = await fetch(target, init);
  } catch (err) {
    clearTimeout(timer);
    const aborted = controller.signal.aborted;
    return apiError(
      aborted ? 504 : 502,
      aborted
        ? `Upstream did not respond within ${timeoutMs}ms.`
        : `Upstream request failed: ${(err as Error).message}`,
      aborted ? "upstream_timeout" : "upstream_unreachable",
    );
  }
  // Headers are in — stop the clock so a long streaming generation is never
  // truncated by the connect timeout.
  clearTimeout(timer);

  const headers = new Headers();
  for (const [name, value] of upstream.headers) {
    if (!STRIPPED_RESPONSE_HEADERS.has(name.toLowerCase())) headers.set(name, value);
  }
  // Never buffer or transform: SSE must reach the backend chunk by chunk.
  headers.set("cache-control", "no-cache, no-transform");
  headers.set("x-accel-buffering", "no");

  // `upstream.body` is a ReadableStream and is passed straight through.
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

if (import.meta.main) {
  // Fail loudly at startup rather than silently on every request.
  warnIfUnconfigured(Deno.env);
  Deno.serve((request) => handleRequest(request, Deno.env));
}

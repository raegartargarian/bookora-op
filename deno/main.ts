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
 *   - PROXY_SECRET        required guard; matches OPENAI_PROXY_SECRET on the backend
 *   - ALLOWED_MODELS      optional comma-separated model allowlist (e.g. gpt-4.1-mini,gpt-4.1)
 *   - MAX_BODY_BYTES      optional request-body cap (default 2097152 = 2 MiB)
 *   - UPSTREAM_TIMEOUT_MS optional time to wait for upstream response HEADERS
 *                         (default 60000). Once headers arrive the timer is
 *                         cleared so long streaming generations are never cut.
 *
 * Backend wiring:
 *   OPENAI_BASE_URL=https://ai.bookora.net/v1
 *   OPENAI_API_KEY=sk-...
 *   OPENAI_PROXY_SECRET=<same value as PROXY_SECRET>
 */

const UPSTREAM_ORIGIN = "https://api.openai.com";

const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;

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
 * When an allowlist is configured, read the `model` field out of a JSON body.
 * Returns the model name, or `null` when the body carries none (embeddings via
 * form data, `/v1/models`, …) — those are let through untouched.
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
  if (url.pathname === "/healthz") {
    return Response.json({ status: "ok", upstream: UPSTREAM_ORIGIN });
  }

  const secret = env.get("PROXY_SECRET");
  if (secret && !safeEqual(request.headers.get("x-proxy-secret"), secret)) {
    return apiError(403, "Forbidden: missing or invalid x-proxy-secret.", "invalid_proxy_secret");
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
    if (model && !allowedModels.has(model)) {
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
  Deno.serve((request) => handleRequest(request, Deno.env));
}

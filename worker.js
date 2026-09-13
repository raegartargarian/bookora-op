/**
 * Cloudflare Worker build of the Bookora OpenAI relay (single file).
 *
 * Functionally identical to `deno/main.ts`. Deploy with `wrangler deploy`, or
 * paste into the dashboard's "Quick edit". `*.workers.dev` is filtered in Iran,
 * so this MUST be routed on a custom domain (e.g. `ai.bookora.net`).
 *
 * Secrets / vars (`wrangler secret put …`):
 *   PROXY_SECRET (REQUIRED — the guard fails closed; without it every request is
 *   refused with 503 and /healthz reports `misconfigured`, because a relay that
 *   serves without a secret is an open relay to api.openai.com on our hostname),
 *   ALLOWED_MODELS (exact ids or `prefix*`; must list both the primary and the
 *   fallback model, e.g. `gpt-5*,gpt-4.1`), MAX_BODY_BYTES, UPSTREAM_TIMEOUT_MS
 *   (time to response HEADERS only, default 120000).
 *
 * The backend uses the Responses API in background mode — `POST /v1/responses`,
 * then polls `GET /v1/responses/{id}` and may `POST /v1/responses/{id}/cancel` —
 * so every exchange is short. Any `/v1/*` path and method is forwarded as-is.
 *
 * No OpenAI key lives here: it arrives in the `Authorization` header from the
 * backend on every request and is forwarded untouched.
 */
const UPSTREAM_ORIGIN = 'https://api.openai.com';

const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 120_000;

const FORWARDED_REQUEST_HEADERS = [
  'authorization',
  'content-type',
  'accept',
  'openai-organization',
  'openai-project',
  'openai-beta',
  'idempotency-key',
  'user-agent',
];

const STRIPPED_RESPONSE_HEADERS = new Set([
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
]);

/** Constant-time string comparison, so the guard can't be probed by timing. */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const enc = new TextEncoder();
  const left = enc.encode(a);
  const right = enc.encode(b);
  let diff = left.length ^ right.length;
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}

/**
 * Read the shared secret, treating unset/blank as unset.
 *
 * The guard **fails closed**. It used to be `if (env.PROXY_SECRET && !safeEqual(...))`,
 * which meant a deploy that forgot the variable relayed for anyone who found the
 * hostname. Refusing to serve is strictly better than serving unauthenticated:
 * the operator sees a dead relay immediately, instead of an OpenAI bill later.
 */
export function configuredSecret(raw) {
  return typeof raw === 'string' && raw.trim().length > 0 ? raw : null;
}

const MISCONFIGURED_MESSAGE =
  'This relay is not configured: PROXY_SECRET is unset. It refuses to serve rather than ' +
  'act as an open relay to api.openai.com.';

let warnedUnconfigured = false;

/** Loud once per instance rather than silent on every request. */
export function warnIfUnconfigured(env) {
  const configured = configuredSecret(env?.PROXY_SECRET) !== null;
  if (!configured && !warnedUnconfigured) {
    warnedUnconfigured = true;
    console.error(`[bookora-openai-proxy] FATAL: ${MISCONFIGURED_MESSAGE}`);
  }
  return configured;
}

/** An OpenAI-shaped error body, so the backend's error handling still works. */
export function apiError(status, message, code, type = 'proxy_error') {
  return Response.json(
    { error: { message, type, param: null, code } },
    { status, headers: { 'cache-control': 'no-store' } },
  );
}

/** Forward the whole OpenAI path, sliced from the first `/v1/` segment. */
export function resolveUpstreamPath(pathname) {
  const idx = pathname.indexOf('/v1/');
  if (idx === -1) return null;
  return pathname.slice(idx);
}

export function pickForwardedHeaders(source) {
  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = source.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

export function parseAllowedModels(raw) {
  if (!raw) return new Set();
  return new Set(raw.split(',').map((entry) => entry.trim()).filter(Boolean));
}

/**
 * Whether `model` passes the allowlist. An empty allowlist allows everything.
 * Entries match exactly, except an entry ending in `*`, which matches any id
 * starting with the text before it — so `gpt-5*` admits dated snapshots and the
 * `-mini` variant without also admitting `gpt-4.1-mini`. The prefix is literal,
 * so keep it specific.
 */
export function isModelAllowed(model, allowed) {
  if (allowed.size === 0) return true;
  for (const entry of allowed) {
    if (entry.endsWith('*')) {
      if (model.startsWith(entry.slice(0, -1))) return true;
    } else if (entry === model) {
      return true;
    }
  }
  return false;
}

/**
 * Read `model` out of a JSON body, or `null` when there is none (`/v1/models`,
 * a background poll `GET /v1/responses/{id}`, its body-less `POST …/cancel`) —
 * those are let through untouched.
 */
export function extractModel(bodyBytes, contentType) {
  if (!bodyBytes || bodyBytes.byteLength === 0) return null;
  if (!contentType || !contentType.toLowerCase().includes('json')) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bodyBytes));
    return typeof parsed?.model === 'string' ? parsed.model : null;
  } catch {
    return null;
  }
}

function positiveInt(raw, fallback) {
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

export async function handleRequest(request, env) {
  const url = new URL(request.url);

  if (url.pathname === '/' || url.pathname === '/index.html') {
    return new Response(INDEX_HTML, {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }

  const secret = configuredSecret(env?.PROXY_SECRET);
  if (secret === null) warnIfUnconfigured(env);

  // The health check is the deployment's own alarm: it must not answer "ok"
  // while the guard is disabled, or the misconfiguration stays invisible.
  if (url.pathname === '/healthz') {
    return secret === null
      ? Response.json(
          { status: 'misconfigured', upstream: UPSTREAM_ORIGIN, error: MISCONFIGURED_MESSAGE },
          { status: 503, headers: { 'cache-control': 'no-store' } },
        )
      : Response.json({ status: 'ok', upstream: UPSTREAM_ORIGIN });
  }

  if (secret === null) {
    return apiError(503, MISCONFIGURED_MESSAGE, 'proxy_not_configured');
  }
  if (!safeEqual(request.headers.get('x-proxy-secret'), secret)) {
    return apiError(403, 'Forbidden: missing or invalid x-proxy-secret.', 'invalid_proxy_secret');
  }

  const upstreamPath = resolveUpstreamPath(url.pathname);
  if (!upstreamPath) {
    return apiError(404, 'Not an OpenAI API path — expected /v1/...', 'unknown_path');
  }

  if (!request.headers.get('authorization')) {
    return apiError(
      401,
      'Missing Authorization header. This proxy stores no API key; the caller must send it.',
      'missing_authorization',
      'invalid_request_error',
    );
  }

  const maxBodyBytes = positiveInt(env.MAX_BODY_BYTES, DEFAULT_MAX_BODY_BYTES);
  const declaredLength = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
    return apiError(413, `Request body exceeds ${maxBodyBytes} bytes.`, 'payload_too_large');
  }

  let bodyBytes = null;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    // Raw bytes — `.text()` would corrupt multipart/binary uploads.
    bodyBytes = await request.arrayBuffer();
    if (bodyBytes.byteLength > maxBodyBytes) {
      return apiError(413, `Request body exceeds ${maxBodyBytes} bytes.`, 'payload_too_large');
    }
  }

  const allowedModels = parseAllowedModels(env.ALLOWED_MODELS);
  if (allowedModels.size > 0) {
    const model = extractModel(bodyBytes, request.headers.get('content-type'));
    if (model && !isModelAllowed(model, allowedModels)) {
      return apiError(403, `Model '${model}' is not allowed by this proxy.`, 'model_not_allowed');
    }
  }

  const target = `${UPSTREAM_ORIGIN}${upstreamPath}${url.search}`;
  const init = {
    method: request.method,
    headers: pickForwardedHeaders(request.headers),
    redirect: 'manual',
  };
  if (bodyBytes && bodyBytes.byteLength > 0) init.body = bodyBytes;

  const timeoutMs = positiveInt(env.UPSTREAM_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  init.signal = controller.signal;

  let upstream;
  try {
    upstream = await fetch(target, init);
  } catch (err) {
    clearTimeout(timer);
    const aborted = controller.signal.aborted;
    return apiError(
      aborted ? 504 : 502,
      aborted
        ? `Upstream did not respond within ${timeoutMs}ms.`
        : `Upstream request failed: ${err.message}`,
      aborted ? 'upstream_timeout' : 'upstream_unreachable',
    );
  }
  // Headers are in — stop the clock so a long stream is never truncated.
  clearTimeout(timer);

  const headers = new Headers();
  for (const [name, value] of upstream.headers) {
    if (!STRIPPED_RESPONSE_HEADERS.has(name.toLowerCase())) headers.set(name, value);
  }
  headers.set('cache-control', 'no-cache, no-transform');
  headers.set('x-accel-buffering', 'no');

  // `upstream.body` is a ReadableStream and is passed straight through, so SSE
  // chunks reach the backend as they are produced.
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

export default {
  fetch: handleRequest,
};

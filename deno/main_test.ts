/**
 * Tests for the Deno relay: path forwarding and the fail-closed secret guard.
 *
 * Run with `deno task test` (from this folder) or
 * `deno test --allow-env openai-proxy/deno/main_test.ts`.
 *
 * `globalThis.fetch` is stubbed so nothing ever leaves the machine; the stub
 * records the URL/method/headers/body the proxy would have sent upstream.
 */
import { assert, assertEquals } from "jsr:@std/assert@^1.0.8";
import {
  DEFAULT_TIMEOUT_MS,
  extractModel,
  handleRequest,
  isModelAllowed,
  parseAllowedModels,
  resolveUpstreamPath,
  safeEqual,
} from "./main.ts";

const SECRET = "s3cret-value";
const KEY = "Bearer sk-test-key";

function env(vars: Record<string, string> = {}) {
  return { get: (key: string) => vars[key] };
}

interface Captured {
  url: string;
  init: RequestInit;
}

/** Swap in a fake upstream; returns the capture slot and a restore function. */
function stubFetch(response: () => Response | Promise<Response>) {
  const captured: Captured[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    captured.push({ url: String(url), init: init ?? {} });
    return Promise.resolve(response());
  }) as typeof fetch;
  return {
    captured,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function okJson() {
  return new Response(JSON.stringify({ id: "chatcmpl-1" }), {
    status: 200,
    headers: { "content-type": "application/json", "content-length": "20" },
  });
}

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`https://ai.bookora.net${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: KEY, ...headers },
    body: JSON.stringify(body),
  });
}

// --- pure helpers ----------------------------------------------------------

Deno.test("resolveUpstreamPath keeps the whole /v1 path on every host shape", () => {
  assertEquals(resolveUpstreamPath("/v1/chat/completions"), "/v1/chat/completions");
  assertEquals(resolveUpstreamPath("/v1/responses"), "/v1/responses");
  assertEquals(resolveUpstreamPath("/v1/embeddings"), "/v1/embeddings");
  assertEquals(resolveUpstreamPath("/v1/models/gpt-4.1-mini"), "/v1/models/gpt-4.1-mini");
  // Netlify shapes
  assertEquals(resolveUpstreamPath("/ai/v1/chat/completions"), "/v1/chat/completions");
  assertEquals(
    resolveUpstreamPath("/.netlify/functions/proxy/v1/chat/completions"),
    "/v1/chat/completions",
  );
  // Not an API path
  assertEquals(resolveUpstreamPath("/"), null);
  assertEquals(resolveUpstreamPath("/wp-login.php"), null);
});

Deno.test("safeEqual compares exactly", () => {
  assert(safeEqual("abc", "abc"));
  assert(!safeEqual("abc", "abd"));
  assert(!safeEqual("abc", "abcd"));
  assert(!safeEqual(null, "abc"));
  assert(!safeEqual(undefined, undefined));
});

Deno.test("parseAllowedModels trims and drops empties", () => {
  assertEquals([...parseAllowedModels(" gpt-4.1-mini , gpt-4.1 ,")], ["gpt-4.1-mini", "gpt-4.1"]);
  assertEquals(parseAllowedModels(undefined).size, 0);
});

Deno.test("extractModel only reads JSON bodies", () => {
  const bytes = new TextEncoder().encode('{"model":"gpt-4.1-mini"}');
  assertEquals(extractModel(bytes, "application/json"), "gpt-4.1-mini");
  assertEquals(extractModel(bytes, "multipart/form-data; boundary=x"), null);
  assertEquals(extractModel(new TextEncoder().encode("not json"), "application/json"), null);
  assertEquals(extractModel(null, "application/json"), null);
});

// --- secret guard ----------------------------------------------------------

Deno.test("secret guard rejects a missing or wrong x-proxy-secret", async () => {
  const stub = stubFetch(okJson);
  try {
    const missing = await handleRequest(
      post("/v1/chat/completions", { model: "gpt-4.1-mini" }),
      env({ PROXY_SECRET: SECRET }),
    );
    assertEquals(missing.status, 403);
    assertEquals((await missing.json()).error.code, "invalid_proxy_secret");

    const wrong = await handleRequest(
      post("/v1/chat/completions", {}, { "x-proxy-secret": "nope" }),
      env({ PROXY_SECRET: SECRET }),
    );
    assertEquals(wrong.status, 403);

    // Nothing was forwarded upstream.
    assertEquals(stub.captured.length, 0);
  } finally {
    stub.restore();
  }
});

Deno.test("secret guard passes with the right header and forwards upstream", async () => {
  const stub = stubFetch(okJson);
  try {
    const res = await handleRequest(
      post("/v1/chat/completions", { model: "gpt-4.1-mini" }, { "x-proxy-secret": SECRET }),
      env({ PROXY_SECRET: SECRET }),
    );
    assertEquals(res.status, 200);
    assertEquals(stub.captured.length, 1);
    assertEquals(stub.captured[0].url, "https://api.openai.com/v1/chat/completions");
  } finally {
    stub.restore();
  }
});

// The guard used to be `if (secret && !safeEqual(...))`, so a deploy that forgot
// the variable served EVERY caller: an open, anonymising relay to api.openai.com
// on our hostname, at a public Deno Deploy URL. It now fails CLOSED.
Deno.test("an unset PROXY_SECRET refuses to serve instead of relaying", async () => {
  const stub = stubFetch(okJson);
  try {
    const cases: Record<string, string>[] = [{}, { PROXY_SECRET: "" }, { PROXY_SECRET: "   " }];
    for (const vars of cases) {
      const res = await handleRequest(
        post("/v1/models", {}, { "x-proxy-secret": SECRET }),
        env(vars),
      );
      assertEquals(res.status, 503);
      assertEquals((await res.json()).error.code, "proxy_not_configured");
    }
    assertEquals(stub.captured.length, 0);
  } finally {
    stub.restore();
  }
});

Deno.test("/healthz reports the misconfiguration loudly instead of answering ok", async () => {
  const res = await handleRequest(new Request("https://ai.bookora.net/healthz"), env());
  assertEquals(res.status, 503);
  const body = await res.json();
  assertEquals(body.status, "misconfigured");
  assert(String(body.error).includes("PROXY_SECRET"));
});

// --- path forwarding -------------------------------------------------------

Deno.test("query string and method survive the hop", async () => {
  const stub = stubFetch(okJson);
  try {
    const res = await handleRequest(
      new Request("https://ai.bookora.net/v1/models?limit=5", {
        headers: { authorization: KEY, "x-proxy-secret": SECRET },
      }),
      env({ PROXY_SECRET: SECRET }),
    );
    assertEquals(res.status, 200);
    assertEquals(stub.captured[0].url, "https://api.openai.com/v1/models?limit=5");
    assertEquals(stub.captured[0].init.method, "GET");
  } finally {
    stub.restore();
  }
});

Deno.test("a non-/v1 path is a 404 and never reaches upstream", async () => {
  const stub = stubFetch(okJson);
  try {
    const res = await handleRequest(
      new Request("https://ai.bookora.net/admin", {
        headers: { authorization: KEY, "x-proxy-secret": SECRET },
      }),
      env({ PROXY_SECRET: SECRET }),
    );
    assertEquals(res.status, 404);
    assertEquals((await res.json()).error.code, "unknown_path");
    assertEquals(stub.captured.length, 0);
  } finally {
    stub.restore();
  }
});

Deno.test("/healthz answers without the secret and without touching upstream", async () => {
  const stub = stubFetch(okJson);
  try {
    const res = await handleRequest(
      new Request("https://ai.bookora.net/healthz"),
      env({ PROXY_SECRET: SECRET }),
    );
    assertEquals(res.status, 200);
    assertEquals((await res.json()).status, "ok");
    assertEquals(stub.captured.length, 0);
  } finally {
    stub.restore();
  }
});

// --- key handling, limits, streaming ---------------------------------------

Deno.test("the Authorization header is forwarded, never stored", async () => {
  const stub = stubFetch(okJson);
  try {
    await handleRequest(
      post("/v1/responses", { model: "gpt-4.1-mini" }, { "x-proxy-secret": SECRET }),
      env({ PROXY_SECRET: SECRET }),
    );
    const headers = stub.captured[0].init.headers as Headers;
    assertEquals(headers.get("authorization"), KEY);
    // Guard header must not leak to OpenAI.
    assertEquals(headers.get("x-proxy-secret"), null);
  } finally {
    stub.restore();
  }
});

Deno.test("a request without Authorization is rejected with 401", async () => {
  const stub = stubFetch(okJson);
  try {
    const res = await handleRequest(
      new Request("https://ai.bookora.net/v1/models", {
        headers: { "x-proxy-secret": SECRET },
      }),
      env({ PROXY_SECRET: SECRET }),
    );
    assertEquals(res.status, 401);
    assertEquals((await res.json()).error.code, "missing_authorization");
    assertEquals(stub.captured.length, 0);
  } finally {
    stub.restore();
  }
});

Deno.test("the model allowlist blocks unlisted models only when configured", async () => {
  const stub = stubFetch(okJson);
  try {
    const blocked = await handleRequest(
      post("/v1/chat/completions", { model: "o3-pro" }, { "x-proxy-secret": SECRET }),
      env({ PROXY_SECRET: SECRET, ALLOWED_MODELS: "gpt-4.1-mini,gpt-4.1" }),
    );
    assertEquals(blocked.status, 403);
    assertEquals((await blocked.json()).error.code, "model_not_allowed");
    assertEquals(stub.captured.length, 0);

    const allowed = await handleRequest(
      post("/v1/chat/completions", { model: "gpt-4.1" }, { "x-proxy-secret": SECRET }),
      env({ PROXY_SECRET: SECRET, ALLOWED_MODELS: "gpt-4.1-mini,gpt-4.1" }),
    );
    assertEquals(allowed.status, 200);
    assertEquals(stub.captured.length, 1);
  } finally {
    stub.restore();
  }
});

Deno.test("oversized bodies are rejected with 413", async () => {
  const stub = stubFetch(okJson);
  try {
    const res = await handleRequest(
      post("/v1/chat/completions", { model: "gpt-4.1-mini", input: "x".repeat(500) }, {
        "x-proxy-secret": SECRET,
      }),
      env({ PROXY_SECRET: SECRET, MAX_BODY_BYTES: "100" }),
    );
    assertEquals(res.status, 413);
    assertEquals(stub.captured.length, 0);
  } finally {
    stub.restore();
  }
});

Deno.test("upstream errors are relayed verbatim with their status", async () => {
  const stub = stubFetch(() =>
    new Response(
      JSON.stringify({
        error: { message: "Incorrect API key provided.", type: "invalid_request_error" },
      }),
      { status: 401, headers: { "content-type": "application/json" } },
    )
  );
  try {
    const res = await handleRequest(
      post("/v1/chat/completions", { model: "gpt-4.1-mini" }, { "x-proxy-secret": SECRET }),
      env({ PROXY_SECRET: SECRET }),
    );
    assertEquals(res.status, 401);
    assertEquals((await res.json()).error.message, "Incorrect API key provided.");
  } finally {
    stub.restore();
  }
});

Deno.test("SSE responses stream through with the upstream content-type", async () => {
  const chunks = [
    'data: {"choices":[{"delta":{"content":"سلام"}}]}\n\n',
    "data: [DONE]\n\n",
  ];
  const stub = stubFetch(() => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        for (const chunk of chunks) controller.enqueue(enc.encode(chunk));
        controller.close();
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream", "content-encoding": "gzip" },
    });
  });
  try {
    const res = await handleRequest(
      post("/v1/chat/completions", { model: "gpt-4.1-mini", stream: true }, {
        "x-proxy-secret": SECRET,
      }),
      env({ PROXY_SECRET: SECRET }),
    );
    assertEquals(res.headers.get("content-type"), "text/event-stream");
    // The runtime already decoded the body — a stale content-encoding must not survive.
    assertEquals(res.headers.get("content-encoding"), null);
    assertEquals(res.headers.get("x-accel-buffering"), "no");
    assertEquals(await res.text(), chunks.join(""));
  } finally {
    stub.restore();
  }
});

Deno.test("an unreachable upstream becomes a 502 with a clear body", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (() => Promise.reject(new Error("dns failure"))) as typeof fetch;
  try {
    const res = await handleRequest(
      post("/v1/chat/completions", { model: "gpt-4.1-mini" }, { "x-proxy-secret": SECRET }),
      env({ PROXY_SECRET: SECRET }),
    );
    assertEquals(res.status, 502);
    const body = await res.json();
    assertEquals(body.error.code, "upstream_unreachable");
    assert(body.error.message.includes("dns failure"));
  } finally {
    globalThis.fetch = original;
  }
});

// --- Responses API, background polling -------------------------------------
//
// The backend creates a background response, polls it by id and may cancel it.
// The poll and the cancel carry no model, so the allowlist must let them through;
// the create carries the alias, which a `prefix*` entry has to admit.

const RESPONSES_ALLOWLIST = "gpt-5*,gpt-4.1";

Deno.test("isModelAllowed matches exact entries and trailing-* prefixes only", () => {
  const allowed = parseAllowedModels(RESPONSES_ALLOWLIST);
  assert(isModelAllowed("gpt-5", allowed));
  assert(isModelAllowed("gpt-5-mini", allowed));
  assert(isModelAllowed("gpt-5-2025-08-07", allowed));
  assert(isModelAllowed("gpt-4.1", allowed));
  // An exact entry is not a prefix, and a wildcard never leaks to another family.
  assert(!isModelAllowed("gpt-4.1-mini", allowed));
  assert(!isModelAllowed("gpt-4.1-2025-04-14", allowed));
  assert(!isModelAllowed("o3-pro", allowed));
  assert(!isModelAllowed("gpt-4o", allowed));
  // No allowlist configured: everything passes.
  assert(isModelAllowed("anything", parseAllowedModels(undefined)));
});

Deno.test("the default header timeout is 120s", () => {
  assertEquals(DEFAULT_TIMEOUT_MS, 120000);
});

Deno.test("a background create on gpt-5 passes a gpt-5* allowlist", async () => {
  const stub = stubFetch(() => Response.json({ id: "resp_abc", status: "queued" }));
  try {
    const res = await handleRequest(
      post("/v1/responses", { model: "gpt-5", background: true, store: true }, {
        "x-proxy-secret": SECRET,
      }),
      env({ PROXY_SECRET: SECRET, ALLOWED_MODELS: RESPONSES_ALLOWLIST }),
    );
    assertEquals(res.status, 200);
    assertEquals((await res.json()).status, "queued");
    assertEquals(stub.captured.length, 1);
    assertEquals(stub.captured[0].url, "https://api.openai.com/v1/responses");
    assertEquals(stub.captured[0].init.method, "POST");
  } finally {
    stub.restore();
  }
});

Deno.test("a body-less poll GET /v1/responses/{id} is forwarded under an allowlist", async () => {
  const stub = stubFetch(() => Response.json({ id: "resp_abc", status: "in_progress" }));
  try {
    const res = await handleRequest(
      new Request("https://ai.bookora.net/v1/responses/resp_abc", {
        headers: { authorization: KEY, "x-proxy-secret": SECRET, accept: "application/json" },
      }),
      env({ PROXY_SECRET: SECRET, ALLOWED_MODELS: RESPONSES_ALLOWLIST }),
    );
    assertEquals(res.status, 200);
    assertEquals(stub.captured.length, 1);
    assertEquals(stub.captured[0].url, "https://api.openai.com/v1/responses/resp_abc");
    assertEquals(stub.captured[0].init.method, "GET");
    assertEquals(stub.captured[0].init.body, undefined);
    const headers = stub.captured[0].init.headers as Headers;
    assertEquals(headers.get("authorization"), KEY);
    assertEquals(headers.get("x-proxy-secret"), null);
  } finally {
    stub.restore();
  }
});

Deno.test("an empty-body cancel POST is forwarded under an allowlist", async () => {
  const stub = stubFetch(() => Response.json({ id: "resp_abc", status: "cancelled" }));
  try {
    const res = await handleRequest(
      new Request("https://ai.bookora.net/v1/responses/resp_abc/cancel", {
        method: "POST",
        headers: { authorization: KEY, "x-proxy-secret": SECRET, accept: "application/json" },
      }),
      env({ PROXY_SECRET: SECRET, ALLOWED_MODELS: RESPONSES_ALLOWLIST }),
    );
    assertEquals(res.status, 200);
    assertEquals(stub.captured.length, 1);
    assertEquals(stub.captured[0].url, "https://api.openai.com/v1/responses/resp_abc/cancel");
    assertEquals(stub.captured[0].init.method, "POST");
  } finally {
    stub.restore();
  }
});

Deno.test("gpt-4.1-mini is refused by a gpt-5*,gpt-4.1 allowlist", async () => {
  const stub = stubFetch(okJson);
  try {
    const res = await handleRequest(
      post("/v1/responses", { model: "gpt-4.1-mini", background: true }, {
        "x-proxy-secret": SECRET,
      }),
      env({ PROXY_SECRET: SECRET, ALLOWED_MODELS: RESPONSES_ALLOWLIST }),
    );
    assertEquals(res.status, 403);
    assertEquals((await res.json()).error.code, "model_not_allowed");
    assertEquals(stub.captured.length, 0);
  } finally {
    stub.restore();
  }
});

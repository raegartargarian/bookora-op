/**
 * Node test for the Cloudflare/Netlify builds of the relay: path forwarding and
 * the secret guard. Run with `npm test` (node --test, no dependencies).
 *
 * `globalThis.fetch` is stubbed so nothing leaves the machine; the stub records
 * what the proxy would have sent upstream.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import worker, {
  DEFAULT_TIMEOUT_MS,
  extractModel,
  handleRequest,
  isModelAllowed,
  parseAllowedModels,
  resolveUpstreamPath,
  safeEqual,
} from '../worker.js';
import {
  DEFAULT_TIMEOUT_MS as NETLIFY_DEFAULT_TIMEOUT_MS,
  handleRequest as netlifyHandleRequest,
  isModelAllowed as netlifyIsModelAllowed,
} from '../netlify/functions/proxy.mjs';

const SECRET = 's3cret-value';
const KEY = 'Bearer sk-test-key';

function stubFetch(response) {
  const captured = [];
  const original = globalThis.fetch;
  globalThis.fetch = (url, init = {}) => {
    captured.push({ url: String(url), init });
    return Promise.resolve(response());
  };
  return {
    captured,
    restore() {
      globalThis.fetch = original;
    },
  };
}

const okJson = () =>
  new Response(JSON.stringify({ id: 'chatcmpl-1' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

function post(path, body, headers = {}) {
  return new Request(`https://ai.bookora.net${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: KEY, ...headers },
    body: JSON.stringify(body),
  });
}

test('resolveUpstreamPath forwards the whole /v1 path from any host shape', () => {
  assert.equal(resolveUpstreamPath('/v1/chat/completions'), '/v1/chat/completions');
  assert.equal(resolveUpstreamPath('/v1/responses'), '/v1/responses');
  assert.equal(resolveUpstreamPath('/v1/embeddings'), '/v1/embeddings');
  assert.equal(resolveUpstreamPath('/v1/models/gpt-4.1'), '/v1/models/gpt-4.1');
  assert.equal(resolveUpstreamPath('/ai/v1/chat/completions'), '/v1/chat/completions');
  assert.equal(
    resolveUpstreamPath('/.netlify/functions/proxy/v1/chat/completions'),
    '/v1/chat/completions',
  );
  assert.equal(resolveUpstreamPath('/'), null);
  assert.equal(resolveUpstreamPath('/wp-login.php'), null);
});

test('safeEqual compares exactly and tolerates non-strings', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
  assert.equal(safeEqual(null, 'abc'), false);
});

test('parseAllowedModels trims and drops empties', () => {
  assert.deepEqual([...parseAllowedModels(' gpt-4.1-mini , gpt-4.1 ,')], [
    'gpt-4.1-mini',
    'gpt-4.1',
  ]);
  assert.equal(parseAllowedModels(undefined).size, 0);
});

test('extractModel only reads JSON bodies', () => {
  const bytes = new TextEncoder().encode('{"model":"gpt-4.1-mini"}');
  assert.equal(extractModel(bytes, 'application/json'), 'gpt-4.1-mini');
  assert.equal(extractModel(bytes, 'multipart/form-data; boundary=x'), null);
  assert.equal(extractModel(null, 'application/json'), null);
});

test('secret guard blocks missing and wrong secrets before any upstream call', async () => {
  const stub = stubFetch(okJson);
  try {
    const missing = await handleRequest(post('/v1/chat/completions', {}), {
      PROXY_SECRET: SECRET,
    });
    assert.equal(missing.status, 403);
    assert.equal((await missing.json()).error.code, 'invalid_proxy_secret');

    const wrong = await handleRequest(
      post('/v1/chat/completions', {}, { 'x-proxy-secret': 'nope' }),
      { PROXY_SECRET: SECRET },
    );
    assert.equal(wrong.status, 403);
    assert.equal(stub.captured.length, 0);
  } finally {
    stub.restore();
  }
});

test('the default export forwards a guarded request to api.openai.com', async () => {
  const stub = stubFetch(okJson);
  try {
    const res = await worker.fetch(
      post('/v1/chat/completions', { model: 'gpt-4.1-mini' }, { 'x-proxy-secret': SECRET }),
      { PROXY_SECRET: SECRET },
    );
    assert.equal(res.status, 200);
    assert.equal(stub.captured.length, 1);
    assert.equal(stub.captured[0].url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(stub.captured[0].init.headers.get('authorization'), KEY);
    assert.equal(stub.captured[0].init.headers.get('x-proxy-secret'), null);
  } finally {
    stub.restore();
  }
});

test('query strings survive and non-/v1 paths 404', async () => {
  const stub = stubFetch(okJson);
  try {
    const ok = await handleRequest(
      new Request('https://ai.bookora.net/v1/models?limit=5', {
        headers: { authorization: KEY, 'x-proxy-secret': SECRET },
      }),
      { PROXY_SECRET: SECRET },
    );
    assert.equal(ok.status, 200);
    assert.equal(stub.captured[0].url, 'https://api.openai.com/v1/models?limit=5');

    const missed = await handleRequest(
      new Request('https://ai.bookora.net/admin', {
        headers: { authorization: KEY, 'x-proxy-secret': SECRET },
      }),
      { PROXY_SECRET: SECRET },
    );
    assert.equal(missed.status, 404);
    assert.equal(stub.captured.length, 1);
  } finally {
    stub.restore();
  }
});

test('a request without Authorization is rejected with 401', async () => {
  const stub = stubFetch(okJson);
  try {
    const res = await handleRequest(
      new Request('https://ai.bookora.net/v1/models', { headers: { 'x-proxy-secret': SECRET } }),
      { PROXY_SECRET: SECRET },
    );
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error.code, 'missing_authorization');
    assert.equal(stub.captured.length, 0);
  } finally {
    stub.restore();
  }
});

test('the model allowlist blocks unlisted models', async () => {
  const stub = stubFetch(okJson);
  const env = { PROXY_SECRET: SECRET, ALLOWED_MODELS: 'gpt-4.1-mini,gpt-4.1' };
  try {
    const blocked = await handleRequest(
      post('/v1/chat/completions', { model: 'o3-pro' }, { 'x-proxy-secret': SECRET }),
      env,
    );
    assert.equal(blocked.status, 403);
    assert.equal((await blocked.json()).error.code, 'model_not_allowed');

    const allowed = await handleRequest(
      post('/v1/chat/completions', { model: 'gpt-4.1' }, { 'x-proxy-secret': SECRET }),
      env,
    );
    assert.equal(allowed.status, 200);
    assert.equal(stub.captured.length, 1);
  } finally {
    stub.restore();
  }
});

test('oversized bodies are rejected with 413', async () => {
  const stub = stubFetch(okJson);
  try {
    const res = await handleRequest(
      post(
        '/v1/chat/completions',
        { model: 'gpt-4.1-mini', input: 'x'.repeat(500) },
        { 'x-proxy-secret': SECRET },
      ),
      { PROXY_SECRET: SECRET, MAX_BODY_BYTES: '100' },
    );
    assert.equal(res.status, 413);
    assert.equal(stub.captured.length, 0);
  } finally {
    stub.restore();
  }
});

test('SSE responses stream through untouched', async () => {
  const chunks = ['data: {"choices":[{"delta":{"content":"سلام"}}]}\n\n', 'data: [DONE]\n\n'];
  const stub = stubFetch(() => {
    const enc = new TextEncoder();
    const body = new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(enc.encode(chunk));
        controller.close();
      },
    });
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'content-encoding': 'gzip' },
    });
  });
  try {
    const res = await handleRequest(
      post(
        '/v1/chat/completions',
        { model: 'gpt-4.1-mini', stream: true },
        { 'x-proxy-secret': SECRET },
      ),
      { PROXY_SECRET: SECRET },
    );
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    assert.equal(res.headers.get('content-encoding'), null);
    assert.equal(res.headers.get('x-accel-buffering'), 'no');
    assert.equal(await res.text(), chunks.join(''));
  } finally {
    stub.restore();
  }
});

test('upstream failure becomes a 502 with an OpenAI-shaped body', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = () => Promise.reject(new Error('dns failure'));
  try {
    const res = await handleRequest(
      post('/v1/chat/completions', { model: 'gpt-4.1-mini' }, { 'x-proxy-secret': SECRET }),
      { PROXY_SECRET: SECRET },
    );
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.error.code, 'upstream_unreachable');
    assert.match(body.error.message, /dns failure/);
  } finally {
    globalThis.fetch = original;
  }
});

test('the Netlify build behaves identically behind its /ai prefix', async () => {
  const stub = stubFetch(okJson);
  try {
    const blocked = await netlifyHandleRequest(post('/ai/v1/chat/completions', {}), {
      PROXY_SECRET: SECRET,
    });
    assert.equal(blocked.status, 403);

    const ok = await netlifyHandleRequest(
      post('/ai/v1/chat/completions', { model: 'gpt-4.1-mini' }, { 'x-proxy-secret': SECRET }),
      { PROXY_SECRET: SECRET },
    );
    assert.equal(ok.status, 200);
    assert.equal(stub.captured[0].url, 'https://api.openai.com/v1/chat/completions');

    const health = await netlifyHandleRequest(new Request('https://x.netlify.app/ai/healthz'), {
      PROXY_SECRET: SECRET,
    });
    assert.equal(health.status, 200);
    assert.equal((await health.json()).status, 'ok');
  } finally {
    stub.restore();
  }
});

// --- fail closed on a missing PROXY_SECRET ---------------------------------
//
// The guard used to be `if (env.PROXY_SECRET && !safeEqual(...))`, so a deploy
// that forgot the variable served EVERY caller: an open, anonymising relay to
// api.openai.com on our hostname, at a public Deno Deploy URL. The relay now
// refuses to serve at all rather than serve unauthenticated.

test('an unset PROXY_SECRET refuses to serve instead of relaying (worker)', async () => {
  const stub = stubFetch(okJson);
  try {
    for (const env of [{}, { PROXY_SECRET: '' }, { PROXY_SECRET: '   ' }]) {
      const res = await handleRequest(
        post('/v1/chat/completions', { model: 'gpt-4.1-mini' }, { 'x-proxy-secret': SECRET }),
        env,
      );
      assert.equal(res.status, 503);
      assert.equal((await res.json()).error.code, 'proxy_not_configured');
    }
    assert.equal(stub.captured.length, 0);
  } finally {
    stub.restore();
  }
});

test('an unset PROXY_SECRET refuses to serve instead of relaying (netlify)', async () => {
  const stub = stubFetch(okJson);
  try {
    const res = await netlifyHandleRequest(
      post('/ai/v1/chat/completions', { model: 'gpt-4.1-mini' }, { 'x-proxy-secret': SECRET }),
      {},
    );
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error.code, 'proxy_not_configured');
    assert.equal(stub.captured.length, 0);
  } finally {
    stub.restore();
  }
});

test('/healthz reports the misconfiguration loudly instead of answering ok', async () => {
  const healthy = await handleRequest(new Request('https://ai.bookora.net/healthz'), {
    PROXY_SECRET: SECRET,
  });
  assert.equal(healthy.status, 200);
  assert.equal((await healthy.json()).status, 'ok');

  const broken = await handleRequest(new Request('https://ai.bookora.net/healthz'), {});
  assert.equal(broken.status, 503);
  const body = await broken.json();
  assert.equal(body.status, 'misconfigured');
  assert.match(body.error, /PROXY_SECRET/);

  const brokenNetlify = await netlifyHandleRequest(
    new Request('https://site.netlify.app/ai/healthz'),
    {},
  );
  assert.equal(brokenNetlify.status, 503);
  assert.equal((await brokenNetlify.json()).status, 'misconfigured');
});

// --- Responses API, background polling -------------------------------------
//
// The backend creates a background response, polls it by id and may cancel it.
// The poll and the cancel carry no model, so the allowlist must let them through;
// the create carries the alias, which a `prefix*` entry has to admit.

const RESPONSES_ALLOWLIST = 'gpt-5*,gpt-4.1';

test('isModelAllowed matches exact entries and trailing-* prefixes only', () => {
  for (const check of [isModelAllowed, netlifyIsModelAllowed]) {
    const allowed = parseAllowedModels(RESPONSES_ALLOWLIST);
    assert.equal(check('gpt-5', allowed), true);
    assert.equal(check('gpt-5-mini', allowed), true);
    assert.equal(check('gpt-5-2025-08-07', allowed), true);
    assert.equal(check('gpt-4.1', allowed), true);
    // An exact entry is not a prefix, and a wildcard never leaks to another family.
    assert.equal(check('gpt-4.1-mini', allowed), false);
    assert.equal(check('gpt-4.1-2025-04-14', allowed), false);
    assert.equal(check('o3-pro', allowed), false);
    assert.equal(check('gpt-4o', allowed), false);
    // No allowlist configured: everything passes.
    assert.equal(check('anything', parseAllowedModels(undefined)), true);
  }
});

test('the default header timeout is 120s (worker) and stays 9s (netlify)', () => {
  assert.equal(DEFAULT_TIMEOUT_MS, 120000);
  assert.equal(NETLIFY_DEFAULT_TIMEOUT_MS, 9000);
});

test('a background create on gpt-5 passes a gpt-5* allowlist', async () => {
  const stub = stubFetch(() => Response.json({ id: 'resp_abc', status: 'queued' }));
  try {
    const res = await handleRequest(
      post(
        '/v1/responses',
        { model: 'gpt-5', background: true, store: true },
        { 'x-proxy-secret': SECRET },
      ),
      { PROXY_SECRET: SECRET, ALLOWED_MODELS: RESPONSES_ALLOWLIST },
    );
    assert.equal(res.status, 200);
    assert.equal((await res.json()).status, 'queued');
    assert.equal(stub.captured.length, 1);
    assert.equal(stub.captured[0].url, 'https://api.openai.com/v1/responses');
    assert.equal(stub.captured[0].init.method, 'POST');
  } finally {
    stub.restore();
  }
});

test('a body-less poll GET /v1/responses/{id} is forwarded under an allowlist', async () => {
  const stub = stubFetch(() => Response.json({ id: 'resp_abc', status: 'in_progress' }));
  try {
    const res = await handleRequest(
      new Request('https://ai.bookora.net/v1/responses/resp_abc', {
        headers: { authorization: KEY, 'x-proxy-secret': SECRET, accept: 'application/json' },
      }),
      { PROXY_SECRET: SECRET, ALLOWED_MODELS: RESPONSES_ALLOWLIST },
    );
    assert.equal(res.status, 200);
    assert.equal(stub.captured.length, 1);
    assert.equal(stub.captured[0].url, 'https://api.openai.com/v1/responses/resp_abc');
    assert.equal(stub.captured[0].init.method, 'GET');
    assert.equal(stub.captured[0].init.body, undefined);
    assert.equal(stub.captured[0].init.headers.get('authorization'), KEY);
    assert.equal(stub.captured[0].init.headers.get('x-proxy-secret'), null);
  } finally {
    stub.restore();
  }
});

test('an empty-body cancel POST is forwarded under an allowlist', async () => {
  const stub = stubFetch(() => Response.json({ id: 'resp_abc', status: 'cancelled' }));
  try {
    const res = await handleRequest(
      new Request('https://ai.bookora.net/v1/responses/resp_abc/cancel', {
        method: 'POST',
        headers: { authorization: KEY, 'x-proxy-secret': SECRET, accept: 'application/json' },
      }),
      { PROXY_SECRET: SECRET, ALLOWED_MODELS: RESPONSES_ALLOWLIST },
    );
    assert.equal(res.status, 200);
    assert.equal(stub.captured.length, 1);
    assert.equal(stub.captured[0].url, 'https://api.openai.com/v1/responses/resp_abc/cancel');
    assert.equal(stub.captured[0].init.method, 'POST');
  } finally {
    stub.restore();
  }
});

test('gpt-4.1-mini is refused by a gpt-5*,gpt-4.1 allowlist (worker and netlify)', async () => {
  const stub = stubFetch(okJson);
  const env = { PROXY_SECRET: SECRET, ALLOWED_MODELS: RESPONSES_ALLOWLIST };
  try {
    const body = { model: 'gpt-4.1-mini', background: true };
    const res = await handleRequest(
      post('/v1/responses', body, { 'x-proxy-secret': SECRET }),
      env,
    );
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error.code, 'model_not_allowed');

    const viaNetlify = await netlifyHandleRequest(
      post('/ai/v1/responses', body, { 'x-proxy-secret': SECRET }),
      env,
    );
    assert.equal(viaNetlify.status, 403);
    assert.equal((await viaNetlify.json()).error.code, 'model_not_allowed');
    assert.equal(stub.captured.length, 0);

    const poll = await netlifyHandleRequest(
      new Request('https://x.netlify.app/ai/v1/responses/resp_abc', {
        headers: { authorization: KEY, 'x-proxy-secret': SECRET },
      }),
      env,
    );
    assert.equal(poll.status, 200);
    assert.equal(stub.captured[0].url, 'https://api.openai.com/v1/responses/resp_abc');
  } finally {
    stub.restore();
  }
});

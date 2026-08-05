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
  extractModel,
  handleRequest,
  parseAllowedModels,
  resolveUpstreamPath,
  safeEqual,
} from '../worker.js';
import { handleRequest as netlifyHandleRequest } from '../netlify/functions/proxy.mjs';

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

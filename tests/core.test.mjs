import test from 'node:test';
import assert from 'node:assert/strict';
import { createGoClient, SessionVault, preparePayload, publicError } from '../server/core.mjs';
import { protocolFor, MODELS_URL, decorateModels } from '../server/catalog.mjs';
import { createHandlers, init, exit } from '../server/index.mjs';
import { base, catalog, key, sessionId, tools, jsonResult, streamEvents, sseResponse, eventsFrom, mockRequest, MockResponse, invoke } from './helpers.mjs';

for (const [protocol, model] of [['chat', 'glm-5.2'], ['responses', 'gpt-6-luna'], ['messages', 'claude-haiku-5-5']]) {
    for (const stream of [false, true]) test(`${protocol}: ${stream ? 'SSE' : 'JSON'} fixed URL, own headers, tool delta`, async () => {
        const calls = [];
        const client = createGoClient({ fetchImpl: async (url, options) => {
            calls.push({ url, options });
            if (url === MODELS_URL) { assert.equal(options.headers.Authorization, undefined); return Response.json(catalog); }
            assert.ok(url.startsWith('https://opencode.ai/inference/go/'));
            assert.equal(options.headers.Authorization, `Bearer ${key}`);
            assert.equal(options.headers['x-opencode-session'], sessionId);
            assert.equal(options.headers['User-Agent'], 'sillytavern-opencode-go-bridge/0.2.0');
            assert.equal(options.redirect, 'error');
            return stream ? sseResponse(streamEvents(protocol, model, true), 1) : Response.json(jsonResult(protocol, model, true));
        } });
        const response = await client.generate(base(model, { stream, tools, tool_choice: 'auto' }), { key, sessionId });
        if (stream) { const es = await eventsFrom(response); assert.ok(es.some(e => e.choices?.[0]?.delta?.tool_calls)); assert.ok(!es.some(e => e.error)); }
        else { const r = await response.json(); assert.equal(r.choices[0].message.tool_calls[0].id, 'call_add'); }
        assert.equal(calls.length, 2);
    });
}
test('catalog: protocol evidence intersection, no invented capabilities', () => {
    const models = decorateModels(catalog);
    assert.equal(models.find(m => m.id === 'omen-alpha').supported, false);
    assert.equal(models.find(m => m.id === 'gemini-4-argon-contributor').supported, false);
    assert.equal(models.find(m => m.id === 'gpt-6-luna').protocol, 'responses');
    assert.ok(models.every(m => m.capabilities.vision === 'unverified'));
    assert.equal(protocolFor('gpt-invented'), 'unknown');
});
test('native payload keeps image/tools/reasoning history and maps JSON schema', () => {
    const messages = [{ role: 'assistant', content: null, reasoning_content: 'test', tool_calls: [] }, { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }];
    const r = preparePayload(base('glm-5.2', { messages, tools, user_name: 'synthetic name', reasoning_effort: 'auto', logprobs: 2, json_schema: { name: 'x', value: { type: 'object' } } }), { native: true });
    assert.deepEqual(r.messages, messages); assert.deepEqual(r.tools, tools); assert.equal(r.reasoning_effort, undefined);
    assert.equal(r.top_logprobs, 2); assert.equal(r.logprobs, true); assert.equal(r.response_format.type, 'json_schema');
});
test('unknown options/YAML/post-processing never silently disappear', () => {
    for (const extra of [{ custom_include_headers: 'User-Agent: fake' }, { custom_include_body: 'x: y' }, { custom_prompt_post_processing: 'merge' }, { request_images: true }, { audio: {} }, { alien_option: 1 }]) assert.throws(() => preparePayload(base('glm-5.2', extra)), /不支持|不解析|后处理|字段/);
});
test('max body size enforced before network', () => assert.throws(() => preparePayload(base('glm-5.2', { messages: [{ role: 'user', content: '字'.repeat(3 * 1024 * 1024) }] })), /8 MiB/));
test('vault isolates user and browser tokens, expires and aborts', () => {
    let now = 1; const vault = new SessionVault({ now: () => now, ttlMs: 10 });
    const a = vault.open('alice', key); const b = vault.open('alice', 'ANOTHER_FAKE_KEY');
    assert.notEqual(a.token, b.token); assert.equal(vault.get('alice', b.token).key, 'ANOTHER_FAKE_KEY');
    assert.throws(() => vault.get('bob', a.token));
    const c = new AbortController(); vault.get('alice', a.token).controllers.add(c);
    now = 20; vault.sweep(); assert.equal(c.signal.aborted, true); assert.throws(() => vault.get('alice', a.token));
});
for (const status of [401, 403, 429, 500, 302]) test(`HTTP ${status}: no raw error leak, retry or billing fallback`, async () => {
    let calls = 0; const client = createGoClient({ fetchImpl: async url => {
        calls++; return url === MODELS_URL ? Response.json(catalog) : new Response(`LEAK ${key}`, { status });
    } });
    await assert.rejects(client.generate(base(), { key, sessionId }), error => { assert.ok(!JSON.stringify(publicError(error)).includes(key)); return true; });
    assert.equal(calls, 2);
});
test('redirect/network exception with credentials is sanitized', () => assert.ok(!JSON.stringify(publicError(new Error(key))).includes(key)));
test('cancel abort signal reaches upstream', async () => {
    const controller = new AbortController(); let started;
    const ready = new Promise(r => { started = r; });
    const client = createGoClient({ fetchImpl: async (url, options) => {
        if (url === MODELS_URL) return Response.json(catalog);
        started(); return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
    } });
    const pending = client.generate(base(), { key, sessionId, signal: controller.signal });
    await ready; controller.abort(); await assert.rejects(pending, { name: 'AbortError' });
});
test('session routes enforce CSRF, login, origin and TLS', async () => {
    const h = createHandlers();
    for (const overrides of [{ user: undefined }, { session: {} }, { headers: {} }, { headers: { host: 'localhost:8000', origin: 'https://evil.test', 'x-st-go-client': '1', 'x-csrf-token': 'TEST_CSRF' } }, { secure: false, socket: { remoteAddress: '192.0.2.3' } }]) {
        const response = await invoke(h.connect, mockRequest({ key, usageAcknowledged: true }, overrides)); assert.ok(response.status >= 400);
    }
    const response = await invoke(h.connect, mockRequest({ key, usageAcknowledged: true }));
    assert.equal(response.status, 200); assert.ok(!(await response.text()).includes(key));
});
test('public Chat endpoint is authenticated and preserves pipeline', async () => {
    const client = createGoClient({ fetchImpl: async url => url === MODELS_URL ? Response.json(catalog) : Response.json(jsonResult('chat', 'glm-5.2')) });
    const h = createHandlers({ client }); const session = h.vault.open('user-a', key);
    const req = mockRequest(base()); req.headers['x-st-go-token'] = session.token; req.headers['x-opencode-session'] = sessionId;
    const result = await invoke(h.compatible, req); assert.equal((await result.json()).choices[0].message.content, '你好');
    const other = mockRequest({ payload: base(), sessionId }, { user: { profile: { handle: 'other' } } }); other.headers['x-st-go-token'] = session.token;
    assert.equal((await invoke(h.generate, other)).status, 401);
});
test('response close cancels active request and cleans controller', async () => {
    let started; const ready = new Promise(r => { started = r; }); let observed;
    const h = createHandlers({ client: { generate: async (_, { signal }) => { observed = signal; started(); return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))); } } });
    const session = h.vault.open('user-a', key); const req = mockRequest({ payload: base(), sessionId }); req.headers['x-st-go-token'] = session.token;
    const res = new MockResponse(); const task = h.generate(req, res); await ready; res.destroy(); await task;
    assert.equal(observed.aborted, true); assert.equal(h.vault.get('user-a', session.token).controllers.size, 0);
});
test('server plugin lifecycle registers only its router routes', async () => {
    const routes = []; const router = Object.fromEntries(['post', 'get', 'delete'].map(method => [method, path => routes.push(method + ' ' + path)]));
    await init(router); await exit(); assert.ok(routes.includes('post /v1/chat/completions')); assert.equal(routes.length, 6);
});
test('vault global and per-owner caps do not share or evict credentials', () => {
    const vault = new SessionVault({ max: 2, perOwner: 1 }); const a = vault.open('a', key);
    assert.throws(() => vault.open('a', key), /用户/); vault.open('b', key);
    assert.throws(() => vault.open('c', key), /上限/); assert.equal(vault.get('a', a.token).key, key);
});
test('fifth concurrent request is rejected without upstream work', async () => {
    let calls = 0; const h = createHandlers({ client: { generate() { calls++; } } });
    const session = h.vault.open('user-a', key); const state = h.vault.get('user-a', session.token);
    for (let i = 0; i < 4; i++) state.controllers.add(new AbortController());
    const req = mockRequest({ payload: base(), sessionId }); req.headers['x-st-go-token'] = session.token;
    assert.equal((await invoke(h.generate, req)).status, 429); assert.equal(calls, 0); h.vault.clear();
});
test('server timeout aborts upstream and removes request listeners/controllers', async () => {
    let observed;
    const h = createHandlers({ timeoutMs: 10, client: { generate: (_, { signal }) => {
        observed = signal; return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    } } });
    const session = h.vault.open('user-a', key); const req = mockRequest({ payload: base(), sessionId }); req.headers['x-st-go-token'] = session.token;
    const keepAlive = setTimeout(() => {}, 1000);
    try { assert.equal((await invoke(h.generate, req)).status, 502); } finally { clearTimeout(keepAlive); }
    assert.equal(observed.aborted, true); assert.equal(h.vault.get('user-a', session.token).controllers.size, 0); assert.equal(req.listenerCount('aborted'), 0);
});

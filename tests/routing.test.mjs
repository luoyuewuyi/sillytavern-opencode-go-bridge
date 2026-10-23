import test from 'node:test';
import assert from 'node:assert/strict';
import { GO_CHAT_BASE, GO_MODELS_BASE, GENERATE_PATH, STATUS_PATH, USER_AGENT, addGoHeaders, createSessionIds } from '../routing.mjs';
import { harness, send, payload, sentBody, origin } from './helpers.mjs';

test('installation is immediate and only headers change on a native Custom Go request', async () => {
    const h = harness(); const original = payload({ temperature: 0.8, reasoning_effort: 'medium', tools: [{ type: 'function', function: { name: 'test' } }], custom_include_body: 'custom: value' });
    await send(h, original, { headers: { 'X-CSRF-Token': 'FAKE_CSRF' }, credentials: 'same-origin' });
    const sent = sentBody(h); const added = JSON.parse(sent.custom_include_headers); delete sent.custom_include_headers;
    assert.deepEqual(sent, original); assert.equal(added['User-Agent'], USER_AGENT); assert.match(added['x-opencode-session'], /^stgo_[a-f0-9]{32}$/);
    assert.equal(added.Authorization, undefined); assert.equal(h.calls[0][1].headers['X-CSRF-Token'], 'FAKE_CSRF');
});
test('status supports current Chat and official directory bases without URL rewriting or model filtering', async () => {
    const h = harness();
    for (const base of [GO_CHAT_BASE, GO_MODELS_BASE]) {
        const data = payload({ custom_url: base }); await h.scope.fetch(STATUS_PATH, { method: 'POST', body: JSON.stringify(data) });
        assert.equal(sentBody(h).custom_url, base); assert.equal(JSON.parse(sentBody(h).custom_include_headers)['User-Agent'], USER_AGENT);
    }
});
for (const url of ['https://api.openai.com/v1', 'https://opencode.ai/zen/v1', 'https://opencode.ai/zen/go/v1', 'https://opencode.ai/inference/openai/v1', 'http://opencode.ai/inference/go/openai/v1', 'https://opencode.ai.evil.test/inference/go/openai/v1', 'https://u:p@opencode.ai/inference/go/openai/v1', GO_CHAT_BASE + '?x=1', GO_CHAT_BASE + '#x', GO_CHAT_BASE + '/extra', 'https://opencode.ai:8443/inference/go/openai/v1', 'https://opencode.ai/a/../inference/go/openai/v1', 'https://opencode.ai/inference/go/openai/%76%31']) {
    test(`unrelated/near-match URL has zero mutation: ${url}`, async () => {
        const h = harness({ parseYaml: () => { throw new Error('must not parse'); } });
        const init = { method: 'POST', headers: { test: 'keep' }, body: ' { "chat_completion_source":"custom", "custom_url":' + JSON.stringify(url) + ', "custom_include_headers":"unparsed: text" } ' };
        await h.scope.fetch(GENERATE_PATH, init); assert.equal(h.calls[0][0], GENERATE_PATH); assert.equal(h.calls[0][1], init);
    });
}
test('non-Custom native paths, direct URLs, unrelated origins, query URLs and malformed bodies pass exactly', async () => {
    const h = harness();
    const cases = [[GENERATE_PATH, { chat_completion_source: 'openai', reverse_proxy: GO_CHAT_BASE, proxy_password: 'FAKE_ST_PROXY_PASSWORD' }],
        [GENERATE_PATH, payload({ chat_completion_source: 'claude' })], [GO_CHAT_BASE + '/chat/completions', payload()],
        ['https://other.test' + GENERATE_PATH, payload()], [GENERATE_PATH + '?x=1', payload()], ['/api/other', payload()]];
    for (const [url, data] of cases) { const init = { method: 'POST', body: JSON.stringify(data) }; await h.scope.fetch(url, init); assert.equal(h.calls.at(-1)[1], init); }
    const init = { method: 'POST', body: 'not JSON' }; await h.scope.fetch(GENERATE_PATH, init); assert.equal(h.calls.at(-1)[1], init);
});
test('other-provider large payload and Request object preserve original argument identity', async () => {
    const h = harness(); const req = new Request(origin + GENERATE_PATH, { method: 'POST', body: JSON.stringify(payload({ custom_url: 'https://else.test', messages: ['x'.repeat(9 * 1024 * 1024)] })) });
    await h.scope.fetch(req); assert.equal(h.calls[0][0], req); assert.equal(req.bodyUsed, false);
});
test('JSON headers preserve Authorization and all unrelated values; UA is truthful and case-deduplicated', () => {
    const raw = JSON.stringify({ Authorization: 'Bearer FAKE_EXPLICIT_USER_HEADER', 'X-Test': 'keep', 'user-agent': 'custom-old', 'USER-AGENT': 'other-old', 'X-OpenCode-Session': 'existing-session:123' });
    const result = JSON.parse(addGoHeaders(raw, 'generated-session', JSON.parse));
    assert.equal(result.Authorization, 'Bearer FAKE_EXPLICIT_USER_HEADER'); assert.equal(result['X-Test'], 'keep');
    assert.equal(result['User-Agent'], USER_AGENT); assert.equal(result['x-opencode-session'], 'existing-session:123'); assert.equal(Object.keys(result).length, 4);
});
test('ST YAML object and list semantics preserved; invalid session replaced', () => {
    const parse = text => { assert.equal(text, 'fixture YAML'); return [{ 'X-One': 'one', 'x-opencode-session': 'bad\nvalue' }, null, ['skip'], { 'X-Two': 'two' }]; };
    assert.deepEqual(JSON.parse(addGoHeaders('fixture YAML', 'generated', parse)), { 'X-One': 'one', 'X-Two': 'two', 'User-Agent': USER_AGENT, 'x-opencode-session': 'generated' });
    for (const invalid of ['', 123, 'a'.repeat(129), '\tbad']) assert.equal(JSON.parse(addGoHeaders(JSON.stringify({ 'x-opencode-session': invalid }), 'new', JSON.parse))['x-opencode-session'], 'new');
});
test('malformed Go YAML fails clearly without forwarding/logging its content', async () => {
    const h = harness(); const response = await send(h, payload({ custom_include_headers: 'FAKE_PRIVATE_VALUE: [' }));
    assert.equal(response.status, 400); assert.ok(!(await response.text()).includes('FAKE_PRIVATE_VALUE')); assert.equal(h.calls.length, 0);
});
test('chat switching and retry retain opaque per-chat IDs; tabs and no-chat scope separated', async () => {
    const h = harness(); const ids = [];
    for (const chat of ['chat-A', 'chat-A', 'chat-B', null, 'chat-A', null]) { h.setChat(chat); await send(h); ids.push(JSON.parse(sentBody(h).custom_include_headers)['x-opencode-session']); }
    assert.equal(ids[0], ids[1]); assert.equal(ids[0], ids[4]); assert.equal(ids[3], ids[5]); assert.equal(new Set(ids).size, 3);
    assert.ok(ids.every(id => !id.includes('chat'))); const tab = harness(); await send(tab); assert.ok(!ids.includes(JSON.parse(sentBody(tab).custom_include_headers)['x-opencode-session']));
});
test('status and generation for the same chat use the same session; supplied valid session wins', async () => {
    const h = harness(); await send(h); const a = JSON.parse(sentBody(h).custom_include_headers)['x-opencode-session'];
    await h.scope.fetch(STATUS_PATH, { method: 'POST', body: JSON.stringify(payload()) }); assert.equal(JSON.parse(sentBody(h).custom_include_headers)['x-opencode-session'], a);
    await send(h, payload({ custom_include_headers: '{"x-opencode-session":"caller-fixed"}' })); assert.equal(JSON.parse(sentBody(h).custom_include_headers)['x-opencode-session'], 'caller-fixed');
});
test('Request input keeps headers, signal, credentials, options, source body and init overrides', async () => {
    const h = harness(); const ac = new AbortController();
    const req = new Request(origin + GENERATE_PATH, { method: 'POST', headers: { 'X-CSRF-Token': 'FAKE_CSRF' }, credentials: 'include', cache: 'no-store', signal: ac.signal, body: JSON.stringify(payload()) });
    await h.scope.fetch(req); const outgoing = h.calls[0][0]; assert.ok(outgoing instanceof Request); assert.equal(req.bodyUsed, false);
    assert.equal(outgoing.headers.get('x-csrf-token'), 'FAKE_CSRF'); assert.equal(outgoing.credentials, 'include'); assert.equal(outgoing.cache, 'no-store');
    ac.abort(); assert.equal(outgoing.signal.aborted, true); assert.equal((await outgoing.json()).secret_id, 'FAKE_SECRET_REFERENCE');
    await h.scope.fetch(req, { signal: new AbortController().signal, body: JSON.stringify(payload({ model: 'any-model' })) }); assert.equal((await h.calls[1][0].json()).model, 'any-model');
});
test('Response identity, fragmented SSE bytes, errors and cancellation remain owned by native fetch', async () => {
    const bytes = new TextEncoder().encode('data: {"choices":[{"delta":{"content":"你好","reasoning_content":"t"}}]}\r\n\r\ndata: [DONE]\n\n');
    let offset = 0; let cancelled = false;
    const response = new Response(new ReadableStream({ pull(c) { if (offset === bytes.length) c.close(); else c.enqueue(bytes.slice(offset, ++offset)); }, cancel() { cancelled = true; } }), { headers: { 'Content-Type': 'text/event-stream' } });
    const h = harness({ fetch: async () => response }); assert.equal(await send(h, payload({ stream: true })), response); assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
    const errorResponse = Response.json({ error: { message: 'native error' } }, { status: 429 }); const e = harness({ fetch: async () => errorResponse }); assert.equal(await send(e), errorResponse);
    const broken = new Error('native network failure'); await assert.rejects(send(harness({ fetch: async () => { throw broken; } })), e => e === broken);
    const pending = new Response(new ReadableStream({ cancel() { cancelled = true; } })); const p = harness({ fetch: async () => pending }); await (await send(p)).body.cancel(); assert.equal(cancelled, true);
});
test('disable restores fetch and leaves settings untouched; later wrapper becomes inert safely', async () => {
    const h = harness(); h.installation.dispose(); assert.equal(h.scope.fetch, h.previous);
    const i = harness(); const inner = i.scope.fetch; const later = (...args) => inner(...args); i.scope.fetch = later; i.installation.dispose();
    assert.equal(i.scope.fetch, later); const init = { method: 'POST', body: JSON.stringify(payload()) }; await i.scope.fetch(GENERATE_PATH, init); assert.equal(i.calls[0][1], init);
});
test('disabled setting and disable during asynchronous body read cause exact passthrough', async () => {
    const h = harness({ enabled: () => false }); const init = { method: 'POST', body: JSON.stringify(payload()) }; await h.scope.fetch(GENERATE_PATH, init); assert.equal(h.calls[0][1], init);
    const p = harness(); const promise = p.scope.fetch(GENERATE_PATH, init); p.installation.dispose(); await promise; assert.equal(p.calls[0][1], init);
});
test('session generator is lazy and stable even across wrapper reinstalls', () => {
    let count = 0; const ids = createSessionIds(() => `fixture_${++count}`); assert.equal(count, 0); assert.equal(ids.forConversation('a'), 'fixture_1'); assert.equal(ids.forConversation('a'), 'fixture_1');
});
test('request-start chat snapshot remains stable if UI changes chat while parsing body', async () => {
    const h = harness(); h.setChat('chat-A'); const first = send(h); h.setChat('chat-B'); await first;
    const a = JSON.parse(sentBody(h).custom_include_headers)['x-opencode-session']; h.setChat('chat-A'); await send(h);
    assert.equal(JSON.parse(sentBody(h).custom_include_headers)['x-opencode-session'], a);
});
test('mixed-case duplicate sessions use last occurrence in YAML list order', () => {
    const raw = JSON.stringify([{ 'x-opencode-session': 'first' }, { 'X-OpenCode-Session': 'middle' }, { 'x-opencode-session': 'last' }]);
    assert.equal(JSON.parse(addGoHeaders(raw, 'generated', JSON.parse))['x-opencode-session'], 'last');
});
test('abort while reading an unfinished Request body settles promptly without forwarding', async () => {
    const h = harness(); const ac = new AbortController(); let bodyController;
    const req = new Request(origin + GENERATE_PATH, { method: 'POST', body: new ReadableStream({ start(c) { bodyController = c; c.enqueue(new TextEncoder().encode('{')); } }), duplex: 'half', signal: ac.signal });
    const pending = h.scope.fetch(req); ac.abort();
    const timeout = setTimeout(() => { bodyController.close(); }, 500);
    try { await assert.rejects(pending, { name: 'AbortError' }); assert.equal(h.calls.length, 0); }
    finally { clearTimeout(timeout); bodyController.close(); }
});
test('used Request with valid replacement body still receives Go headers', async () => {
    const h = harness(); const req = new Request(origin + GENERATE_PATH, { method: 'POST', body: '{}' }); await req.text();
    await h.scope.fetch(req, { body: JSON.stringify(payload()) }); const sent = await h.calls[0][0].json();
    assert.equal(JSON.parse(sent.custom_include_headers)['User-Agent'], USER_AGENT);
});

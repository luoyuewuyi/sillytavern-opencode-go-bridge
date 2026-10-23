import test from 'node:test';
import assert from 'node:assert/strict';
import { GO_BASE, GO_MARKER, isGoBase, createRoutedFetch, createSessionIds } from '../routing.mjs';
import { createActivation } from '../activation.mjs';
import { ReplayCache } from '../server/replay.mjs';
import { base } from './helpers.mjs';
const origin = 'https://st.example';
const payload = () => ({ ...base(), chat_completion_source: 'custom', custom_url: GO_MARKER });
function harness(state = {}) {
    const calls = []; const current = { active: true, token: 'TEST_BROWSER_TOKEN', ...state };
    const fetch = createRoutedFetch({ originalFetch: async (...args) => { calls.push(args); return Response.json({ ok: true }); }, origin, getState: () => current,
        requestHeaders: () => ({ 'X-CSRF-Token': 'TEST_CSRF' }), conversationId: () => 'synthetic-conversation' });
    return { fetch, calls, current };
}
test('native custom generation routes Go only and strips host credentials', async () => {
    const h = harness(); const controller = new AbortController();
    await h.fetch('/api/backends/chat-completions/generate', { method: 'POST', signal: controller.signal, body: JSON.stringify({ ...payload(), proxy_password: 'DO_NOT_FORWARD', secret_id: 'OLD_SECRET_REF' }) });
    const [url, options] = h.calls[0]; assert.equal(url, '/api/plugins/opencode-go-bridge/generate');
    assert.ok(!options.body.includes('DO_NOT_FORWARD')); assert.ok(!options.body.includes('OLD_SECRET_REF'));
    assert.equal(options.headers.get('x-csrf-token'), 'TEST_CSRF'); controller.abort(); assert.equal(options.signal.aborted, true);
});
test('LWB host openai/reverse_proxy shape routes without leaking proxy password', async () => {
    const h = harness(); await h.fetch('/api/backends/chat-completions/generate', { method: 'POST', body: JSON.stringify({ ...base(), chat_completion_source: 'openai', reverse_proxy: GO_BASE, proxy_password: 'OLD_FAKE_KEY' }) });
    assert.equal(h.calls[0][0], '/api/plugins/opencode-go-bridge/generate'); assert.ok(!h.calls[0][1].body.includes('OLD_FAKE_KEY'));
});
test('direct SDK Request object supported only after opt-in', async () => {
    const req = new Request(GO_BASE + '/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer OLD_FAKE_KEY' }, body: JSON.stringify(base()) });
    const off = harness(); await off.fetch(req); assert.equal(off.calls[0][0], req);
    const on = harness({ direct: true }); await on.fetch(req); assert.equal(on.calls[0][0], '/api/plugins/opencode-go-bridge/generate');
    assert.equal(on.calls[0][1].headers.get('authorization'), null); assert.ok(!req.bodyUsed);
});
test('other providers, schemes, userinfo, ports and suffix hosts are untouched', async () => {
    for (const url of ['https://opencode.ai.evil.test/inference/go/openai/v1', 'http://opencode.ai/inference/go/openai/v1', 'https://u:p@opencode.ai/inference/go/openai/v1', GO_BASE + '?x=1', GO_BASE + '#x', 'https://opencode.ai:8443/inference/go/openai/v1', 'https://api.openai.com/v1']) {
        assert.equal(isGoBase(url), false); const h = harness(); const options = { method: 'POST', body: JSON.stringify({ ...payload(), custom_url: url }) };
        await h.fetch('/api/backends/chat-completions/generate', options); assert.equal(h.calls[0][1], options);
    }
});
test('disconnected Go fails locally; other requests preserve exact call identity', async () => {
    const h = harness({ token: null }); const result = await h.fetch('/api/backends/chat-completions/generate', { method: 'POST', body: JSON.stringify(payload()) });
    assert.equal(result.status, 401); assert.equal(h.calls.length, 0);
    const options = { method: 'POST', body: '{}' }; await h.fetch('/api/other', options); assert.equal(h.calls[0][1], options);
});
test('model choice preserved; missing model default and manual effort scoped to Go', async () => {
    const h = harness({ model: 'gpt-6-luna', reasoningMode: 'custom', reasoningEffort: 'high' });
    await h.fetch('/api/backends/chat-completions/generate', { method: 'POST', body: JSON.stringify(payload()) });
    const body = JSON.parse(h.calls[0][1].body).payload; assert.equal(body.model, 'glm-5.2'); assert.equal(body.reasoning_effort, 'high');
});
test('session IDs contain no private identifiers and are stable per conversation', () => {
    const ids = createSessionIds(); const a = ids.forConversation('private-title'); assert.equal(a, ids.forConversation('private-title'));
    assert.notEqual(a, ids.forConversation('another-title')); assert.ok(!a.includes('private')); assert.throws(() => ids.forConversation(null));
});
test('activation creates recovery + dedicated Go profile; restore does not overwrite later provider', async () => {
    const manager = { profiles: [{ id: 'old', name: 'Existing provider' }], selectedProfile: 'old' }; const history = [];
    const context = { extensionSettings: { connectionManager: manager }, chatCompletionSettings: {} };
    const a = createActivation({ getContext: () => context, uuid: () => '01234567-8901-2345-6789-012345678901', execute: async (name, value) => {
        history.push([name, value]); if (name === 'profile-create') { manager.profiles.push({ id: value, name: value }); manager.selectedProfile = value; return value; }
        if (name === 'profile') manager.selectedProfile = value;
    } });
    await a.activate('glm-5.2'); assert.equal(manager.profiles[0].name, 'Existing provider'); assert.equal(manager.profiles.length, 3);
    assert.ok(history.some(([n, v]) => n === 'api-url' && v === GO_MARKER)); await a.restore(); assert.equal(manager.selectedProfile, a.recoveryProfile);
    await a.activate('glm-5.2'); manager.selectedProfile = 'old'; const count = history.length; await a.restore(); assert.equal(history.length, count);
});
test('activation stops before touching connections when recovery fails or overrides exist', async () => {
    const context = { extensionSettings: { connectionManager: { profiles: [] } }, chatCompletionSettings: { custom_include_headers: 'Authorization: old' } };
    let calls = 0; const a = createActivation({ getContext: () => context, execute: async () => { calls++; return ''; } });
    await assert.rejects(a.activate('glm-5.2')); assert.equal(calls, 0); context.chatCompletionSettings = {};
    await assert.rejects(a.activate('glm-5.2')); assert.equal(calls, 1);
});
test('replay cache exact-match isolation and edited messages are not silently replaced', () => {
    const cache = new ReplayCache(); const m = { role: 'assistant', content: 'hello', go_bridge: { protocol: 'messages', model: 'claude-haiku-5-5', blocks: [] } };
    cache.remember('a', 'claude-haiku-5-5', m);
    const input = base('claude-haiku-5-5', { messages: [{ role: 'assistant', content: 'hello' }] });
    assert.ok(cache.restore('a', input).messages[0].go_bridge); assert.ok(!cache.restore('b', input).messages[0].go_bridge);
    input.messages[0].content = 'edited'; assert.ok(!cache.restore('a', input).messages[0].go_bridge);
});
test('replay rejects edited reasoning and ambiguous repeated visible answers', () => {
    const cache = new ReplayCache(); const model = 'claude-haiku-5-5';
    const message = { role: 'assistant', content: 'same', reasoning_content: 'first', go_bridge: { protocol: 'messages', model, blocks: [{ type: 'thinking', thinking: 'first', signature: 'one' }] } };
    cache.remember('conversation', model, message);
    assert.throws(() => cache.restore('conversation', base(model, { messages: [{ role: 'assistant', content: 'same', reasoning_content: 'edited' }] })), /不一致/);
    assert.ok(cache.restore('conversation', base(model, { messages: [{ role: 'assistant', content: 'same' }] })).messages[0].go_bridge);
    cache.remember('conversation', model, { ...message, reasoning_content: 'second', go_bridge: { ...message.go_bridge, blocks: [] } });
    assert.throws(() => cache.restore('conversation', base(model, { messages: [{ role: 'assistant', content: 'same' }] })), /多份/);
});

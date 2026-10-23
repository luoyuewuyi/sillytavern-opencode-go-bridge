import test from 'node:test';
import assert from 'node:assert/strict';
import { createGoClient } from '../server/core.mjs';
import { createHandlers } from '../server/index.mjs';
import { MODELS_URL, protocolFor } from '../server/catalog.mjs';
import { GO_MARKER } from '../routing.mjs';
import { base, catalog, key, jsonResult, mockRequest, invoke } from './helpers.mjs';

// Small DOM contract double: exercises the shipped entrypoint and event handlers,
// not a replacement controller. This is not browser layout or live-ST validation.
class Element {
    constructor(doc) { this.doc = doc; this.value = ''; this.checked = false; this.textContent = ''; this.children = []; this.nodes = new Map(); }
    set innerHTML(html) {
        this.html = html;
        for (const match of html.matchAll(/data-go="([^"]+)"/g)) this.nodes.set(match[1], new Element(this.doc));
        this.nodes.set('.go-url', new Element(this.doc)); this.nodes.get('auto').checked = true; this.nodes.get('reasoning').value = 'preserve';
    }
    querySelector(selector) { return selector === '.go-url' ? this.nodes.get(selector) : this.nodes.get(/data-go="([^"]+)"/.exec(selector)?.[1]); }
    append(el) { this.children.push(el); if (el.id) this.doc.ids.set(el.id, el); }
    replaceChildren(...children) { this.children = children; this.value = children[0]?.value ?? ''; }
    add(child) { this.children.push(child); }
}
async function environment(t, { missingBackend = false, noManager = false, failModel = false, failDelete = false, connectGate } = {}) {
    const globals = ['document', 'SillyTavern', 'location', 'Option', 'isSecureContext', 'fetch', 'OpenCodeGoBridge'];
    const saved = new Map(globals.map(k => [k, globalThis[k]]));
    const doc = { ids: new Map(), readyState: 'complete', createElement: () => new Element(doc), getElementById: id => doc.ids.get(id) };
    doc.ids.set('extensions_settings2', new Element(doc));
    const originalSettings = { chat_completion_source: 'openrouter', custom_url: 'https://old.example/v1', custom_model: 'old-model' };
    const context = { chatCompletionSettings: { ...originalSettings }, getRequestHeaders: () => ({ 'X-CSRF-Token': 'TEST_CSRF' }), getCurrentChatId: () => 'fixture-chat', characterId: 'fixture-char',
        extensionSettings: { connectionManager: { profiles: [{ id: 'original', name: 'Original', settings: { ...originalSettings } }], selectedProfile: 'original' } } };
    const commands = []; const upstream = []; const sent = [];
    context.executeSlashCommandsWithOptions = async text => {
        const [command, ...rest] = text.trim().split(/\s+/); const value = rest.filter(s => !s.includes('=')).join(' '); commands.push(text);
        const m = context.extensionSettings.connectionManager;
        if (command === '/profile-create') { m.profiles.push({ id: value, name: value, settings: { ...context.chatCompletionSettings } }); m.selectedProfile = value; return { pipe: value }; }
        if (command === '/api') context.chatCompletionSettings.chat_completion_source = value;
        if (command === '/api-url') context.chatCompletionSettings.custom_url = value;
        if (command === '/model') { if (failModel) throw new Error('mock model selection failure'); context.chatCompletionSettings.custom_model = value; }
        if (command === '/profile') { const p = m.profiles.find(p => p.name === value); Object.assign(context.chatCompletionSettings, p.settings); m.selectedProfile = p.id; }
        return { pipe: value };
    };
    if (noManager) delete context.extensionSettings.connectionManager;
    const client = createGoClient({ fetchImpl: async (url, options) => {
        upstream.push({ url, options }); if (url === MODELS_URL) return Response.json(catalog);
        const body = JSON.parse(options.body); return Response.json(jsonResult(protocolFor(body.model), body.model));
    } });
    const handlers = createHandlers({ client });
    const originalFetch = async (url, options) => {
        sent.push({ url, options });
        if (!String(url).startsWith('/api/plugins/opencode-go-bridge/')) return Response.json({ passthrough: true });
        if (missingBackend) return new Response('', { status: 404 });
        const headers = Object.fromEntries(new Headers(options.headers));
        const req = mockRequest(options.body ? JSON.parse(options.body) : {}); Object.assign(req.headers, headers);
        const path = String(url).split('/opencode-go-bridge')[1];
        if (path === '/session' && options.method === 'DELETE' && failDelete) throw new Error('mock offline');
        if (path === '/session' && options.method === 'POST' && connectGate) await connectGate;
        const handler = path === '/status' ? handlers.status : path === '/session' ? options.method === 'DELETE' ? handlers.disconnect : handlers.connect : path === '/v1/chat/completions' ? handlers.compatible : handlers.generate;
        return invoke(handler, req);
    };
    Object.assign(globalThis, { document: doc, SillyTavern: { getContext: () => context }, location: { origin: 'https://localhost:8000' },
        Option: class { constructor(text, value) { this.text = text; this.value = value; } }, isSecureContext: true, fetch: originalFetch });
    await import(`../index.js?panel=${Math.random()}`);
    t.after(async () => {
        try { await globalThis.OpenCodeGoBridge?.dispose(); } catch { /* negative tests have no connection */ }
        handlers.vault.clear(); for (const [k, v] of saved) { if (v === undefined) delete globalThis[k]; else globalThis[k] = v; }
    });
    const root = doc.getElementById('st-go-bridge'); const el = k => root.querySelector(`[data-go="${k}"]`);
    el('key').value = key; el('ack').checked = true;
    return { el, context, originalSettings, originalFetch, commands, sent, upstream, handlers };
}
test('shipped panel: Key -> dedicated profile -> native chat -> restore -> dispose', async t => {
    const h = await environment(t); await h.el('connect').onclick();
    assert.match(h.el('status').textContent, /已建立/); assert.equal(h.el('key').value, '');
    assert.equal(h.context.chatCompletionSettings.custom_url, GO_MARKER); assert.equal(h.context.extensionSettings.connectionManager.profiles[0].name, 'Original');
    assert.ok(h.commands.every(s => !s.includes(key)));
    const payload = { ...base(h.context.chatCompletionSettings.custom_model), chat_completion_source: 'custom', custom_url: GO_MARKER };
    const result = await globalThis.fetch('/api/backends/chat-completions/generate', { method: 'POST', body: JSON.stringify(payload) });
    assert.equal((await result.json()).choices[0].message.content, '你好');
    assert.ok(h.upstream.some(c => c.options.headers.Authorization === `Bearer ${key}`));
    const publicResult = await globalThis.OpenCodeGoBridge.request(base('gpt-6-luna'), { conversation: 'external-task' });
    assert.equal((await publicResult.json()).choices[0].message.content, '你好');
    await h.el('disconnect').onclick(); assert.deepEqual(h.context.chatCompletionSettings, h.originalSettings);
    await globalThis.OpenCodeGoBridge.dispose(); assert.equal(globalThis.fetch, h.originalFetch);
});
test('shipped panel: missing backend does not change profiles or send credentials', async t => {
    const h = await environment(t, { missingBackend: true }); await h.el('connect').onclick();
    assert.match(h.el('status').textContent, /服务端插件/); assert.equal(h.commands.length, 0); assert.ok(h.sent.every(c => !c.options.body.includes(key)));
});
test('shipped panel: missing Connection Manager reports before network/changes', async t => {
    const h = await environment(t, { noManager: true }); await h.el('connect').onclick();
    assert.match(h.el('status').textContent, /Connection Manager/); assert.equal(h.sent.length, 0);
});
test('shipped panel: partial activation failure restores snapshot and revokes session', async t => {
    const h = await environment(t, { failModel: true }); await h.el('connect').onclick();
    assert.match(h.el('status').textContent, /mock model/); assert.deepEqual(h.context.chatCompletionSettings, h.originalSettings);
    assert.ok(h.sent.some(c => c.options.method === 'DELETE'));
    await assert.rejects(globalThis.OpenCodeGoBridge.request(base(), { conversation: 'test' }), /先在/);
});

test('shipped panel: failed remote revocation still restores and disables local connection', async t => {
    const h = await environment(t, { failDelete: true }); await h.el('connect').onclick();
    await h.el('disconnect').onclick(); assert.match(h.el('status').textContent, /撤销未确认/);
    assert.deepEqual(h.context.chatCompletionSettings, h.originalSettings);
    await assert.rejects(globalThis.OpenCodeGoBridge.request(base(), { conversation: 'x' }), /先在/);
    await globalThis.OpenCodeGoBridge.dispose(); assert.equal(globalThis.fetch, h.originalFetch);
});
test('shipped panel: connection work serializes mutually exclusive controls', async t => {
    let resolve; const connectGate = new Promise(r => { resolve = r; });
    const h = await environment(t, { connectGate }); const pending = h.el('connect').onclick();
    await new Promise(r => setImmediate(r)); assert.ok(h.el('disconnect').disabled);
    await h.el('disconnect').onclick(); resolve(); await pending;
    assert.match(h.el('status').textContent, /已建立/); assert.equal(h.el('disconnect').disabled, false);
    await h.el('disconnect').onclick(); assert.deepEqual(h.context.chatCompletionSettings, h.originalSettings);
});
test('public dispose waits for pending registration then revokes the late token', async t => {
    let resolve; const connectGate = new Promise(r => { resolve = r; });
    const h = await environment(t, { connectGate }); const connecting = h.el('connect').onclick();
    await new Promise(r => setImmediate(r)); const disposing = globalThis.OpenCodeGoBridge.dispose();
    resolve(); await Promise.all([connecting, disposing]);
    assert.equal(globalThis.fetch, h.originalFetch); assert.deepEqual(h.context.chatCompletionSettings, h.originalSettings);
    await assert.rejects(globalThis.OpenCodeGoBridge.request(base(), { conversation: 'x' }), /先在/);
    assert.ok(h.sent.some(c => c.options.method === 'DELETE'));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { payload, origin } from './helpers.mjs';
import { GENERATE_PATH, USER_AGENT } from '../routing.mjs';

test('real entry installs with no UI/network/settings writes; native configuration remains identical', async t => {
    const names = ['fetch', 'location', 'SillyTavern', 'document']; const saved = new Map(names.map(k => [k, globalThis[k]]));
    const settings = Object.freeze({ custom_url: 'original-fixture-url', custom_model: 'original-model', secret_id: 'FAKE_SECRET_REF' });
    const extensionSettings = { disabledExtensions: [] }; let chat = 'chat-A'; const calls = [];
    const original = async (...args) => { calls.push(args); return Response.json({ native: true }); };
    Object.assign(globalThis, { fetch: original, location: { origin }, SillyTavern: { libs: { yaml: { parse: JSON.parse } }, getContext: () => ({ chatCompletionSettings: settings, extensionSettings, getCurrentChatId: () => chat, characterId: 'character-fixture' }) }, document: new Proxy({}, { get() { throw new Error('UI access forbidden'); } }) });
    const entry = await import(`../index.js?test=${Math.random()}`);
    t.after(() => { entry.disable(); for (const [k, v] of saved) v === undefined ? delete globalThis[k] : globalThis[k] = v; });
    assert.notEqual(globalThis.fetch, original); assert.equal(calls.length, 0);
    const send = data => globalThis.fetch(GENERATE_PATH, { method: 'POST', body: JSON.stringify(data) });
    await send(payload()); const head = JSON.parse(JSON.parse(calls[0][1].body).custom_include_headers); assert.equal(head['User-Agent'], USER_AGENT);
    chat = 'chat-B'; await send(payload()); assert.notEqual(JSON.parse(JSON.parse(calls[1][1].body).custom_include_headers)['x-opencode-session'], head['x-opencode-session']);
    const init = { method: 'POST', body: JSON.stringify(payload({ custom_url: 'https://other.test/v1' })) }; await globalThis.fetch(GENERATE_PATH, init); assert.equal(calls[2][1], init);
    assert.equal(settings.custom_url, 'original-fixture-url'); assert.equal(settings.secret_id, 'FAKE_SECRET_REF'); assert.deepEqual(extensionSettings, { disabledExtensions: [] });
    entry.disable(); assert.equal(globalThis.fetch, original); entry.enable(); assert.notEqual(globalThis.fetch, original);
    chat = 'chat-A'; await send(payload()); assert.equal(JSON.parse(JSON.parse(calls[3][1].body).custom_include_headers)['x-opencode-session'], head['x-opencode-session']);
    extensionSettings.disabledExtensions.push('third-party/sillytavern-opencode-go-bridge'); await globalThis.fetch(GENERATE_PATH, init); assert.equal(calls[4][1], init);
});

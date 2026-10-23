// Read-only opt-in tests against official ST source. No server startup, config or secrets.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { installGoHeaders, GENERATE_PATH, STATUS_PATH, GO_CHAT_BASE, GO_MODELS_BASE, USER_AGENT, addGoHeaders } from '../routing.mjs';
import { payload, origin } from './helpers.mjs';
const root = process.env.ST_REFERENCE_ROOT;
const yamlModule = process.env.ST_YAML_MODULE;
const yaml = yamlModule ? await import(pathToFileURL(resolve(yamlModule))) : { parse: JSON.parse };
let source; let util; let version;
if (root) {
    source = await readFile(resolve(root, 'src/endpoints/backends/chat-completions.js'), 'utf8');
    util = await readFile(resolve(root, 'src/util.js'), 'utf8');
    version = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')).version;
}
function routeFunction(route, sandbox) {
    const marker = `router.post('${route}',`;
    const begin = source.indexOf(marker); assert.ok(begin >= 0, `native route ${route}`);
    let fnStart = source.indexOf('function', begin); if (source.slice(fnStart - 6, fnStart) === 'async ') fnStart -= 6; const end = source.indexOf('\n});', fnStart);
    assert.ok(end > fnStart); return vm.runInNewContext('(' + source.slice(fnStart, end + 2) + ')', sandbox);
}
function nativeServer() {
    const calls = []; let secretReads = 0;
    const merge = util.match(/export function mergeObjectWithYaml\(obj, yamlString\) \{[\s\S]*?\n\}/)?.[0]; assert.ok(merge);
    const sandbox = { URL, AbortController, console: new Proxy({}, { get: () => () => {} }),
        CHAT_COMPLETION_SOURCES: new Proxy({}, { get: (_, k) => k.toLowerCase() }), SECRET_KEYS: { CUSTOM: 'api_key_custom' },
        TEXT_COMPLETION_MODELS: [], OPENAI_REASONING_EFFORT_MODELS: [], OPENAI_VERBOSITY_MODELS: /never-matches/,
        readSecret: () => { secretReads++; return 'FAKE_NATIVE_ST_SECRET'; },
        mergeObjectWithYaml: vm.runInNewContext('(' + merge.replace('export ', '') + ')', { yaml }),
        embedOpenRouterMedia: () => {}, excludeKeysByYaml: () => {},
        urlJoin: (a, b) => a.replace(/\/$/, '') + '/' + b.replace(/^\//, ''),
        fetch: async (url, options) => {
            calls.push({ url: String(url), options });
            return String(url).endsWith('/models') ? Response.json({ data: [{ id: 'glm-5.2' }] }) : Response.json({ choices: [{ message: { role: 'assistant', content: 'synthetic' } }] });
        },
        forwardFetchResponse: (upstream, response) => response.sendResponse(upstream),
    };
    const routes = { [GENERATE_PATH]: routeFunction('/generate', sandbox), [STATUS_PATH]: routeFunction('/status', sandbox) };
    const fetch = async (url, options) => {
        let resolveResponse; let rejectResponse;
        const completion = new Promise((resolve, reject) => { resolveResponse = resolve; rejectResponse = reject; });
        let status = 200;
        const response = { status(s) { status = s; return this; }, send(value) { resolveResponse(Response.json(value, { status })); },
            sendResponse(value) { resolveResponse(value); }, end() { resolveResponse(new Response('', { status })); }, sendStatus(s) { resolveResponse(new Response('', { status: s })); } };
        const req = { body: JSON.parse(options.body), user: { directories: {} }, socket: new EventEmitter() };
        Promise.resolve(routes[url](req, response)).catch(rejectResponse);
        return completion;
    };
    return { calls, fetch, get secretReads() { return secretReads; } };
}
for (const path of [GENERATE_PATH, STATUS_PATH]) for (const stream of [false, true]) {
    test(`ST ${version || 'reference'} actual ${path.split('/').at(-1)} handler + merge, stream=${stream}`, { skip: !root }, async () => {
        const native = nativeServer(); const scope = { fetch: native.fetch };
        const install = installGoHeaders({ scope, origin, conversationId: () => 'synthetic-chat', parseYaml: yaml.parse });
        const body = payload({ stream, custom_url: path === STATUS_PATH ? GO_MODELS_BASE : GO_CHAT_BASE,
            custom_include_headers: JSON.stringify({ 'X-User-Header': 'preserve' }),
            tools: [{ type: 'function', function: { name: 'fixture', parameters: { type: 'object' } } }], tool_choice: 'auto' });
        const response = await scope.fetch(path, { method: 'POST', body: JSON.stringify(body) }); assert.equal(response.status, 200);
        assert.equal(native.calls.length, 1); assert.equal(native.secretReads, 1);
        const c = native.calls[0]; assert.equal(c.options.headers.Authorization, 'Bearer FAKE_NATIVE_ST_SECRET');
        assert.equal(c.options.headers['User-Agent'], USER_AGENT); assert.equal(c.options.headers['X-User-Header'], 'preserve'); assert.match(c.options.headers['x-opencode-session'], /^stgo_/);
        assert.equal(c.url, path === STATUS_PATH ? GO_MODELS_BASE + '/models' : GO_CHAT_BASE + '/chat/completions');
        if (path === GENERATE_PATH) { const p = JSON.parse(c.options.body); assert.deepEqual(p.messages, body.messages); assert.deepEqual(p.tools, body.tools); }
        install.dispose();
    });
}
test('actual native status appends /models to configured URL; extension deliberately does not relocate it', { skip: !root }, async () => {
    const native = nativeServer(); const scope = { fetch: native.fetch };
    const install = installGoHeaders({ scope, origin, conversationId: () => 'fixture-chat' });
    await scope.fetch(STATUS_PATH, { method: 'POST', body: JSON.stringify(payload()) });
    assert.equal(native.calls[0].url, GO_CHAT_BASE + '/models'); install.dispose();
});
test('reference public YAML library and Custom header support exist; OpenAI branch has no header merge', { skip: !root }, async () => {
    const lib = await readFile(resolve(root, 'public/lib.js'), 'utf8'); const script = await readFile(resolve(root, 'public/script.js'), 'utf8');
    assert.match(lib, /import yaml from 'yaml'/); assert.match(script, /globalThis\.SillyTavern = \{\s*libs,/);
    const start = source.indexOf("router.post('/status'"); const openai = source.slice(start, source.indexOf('CHAT_COMPLETION_SOURCES.OPENROUTER', start));
    assert.ok(!openai.includes('mergeObjectWithYaml')); assert.match(source, /mergeObjectWithYaml\(headers, request.body.custom_include_headers\)/);
});
test('real existing YAML parser preserves YAML maps/list headers and rejects malformed content', { skip: !yamlModule }, () => {
    const value = addGoHeaders('- X-Test: keep\n- Authorization: Bearer FAKE_USER_HEADER\n- User-Agent: previous\n- x-opencode-session: existing-session\n', 'generated', yaml.parse);
    assert.deepEqual(JSON.parse(value), { 'X-Test': 'keep', Authorization: 'Bearer FAKE_USER_HEADER', 'User-Agent': USER_AGENT, 'x-opencode-session': 'existing-session' });
    assert.throws(() => addGoHeaders('broken: [', 'generated', yaml.parse));
});

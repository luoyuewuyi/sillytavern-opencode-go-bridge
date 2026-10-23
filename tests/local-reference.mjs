// Opt-in read-only reference integration. No personal path is embedded in the package.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createRoutedFetch, GO_BASE } from '../routing.mjs';
import { createGoClient } from '../server/core.mjs';
import { MODELS_URL, protocolFor } from '../server/catalog.mjs';
import { base, key, sessionId, catalog, jsonResult, sseResponse, streamEvents } from './helpers.mjs';
const root = process.env.LWB_REFERENCE_ROOT;
for (const stream of [false, true]) for (const model of ['glm-5.2', 'gpt-6-luna', 'claude-haiku-5-5']) {
    test(`actual LWB Host Client ${stream ? 'stream' : 'nonstream'} -> ${protocolFor(model)}`, { skip: !root }, async () => {
        const path = resolve(root, 'shared/host-llm/chat-completions/client.js');
        const lwb = await import(pathToFileURL(path)); let captured;
        const client = createGoClient({ fetchImpl: async (url, options) => {
            if (url === MODELS_URL) return Response.json(catalog);
            captured = { url, body: JSON.parse(options.body) }; const p = protocolFor(model);
            return stream ? sseResponse(streamEvents(p, model, true)) : Response.json(jsonResult(p, model, true));
        } });
        const route = createRoutedFetch({ originalFetch: async (url, options) => {
            assert.equal(url, '/api/plugins/opencode-go-bridge/generate'); const e = JSON.parse(options.body);
            return client.generate(e.payload, { key, sessionId: e.sessionId, native: true });
        }, origin: 'https://st.example', getState: () => ({ active: true, token: 'FAKE_BROWSER_TOKEN' }), requestHeaders: () => ({ 'X-CSRF-Token': 'TEST_CSRF' }), conversationId: () => 'fixture-conversation' });
        const host = lwb.createHostChatCompletionsClient({ fetch: route, requestHeadersProvider: () => ({ 'X-CSRF-Token': 'TEST_CSRF' }) });
        const payload = lwb.buildHostOpenAICompatibleGeneratePayload({ baseUrl: GO_BASE, apiKey: 'LEGACY_FAKE_KEY', model }, { maxTokens: 128 }, base().messages, stream);
        if (stream) { const chunks = []; await host.streamHostChatCompletion(payload, e => chunks.push(e)); assert.ok(chunks.some(e => e.choices?.[0]?.delta?.tool_calls)); }
        else { const result = await host.createHostChatCompletion(payload); assert.equal(result.choices[0].message.tool_calls[0].id, 'call_add'); }
        assert.ok(captured.url.startsWith('https://opencode.ai/inference/go/')); assert.ok(!JSON.stringify(captured).includes('LEGACY_FAKE_KEY'));
    });
}

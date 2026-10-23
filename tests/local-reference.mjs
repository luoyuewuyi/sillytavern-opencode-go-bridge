// Actual LWB source module, read-only. No personal path is embedded in this project.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { installGoHeaders, GO_CHAT_BASE, GENERATE_PATH, STATUS_PATH } from '../routing.mjs';
import { origin } from './helpers.mjs';
const root = process.env.LWB_REFERENCE_ROOT;
for (const stream of [false, true]) {
    test(`actual LWB Host OpenAI client remains unchanged, stream=${stream}: native header limitation explicit`, { skip: !root }, async () => {
        const lwb = await import(pathToFileURL(resolve(root, 'shared/host-llm/chat-completions/client.js')));
        const calls = [];
        const scope = { fetch: async (url, options) => {
            calls.push({ url, options });
            if (url === STATUS_PATH) return Response.json({ data: [{ id: 'glm-5.2' }] });
            return stream ? new Response('data: {"choices":[{"delta":{"content":"fixture"}}]}\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } }) : Response.json({ choices: [{ message: { content: 'fixture' } }] });
        } };
        const installed = installGoHeaders({ scope, origin, conversationId: () => 'fixture-chat' });
        const host = lwb.createHostChatCompletionsClient({ fetch: scope.fetch, requestHeadersProvider: () => ({ 'X-CSRF-Token': 'FAKE_CSRF' }) });
        const body = lwb.buildHostOpenAICompatibleGeneratePayload({ baseUrl: GO_CHAT_BASE, apiKey: 'FAKE_LWB_NATIVE_KEY', model: 'glm-5.2' }, {}, [{ role: 'user', content: 'synthetic fixture' }], stream);
        if (stream) { const chunks = []; await host.streamHostChatCompletion(body, e => chunks.push(e)); assert.ok(chunks.length); }
        else assert.equal((await host.createHostChatCompletion(body)).choices[0].message.content, 'fixture');
        assert.equal(calls[0].url, GENERATE_PATH); assert.deepEqual(JSON.parse(calls[0].options.body), body);
        assert.equal(body.chat_completion_source, 'openai'); assert.equal(body.custom_include_headers, undefined); installed.dispose();
    });
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeRequest, decodeResponse, convertStream } from '../server/protocols.mjs';
import { sanitizeSse } from '../server/sse.mjs';
import { base, tools, jsonResult, streamEvents, sseResponse, eventsFrom } from './helpers.mjs';

for (const [p, model] of [['responses', 'gpt-6-luna'], ['messages', 'claude-haiku-5-5']]) {
    test(`${p}: tool call/result roundtrip and assistant provenance`, () => {
        const decoded = decodeResponse(jsonResult(p, model, true), p, model);
        const messages = [...base(model).messages, decoded.choices[0].message, { role: 'tool', tool_call_id: 'call_add', content: '2' }];
        const encoded = encodeRequest(base(model, { messages, tools }));
        assert.ok(JSON.stringify(encoded.body).includes('call_add'));
        assert.ok(JSON.stringify(encoded.body).includes(p === 'responses' ? 'function_call_output' : 'tool_result'));
        assert.ok(!JSON.stringify(encoded.body).includes('go_bridge'));
    });
    test(`${p}: input images retained without local fetch`, () => {
        const content = [{ type: 'text', text: 'Describe diagram' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }];
        const encoded = encodeRequest(base(model, { messages: [{ role: 'user', content }] }));
        assert.ok(JSON.stringify(encoded.body).includes('AAAA')); assert.ok(JSON.stringify(encoded.body).includes('image'));
    });
    test(`${p}: UTF-8 fragmented SSE text`, async () => {
        const es = await eventsFrom(convertStream(sseResponse(streamEvents(p, model), 1), p, model));
        assert.equal(es.map(e => e.choices?.[0]?.delta?.content || '').join(''), '你好');
        assert.equal(es.at(-1).choices[0].finish_reason, 'stop');
    });
    test(`${p}: unknown/lossy params explicitly rejected`, () => {
        for (const extra of [{ frequency_penalty: 1 }, { n: 2 }, { seed: 99 }, { logprobs: true }, { enable_thinking: true }]) assert.throws(() => encodeRequest(base(model, extra)), /不能保真/);
        assert.throws(() => encodeRequest(base(model, { messages: [{ role: 'assistant', content: '', reasoning_content: 'lost signature' }] })), /reasoning_content/);
    });
    test(`${p}: stream provider error is redacted`, async () => {
        const es = await eventsFrom(convertStream(sseResponse([{ type: 'error', error: { message: 'SECRET_ECHO' } }]), p, model));
        assert.equal(es[0].error.code, 'go_stream_error'); assert.ok(!JSON.stringify(es).includes('SECRET_ECHO'));
    });
    test(`${p}: truncated stream fails explicitly`, async () => {
        const es = await eventsFrom(convertStream(sseResponse(streamEvents(p, model).slice(0, 2)), p, model));
        assert.ok(es.at(-1).error);
    });
}
test('Messages: thought signature preserved through SSE and next request', async () => {
    const model = 'claude-haiku-5-5'; const events = [
        { type: 'message_start', message: { id: 'm', usage: {} } },
        { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'reason' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'signed-test' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }, { type: 'message_stop' },
    ];
    const es = await eventsFrom(convertStream(sseResponse(events), 'messages', model));
    const provenance = es.find(e => e.choices?.[0]?.delta?.go_bridge).choices[0].delta.go_bridge;
    const encoded = encodeRequest(base(model, { messages: [...base().messages, { role: 'assistant', content: '', reasoning_content: 'reason', go_bridge: provenance }, { role: 'user', content: 'next' }] }));
    assert.equal(encoded.body.messages[1].content[0].signature, 'signed-test');
});
test('Responses: reasoning encrypted metadata survives roundtrip', () => {
    const model = 'gpt-6-luna'; const raw = jsonResult('responses', model); raw.output.unshift({ type: 'reasoning', id: 'r', encrypted_content: 'opaque-test', summary: [{ type: 'summary_text', text: 'brief' }] });
    const msg = decodeResponse(raw, 'responses', model).choices[0].message;
    const encoded = encodeRequest(base(model, { messages: [...base().messages, msg] }));
    assert.equal(encoded.body.input[1].encrypted_content, 'opaque-test');
});
test('Messages requires explicit token budget and rejects strict tools/image detail', () => {
    assert.throws(() => encodeRequest({ model: 'claude-haiku-5-5', messages: base().messages }), /max_tokens/);
    assert.throws(() => encodeRequest(base('claude-haiku-5-5', { tools: [{ type: 'function', function: { name: 'x', strict: true } }] })), /strict/);
});
test('Chat SSE unchanged for tool/reasoning frames and CRLF', async () => {
    const raw = 'data: {"choices":[{"delta":{"reasoning_content":"思考","tool_calls":[]}}]}\r\n\r\ndata: [DONE]\r\n\r\n';
    assert.equal(await sanitizeSse(sseResponse([raw], 1)).text(), raw);
});
test('Chat SSE redacts error and rejects malformed/truncated frames', async () => {
    for (const data of ['data: {"error":{"message":"SECRET"}}\n\n', 'data: invalid\n\n', 'data: {"choices":[]}\n\n']) {
        const text = await sanitizeSse(sseResponse([data])).text(); assert.ok(text.includes('go_stream_error')); assert.ok(!text.includes('SECRET'));
    }
});
test('manual effort maps only when explicitly supplied; default does not force thinking', () => {
    assert.equal(encodeRequest(base('gpt-6-luna')).body.reasoning, undefined);
    assert.deepEqual(encodeRequest(base('gpt-6-luna', { reasoning_effort: 'high' })).body.reasoning, { effort: 'high' });
    assert.deepEqual(encodeRequest(base('claude-haiku-5-5', { reasoning_effort: 'high' })).body.output_config, { effort: 'high' });
});
for (const [protocol, model] of [['responses', 'gpt-6-luna'], ['messages', 'claude-haiku-5-5']]) {
    test(`${protocol}: edited visible text and tools cannot be overwritten by sidecar`, () => {
        for (const tool of [false, true]) {
            const msg = decodeResponse(jsonResult(protocol, model, tool), protocol, model).choices[0].message;
            if (tool) msg.tool_calls[0].function.arguments = '{"a":999}'; else msg.content = 'edited';
            assert.throws(() => encodeRequest(base(model, { messages: [msg] })), /conflict/);
        }
    });
}
test('Messages: empty tool arguments are valid JSON and replay unchanged', async () => {
    const events = streamEvents('messages', 'claude-haiku-5-5', true).filter(e => e.type !== 'content_block_delta');
    const es = await eventsFrom(convertStream(sseResponse(events, 1), 'messages', 'claude-haiku-5-5'));
    const args = es.flatMap(e => e.choices?.[0]?.delta?.tool_calls ?? []).map(t => t.function?.arguments ?? '').join('');
    assert.deepEqual(JSON.parse(args), {}); assert.ok(!es.some(e => e.error));
});
test('Messages: premature stop, open blocks and missing final reason are errors', async () => {
    const full = streamEvents('messages', 'claude-haiku-5-5');
    for (const es of [[{ type: 'message_stop' }], full.filter(e => e.type !== 'content_block_stop'), full.filter(e => e.type !== 'message_delta')]) {
        const actual = await eventsFrom(convertStream(sseResponse(es), 'messages', 'claude-haiku-5-5'));
        assert.equal(actual.at(-1).error?.code, 'go_stream_error');
    }
});
test('Chat SSE supports multiline data and closes at DONE without waiting for socket EOF', async () => {
    let cancelled = false; let sent = false;
    const raw = 'data: {"choices":\ndata: []}\n\ndata: [DONE]\n\n';
    const source = new ReadableStream({ pull(c) { if (!sent) { sent = true; c.enqueue(new TextEncoder().encode(raw)); } }, cancel() { cancelled = true; } });
    assert.equal(await sanitizeSse(new Response(source)).text(), raw);
    await new Promise(resolve => setImmediate(resolve)); assert.ok(cancelled);
});
test('all protocols expose socket read failures as redacted SSE errors', async () => {
    for (const p of ['chat', 'responses', 'messages']) {
        const response = new Response(new ReadableStream({ pull(c) { c.error(new Error('PRIVATE_NETWORK_DETAILS')); } }));
        const output = p === 'chat' ? sanitizeSse(response) : convertStream(response, p, 'model');
        const text = await output.text(); assert.match(text, /go_stream_error/); assert.ok(!text.includes('PRIVATE_NETWORK_DETAILS'));
    }
});
test('Responses completion cannot hide missing text/tool deltas', async () => {
    for (const tool of [false, true]) {
        const events = streamEvents('responses', 'gpt-6-luna', tool).filter(e => !e.type.endsWith('.delta'));
        const result = await eventsFrom(convertStream(sseResponse(events), 'responses', 'gpt-6-luna'));
        assert.ok(result.at(-1).error);
    }
});

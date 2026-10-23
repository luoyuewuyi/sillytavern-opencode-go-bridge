import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import { readFileSync } from 'node:fs';
export const catalog = JSON.parse(readFileSync(new URL('../evidence/go-models-2026-10-23.json', import.meta.url)));
export const key = 'TEST_KEY_NOT_REAL_123';
export const sessionId = 'stgo_01234567890123456789012345678901';
export const tools = [{ type: 'function', function: { name: 'add', description: 'Add integers', parameters: { type: 'object', properties: { a: { type: 'integer' } } } } }];
export const base = (model = 'glm-5.2', extra = {}) => ({ model, messages: [{ role: 'user', content: 'Write an add function.' }], max_tokens: 128, ...extra });
export function jsonResult(protocol, model, tool = false) {
    const toolValue = { id: 'call_add', type: 'function', function: { name: 'add', arguments: '{"a":1}' } };
    if (protocol === 'chat') return { id: 'chat1', object: 'chat.completion', model, choices: [{ index: 0, message: { role: 'assistant', content: tool ? null : '你好', ...(tool ? { tool_calls: [toolValue] } : {}) }, finish_reason: tool ? 'tool_calls' : 'stop' }] };
    if (protocol === 'responses') return { id: 'resp1', status: 'completed', model, output: tool ? [{ type: 'function_call', id: 'fc_1', call_id: 'call_add', name: 'add', arguments: '{"a":1}' }] : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '你好', annotations: [] }] }], usage: { input_tokens: 10, output_tokens: 2 } };
    return { id: 'msg1', type: 'message', model, content: tool ? [{ type: 'tool_use', id: 'call_add', name: 'add', input: { a: 1 } }] : [{ type: 'text', text: '你好' }], stop_reason: tool ? 'tool_use' : 'end_turn', usage: { input_tokens: 10, output_tokens: 2 } };
}
export function sseResponse(events, split = 7) {
    const raw = events.map(e => typeof e === 'string' ? e : `event: ${e.type ?? 'message'}\r\ndata: ${JSON.stringify(e)}\r\n\r\n`).join('');
    const bytes = new TextEncoder().encode(raw); let offset = 0;
    return new Response(new ReadableStream({ pull(c) { if (offset >= bytes.length) c.close(); else { c.enqueue(bytes.slice(offset, offset + split)); offset += split; } } }), { headers: { 'Content-Type': 'text/event-stream' } });
}
export function streamEvents(protocol, model, tool = false) {
    const final = jsonResult(protocol, model, tool);
    if (protocol === 'chat') return [{ ...final, choices: [{ index: 0, delta: tool ? { tool_calls: [{ index: 0, ...final.choices[0].message.tool_calls[0] }] } : { content: '你好', reasoning_content: 'test reasoning' }, finish_reason: null }] }, 'data: [DONE]\n\n'];
    if (protocol === 'responses') return [
        { type: 'response.created', response: { id: 'resp1' } },
        { type: 'response.output_item.added', output_index: 0, item: tool ? { type: 'function_call', call_id: 'call_add', name: 'add', arguments: '' } : { type: 'message', content: [] } },
        tool ? { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"a":1}' } : { type: 'response.output_text.delta', output_index: 0, delta: '你好' },
        { type: 'response.completed', response: final },
    ];
    return [
        { type: 'message_start', message: { id: 'msg1', usage: { input_tokens: 10 } } },
        { type: 'content_block_start', index: 0, content_block: tool ? { type: 'tool_use', id: 'call_add', name: 'add', input: {} } : { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: tool ? { type: 'input_json_delta', partial_json: '{"a":1}' } : { type: 'text_delta', text: '你好' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 2 } },
        { type: 'message_stop' },
    ];
}
export async function eventsFrom(response) {
    const text = await response.text();
    return text.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).filter(s => s && s !== '[DONE]').map(JSON.parse);
}
export class MockResponse extends Writable {
    constructor() { super(); this.chunks = []; this.headers = {}; this.statusCode = 200; this.headersSent = false; }
    _write(chunk, encoding, done) { this.headersSent = true; this.chunks.push(Buffer.from(chunk)); done(); }
    setHeader(k, v) { this.headers[k] = v; }
    status(code) { this.statusCode = code; return this; }
    json(data) { this.setHeader('Content-Type', 'application/json'); this.end(JSON.stringify(data)); return this; }
    flushHeaders() { this.headersSent = true; }
}
export function mockRequest(body = {}, overrides = {}) {
    return Object.assign(new EventEmitter(), { body, user: { profile: { handle: 'user-a' } }, session: { csrfToken: 'TEST_CSRF' },
        secure: true, socket: { remoteAddress: '127.0.0.1' },
        headers: { host: 'localhost:8000', origin: 'https://localhost:8000', 'x-csrf-token': 'TEST_CSRF', 'x-st-go-client': '1' }, ...overrides });
}
export async function invoke(handler, req) { const res = new MockResponse(); await handler(req, res); return new Response(Buffer.concat(res.chunks), { status: res.statusCode, headers: res.headers }); }

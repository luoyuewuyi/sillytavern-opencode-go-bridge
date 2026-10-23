import { BridgeError } from './errors.mjs';
import { guardedSseBody } from './sse.mjs';
import { protocolFor, CHAT_URL } from './catalog.mjs';

const fail = field => { throw new BridgeError(400, 'conversion_unsupported', `当前协议不能保真转换 ${field}；请移除该参数或使用对应原生协议。`); };
const badResponse = () => { throw new BridgeError(502, 'unsupported_response', '上游返回了无法保真转换的内容或协议错误；未丢弃该内容继续生成。'); };
const neutral = value => value == null || value === false || value === 0 || (Array.isArray(value) && !value.length) || (typeof value === 'object' && !Array.isArray(value) && !Object.keys(value).length);
function supported(body, keys) {
    for (const [key, value] of Object.entries(body)) {
        if (keys.includes(key)) continue;
        if ((key === 'n' && value === 1) || neutral(value)) continue;
        fail(key);
    }
}
function ensureKeys(object, keys, label) { if (Object.keys(object).some(k => !keys.includes(k))) fail(label); }
function parts(content, role, protocol) {
    if (content == null) return [];
    if (typeof content === 'string') return content ? [{ type: protocol === 'messages' ? 'text' : role === 'assistant' ? 'output_text' : 'input_text', text: content }] : [];
    if (!Array.isArray(content)) return fail('message.content');
    return content.map(p => {
        if (p.type === 'text' && typeof p.text === 'string') { ensureKeys(p, ['type', 'text'], 'text metadata'); return { type: protocol === 'messages' ? 'text' : role === 'assistant' ? 'output_text' : 'input_text', text: p.text }; }
        if (p.type !== 'image_url' || role === 'assistant') return fail('content block');
        ensureKeys(p, ['type', 'image_url'], 'image metadata');
        ensureKeys(p.image_url, ['url', 'detail'], 'image_url metadata');
        const url = p.image_url?.url;
        if (typeof url !== 'string') return fail('image_url');
        if (protocol === 'responses') return { type: 'input_image', image_url: url, ...(p.image_url.detail ? { detail: p.image_url.detail } : {}) };
        if (p.image_url.detail && p.image_url.detail !== 'auto') return fail('image detail');
        const data = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(url);
        if (data) return { type: 'image', source: { type: 'base64', media_type: data[1], data: data[2] } };
        try { if (new URL(url).protocol === 'https:') return { type: 'image', source: { type: 'url', url } }; } catch { /* rejected below */ }
        return fail('image URL');
    });
}
function validateMessage(m) {
    if (!m || typeof m !== 'object') fail('message');
    ensureKeys(m, ['role', 'content', 'tool_calls', 'tool_call_id', 'reasoning_content', 'go_bridge', 'refusal'], 'message metadata');
    if (m.refusal && !m.go_bridge) fail('historical refusal without protocol metadata');
    if (m.reasoning_content && !m.go_bridge) fail('reasoning_content history without protocol metadata');
}
function toolDefinition(t, protocol) {
    ensureKeys(t, ['type', 'function'], 'tool metadata');
    if (t.type !== 'function' || !t.function?.name) fail('tool type');
    const f = t.function; ensureKeys(f, ['name', 'description', 'parameters', 'strict'], 'function metadata');
    if (protocol === 'responses') return { type: 'function', ...f };
    if (f.strict !== undefined) fail('strict tools');
    return { name: f.name, ...(f.description ? { description: f.description } : {}), input_schema: f.parameters ?? { type: 'object', properties: {} } };
}
function choice(value, protocol) {
    if (value == null) return undefined;
    if (protocol === 'responses') {
        if (typeof value === 'string' && ['auto', 'none', 'required'].includes(value)) return value;
        if (value?.type === 'function' && value.function?.name) return { type: 'function', name: value.function.name };
    } else {
        if (value === 'auto') return { type: 'auto' };
        if (value === 'required') return { type: 'any' };
        if (value?.type === 'function' && value.function?.name) return { type: 'tool', name: value.function.name };
    }
    fail('tool_choice');
}
function sidecar(m, protocol, model) {
    if (!m.go_bridge) return null;
    if (m.go_bridge.protocol !== protocol || m.go_bridge.model !== model) fail('cross-model protocol metadata');
    const blocks = m.go_bridge.blocks;
    if (!Array.isArray(blocks)) fail('protocol metadata');
    const decoded = decodeResponse(protocol === 'responses' ? { output: blocks, status: 'completed' } : { content: blocks, stop_reason: 'end_turn' }, protocol, model).choices[0].message;
    if (JSON.stringify(m.content ?? '') !== JSON.stringify(decoded.content ?? '') || JSON.stringify(m.tool_calls ?? []) !== JSON.stringify(decoded.tool_calls ?? [])) fail('edited assistant/protocol metadata conflict');
    for (const k of ['reasoning_content', 'refusal']) if (Object.hasOwn(m, k) && (m[k] ?? '') !== (decoded[k] ?? '')) fail(`edited ${k}/protocol metadata conflict`);
    return structuredClone(blocks);
}
function encodeResponses(b) {
    supported(b, ['model', 'messages', 'stream', 'temperature', 'top_p', 'max_tokens', 'max_completion_tokens', 'tools', 'tool_choice', 'parallel_tool_calls', 'reasoning_effort', 'response_format', 'stream_options', 'verbosity']);
    const input = [];
    for (const m of b.messages) {
        validateMessage(m);
        const replay = sidecar(m, 'responses', b.model);
        if (replay) { if (m.role !== 'assistant') fail('protocol metadata role'); input.push(...replay); continue; }
        if (m.role === 'tool') { if (typeof m.content !== 'string' || !m.tool_call_id) fail('tool result'); input.push({ type: 'function_call_output', call_id: m.tool_call_id, output: m.content }); continue; }
        if (!['system', 'developer', 'user', 'assistant'].includes(m.role)) fail('message.role');
        const content = parts(m.content, m.role, 'responses');
        if (content.length) input.push({ role: m.role, content });
        for (const t of m.tool_calls ?? []) {
            if (m.role !== 'assistant' || t.type !== 'function' || !t.id || typeof t.function?.arguments !== 'string') fail('tool call');
            input.push({ type: 'function_call', call_id: t.id, name: t.function.name, arguments: t.function.arguments });
        }
    }
    const out = { model: b.model, input, stream: !!b.stream, store: false, include: ['reasoning.encrypted_content'] };
    for (const k of ['temperature', 'top_p', 'parallel_tool_calls']) if (b[k] !== undefined) out[k] = b[k];
    const limit = b.max_completion_tokens ?? b.max_tokens; if (limit != null) out.max_output_tokens = limit;
    if (b.tools?.length) out.tools = b.tools.map(t => toolDefinition(t, 'responses'));
    if (b.tool_choice !== undefined) out.tool_choice = choice(b.tool_choice, 'responses');
    if (b.reasoning_effort) out.reasoning = { effort: b.reasoning_effort };
    if (b.response_format) {
        const f = b.response_format;
        if (f.type === 'json_schema') out.text = { format: { type: f.type, ...f.json_schema } };
        else if (['json_object', 'text'].includes(f.type)) out.text = { format: f };
        else fail('response_format');
    }
    if (b.verbosity) out.text = { ...out.text, verbosity: b.verbosity };
    return out;
}
function encodeMessages(b) {
    supported(b, ['model', 'messages', 'stream', 'temperature', 'top_p', 'top_k', 'max_tokens', 'max_completion_tokens', 'tools', 'tool_choice', 'parallel_tool_calls', 'thinking', 'reasoning_effort', 'stop', 'stream_options']);
    const messages = []; const system = [];
    const push = (role, content) => { if (!content.length) return; const previous = messages.at(-1); if (previous?.role === role) previous.content.push(...content); else messages.push({ role, content }); };
    for (const m of b.messages) {
        validateMessage(m);
        if (['system', 'developer'].includes(m.role)) {
            if (messages.length || m.role === 'developer') fail('interleaved system/developer');
            system.push(...parts(m.content, m.role, 'messages')); continue;
        }
        const replay = sidecar(m, 'messages', b.model);
        if (replay) { if (m.role !== 'assistant') fail('protocol metadata role'); push('assistant', replay); continue; }
        if (m.role === 'tool') {
            if (!m.tool_call_id) fail('tool result id');
            push('user', [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: parts(m.content, 'user', 'messages') }]); continue;
        }
        if (!['user', 'assistant'].includes(m.role)) fail('message.role');
        const content = parts(m.content, m.role, 'messages');
        for (const t of m.tool_calls ?? []) {
            if (m.role !== 'assistant' || t.type !== 'function' || !t.id) fail('tool call');
            let args; try { args = JSON.parse(t.function.arguments); } catch { fail('tool arguments JSON'); }
            if (!args || typeof args !== 'object' || Array.isArray(args)) fail('tool arguments object');
            content.push({ type: 'tool_use', id: t.id, name: t.function.name, input: args });
        }
        push(m.role, content);
    }
    const limit = b.max_completion_tokens ?? b.max_tokens;
    if (!Number.isInteger(limit) || limit <= 0) fail('max_tokens (Messages requires a positive integer)');
    const out = { model: b.model, messages, max_tokens: limit, stream: !!b.stream };
    if (system.length) out.system = system;
    for (const k of ['temperature', 'top_p', 'top_k', 'thinking']) if (b[k] !== undefined) out[k] = b[k];
    if (b.reasoning_effort) out.output_config = { effort: b.reasoning_effort };
    if (b.stop?.length) out.stop_sequences = typeof b.stop === 'string' ? [b.stop] : b.stop;
    if (b.tools?.length) out.tools = b.tools.map(t => toolDefinition(t, 'messages'));
    if (b.tool_choice !== undefined) out.tool_choice = choice(b.tool_choice, 'messages');
    if (b.parallel_tool_calls !== undefined) out.tool_choice = { ...(out.tool_choice ?? { type: 'auto' }), disable_parallel_tool_use: !b.parallel_tool_calls };
    return out;
}
export function encodeRequest(body) {
    const protocol = protocolFor(body.model);
    if (body.max_tokens != null && body.max_completion_tokens != null && body.max_tokens !== body.max_completion_tokens) fail('conflicting token limits');
    if (protocol === 'chat') { if (body.messages.some(m => m.go_bridge)) fail('cross-protocol metadata'); return { protocol, url: CHAT_URL, body, headers: {} }; }
    if (protocol === 'responses') return { protocol, url: 'https://opencode.ai/inference/go/openai/v1/responses', body: encodeResponses(body), headers: {} };
    if (protocol === 'messages') return { protocol, url: 'https://opencode.ai/inference/go/anthropic/v1/messages', body: encodeMessages(body), headers: { 'anthropic-version': '2023-06-01' } };
    fail('model protocol');
}
function usage(u = {}) {
    const input = u.input_tokens ?? 0; const output = u.output_tokens ?? 0;
    return { prompt_tokens: input, completion_tokens: output, total_tokens: input + output, go_native: u };
}
export function decodeResponse(result, protocol, model) {
    if (protocol === 'chat') return result;
    if (result.error) badResponse();
    const message = { role: 'assistant', content: '', tool_calls: [] }; let finish = 'stop';
    let blocks;
    if (protocol === 'responses') {
        blocks = result.output; if (!Array.isArray(blocks) || !['completed', 'incomplete'].includes(result.status)) badResponse();
        for (const block of blocks) {
            if (block.type === 'message') for (const p of block.content ?? []) {
                if (p.type === 'output_text') { if (p.annotations?.length) badResponse(); message.content += p.text; }
                else if (p.type === 'refusal') { message.refusal = (message.refusal ?? '') + p.refusal; finish = 'content_filter'; }
                else badResponse();
            }
            else if (block.type === 'function_call') message.tool_calls.push({ id: block.call_id, type: 'function', function: { name: block.name, arguments: block.arguments } });
            else if (block.type === 'reasoning') message.reasoning_content = (message.reasoning_content ?? '') + (block.summary ?? []).map(p => { if (p.type !== 'summary_text') badResponse(); return p.text; }).join('\n');
            else badResponse();
        }
        if (result.status === 'incomplete') finish = result.incomplete_details?.reason === 'max_output_tokens' ? 'length' : 'content_filter';
    } else {
        blocks = result.content; if (!Array.isArray(blocks)) badResponse();
        for (const block of blocks) {
            if (block.type === 'text') { if (block.citations?.length) badResponse(); message.content += block.text; }
            else if (block.type === 'tool_use') message.tool_calls.push({ id: block.id, type: 'function', function: { name: block.name, arguments: JSON.stringify(block.input) } });
            else if (block.type === 'thinking') message.reasoning_content = (message.reasoning_content ?? '') + block.thinking;
            else if (block.type !== 'redacted_thinking') badResponse();
        }
        const stops = { end_turn: 'stop', stop_sequence: 'stop', tool_use: 'tool_calls', max_tokens: 'length', refusal: 'content_filter' };
        finish = stops[result.stop_reason]; if (!finish) badResponse();
    }
    if (message.tool_calls.length && finish === 'stop') finish = 'tool_calls';
    if (!message.tool_calls.length) delete message.tool_calls;
    message.go_bridge = { protocol, model, blocks };
    return { id: result.id, object: 'chat.completion', model, created: Math.floor(Date.now() / 1000),
        choices: [{ index: 0, message, finish_reason: finish }], usage: usage(result.usage) };
}

// Incremental translation; bounded event buffer, no whole-stream text buffering.
export function convertStream(response, protocol, model, onAssistant) {
    const encoder = new TextEncoder(); const decoder = new TextDecoder();
    let streamedText = ''; let streamedRefusal = ''; const streamedTools = []; const streamedReasoning = new Map();
    let buffer = ''; let ended = false; let id = 'go-stream'; let nativeUsage = {};
    const toolIndices = new Map(); const blocks = []; const openBlocks = new Set(); let started = false; let finalMessage = null; let totalBytes = 0;
    const chunk = (delta, finish = null, u) => ({ id, object: 'chat.completion.chunk', model, choices: [{ index: 0, delta, finish_reason: finish }], ...(u ? { usage: usage(u) } : {}) });
    const emit = (c, data) => c.enqueue(encoder.encode(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`));
    const error = c => { emit(c, { error: { code: 'go_stream_error', message: 'Go 流中断或包含不能保真转换的内容；未重试。' } }); emit(c, '[DONE]'); ended = true; c.terminate(); };
    function consume(event, c) {
        if (event.error || event.type === 'error' || ['response.failed', 'response.incomplete'].includes(event.type)) {
            if (event.type !== 'response.incomplete') return error(c);
        }
        if (protocol === 'responses') {
            if (event.type === 'response.created') { id = event.response.id; emit(c, chunk({ role: 'assistant' })); }
            else if (event.type === 'response.output_item.added') {
                if (event.item.type === 'function_call') {
                    const index = toolIndices.size; toolIndices.set(event.output_index, index);
                    streamedTools.push({ id: event.item.call_id, type: 'function', function: { name: event.item.name, arguments: event.item.arguments || '' } });
                    emit(c, chunk({ tool_calls: [{ index, id: event.item.call_id, type: 'function', function: { name: event.item.name, arguments: event.item.arguments || '' } }] }));
                } else if (!['reasoning', 'message'].includes(event.item.type)) return error(c);
            }
            else if (event.type === 'response.output_text.delta') { streamedText += event.delta; emit(c, chunk({ content: event.delta })); }
            else if (event.type === 'response.refusal.delta') { streamedRefusal += event.delta; emit(c, chunk({ refusal: event.delta })); }
            else if (event.type === 'response.reasoning_summary_text.delta') { const k = `${event.output_index}:${event.summary_index}`; streamedReasoning.set(k, (streamedReasoning.get(k) ?? '') + event.delta); emit(c, chunk({ reasoning_content: event.delta })); }
            else if (event.type === 'response.function_call_arguments.delta') {
                const index = toolIndices.get(event.output_index); if (index === undefined) return error(c);
                streamedTools[index].function.arguments += event.delta;
                emit(c, chunk({ tool_calls: [{ index, function: { arguments: event.delta } }] }));
            }
            else if (['response.completed', 'response.incomplete'].includes(event.type)) {
                const final = decodeResponse(event.response, protocol, model);
                const m = final.choices[0].message;
                if (m.content !== streamedText || (m.refusal ?? '') !== streamedRefusal || JSON.stringify(m.tool_calls ?? []) !== JSON.stringify(streamedTools) || (m.reasoning_content ?? '') !== [...streamedReasoning.values()].join('\n')) return error(c);
                onAssistant?.(final.choices[0].message);
                emit(c, chunk({ go_bridge: final.choices[0].message.go_bridge }, final.choices[0].finish_reason, event.response.usage));
                emit(c, '[DONE]'); ended = true; c.terminate();
            }
            else if (!['response.in_progress', 'response.output_item.done', 'response.content_part.added', 'response.content_part.done', 'response.output_text.done', 'response.function_call_arguments.done', 'response.reasoning_summary_part.added', 'response.reasoning_summary_part.done', 'response.reasoning_summary_text.done', 'response.refusal.done'].includes(event.type)) return error(c);
        } else {
            if (event.type === 'message_start') { if (started) return error(c); started = true; id = event.message.id; nativeUsage = event.message.usage ?? {}; emit(c, chunk({ role: 'assistant' })); }
            else if (event.type === 'content_block_start') {
                if (!started || finalMessage || !Number.isInteger(event.index) || event.index !== blocks.length) return error(c);
                openBlocks.add(event.index); const b = structuredClone(event.content_block); blocks[event.index] = b;
                if (b.type === 'tool_use') {
                    const index = toolIndices.size; toolIndices.set(event.index, index); b._arguments = '';
                    emit(c, chunk({ tool_calls: [{ index, id: b.id, type: 'function', function: { name: b.name, arguments: Object.keys(b.input ?? {}).length ? JSON.stringify(b.input) : '' } }] }));
                } else if (b.type === 'text' && b.text) emit(c, chunk({ content: b.text }));
                else if (b.type === 'thinking' && b.thinking) emit(c, chunk({ reasoning_content: b.thinking }));
                else if (!['text', 'thinking', 'redacted_thinking'].includes(b.type)) return error(c);
            }
            else if (event.type === 'content_block_delta') {
                const b = blocks[event.index]; if (!b || !openBlocks.has(event.index)) return error(c);
                const d = event.delta;
                if (d.type === 'text_delta' && b.type === 'text') { b.text += d.text; emit(c, chunk({ content: d.text })); }
                else if (d.type === 'thinking_delta' && b.type === 'thinking') { b.thinking += d.thinking; emit(c, chunk({ reasoning_content: d.thinking })); }
                else if (d.type === 'signature_delta' && b.type === 'thinking') b.signature = (b.signature ?? '') + d.signature;
                else if (d.type === 'input_json_delta' && b.type === 'tool_use') { b._arguments += d.partial_json; emit(c, chunk({ tool_calls: [{ index: toolIndices.get(event.index), function: { arguments: d.partial_json } }] })); }
                else return error(c);
            }
            else if (event.type === 'content_block_stop') {
                const b = blocks[event.index]; if (!b || !openBlocks.has(event.index)) return error(c);
                if (b.type === 'tool_use') {
                    if (b._arguments) { if (Object.keys(b.input ?? {}).length) return error(c); b.input = JSON.parse(b._arguments); }
                    else if (!Object.keys(b.input ?? {}).length) emit(c, chunk({ tool_calls: [{ index: toolIndices.get(event.index), function: { arguments: '{}' } }] }));
                    if (!b.input || typeof b.input !== 'object' || Array.isArray(b.input)) return error(c);
                    delete b._arguments;
                }
                openBlocks.delete(event.index);
            }
            else if (event.type === 'message_delta') {
                if (!started || finalMessage || openBlocks.size) return error(c);
                nativeUsage = { ...nativeUsage, ...event.usage };
                const final = decodeResponse({ id, content: blocks, stop_reason: event.delta.stop_reason, usage: nativeUsage }, protocol, model);
                finalMessage = final.choices[0].message;
                emit(c, chunk({ go_bridge: finalMessage.go_bridge }, final.choices[0].finish_reason, nativeUsage));
            }
            else if (event.type === 'message_stop') { if (!started || !finalMessage || openBlocks.size) return error(c); onAssistant?.(finalMessage); emit(c, '[DONE]'); ended = true; c.terminate(); }
            else if (event.type !== 'ping') return error(c);
        }
    }
    return new Response(guardedSseBody(response.body).pipeThrough(new TransformStream({
        transform(bytes, c) {
            if (ended) return;
            totalBytes += bytes.byteLength; if (totalBytes > 16 * 1024 * 1024) return error(c);
            buffer += decoder.decode(bytes, { stream: true }); let match;
            while ((match = /\r?\n\r?\n/.exec(buffer))) {
                const frame = buffer.slice(0, match.index); buffer = buffer.slice(match.index + match[0].length);
                if (frame.length > 1024 * 1024) return error(c);
                const data = frame.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
                if (!data) continue;
                try { consume(JSON.parse(data), c); } catch { return error(c); }
                if (ended) return;
            }
            if (buffer.length > 1024 * 1024) error(c);
        },
        flush(c) { if (!ended) error(c); },
    })), { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } });
}

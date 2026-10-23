import { randomBytes } from 'node:crypto';
import { CHAT_URL, MODELS_URL, USER_AGENT, decorateModels, protocolFor } from './catalog.mjs';
import { sanitizeSse } from './sse.mjs';
import { BridgeError } from './errors.mjs';
import { encodeRequest, decodeResponse, convertStream } from './protocols.mjs';
export { BridgeError } from './errors.mjs';

export function publicError(error) {
    return error instanceof BridgeError ? { status: error.status, error: { code: error.code, message: error.message } }
        : { status: 502, error: { code: 'upstream_unavailable', message: 'Go 请求失败。请检查服务连接；未重试或切换计费端点。' } };
}
export function abortCheck(signal) { if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError'); }

export class SessionVault {
    #sessions = new Map();
    constructor({ now = Date.now, ttlMs = 8 * 3600_000, max = 64, perOwner = 8 } = {}) { this.now = now; this.ttlMs = ttlMs; this.max = max; this.perOwner = perOwner; }
    sweep() { for (const [token, s] of this.#sessions) if (s.expires <= this.now()) { for (const c of s.controllers) c.abort(); this.#sessions.delete(token); } }
    open(owner, key) {
        this.sweep();
        if (!owner) throw new BridgeError(401, 'user_required', '需要酒馆用户上下文。此版本不支持匿名插件路由。');
        if (typeof key !== 'string' || !/^[\x21-\x7E]{8,4096}$/.test(key)) throw new BridgeError(400, 'invalid_key', 'API Key 格式无效。');
        if (this.#sessions.size >= this.max) throw new BridgeError(429, 'session_limit', '临时连接已达上限。请先断开旧连接。');
        if ([...this.#sessions.values()].filter(s => s.owner === owner).length >= this.perOwner) throw new BridgeError(429, 'session_limit', '此用户的临时连接已达上限，请先断开旧连接。');
        const token = randomBytes(32).toString('base64url');
        const expires = this.now() + this.ttlMs;
        this.#sessions.set(token, { owner, key, expires, controllers: new Set() });
        return { token, expires };
    }
    get(owner, token) {
        this.sweep(); const s = this.#sessions.get(token);
        if (!s || !owner || s.owner !== owner) throw new BridgeError(401, 'session_expired', 'Go 临时连接不存在或已过期，请重新输入 API Key。');
        return s;
    }
    close(owner, token) {
        const s = this.get(owner, token);
        for (const controller of s.controllers) controller.abort();
        this.#sessions.delete(token);
    }
    clear() {
        for (const s of this.#sessions.values()) for (const c of s.controllers) c.abort();
        this.#sessions.clear();
    }
}

const fields = new Set(['model', 'messages', 'stream', 'temperature', 'max_tokens', 'max_completion_tokens',
    'top_p', 'top_k', 'presence_penalty', 'frequency_penalty', 'stop', 'seed', 'n', 'logit_bias',
    'logprobs', 'top_logprobs', 'tools', 'tool_choice', 'parallel_tool_calls', 'response_format',
    'reasoning_effort', 'thinking', 'enable_thinking', 'stream_options', 'verbosity']);
const hostMetadata = new Set(['type', 'chat_completion_source', 'user_name', 'char_name', 'group_names', 'include_reasoning',
    'enable_web_search', 'request_images', 'request_image_resolution', 'request_image_aspect_ratio',
    'custom_prompt_post_processing', 'custom_include_body', 'custom_exclude_body', 'custom_include_headers', 'json_schema', 'use_sysprompt']);

export function preparePayload(input, { native = false } = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new BridgeError(400, 'invalid_body', '请求必须是 JSON 对象。');
    if (Buffer.byteLength(JSON.stringify(input)) > 8 * 1024 * 1024) throw new BridgeError(413, 'body_too_large', '请求超过适配器 8 MiB 限制。');
    if (typeof input.model !== 'string' || !['chat', 'responses', 'messages'].includes(protocolFor(input.model))) throw new BridgeError(400, 'unsupported_protocol', '此模型协议尚未核实或未支持。Gemini 和未知协议暂不支持。');
    if (!Array.isArray(input.messages) || input.messages.length === 0) throw new BridgeError(400, 'messages_required', '需要非空 messages。');
    if (input.stream !== undefined && typeof input.stream !== 'boolean') throw new BridgeError(400, 'invalid_stream', 'stream 必须是布尔值。');
    for (const field of ['custom_include_body', 'custom_exclude_body', 'custom_include_headers']) {
        if (input[field]?.trim?.()) throw new BridgeError(400, 'custom_yaml_unsupported', 'Go 连接请清空自定义 YAML 参数/请求头；此适配器不解析或默默忽略这些覆盖。');
    }
    if (input.custom_prompt_post_processing && input.custom_prompt_post_processing !== 'none') throw new BridgeError(400, 'post_processing_unsupported', 'Go 连接请将提示词后处理设为 None；此版本不替代酒馆的消息合并逻辑。');
    if (input.enable_web_search || input.request_images) throw new BridgeError(400, 'unsupported_feature', '此版本不支持内置联网搜索或图片生成。输入图片可按协议转换，但模型能力仍需核实。');
    for (const field of ['audio', 'modalities', 'prediction', 'functions', 'function_call', 'prompt']) {
        if (input[field] != null) throw new BridgeError(400, 'unsupported_field', `暂不支持字段 ${field}，请使用文本 Chat Completions 协议。`);
    }
    {
        const unknown = Object.keys(input).some(key => !fields.has(key) && !(native && hostMetadata.has(key)));
        if (unknown) throw new BridgeError(400, 'unsupported_field', '直连接口含未支持字段；为防止丢失参数，已停止请求。');
    }
    const body = Object.fromEntries(Object.entries(input).filter(([key, value]) => fields.has(key) && value !== undefined));
    // Never change nested messages: includes tool history, reasoning_content and image_url.
    if (!body.reasoning_effort || body.reasoning_effort === 'auto') delete body.reasoning_effort;
    if (body.reasoning_effort && !/^[a-z0-9_-]{1,32}$/i.test(body.reasoning_effort)) throw new BridgeError(400, 'invalid_reasoning', '思考参数格式无效。');
    if (native && input.json_schema && !body.response_format) body.response_format = {
        type: 'json_schema', json_schema: { name: input.json_schema.name, strict: input.json_schema.strict ?? true, schema: input.json_schema.value },
    };
    // ST native logprobs is a count; OpenAI-compatible Chat uses boolean + top_logprobs.
    if (native && typeof body.logprobs === 'number') {
        if (body.logprobs > 0) { body.top_logprobs = body.logprobs; body.logprobs = true; }
        else { delete body.logprobs; delete body.top_logprobs; }
    }
    return body;
}

const errorMessages = {
    401: 'Go 拒绝认证。请检查自己的 API Key。',
    403: 'Go 拒绝访问。请核实订阅、地区、模型及用途；适配器不会伪装客户端或尝试旁路。',
    429: 'Go 限额或速率限制。请稍后重试并检查控制台；不会自动切换按量接口。',
};

export function createGoClient({ fetchImpl = globalThis.fetch, now = Date.now } = {}) {
    let cache; let cachedAt = 0;
    async function models(signal) {
        abortCheck(signal);
        if (cache && now() - cachedAt < 300_000) return cache;
        let response;
        try { response = await fetchImpl(MODELS_URL, { redirect: 'error', signal, headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } }); }
        catch (error) { abortCheck(signal); throw new BridgeError(503, 'catalog_unavailable', 'Go 模型目录暂不可达，未使用过期目录发送推理。'); }
        if (!response.ok) { await response.body?.cancel(); throw new BridgeError(503, 'catalog_unavailable', 'Go 模型目录暂不可用。'); }
        cache = decorateModels(await response.json()); cachedAt = now(); return cache;
    }
    async function generate(input, { key, sessionId, signal, native = false, onAssistant } = {}) {
        abortCheck(signal);
        if (typeof sessionId !== 'string' || !/^stgo_[a-zA-Z0-9_-]{20,80}$/.test(sessionId)) throw new BridgeError(400, 'session_required', '需要稳定的会话标识。');
        if (typeof key !== 'string' || !/^[\x21-\x7E]{8,4096}$/.test(key)) throw new BridgeError(401, 'invalid_key', 'API Key 格式无效。');
        const body = preparePayload(input, { native });
        const encoded = encodeRequest(body);
        const available = await models(signal);
        if (!available.some(m => m.id === body.model && m.supported)) throw new BridgeError(400, 'model_unavailable', '模型不在当前 Go 目录中，未发送推理。');
        const response = await fetchImpl(encoded.url, {
            method: 'POST', redirect: 'error', signal,
            headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json',
                Accept: body.stream ? 'text/event-stream' : 'application/json',
                'User-Agent': USER_AGENT, 'x-opencode-session': sessionId, ...encoded.headers },
            body: JSON.stringify(encoded.body),
        });
        if (!response.ok) {
            await response.body?.cancel(); // Never echo an upstream error that might contain credentials/content.
            throw new BridgeError(response.status >= 400 && response.status <= 599 ? response.status : 502,
                'go_rejected', errorMessages[response.status] ?? `Go 返回 HTTP ${response.status}。请求参数或服务可能暂不支持；未自动重试。`);
        }
        if (body.stream) {
            if (!response.headers.get('content-type')?.includes('text/event-stream')) {
                await response.body?.cancel(); throw new BridgeError(502, 'invalid_stream', 'Go 返回了非 SSE 响应。');
            }
            return encoded.protocol === 'chat' ? sanitizeSse(response) : convertStream(response, encoded.protocol, body.model, onAssistant);
        }
        const result = decodeResponse(await response.json(), encoded.protocol, body.model);
        if (result?.error || !Array.isArray(result?.choices)) throw new BridgeError(502, 'invalid_response', 'Go 返回了无效或错误响应。');
        onAssistant?.(result.choices[0]?.message);
        return Response.json(result);
    }
    return { models, generate };
}

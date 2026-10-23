export const GO_BASE = 'https://opencode.ai/inference/go/openai/v1';
// Reserved .invalid marker cannot accidentally contact a provider after uninstall.
export const GO_MARKER = 'https://opencode-go.invalid/v1';
const nativeGenerate = '/api/backends/chat-completions/generate';
const nativeStatus = '/api/backends/chat-completions/status';
const pluginBase = '/api/plugins/opencode-go-bridge';

export function isGoBase(value) {
    if (typeof value !== 'string') return false;
    try {
        const url = new URL(value);
        return !url.username && !url.password && !url.search && !url.hash &&
            ((url.origin === 'https://opencode.ai' && url.pathname.replace(/\/$/, '') === '/inference/go/openai/v1') ||
            (url.origin === 'https://opencode-go.invalid' && url.pathname.replace(/\/$/, '') === '/v1'));
    } catch { return false; }
}
export function classify(url, body, origin, { direct = false } = {}) {
    const target = new URL(url, origin);
    if (target.origin === origin && [nativeGenerate, nativeStatus].includes(target.pathname) && !target.search) {
        const endpoint = body?.chat_completion_source === 'custom' ? body.custom_url
            : body?.chat_completion_source === 'openai' ? body.reverse_proxy : null;
        if (isGoBase(endpoint)) return target.pathname === nativeStatus ? 'native-status' : 'native-generate';
    }
    if (direct && target.href === `${GO_BASE}/chat/completions`) return 'direct-generate';
    // This public catalog is at /go/v1/models, not /go/openai/v1/models.
    if (direct && [GO_BASE + '/models', 'https://opencode.ai/inference/go/v1/models'].includes(target.href)) return 'direct-status';
    return null;
}
const sensitiveHostFields = new Set(['proxy_password', 'api_key', 'key', 'password', 'secret_id', 'custom_url', 'reverse_proxy']);
export function withoutHostCredentials(body) {
    return Object.fromEntries(Object.entries(body).filter(([key]) => !sensitiveHostFields.has(key)));
}
export function createSessionIds({ uuid = () => crypto.randomUUID() } = {}) {
    const map = new Map();
    return { forConversation(id) {
        if (typeof id !== 'string' || !id) throw new Error('请先打开一个会话，以便为 Go 提供稳定的会话标识。');
        if (!map.has(id)) map.set(id, 'stgo_' + uuid().replace(/-/g, ''));
        return map.get(id);
    }, clear() { map.clear(); } };
}
const localError = (status, code, message) => Response.json({ error: { code, message } }, { status });

// No global patch on import. Caller installs only after an explicit connection action.
export function createRoutedFetch({ originalFetch, origin, getState, requestHeaders, conversationId, sessionIds = createSessionIds() }) {
    return async function routedFetch(input, init) {
        const state = getState();
        if (!state.active) return originalFetch(input, init);
        let url;
        try { url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, origin); }
        catch { return originalFetch(input, init); }
        const native = url.origin === origin && [nativeGenerate, nativeStatus].includes(url.pathname);
        const directCandidate = state.direct && url.origin === 'https://opencode.ai' && url.pathname.startsWith('/inference/go/');
        if (!native && !directCandidate) return originalFetch(input, init);
        const req = input instanceof Request ? new Request(input.clone(), init) : new Request(url, init);
        let body;
        try { body = req.method === 'POST' ? await req.clone().json() : {}; }
        catch { return originalFetch(input, init); }
        const kind = classify(url, body, origin, { direct: state.direct });
        if (!kind) return originalFetch(input, init);
        if (!state.token) return localError(401, 'not_connected', '请在 Go 扩展中输入自己的 Key 并连接。');
        if (!['POST', 'GET'].includes(req.method)) return localError(405, 'method_not_allowed', 'Go 适配器不支持此方法。');
        if (kind.endsWith('generate') && req.method !== 'POST') return localError(405, 'method_not_allowed', '推理必须使用 POST。');
        const headers = new Headers(await requestHeaders());
        headers.set('Content-Type', 'application/json'); headers.set('x-st-go-client', '1'); headers.set('x-st-go-token', state.token);
        // Incoming headers (API keys, cookies, SDK identity) are never copied.
        let envelope;
        if (kind.endsWith('generate')) {
            let sessionId;
            try { sessionId = sessionIds.forConversation(conversationId()); }
            catch { return localError(400, 'conversation_required', '请先打开会话。后台独立任务需单独接入会话标识。'); }
            const payload = kind.startsWith('native') ? withoutHostCredentials(body) : { ...body };
            // Respect each plugin's selected model; use the panel only as a missing-model default.
            if (!payload.model && state.model) payload.model = state.model;
            if (state.reasoningMode === 'auto') { delete payload.reasoning_effort; delete payload.thinking; delete payload.enable_thinking; }
            if (state.reasoningMode === 'custom' && state.reasoningEffort) payload.reasoning_effort = state.reasoningEffort;
            envelope = { payload, native: kind.startsWith('native'), sessionId };
        }
        return originalFetch(`${pluginBase}/${kind.endsWith('status') ? 'status' : 'generate'}`, {
            method: 'POST', credentials: 'same-origin', redirect: 'error', headers,
            signal: req.signal, body: JSON.stringify(envelope ?? {}),
        });
    };
}

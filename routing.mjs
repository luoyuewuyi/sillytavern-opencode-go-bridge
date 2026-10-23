export const USER_AGENT = 'sillytavern-opencode-go-bridge/0.3.0';
export const GO_CHAT_BASE = 'https://opencode.ai/inference/go/openai/v1';
export const GO_MODELS_BASE = 'https://opencode.ai/inference/go/v1';
export const GENERATE_PATH = '/api/backends/chat-completions/generate';
export const STATUS_PATH = '/api/backends/chat-completions/status';

// Exact current official URLs only. No Zen PAYG, legacy URLs, redirects or URL rewrites.
export function matchesGo(body, path) {
    if (body?.chat_completion_source !== 'custom' || typeof body.custom_url !== 'string') return false;
    const bases = path === STATUS_PATH ? [GO_CHAT_BASE, GO_MODELS_BASE] : path === GENERATE_PATH ? [GO_CHAT_BASE] : [];
    return bases.some(base => body.custom_url === base || body.custom_url === base + '/');
}
function randomSession() {
    const bytes = new Uint8Array(16); crypto.getRandomValues(bytes);
    return 'stgo_' + Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}
export function createSessionIds(random = randomSession) {
    const ids = new Map();
    return { forConversation(id) {
        // Main and auxiliary requests for an open chat share one opaque ID.
        // With no open chat, requests share a separate page-scoped ID.
        const scope = typeof id === 'string' && id ? id : '\u0000no-open-chat';
        if (!ids.has(scope)) ids.set(scope, random());
        return ids.get(scope);
    } };
}
export function addGoHeaders(raw, sessionId, parseYaml) {
    let parsed;
    if (raw !== undefined && raw !== null && raw !== '') {
        if (typeof raw !== 'string') throw new Error('invalid_headers');
        try { parsed = parseYaml ? parseYaml(raw) : JSON.parse(raw); } catch { throw new Error('invalid_headers'); }
        if (parsed !== null && typeof parsed !== 'object') throw new Error('invalid_headers');
    }
    // Mirror ST mergeObjectWithYaml's object/list-of-objects handling. Preserve every
    // non-client header, including any explicit Authorization, without inspecting it.
    const headers = Object.create(null); let existingSession;
    for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
        for (const [name, value] of Object.entries(item)) {
            const lower = name.toLowerCase();
            if (lower === 'x-opencode-session') existingSession = value;
            else if (lower !== 'user-agent') headers[name] = value;
        }
    }
    // Last case-insensitive session wins if it is a bounded printable identifier.
    // Invalid/empty values are replaced; user-provided valid IDs are never re-derived.
    headers['User-Agent'] = USER_AGENT;
    headers['x-opencode-session'] = typeof existingSession === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(existingSession) ? existingSession : sessionId;
    return JSON.stringify(headers); // JSON is a valid YAML mapping in the native server.
}

async function readJson(request) {
    request.signal.throwIfAborted();
    const reader = request.clone().body?.getReader();
    if (!reader) throw new Error('empty_body');
    const decoder = new TextDecoder(); let text = '';
    // Cancellation must also work before the request body has finished arriving.
    // Cancelling a tee branch can wait on its sibling, so do not await cancel().
    const onAbort = () => { void reader.cancel(request.signal.reason).catch(() => {}); };
    request.signal.addEventListener('abort', onAbort, { once: true });
    if (request.signal.aborted) onAbort();
    try {
        while (true) {
            const next = await reader.read(); request.signal.throwIfAborted();
            if (next.done) break;
            text += decoder.decode(next.value, { stream: true });
        }
        return JSON.parse(text + decoder.decode());
    } finally { request.signal.removeEventListener('abort', onAbort); reader.releaseLock(); }
}

export function installGoHeaders({ scope = globalThis, origin, conversationId, parseYaml,
    isEnabled = () => true, sessions = createSessionIds() }) {
    const previous = scope.fetch; let active = true;
    const passthrough = (input, init) => previous.call(scope, input, init);
    async function wrapped(input, init) {
        if (!active || !isEnabled()) return passthrough(input, init);
        let target;
        try { target = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, origin); }
        catch { return passthrough(input, init); }
        if (target.origin !== origin || target.search || target.hash || ![GENERATE_PATH, STATUS_PATH].includes(target.pathname)) return passthrough(input, init);
        let chat; try { chat = conversationId(); } catch { chat = null; }
        let request; let body;
        try {
            request = input instanceof Request ? new Request(init?.body != null ? input : input.clone(), init) : new Request(target, init);
            if (request.method !== 'POST') return passthrough(input, init);
            body = await readJson(request);
        } catch (error) {
            if (request?.signal.aborted) throw request.signal.reason;
            return passthrough(input, init);
        }
        if (!matchesGo(body, target.pathname)) return passthrough(input, init);
        // Disable may occur while the cloned request body is being read.
        if (!active || !isEnabled()) return passthrough(input, init);
        let value;
        try {
            value = addGoHeaders(body.custom_include_headers, sessions.forConversation(chat), parseYaml);
        } catch {
            // Never log/echo YAML: it can contain explicit user credentials.
            return Response.json({ error: { message: 'Go 请求头无法解析。请检查酒馆原生自定义请求头的 YAML 格式及扩展兼容性。' } }, { status: 400 });
        }
        const nextBody = JSON.stringify({ ...body, custom_include_headers: value });
        // Preserve caller headers/CSRF, credentials, signal and every other option.
        // Do not read, parse, buffer or rewrite the returned response/SSE stream.
        if (input instanceof Request) return passthrough(new Request(request, { body: nextBody }));
        return passthrough(input, { ...init, body: nextBody });
    }
    scope.fetch = wrapped;
    return { dispose() {
        active = false;
        // A later extension's wrapper must not be overwritten. Our inner wrapper
        // becomes inert in that case and forwards exactly to the prior fetch.
        if (scope.fetch === wrapped) scope.fetch = previous;
    }, get active() { return active; } };
}

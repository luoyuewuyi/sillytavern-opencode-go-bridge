import { GO_MARKER, createRoutedFetch, createSessionIds } from './routing.mjs';
import { createActivation } from './activation.mjs';

// The panel deliberately uses the stable public context instead of private imports.
const getContext = () => globalThis.SillyTavern?.getContext?.();
const state = { active: false, token: null, direct: false, model: '', reasoningMode: 'preserve', reasoningEffort: '' };
const previousFetch = globalThis.fetch;
const originalFetch = previousFetch.bind(globalThis);
const endpoint = '/api/plugins/opencode-go-bridge';
let installed = false;
let sessionToken = null;
let expiryTimer;
let routedFetch;
let activeAction = null;
let disposed = false;
const publicSessions = createSessionIds();
const activation = createActivation({ getContext, execute: async (name, value, args = {}) => {
    const run = getContext()?.executeSlashCommandsWithOptions;
    if (typeof run !== 'function') throw new Error('此版本没有所需的公开命令接口，请手动建立 Go 连接。');
    const named = Object.entries(args).map(([k, v]) => `${k}=${v}`).join(' ');
    const result = await run(`/${name} ${named} ${value}`.trim(), { displayCommand: false, displayResult: false, handleParserErrors: false, handleExecutionErrors: false });
    return result?.pipe;
} });
async function headers() {
    const getHeaders = getContext()?.getRequestHeaders;
    if (typeof getHeaders !== 'function') throw new Error('当前酒馆未提供 getRequestHeaders；请升级或使用受支持版本。');
    return { ...await getHeaders(), 'Content-Type': 'application/json', 'x-st-go-client': '1', ...(sessionToken ? { 'x-st-go-token': sessionToken } : {}) };
}
async function api(path, body, method = 'POST') {
    const response = await originalFetch(endpoint + path, { method, credentials: 'same-origin', redirect: 'error', headers: await headers(),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    if (response.status === 404) throw new Error('未找到 Go 服务端插件。仅前端扩展无法自动设置服务端请求头。');
    let result;
    try { result = await response.json(); } catch { throw new Error('酒馆返回了非 JSON 响应，请检查服务端插件与反向代理。'); }
    if (!response.ok || result.error) throw Object.assign(new Error(result.error?.message || `HTTP ${response.status}`), { status: response.status, code: result.error?.code });
    return result;
}
async function disconnectLocal({ dispose = false } = {}) {
    let remoteError; let restoreError;
    try { if (sessionToken) await api('/session', undefined, 'DELETE'); }
    catch (error) { remoteError = error; }
    finally {
        clearTimeout(expiryTimer); sessionToken = null; state.token = null;
        try { await activation.restore(); } catch (error) { restoreError = error; }
        if (dispose) {
            state.active = false;
            if (globalThis.fetch === routedFetch) globalThis.fetch = previousFetch;
            installed = false; publicSessions.clear();
        }
    }
    if (restoreError) throw new Error(`本地连接已停用，但自动恢复失败，请选择恢复配置：${activation.recoveryProfile || 'Go-Recovery'}。`);
    if (remoteError) throw new Error('本地连接已停用并恢复；服务端撤销未确认，临时 Key 最迟在 8 小时 TTL 到期后清除。');
}
function installRouter() {
    if (installed) return;
    routedFetch = createRoutedFetch({ originalFetch, origin: location.origin, getState: () => state, requestHeaders: headers,
        conversationId: () => {
            const c = getContext(); const chat = c?.getCurrentChatId?.();
            return chat ? JSON.stringify([c.groupId ?? null, c.characterId ?? null, chat]) : null;
        },
    });
    globalThis.fetch = routedFetch;
    installed = true;
}
function mount() {
    if (document.getElementById('st-go-bridge')) return;
    const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!host) return;
    const root = document.createElement('div'); root.id = 'st-go-bridge';
    root.innerHTML = `<details><summary>OpenCode Go Bridge · 预览版</summary>
        <p>自动处理真实客户端标识与会话头。需要配套服务端插件；仅接管明确指向 Go 的连接。</p>
        <p class="go-notice">Go 官方要求典型编程代理流量，普通角色聊天未获明确确认。账户若开启 Extra usage，超限可能扣余额；本插件不能控制账户开关，也不会切换按量接口。</p>
        <label>Go API Key（只保存在临时内存）<input data-go="key" type="password" autocomplete="off" spellcheck="false" placeholder="各使用者填写自己的 Key"></label>
        <label><input data-go="ack" type="checkbox">我已确认当前工作符合 Go 官方用途。勾选不代表获得官方授权。</label>
        <label><input data-go="auto" type="checkbox" checked>连接时自动创建独立 Go 配置和恢复快照（断开可恢复，不覆盖原配置）</label>
        <div class="go-buttons"><button class="menu_button" data-go="connect">连接</button><button class="menu_button" data-go="disconnect">断开并清除 Key</button><button class="menu_button" data-go="models">刷新模型</button></div>
        <label>默认模型（调用方未指定时使用）<select data-go="model"><option value="">使用调用方模型</option></select></label>
        <label>思考参数<select data-go="reasoning"><option value="preserve">保留调用方设置（默认）</option><option value="auto">由模型默认决定</option><option value="custom">手动 reasoning_effort（需模型文档支持）</option></select></label>
        <label data-go="effort-label" hidden>reasoning_effort<input data-go="effort" placeholder="填写该模型官方支持的值"></label>
        <label><input data-go="direct" type="checkbox">实验：接管当前页面直接发往 Go 的 Chat 请求</label>
        <p>自动接入只需填写 Key；默认使用目录中第一个受支持模型，可改选。需要酒馆 Connection Manager。手动接入时新建 Chat Completion → Custom 连接，使用下面的专用标记 URL。</p>
        <code class="go-url"></code>
        <p>支持 Chat、Responses、Messages 转换。工具和图片按协议保留，模型能力需另行核实；不能保真的字段会报错。Gemini 暂不支持。后台、iframe 或已缓存 fetch 的插件可用公开适配 API。</p>
        <output data-go="status" role="status">尚未连接。未修改酒馆配置。</output>
    </details>`;
    root.querySelector('.go-url').textContent = GO_MARKER;
    const el = key => root.querySelector(`[data-go="${key}"]`);
    const report = text => { el('status').textContent = text; };
    let busy = false;
    const action = fn => async () => {
        if (busy || disposed) return; busy = true;
        for (const key of ['connect', 'disconnect', 'models']) el(key).disabled = true;
        try { activeAction = fn(); await activeAction; } catch (error) { report(error.message || '操作失败。'); }
        finally { activeAction = null; busy = false; for (const key of ['connect', 'disconnect', 'models']) el(key).disabled = false; }
    };
    async function refresh() {
        const data = await api('/status', {});
        const selected = el('model').value;
        el('model').replaceChildren(new Option('使用调用方模型', ''));
        for (const model of data.data) el('model').add(new Option(`${model.id} · ${model.protocol} · 能力未核实`, model.id));
        el('model').value = selected; state.model = el('model').value;
        return data;
    }
    el('connect').onclick = action(async () => {
        if (!el('ack').checked) throw new Error('请先核实当前用途并勾选用途说明。');
        if (sessionToken) throw new Error('已有临时连接，请先断开。');
        if (!globalThis.isSecureContext) throw new Error('请通过 HTTPS 或浏览器认可的本机安全地址使用。');
        if (!crypto.randomUUID) throw new Error('浏览器缺少安全随机 UUID 支持。');
        if (el('auto').checked) activation.preflight();
        const catalog = await refresh();
        const key = el('key').value; el('key').value = '';
        const result = await api('/session', { key, usageAcknowledged: true });
        sessionToken = result.token; state.token = result.token; state.active = true;
        installRouter();
        try { if (el('auto').checked) await activation.activate(state.model || catalog.data[0]?.id); }
        catch (error) {
            try { await disconnectLocal(); } catch (cleanupError) { throw new Error(`${error.message}；${cleanupError.message}`); }
            throw error;
        }
        clearTimeout(expiryTimer);
        expiryTimer = setTimeout(() => { sessionToken = null; state.token = null; report('临时连接已过期，请重新输入 Key。'); }, Math.max(0, result.expires - Date.now()));
        report(`已建立临时连接（最多 8 小时）。${activation.recoveryProfile ? `恢复配置：${activation.recoveryProfile}。` : ''}仅接管 Go 连接。`);
    });
    el('disconnect').onclick = action(async () => {
        el('key').value = '';
        await disconnectLocal();
        // Keep the narrow guard installed to prevent a disconnected Go request falling through.
        report('已清除服务端临时 Key；若仍在本插件创建的 Go 连接，已恢复快照。可在禁用前执行此操作。');
    });
    el('models').onclick = action(async () => { const data = await refresh(); report(`受支持模型 ${data.data.length} 个；未支持/未核实协议 ${data.unsupported.length} 个。`); });
    el('model').onchange = () => { state.model = el('model').value; };
    el('direct').onchange = () => { state.direct = el('direct').checked; };
    el('reasoning').onchange = () => { state.reasoningMode = el('reasoning').value; el('effort-label').hidden = state.reasoningMode !== 'custom'; };
    el('effort').oninput = () => { state.reasoningEffort = el('effort').value.trim(); };
    host.append(root);
}
globalThis.OpenCodeGoBridge = Object.freeze({
    async request(payload, { conversation, signal } = {}) {
        if (!state.token) throw new Error('请先在 Go 扩展面板连接。');
        return originalFetch(endpoint + '/v1/chat/completions', { method: 'POST', credentials: 'same-origin', redirect: 'error',
            headers: { ...await headers(), 'x-opencode-session': publicSessions.forConversation(conversation) },
            body: JSON.stringify(payload), signal });
    },
    async models() { return api('/status', {}); },
    async dispose() {
        disposed = true;
        // Finish a pending registration before revoking its newly issued token.
        try { await activeAction; } catch { /* action already reports its error */ }
        await disconnectLocal({ dispose: true });
    },
});
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
else mount();

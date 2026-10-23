import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { timingSafeEqual } from 'node:crypto';
import { BridgeError, createGoClient, publicError, SessionVault } from './core.mjs';
import { ReplayCache } from './replay.mjs';

export const info = { id: 'opencode-go-bridge', name: 'OpenCode Go Bridge', description: 'Explicit Go routes with truthful client headers; no billing fallback.' };
export function createHandlers({ client = createGoClient(), vault = new SessionVault(), timeoutMs = 300_000 } = {}) {
    const owner = req => req.user?.profile?.handle;
    const token = req => req.headers?.['x-st-go-token'];
    const sendError = (res, error) => {
        if (res.destroyed || res.writableEnded) return;
        const safe = publicError(error);
        if (!res.headersSent) res.status(safe.status).json({ error: safe.error });
        else res.end();
    };
    function check(req) {
        if (!owner(req)) throw new BridgeError(401, 'user_required', '需要酒馆用户上下文。');
        if (req.headers?.['x-st-go-client'] !== '1') throw new BridgeError(403, 'client_required', '请从同源 Go 扩展调用。');
        const expected = req.session?.csrfToken; const actual = req.headers?.['x-csrf-token'];
        if (typeof expected !== 'string' || typeof actual !== 'string' || Buffer.byteLength(expected) !== Buffer.byteLength(actual) || !timingSafeEqual(Buffer.from(expected), Buffer.from(actual))) throw new BridgeError(403, 'csrf_required', '需要有效的酒馆 CSRF 会话。请刷新页面；不要关闭 CSRF 防护。');
        const origin = req.headers?.origin;
        if (origin) {
            try { if (new URL(origin).host !== req.headers.host) throw new Error(); }
            catch { throw new BridgeError(403, 'origin_rejected', '拒绝跨站 Go 请求。'); }
        }
    }
    const wrap = fn => async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        try { check(req); await fn(req, res); } catch (error) { sendError(res, error); }
    };
    const status = wrap(async (req, res) => {
        const signal = AbortSignal.timeout(20_000);
        const data = await client.models(signal);
        res.json({ object: 'list', data: data.filter(m => m.supported), unsupported: data.filter(m => !m.supported),
            version: '0.2.0', credentialStorage: 'memory-only',
            warning: 'Go 用于典型编程代理流量。普通角色聊天未获官方确认。账户 Extra usage 可能额外扣余额。',
        });
    });
    const connect = wrap(async (req, res) => {
        const remote = req.socket?.remoteAddress;
        const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote) && /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(req.headers.host ?? '');
        // Do not trust arbitrary X-Forwarded-Proto. ST/reverse proxy must provide req.secure correctly.
        if (!req.secure && !local) throw new BridgeError(400, 'https_required', '远程输入 Key 需要正确配置的 HTTPS；扩展不会更改网络安全设置。');
        if (req.body?.usageAcknowledged !== true) throw new BridgeError(400, 'usage_unconfirmed', '请先确认当前用途符合 Go 官方规则。勾选不代表官方授权。');
        const result = vault.open(owner(req), req.body?.key);
        res.json(result);
    });
    const disconnect = wrap(async (req, res) => { vault.close(owner(req), token(req)); res.json({ disconnected: true }); });
    const generate = wrap(async (req, res) => {
        const session = vault.get(owner(req), token(req));
        if (session.controllers.size >= 4) throw new BridgeError(429, 'concurrency_limit', '此浏览器连接已有 4 个进行中的请求，请等待或取消。');
        session.replay ??= new ReplayCache();
        const controller = new AbortController(); session.controllers.add(controller);
        const stop = () => { if (!res.writableEnded) controller.abort(); };
        req.once('aborted', stop); res.once('close', stop);
        const timer = setTimeout(() => controller.abort(), timeoutMs); timer.unref?.();
        try {
            const payload = session.replay.restore(req.body?.sessionId, req.body?.payload);
            const response = await client.generate(payload, { key: session.key, sessionId: req.body?.sessionId,
                native: req.body?.native === true, signal: controller.signal,
                onAssistant: message => session.replay.remember(req.body?.sessionId, payload.model, message) });
            res.setHeader('Content-Type', response.headers.get('content-type') || 'application/json');
            if (req.body?.payload?.stream) {
                res.setHeader('X-Accel-Buffering', 'no');
                res.flushHeaders?.();
            }
            await pipeline(Readable.fromWeb(response.body), res, { signal: controller.signal });
        } finally {
            clearTimeout(timer); req.removeListener('aborted', stop); res.removeListener('close', stop);
            session.controllers.delete(controller);
        }
    });
    const compatible = (req, res) => {
        req.body = { payload: req.body, native: false, sessionId: req.headers['x-opencode-session'] };
        return generate(req, res);
    };
    return { status, connect, disconnect, generate, compatible, vault };
}
const handlers = createHandlers();
let cleanup;
export async function init(router) {
    router.post('/status', handlers.status);
    router.post('/session', handlers.connect);
    router.delete('/session', handlers.disconnect);
    router.post('/generate', handlers.generate);
    router.post('/v1/chat/completions', handlers.compatible);
    router.get('/v1/models', handlers.status);
    cleanup = setInterval(() => handlers.vault.sweep(), 60_000); cleanup.unref();
}
export async function exit() { clearInterval(cleanup); handlers.vault.clear(); }

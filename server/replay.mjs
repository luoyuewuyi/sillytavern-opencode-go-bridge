import { createHash } from 'node:crypto';
import { BridgeError } from './errors.mjs';
// Native clients may drop provenance. Never choose between conflicting histories.
export class ReplayCache {
    #entries = new Map();
    #bytes = 0;
    fingerprint(conversation, model, message) {
        return createHash('sha256').update(JSON.stringify([conversation, model, message.content ?? '', message.tool_calls ?? []])).digest('hex');
    }
    remember(conversation, model, message) {
        if (!message?.go_bridge) return;
        const data = JSON.stringify({ go_bridge: message.go_bridge, reasoning_content: message.reasoning_content, refusal: message.refusal });
        if (Buffer.byteLength(data) > 1024 * 1024) return;
        const id = this.fingerprint(conversation, model, message);
        const old = this.#entries.get(id);
        // A tombstone prevents guessing after repeated identical visible answers.
        const value = old !== undefined && old !== data ? null : data;
        if (old) this.#bytes -= Buffer.byteLength(old);
        this.#entries.set(id, value); if (value) this.#bytes += Buffer.byteLength(value);
        while (this.#entries.size > 128 || this.#bytes > 4 * 1024 * 1024) {
            const first = this.#entries.keys().next().value; const removed = this.#entries.get(first);
            if (removed) this.#bytes -= Buffer.byteLength(removed); this.#entries.delete(first);
        }
    }
    restore(conversation, payload) {
        if (!Array.isArray(payload?.messages)) return payload;
        return { ...payload, messages: payload.messages.map(m => {
            if (m.role !== 'assistant' || m.go_bridge) return m;
            const data = this.#entries.get(this.fingerprint(conversation, payload.model, m));
            if (data === undefined) return m;
            if (data === null) throw new BridgeError(400, 'ambiguous_history', '相同回答对应多份协议历史，无法安全恢复思考签名；请保留原始 go_bridge 元数据。');
            const cached = JSON.parse(data);
            for (const k of ['reasoning_content', 'refusal']) if (Object.hasOwn(m, k) && (m[k] ?? '') !== (cached[k] ?? '')) throw new BridgeError(400, 'edited_history', '历史思考或拒绝内容与原始协议数据不一致，请保留原始元数据或开始新会话。');
            return { ...m, go_bridge: cached.go_bridge };
        }) };
    }
}

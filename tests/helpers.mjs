import { GO_CHAT_BASE, GENERATE_PATH, installGoHeaders } from '../routing.mjs';
export const origin = 'https://st.example';
export const payload = (extra = {}) => ({ chat_completion_source: 'custom', custom_url: GO_CHAT_BASE,
    model: 'glm-5.2', messages: [{ role: 'user', content: 'synthetic fixture' }], stream: false,
    secret_id: 'FAKE_SECRET_REFERENCE', ...extra });
export function harness({ fetch, parseYaml = JSON.parse, sessions, enabled = () => true } = {}) {
    const calls = []; let chat = 'fixture-chat';
    const previous = fetch || (async (...args) => { calls.push(args); return Response.json({ choices: [] }); });
    const scope = { fetch: previous };
    const installation = installGoHeaders({ scope, origin, conversationId: () => chat, parseYaml, sessions, isEnabled: enabled });
    return { scope, calls, previous, installation, setChat(v) { chat = v; } };
}
export const send = (h, data = payload(), extra = {}) => h.scope.fetch(GENERATE_PATH, { method: 'POST', body: JSON.stringify(data), ...extra });
export const sentBody = h => JSON.parse(h.calls.at(-1)[1].body);

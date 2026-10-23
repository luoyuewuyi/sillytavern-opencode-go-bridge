// Protocol mapping, not a claim of model capabilities. Official Go docs, 2026-10-23.
export const CHAT_URL = 'https://opencode.ai/inference/go/openai/v1/chat/completions';
export const MODELS_URL = 'https://opencode.ai/inference/go/v1/models';
export const USER_AGENT = 'sillytavern-opencode-go-bridge/0.2.0';
export const EVIDENCE_URL = 'https://opencode.ai/v2/docs/console/go/#endpoints';
const families = {
    chat: ['glm-5.3-flash', 'glm-5.3', 'glm-5.2', 'kimi-k3', 'kimi-k2.7-code',
        'longcat-2.0', 'deepseek-v4.1-flash', 'deepseek-v4-pro', 'mimo-v2.6-flash',
        'mimo-v2.6-pro', 'mimo-v2.5', 'mimo-v2.5-pro', 'minimax-m3.1-flash',
        'hy4-preview', 'hy3', 'longcat-2.5-preview-free', 'step-5-preview', 'beam-free'],
    responses: ['grok-4.7', 'gpt-6-luna', 'gpt-5.6-luna', 'muse-spark-1.3-contributor', 'muse-spark-1.2-contributor'],
    messages: ['claude-haiku-5-5', 'minimax-m3', 'qwen3.8-max', 'qwen3.8-flash', 'qwen3.7-plus'],
    gemini: ['gemini-4-argon-contributor'],
};
export function protocolFor(id) {
    return Object.entries(families).find(([, models]) => models.includes(id))?.[0] ?? 'unknown';
}
export function decorateModels(data) {
    if (!Array.isArray(data?.data)) throw new Error('Invalid models directory');
    return [...new Set(data.data.map(m => m?.id).filter(id => typeof id === 'string' && /^[\w.\/-]{1,120}$/.test(id)))].map(id => ({
        id, object: 'model', owned_by: 'opencode', protocol: protocolFor(id),
        supported: ['chat', 'responses', 'messages'].includes(protocolFor(id)),
        capabilities: { tools: 'unverified', vision: 'unverified', reasoning: 'unverified' },
        evidence: EVIDENCE_URL,
    }));
}

import { GO_MARKER } from './routing.mjs';

// Uses ST's own profile operations. Existing profiles are never updated/deleted.
// The separate recovery profile contains native settings/secret references, never this plugin's Key.
export function createActivation({ execute, getContext, uuid = () => crypto.randomUUID() }) {
    let recovery = null; let goProfile = null;
    const manager = () => getContext().extensionSettings.connectionManager;
    function resume() {
        if (goProfile) return;
        const m = manager(); const p = m.profiles.find(p => p.id === m.selectedProfile);
        if (p?.go_bridge_recovery) { goProfile = p.name; recovery = p.go_bridge_recovery; }
    }
    function preflight() {
        const c = getContext();
        if (!Array.isArray(c?.extensionSettings?.connectionManager?.profiles) || c.extensionSettings.disabledExtensions?.includes('connection-manager')) throw new Error('自动接入需要启用酒馆 Connection Manager。可改用手动 Go 专用连接。');
        for (const k of ['custom_include_body', 'custom_exclude_body', 'custom_include_headers']) if (c.chatCompletionSettings?.[k]?.trim()) throw new Error('当前自定义连接有 YAML 覆盖。请先创建干净的 Go 专用预设；扩展不会覆盖这些配置。');
        if (c.chatCompletionSettings?.custom_prompt_post_processing) throw new Error('当前预设启用了提示词后处理，请先为 Go 选择不带后处理的预设。');
    }
    async function activate(model) {
        preflight();
        if (!/^[a-zA-Z0-9_.-]{1,120}$/.test(model)) throw new Error('没有可用模型，未更改连接。');
        resume();
        if (goProfile) return;
        const suffix = uuid().replace(/-/g, '').slice(0, 12);
        recovery = `Go-Recovery-${suffix}`;
        const saved = await execute('profile-create', recovery);
        if (saved !== recovery) { recovery = null; throw new Error('无法创建恢复快照，未切换到 Go。'); }
        const c = getContext(); const snapshot = manager().profiles.find(p => p.name === recovery);
        const touched = { custom_url: c.chatCompletionSettings.custom_url ?? '', custom_model: c.chatCompletionSettings.custom_model ?? '' };
        // Native profiles only record the active provider. Keep the inactive custom fields too.
        snapshot.go_bridge_restore = touched;
        c.saveSettingsDebounced?.();
        try {
            await execute('api-url', GO_MARKER, { api: 'custom', connect: 'false', quiet: 'true' });
            await execute('api', 'custom');
            await execute('model', model);
            const name = `OpenCode-Go-${suffix}`;
            if (await execute('profile-create', name) !== name) throw new Error('无法创建 Go 独立连接。');
            goProfile = name;
            manager().profiles.find(p => p.name === name).go_bridge_recovery = recovery;
            c.saveSettingsDebounced?.();
        } catch (error) {
            try { await execute('profile', recovery, { await: 'true', timeout: '0' }); }
            finally { Object.assign(c.chatCompletionSettings, touched); c.saveSettingsDebounced?.(); }
            throw error;
        }
    }
    async function restore() {
        if (!getContext()?.extensionSettings?.connectionManager) return;
        resume(); if (!goProfile || !recovery) return;
        const c = getContext(); const manager = c.extensionSettings.connectionManager;
        const selected = manager.profiles.find(p => p.id === manager.selectedProfile);
        // Do not overwrite a later user-selected provider.
        if (selected?.name === goProfile) {
            const touched = manager.profiles.find(p => p.name === recovery)?.go_bridge_restore;
            await execute('profile', recovery, { await: 'true', timeout: '0' });
            if (touched) Object.assign(c.chatCompletionSettings, touched);
            c.saveSettingsDebounced?.();
        }
        goProfile = null;
    }
    return { preflight, activate, restore, get recoveryProfile() { return recovery; } };
}

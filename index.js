import { installGoHeaders, createSessionIds } from './routing.mjs';

// No UI, credentials, profiles, settings writes, backend, timers or network call on load.
const sessions = createSessionIds();
let installation;
const context = () => globalThis.SillyTavern?.getContext?.();
const extensionId = (() => {
    const match = new URL(import.meta.url).pathname.match(/\/scripts\/extensions\/(.+)\/index\.js$/);
    return match ? decodeURIComponent(match[1]) : 'third-party/sillytavern-opencode-go-bridge';
})();
export function enable() {
    if (installation?.active) return;
    installation = installGoHeaders({ origin: location.origin, sessions,
        isEnabled: () => !context()?.extensionSettings?.disabledExtensions?.includes(extensionId),
        parseYaml: value => {
            const parse = globalThis.SillyTavern?.libs?.yaml?.parse;
            // Blank/JSON headers also work on hosts without the public YAML library.
            return parse ? parse(value) : JSON.parse(value);
        },
        conversationId: () => {
            const c = context(); const chat = c?.getCurrentChatId?.();
            return chat ? JSON.stringify([c.groupId ?? null, c.characterId ?? null, chat]) : null;
        },
    });
}
export function disable() { installation?.dispose(); }
enable();

export const FRONTEND_FILES = ['manifest.json', 'index.js', 'activation.mjs', 'routing.mjs', 'style.css'];
export const SERVER_FILES = ['server/package.json', 'server/index.mjs', 'server/core.mjs', 'server/catalog.mjs', 'server/errors.mjs', 'server/protocols.mjs', 'server/replay.mjs', 'server/sse.mjs'];
export const RELEASE_FILES = [...FRONTEND_FILES, ...SERVER_FILES, 'package.json', '.gitattributes', 'install.sh', 'install.ps1', 'install/install.mjs', 'install/layout.mjs'];
export const COMPONENTS = {
    server: { relative: 'plugins/opencode-go-bridge', files: SERVER_FILES, strip: 'server/' },
    frontend: { relative: 'public/scripts/extensions/third-party/sillytavern-opencode-go-bridge', files: FRONTEND_FILES, strip: '' },
};
export const STATE_DIR = '.opencode-go-bridge-installer';

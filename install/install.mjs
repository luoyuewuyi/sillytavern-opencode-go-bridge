#!/usr/bin/env node
import { lstat, readFile, writeFile, readdir, mkdir, rename, rm, copyFile, realpath } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { resolve, join, dirname, relative, basename, parse, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { COMPONENTS, RELEASE_FILES, STATE_DIR } from './layout.mjs';
const SOURCE = dirname(dirname(fileURLToPath(import.meta.url)));
const MARKER = '.go-bridge-managed.json';
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = message => { throw new Error(message); };
async function exists(path) { try { await lstat(path); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }
async function json(path) { return JSON.parse(await readFile(path, 'utf8')); }
const inside = (child, parent) => child === parent || child.startsWith(parent + sep);
export async function safePath(path) {
    path = resolve(path); const root = parse(path).root; let current = root;
    for (const part of relative(root, path).split(sep).filter(Boolean)) {
        current = join(current, part);
        try { if ((await lstat(current)).isSymbolicLink()) fail(`Symbolic links/junctions are not allowed in installer paths: ${current}`); }
        catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    return path;
}
async function tree(path) {
    if (!await exists(path)) return null;
    const result = {};
    async function walk(dir) {
        for (const e of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
            const full = join(dir, e.name); const name = relative(path, full).split(sep).join('/');
            const stat = await lstat(full);
            if (stat.isSymbolicLink() || !(stat.isDirectory() || stat.isFile())) fail(`Unsafe file type in plugin directory: ${full}`);
            if (stat.isDirectory()) { result[name + '/'] = 'directory'; await walk(full); } else result[name] = hash(await readFile(full));
        }
    }
    if (!(await lstat(path)).isDirectory()) fail(`Expected directory: ${path}`);
    await walk(path); return hash(JSON.stringify(result));
}
async function verifySource(source, expectedVersion) {
    await safePath(source);
    const release = await json(join(source, 'release-manifest.json'));
    if (release.schema !== 1 || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(release.version)) fail('Invalid release manifest version/schema.');
    if (expectedVersion && expectedVersion !== release.version) fail(`Version mismatch: expected ${expectedVersion}, found ${release.version}.`);
    if (JSON.stringify(Object.keys(release.files ?? {}).sort()) !== JSON.stringify([...RELEASE_FILES].sort())) fail('Release file list differs from the fixed installer allowlist.');
    for (const file of RELEASE_FILES) {
        const target = join(source, file); await safePath(target);
        if (!(await lstat(target)).isFile() || hash(await readFile(target)) !== release.files[file]) fail(`Release integrity mismatch: ${file}`);
    }
    for (const file of ['package.json', 'manifest.json', 'server/package.json']) if ((await json(join(source, file))).version !== release.version) fail(`Inconsistent version: ${file}`);
    return release;
}
async function isStRoot(root) {
    try {
        const pkg = await json(join(root, 'package.json'));
        return pkg.name?.toLowerCase() === 'sillytavern' && await exists(join(root, 'server.js')) && await exists(join(root, 'public/scripts/extensions'));
    } catch { return false; }
}
export async function findStRoot(start) {
    let current = resolve(start);
    while (true) { if (await isStRoot(current)) return current; const parent = dirname(current); if (parent === current) return null; current = parent; }
}
export function patchConfig(text, enable) {
    if (/^---\s*$/m.test(text) || /^\.\.\.\s*$/m.test(text)) fail('Multiple-document/explicit-document YAML is unsupported; edit server plugin configuration manually.');
    const lines = text.split(/\r?\n/); const indices = lines.map((line, i) => /^enableServerPlugins\s*:/.test(line) ? i : -1).filter(i => i >= 0);
    if (indices.length > 1) fail('Duplicate enableServerPlugins entries; resolve configuration manually.');
    const newline = text.includes('\r\n') ? '\r\n' : '\n'; let enabled = false;
    if (indices.length) {
        const i = indices[0]; const match = /^(enableServerPlugins\s*:\s*)(true|false)(\s*(?:#.*)?)$/.exec(lines[i]);
        if (!match) fail('enableServerPlugins is not a simple YAML boolean; resolve configuration manually.');
        enabled = match[2] === 'true';
        if (enable && !enabled) lines[i] = match[1] + 'true' + match[3];
    } else if (enable) {
        if (lines.at(-1) === '') lines.pop(); lines.push('enableServerPlugins: true', '');
    }
    return { enabled, after: enable ? lines.join(newline) : text };
}
async function owned(target, component) {
    if (!await exists(target)) return;
    await tree(target);
    if (await exists(join(target, '.git'))) fail(`Git-managed frontend detected: ${target}. Use --backend-only and update its Git checkout separately.`);
    if (await exists(join(target, MARKER))) {
        const m = await json(join(target, MARKER)); if (m.project === 'sillytavern-opencode-go-bridge' && m.component === component) return;
    }
    if (component === 'server') {
        try { if ((await json(join(target, 'package.json'))).name === 'sillytavern-opencode-go-server') return; } catch { /* no ownership */ }
    } else {
        try { const m = await json(join(target, 'manifest.json')); if (m.display_name?.startsWith('OpenCode Go Bridge') && m.js === 'index.js') return; } catch { /* no ownership */ }
    }
    fail(`Refusing to replace an unrecognized directory: ${target}`);
}
async function persist(file, value) {
    await safePath(file); const temp = file + '.' + randomBytes(8).toString('hex') + '.tmp'; await safePath(temp);
    await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    try { await rename(temp, file); } finally { await rm(temp, { force: true }); }
}
async function atomicConfig(path, bytes, suffix) {
    const temp = path + `.go-bridge-${suffix}.tmp`; await safePath(temp);
    // wx prevents clobbering a pre-existing temp path; replacement occurs on the same filesystem.
    await writeFile(temp, bytes, { flag: 'wx', mode: (await lstat(path)).mode & 0o777 });
    try { await rename(temp, path); } finally { await rm(temp, { force: true }); }
}
async function confirmTarget(root, options, io) {
    if (options.confirmRoot !== undefined) { if (resolve(options.confirmRoot) !== root) fail('--confirm-root must exactly name the displayed SillyTavern root.'); return; }
    if (io.confirm) { if (!await io.confirm(root)) fail('Installation cancelled; no files changed.'); return; }
    if (!process.stdin.isTTY || !process.stdout.isTTY) fail('No interactive terminal. Re-run with --confirm-root "<displayed absolute root>" after reviewing --dry-run.');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try { if (await rl.question(`Type the exact target root to confirm changes:\n${root}\n> `) !== root) fail('Cancelled; target confirmation did not match.'); } finally { rl.close(); }
}
async function readRecord(txDir, root) {
    await safePath(txDir); await safePath(join(txDir, 'transaction.json'));
    let record;
    try { record = await json(join(txDir, 'transaction.json')); }
    catch { fail(`No readable journal in ${txDir}. Recovery made no destination changes. Inspect the retained preparation/backup directory before manual recovery; do not delete backups blindly.`); }
    if (!/^[0-9TZ-]+-[a-f0-9]{12}$/.test(record.id) || record.id !== basename(txDir)) fail('Invalid transaction identity.');
    if (!['preparing', 'pending', 'completed', 'rollback_failed', 'rolled_back'].includes(record.status)) fail('Invalid transaction state.');
    if (record.schema !== 1 || record.root !== root || !['install', 'uninstall'].includes(record.action) || !Array.isArray(record.components)) fail('Invalid transaction record.');
    if (!record.components.every(k => Object.hasOwn(COMPONENTS, k)) || new Set(record.components).size !== record.components.length) fail('Invalid transaction component list.');
    for (const key of record.components) for (const field of ['before', 'after']) if (!(record[field]?.[key] === null || /^[a-f0-9]{64}$/.test(record[field]?.[key]))) fail('Invalid transaction digest.');
    if (record.config && !['before', 'after'].every(k => /^[a-f0-9]{64}$/.test(record.config[k]))) fail('Invalid configuration digest.');
    return record;
}
async function rollback(txDir, root, io) {
    const record = await readRecord(txDir, root);
    if (record.status === 'rolled_back') fail('This transaction was already rolled back.');
    // Validate ALL paths and hashes before restoring any item; never overwrite later user edits.
    for (const key of record.components) {
        const target = join(root, COMPONENTS[key].relative); const backup = join(txDir, 'backup', key);
        await safePath(target); await safePath(backup);
        const current = await tree(target); const saved = await tree(backup); const original = record.before[key] ?? null;
        if (saved !== null && saved !== original) fail(`Backup integrity changed: ${key}`);
        const expected = record.after[key] ?? null;
        if (current !== null && current !== expected && !(saved === null && current === original)) fail(`Cannot roll back modified plugin: ${target}`);
        if (original !== null && saved === null && current !== original) fail(`Original backup is missing: ${key}`);
    }
    let restoreConfig = false;
    if (record.config) {
        const path = join(root, 'config.yaml'); const backup = join(txDir, 'backup/config.yaml'); await safePath(path); await safePath(backup);
        const current = hash(await readFile(path));
        if (hash(await readFile(backup)) !== record.config.before) fail('Configuration backup integrity changed.');
        if (![record.config.before, record.config.after].includes(current)) fail('config.yaml changed after installation; rollback stopped to preserve later edits.');
        restoreConfig = current === record.config.after && current !== record.config.before;
    }
    for (const key of [...record.components].reverse()) {
        const target = join(root, COMPONENTS[key].relative); const backup = join(txDir, 'backup', key);
        if (await exists(backup)) { if (await exists(target)) await rm(target, { recursive: true }); await mkdir(dirname(target), { recursive: true }); await rename(backup, target); }
        else if (record.before[key] === null && await exists(target)) await rm(target, { recursive: true });
    }
    if (restoreConfig) await atomicConfig(join(root, 'config.yaml'), await readFile(join(txDir, 'backup/config.yaml')), record.id);
    record.status = 'rolled_back'; await persist(join(txDir, 'transaction.json'), record); io.log(`Rolled back ${record.id}.`);
}
export async function runInstaller(options = {}, io = {}) {
    io = { log: () => {}, ...io };
    if (Number(process.versions.node.split('.')[0]) < 20) fail('Node.js >=20 is required. No runtime will be installed automatically.');
    const source = resolve(options.sourceDir ?? SOURCE);
    const release = await verifySource(source, options.expectVersion);
    const discovered = options.stRoot ? resolve(options.stRoot) : await findStRoot(options.cwd ?? process.cwd());
    if (!discovered) fail('SillyTavern root not found. Supply --st-root explicitly.');
    const root = await safePath(discovered);
    if (root === parse(root).root || !await isStRoot(root) || await realpath(root) !== root) fail('Target is not a valid, non-symlink SillyTavern root.');
    const state = join(root, STATE_DIR); await safePath(state); await safePath(join(state, 'transactions'));
    const action = options.rollback ? 'rollback' : options.uninstall ? 'uninstall' : 'install';
    if (options.rollback && !/^[0-9TZ-]+-[a-f0-9]{12}$/.test(options.rollback)) fail('Invalid rollback transaction ID.');
    const components = options.rollback ? (await readRecord(join(state, 'transactions', options.rollback), root)).components : options.backendOnly ? ['server'] : ['server', 'frontend'];
    for (const key of components) {
        const target = join(root, COMPONENTS[key].relative); await safePath(target);
        if (inside(source, target) || inside(target, source)) fail('Installer source overlaps a destination. For a frontend Git checkout inside SillyTavern, use --backend-only.');
        await owned(target, key);
    }
    if (action !== 'install' && options.enableServerPlugins) fail('--enable-server-plugins applies only to install.');
    const configPath = join(root, 'config.yaml'); await safePath(configPath);
    const configBytes = await readFile(configPath); if (configBytes.length > 2 * 1024 * 1024) fail('config.yaml is too large for safe scalar editing.');
    const config = patchConfig(configBytes.toString('utf8'), action === 'install' && options.enableServerPlugins === true);
    const configChange = action === 'install' && config.after !== configBytes.toString('utf8');
    if (options.rollback && !/^[0-9TZ-]+-[a-f0-9]{12}$/.test(options.rollback)) fail('Invalid rollback transaction ID.');
    if (await exists(join(state, 'transactions')) && !options.rollback) {
        for (const id of await readdir(join(state, 'transactions'))) {
            const dir = join(state, 'transactions', id); await safePath(dir);
            const r = await readRecord(dir, root);
            if (['preparing', 'pending', 'rollback_failed'].includes(r.status)) fail(`Unfinished transaction ${id}; review and run --rollback ${id} first.`);
        }
    }
    const plan = { action, version: release.version, root, targets: components.map(k => join(root, COMPONENTS[k].relative)),
        configChange, serverPluginsEnabled: config.enabled, backupDirectory: state, rollbackId: options.rollback ?? null };
    io.log(JSON.stringify(plan, null, 2));
    if (options.dryRun) { io.log('DRY RUN: no directories, config, backups or lock files created.'); return plan; }
    if (action === 'install' && !config.enabled && !options.enableServerPlugins) fail('Server plugins are disabled. Review and add --enable-server-plugins, or enable them manually first.');
    await confirmTarget(root, options, io);
    await mkdir(state, { recursive: true, mode: 0o700 }); const lock = join(state, 'lock');
    try { await mkdir(lock, { mode: 0o700 }); } catch (e) { if (e.code === 'EEXIST') fail(`Installer lock exists: ${lock}. Check for another installer; never remove an active lock.`); throw e; }
    let txDir;
    try {
        await persist(join(lock, 'owner.json'), { pid: process.pid });
        if (action === 'rollback') { await rollback(join(state, 'transactions', options.rollback), root, io); return plan; }
        // Revalidate immediately before staging; confirmation may have taken time.
        await verifySource(source, release.version);
        for (const key of components) { await safePath(join(root, COMPONENTS[key].relative)); await owned(join(root, COMPONENTS[key].relative), key); }
        if (hash(await readFile(configPath)) !== hash(configBytes)) fail('config.yaml changed during confirmation; start again.');
        const id = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomBytes(6).toString('hex');
        txDir = join(state, 'transactions', id); await safePath(txDir); await safePath(join(txDir, 'stage')); await safePath(join(txDir, 'backup')); await mkdir(join(txDir, 'backup'), { recursive: true, mode: 0o700 });
        const record = { schema: 1, id, root, action, version: release.version, status: 'preparing', components, before: {}, after: {}, config: null };
        for (const key of components) { record.before[key] = await tree(join(root, COMPONENTS[key].relative)); record.after[key] = null; }
        if (configChange) {
            await writeFile(join(txDir, 'backup/config.yaml'), configBytes, { mode: 0o600 });
            record.config = { before: hash(configBytes), after: hash(config.after) };
        }
        await persist(join(txDir, 'transaction.json'), record);
        for (const key of components) {
            if (action === 'install') {
                const stage = join(txDir, 'stage', key); await mkdir(stage, { recursive: true });
                for (const file of COMPONENTS[key].files) {
                    const dest = join(stage, file.slice(COMPONENTS[key].strip.length)); await mkdir(dirname(dest), { recursive: true }); await copyFile(join(source, file), dest);
                    if (hash(await readFile(dest)) !== release.files[file]) fail(`Staging integrity mismatch: ${file}`);
                }
                await persist(join(stage, MARKER), { project: 'sillytavern-opencode-go-bridge', component: key, version: release.version, transaction: id });
                record.after[key] = await tree(stage);
                await io.fault?.(`during-stage:${key}`);
            }
        }
        record.status = 'pending';
        await persist(join(txDir, 'transaction.json'), record);
        try {
            for (const key of components) {
                const target = join(root, COMPONENTS[key].relative); await safePath(target);
                if (await tree(target) !== record.before[key]) fail(`Target changed before replacement: ${target}`);
                if (await exists(target)) await rename(target, join(txDir, 'backup', key));
                await io.fault?.(`after-backup:${key}`);
                if (action === 'install') { await mkdir(dirname(target), { recursive: true }); await rename(join(txDir, 'stage', key), target); }
                await io.fault?.(`after-install:${key}`);
            }
            if (configChange) {
                if (hash(await readFile(configPath)) !== record.config.before) fail('Configuration changed before write.');
                await atomicConfig(configPath, config.after, id); await io.fault?.('after-config');
            }
            record.status = 'completed'; await persist(join(txDir, 'transaction.json'), record);
            io.log(`Completed ${action} ${release.version}. Transaction: ${id}`);
            io.log('No restart performed. Administrator must restart SillyTavern when ready.');
            if (action === 'uninstall') io.log('Shared enableServerPlugins setting is unchanged. Remove it manually only after checking other server plugins.');
            return { ...plan, transaction: id };
        } catch (error) {
            try { await rollback(txDir, root, io); }
            catch (rollbackError) { record.status = 'rollback_failed'; await persist(join(txDir, 'transaction.json'), record); throw new Error(`Operation failed; automatic rollback could not safely finish. Transaction ${id}. ${rollbackError.message}`); }
            throw new Error(`Operation failed and was rolled back: ${error.message}`);
        }
    } catch (error) {
        // Preparation failed before any destination mutation or journal was written.
        if (txDir && !await exists(join(txDir, 'transaction.json'))) { await safePath(txDir); await rm(txDir, { recursive: true, force: true }); }
        else if (txDir && (await readRecord(txDir, root)).status === 'preparing') { await rollback(txDir, root, io); throw new Error(`Preparation failed and was rolled back: ${error.message}`); }
        throw error;
    } finally { await rm(lock, { recursive: true, force: true }); }
}
export function parseArgs(args) {
    const o = {};
    const values = { '--st-root': 'stRoot', '--confirm-root': 'confirmRoot', '--expect-version': 'expectVersion', '--rollback': 'rollback' };
    const flags = { '--dry-run': 'dryRun', '--backend-only': 'backendOnly', '--enable-server-plugins': 'enableServerPlugins', '--uninstall': 'uninstall', '--help': 'help' };
    for (let i = 0; i < args.length; i++) {
        const a = args[i]; if (a in flags) { if (o[flags[a]]) fail(`Duplicate option: ${a}`); o[flags[a]] = true; }
        else if (a in values) { const value = args[++i]; if (!value || value.startsWith('--') || o[values[a]]) fail(`Missing/duplicate value: ${a}`); o[values[a]] = value; }
        else fail(`Unknown option: ${a}`);
    }
    if (o.rollback && o.uninstall) fail('--rollback and --uninstall cannot be combined.');
    return o;
}
const help = `OpenCode Go Bridge installer (Preview)\n\nnode install/install.mjs [options]\n  --st-root PATH             Explicit existing SillyTavern root; otherwise discover from cwd ancestors\n  --dry-run                  Print exact plan; write nothing\n  --expect-version VERSION   Require the stated release\n  --backend-only             Keep Git-installed frontend untouched\n  --enable-server-plugins    Explicitly permit changing only this YAML boolean, with backup\n  --confirm-root PATH        Noninteractive confirmation of the exact printed root\n  --uninstall                Remove recognized plugin directories with rollback backup\n  --rollback TRANSACTION    Restore a recorded transaction; stop if later edits conflict\n\nNo download, dependency installation, credentials, network changes or restart.\n`;
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try { const options = parseArgs(process.argv.slice(2)); if (options.help) console.log(help); else await runInstaller(options, { log: console.log }); }
    catch (error) { console.error(`Installer stopped: ${error.message}`); process.exitCode = 1; }
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile, readFile, readdir, access, symlink, cp } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { runInstaller, findStRoot, parseArgs, patchConfig } from '../install/install.mjs';
import { COMPONENTS, RELEASE_FILES, STATE_DIR } from '../install/layout.mjs';
const source = dirname(dirname(fileURLToPath(import.meta.url)));
async function present(path) { try { await access(path); return true; } catch { return false; } }
async function fixture(t, enabled = false) {
    const fixtures = join(dirname(source), '.go-bridge-installer-fixtures'); await mkdir(fixtures, { recursive: true });
    const root = await mkdtemp(join(fixtures, 'ST space 测试-'));
    await writeFile(join(root, 'package.json'), '{"name":"SillyTavern","version":"1.18.0"}');
    await writeFile(join(root, 'server.js'), '// fixture only; never started\n');
    await mkdir(join(root, 'public/scripts/extensions/third-party/other-plugin'), { recursive: true });
    await writeFile(join(root, 'public/scripts/extensions/third-party/other-plugin/keep.txt'), 'unrelated');
    await writeFile(join(root, 'config.yaml'), `# fixture\nenableServerPlugins: ${enabled} # keep comment\nport: 8123\n`);
    t.after(() => rm(root, { recursive: true, force: true })); return root;
}
const opts = root => ({ stRoot: root, sourceDir: source, confirmRoot: root, expectVersion: '0.2.0', enableServerPlugins: true });
const dest = (root, kind) => join(root, COMPONENTS[kind].relative);
async function oldPlugin(root) {
    await mkdir(dest(root, 'server'), { recursive: true });
    await writeFile(join(dest(root, 'server'), 'package.json'), '{"name":"sillytavern-opencode-go-server","version":"0.0.0"}');
    await writeFile(join(dest(root, 'server'), 'old.txt'), 'original plugin bytes');
}
test('installer dry-run discovers root and writes absolutely nothing', async t => {
    const root = await fixture(t); const before = await readdir(root);
    const plan = await runInstaller({ cwd: join(root, 'public/scripts'), dryRun: true, sourceDir: source });
    assert.equal(plan.root, root); assert.equal(plan.configChange, false); assert.equal(await findStRoot(join(root, 'public')), root);
    assert.deepEqual(await readdir(root), before); assert.ok(!await present(join(root, STATE_DIR)));
});
test('installer requires exact target confirmation and explicit config opt-in', async t => {
    const root = await fixture(t);
    await assert.rejects(runInstaller({ ...opts(root), confirmRoot: source }), /confirm-root/);
    await assert.rejects(runInstaller({ ...opts(root), enableServerPlugins: false }), /disabled/);
    assert.ok(!await present(join(root, STATE_DIR))); assert.ok(!await present(dest(root, 'server')));
});
test('install copies allowlisted frontend/backend, preserves other settings/plugins and backs config', async t => {
    const root = await fixture(t); const original = await readFile(join(root, 'config.yaml'), 'utf8');
    const result = await runInstaller(opts(root));
    assert.equal(JSON.parse(await readFile(join(dest(root, 'frontend'), 'manifest.json'))).version, '0.2.0');
    assert.equal(JSON.parse(await readFile(join(dest(root, 'server'), 'package.json'))).version, '0.2.0');
    assert.equal(await readFile(join(root, 'config.yaml'), 'utf8'), original.replace('false', 'true'));
    assert.equal(await readFile(join(root, 'public/scripts/extensions/third-party/other-plugin/keep.txt'), 'utf8'), 'unrelated');
    assert.equal(await readFile(join(root, STATE_DIR, 'transactions', result.transaction, 'backup/config.yaml'), 'utf8'), original);
    assert.ok(!await present(join(root, STATE_DIR, 'lock')));
});
test('successful install rollback restores previous plugin and exact original config', async t => {
    const root = await fixture(t); await oldPlugin(root); const config = await readFile(join(root, 'config.yaml'), 'utf8');
    const done = await runInstaller(opts(root));
    await runInstaller({ stRoot: root, confirmRoot: root, rollback: done.transaction });
    assert.equal(await readFile(join(dest(root, 'server'), 'old.txt'), 'utf8'), 'original plugin bytes');
    assert.ok(!await present(dest(root, 'frontend'))); assert.equal(await readFile(join(root, 'config.yaml'), 'utf8'), config);
});
for (const step of ['after-backup:server', 'after-install:server', 'after-install:frontend', 'after-config']) {
    test(`automatic rollback after injected failure: ${step}`, async t => {
        const root = await fixture(t); await oldPlugin(root); const original = await readFile(join(root, 'config.yaml'), 'utf8');
        await assert.rejects(runInstaller(opts(root), { fault: point => { if (point === step) throw new Error('fixture I/O failure'); } }), /rolled back/);
        assert.equal(await readFile(join(dest(root, 'server'), 'old.txt'), 'utf8'), 'original plugin bytes');
        assert.ok(!await present(dest(root, 'frontend'))); assert.equal(await readFile(join(root, 'config.yaml'), 'utf8'), original);
        assert.ok(!await present(join(root, STATE_DIR, 'lock')));
    });
}
test('uninstall preserves shared config; rollback of uninstall restores plugin', async t => {
    const root = await fixture(t, true); await runInstaller(opts(root));
    const config = await readFile(join(root, 'config.yaml'), 'utf8');
    const done = await runInstaller({ stRoot: root, confirmRoot: root, uninstall: true });
    assert.ok(!await present(dest(root, 'server'))); assert.ok(!await present(dest(root, 'frontend')));
    assert.equal(await readFile(join(root, 'config.yaml'), 'utf8'), config);
    await runInstaller({ stRoot: root, confirmRoot: root, rollback: done.transaction });
    assert.ok(await present(join(dest(root, 'server'), 'index.mjs')));
});
test('backend-only install leaves frontend path absent', async t => {
    const root = await fixture(t); await runInstaller({ ...opts(root), backendOnly: true });
    assert.ok(await present(dest(root, 'server'))); assert.ok(!await present(dest(root, 'frontend')));
});
test('version mismatch and tampered release file stop before target writes', async t => {
    const root = await fixture(t); await assert.rejects(runInstaller({ ...opts(root), expectVersion: '9.9.9' }), /Version mismatch/);
    const copy = join(root, 'source-copy'); await mkdir(copy);
    for (const file of [...RELEASE_FILES, 'release-manifest.json']) { await mkdir(dirname(join(copy, file)), { recursive: true }); await cp(join(source, file), join(copy, file)); }
    await writeFile(join(copy, 'index.js'), 'tampered');
    await assert.rejects(runInstaller({ ...opts(root), sourceDir: copy }), /integrity/); assert.ok(!await present(dest(root, 'server')));
});
test('unknown target, symlinks and source overlap cannot be overwritten', async t => {
    const root = await fixture(t); await mkdir(dest(root, 'server'), { recursive: true });
    await writeFile(join(dest(root, 'server'), 'keep'), 'unrelated');
    await assert.rejects(runInstaller(opts(root)), /unrecognized/);
    await rm(dest(root, 'server'), { recursive: true });
    await symlink(join(root, 'public'), dest(root, 'server'), 'dir');
    await assert.rejects(runInstaller(opts(root)), /Symbolic links/);
    await rm(dest(root, 'server'));
    const sourceCopy = dest(root, 'frontend'); await mkdir(sourceCopy, { recursive: true });
    for (const f of [...RELEASE_FILES, 'release-manifest.json']) { await mkdir(dirname(join(sourceCopy, f)), { recursive: true }); await cp(join(source, f), join(sourceCopy, f)); }
    await assert.rejects(runInstaller({ ...opts(root), sourceDir: sourceCopy }), /overlaps/);
    await runInstaller({ ...opts(root), sourceDir: sourceCopy, backendOnly: true });
    assert.ok(await present(join(sourceCopy, 'install.sh')));
});
test('rollback refuses changed plugin/config and keeps backups', async t => {
    const root = await fixture(t); const done = await runInstaller(opts(root));
    await writeFile(join(dest(root, 'server'), 'index.mjs'), 'later user edit');
    await assert.rejects(runInstaller({ stRoot: root, confirmRoot: root, rollback: done.transaction }), /modified plugin/);
    assert.equal(await readFile(join(dest(root, 'server'), 'index.mjs'), 'utf8'), 'later user edit');
    assert.ok(await present(join(root, STATE_DIR, 'transactions', done.transaction, 'backup/config.yaml')));
});
test('installer lock and unsafe YAML block without changing config', async t => {
    const root = await fixture(t); await mkdir(join(root, STATE_DIR, 'lock'), { recursive: true });
    await assert.rejects(runInstaller(opts(root)), /lock exists/);
    assert.ok((await readFile(join(root, 'config.yaml'), 'utf8')).includes('false'));
    for (const cfg of ['enableServerPlugins: true\nenableServerPlugins: false\n', 'enableServerPlugins: *alias\n', '---\nenableServerPlugins: false\n']) assert.throws(() => patchConfig(cfg, true));
    assert.equal(patchConfig('port: 1234\r\n', true).after, 'port: 1234\r\nenableServerPlugins: true\r\n');
});
test('platform wrapper forwards quoted space/unicode target for real dry-run', async t => {
    const root = await fixture(t);
    const args = ['--st-root', root, '--dry-run', '--expect-version', '0.2.0'];
    const result = process.platform === 'win32' ? spawnSync('pwsh', ['-NoProfile', '-File', join(source, 'install.ps1'), ...args], { encoding: 'utf8' }) : spawnSync('sh', [join(source, 'install.sh'), ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /DRY RUN/); assert.ok(!await present(join(root, STATE_DIR)));
});
test('CLI rejects unknown/duplicate options and traversal rollback ids', async t => {
    assert.throws(() => parseArgs(['--yes'])); assert.throws(() => parseArgs(['--st-root'])); assert.throws(() => parseArgs(['--dry-run', '--dry-run']));
    const root = await fixture(t); await assert.rejects(runInstaller({ ...opts(root), enableServerPlugins: false, rollback: '../elsewhere' }), /Invalid rollback/);
});
test('empty transactions symlink cannot redirect backups outside confirmed root', async t => {
    const root = await fixture(t); const outside = await fixture(t); const before = await readdir(outside);
    await mkdir(join(root, STATE_DIR)); await symlink(outside, join(root, STATE_DIR, 'transactions'), 'dir');
    await assert.rejects(runInstaller(opts(root)), /Symbolic links/);
    assert.deepEqual(await readdir(outside), before); assert.ok(!await present(dest(root, 'server')));
});
test('staging failure leaves a recoverable rolled-back journal and permits next install', async t => {
    const root = await fixture(t); await oldPlugin(root);
    await assert.rejects(runInstaller(opts(root), { fault: step => { if (step === 'during-stage:server') throw new Error('staging error'); } }), /rolled back/);
    assert.equal(await readFile(join(dest(root, 'server'), 'old.txt'), 'utf8'), 'original plugin bytes');
    await runInstaller(opts(root)); assert.ok(await present(join(dest(root, 'server'), 'index.mjs')));
});
test('transaction record symlink is rejected without writing the linked file', async t => {
    const root = await fixture(t); const done = await runInstaller(opts(root));
    const record = join(root, STATE_DIR, 'transactions', done.transaction, 'transaction.json'); const elsewhere = join(root, 'outside-record.json');
    await cp(record, elsewhere); const original = await readFile(elsewhere, 'utf8'); await rm(record); await symlink(elsewhere, record);
    await assert.rejects(runInstaller({ stRoot: root, confirmRoot: root, rollback: done.transaction }), /Symbolic links/);
    assert.equal(await readFile(elsewhere, 'utf8'), original);
});
test('orphan preparation journal gives explicit safe recovery instructions', async t => {
    const root = await fixture(t); const id = '2026-10-23T00-00-00-000Z-0123456789ab';
    await mkdir(join(root, STATE_DIR, 'transactions', id, 'stage'), { recursive: true });
    await assert.rejects(runInstaller(opts(root)), /No readable journal.*no destination changes/);
    assert.ok(!await present(dest(root, 'server')));
});

test('rollback dry-run reports exactly the recorded components and changes nothing', async t => {
    const root = await fixture(t); const installed = await runInstaller({ ...opts(root), backendOnly: true });
    const before = await readFile(join(root, 'config.yaml'), 'utf8');
    const plan = await runInstaller({ stRoot: root, rollback: installed.transaction, dryRun: true });
    assert.deepEqual(plan.targets, [dest(root, 'server')]); assert.equal(await readFile(join(root, 'config.yaml'), 'utf8'), before);
    assert.ok(await present(join(dest(root, 'server'), 'index.mjs')));
});

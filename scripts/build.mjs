import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { deflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
const crcTable = Array.from({ length: 256 }, (_, n) => { for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1; return n >>> 0; });
function crc32(b) { let n = 0xffffffff; for (const v of b) n = crcTable[(n ^ v) & 255] ^ (n >>> 8); return (n ^ 0xffffffff) >>> 0; }
async function walk(dir) {
    const result = [];
    for (const e of (await readdir(join(root, dir), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (e.isSymbolicLink()) throw new Error('Symlinks are not distributable');
        const path = join(dir, e.name); if (e.isDirectory()) result.push(...await walk(path)); else if (e.isFile()) result.push(path);
    }
    return result;
}
const docs = ['README.md', 'INSTALL.md', 'COMPATIBILITY.md', 'API.md', 'RESEARCH.md', 'TESTING.md', 'CHANGELOG.md', 'LICENSE'];
const frontend = ['manifest.json', 'index.js', 'routing.mjs'];
const source = [...docs, ...frontend, ...await walk('tests'), ...await walk('scripts'), ...await walk('.github'), 'package.json', '.gitignore', '.gitattributes'];
async function zip(entries) {
    const locals = []; const centrals = []; let offset = 0;
    for (const [name, path] of entries.sort((a, b) => a[0].localeCompare(b[0]))) {
        if (name.startsWith('/') || name.includes('..') || /node_modules|\.env(?:\.|$)|\.DS_Store/.test(name)) throw new Error('Unsafe archive path');
        const data = await readFile(join(root, path));
        // Detect accidental private local paths; fixture Key values are explicitly fake.
        if (/\/Users\/|\/home\/[^/]+\//.test(data.toString('utf8'))) throw new Error(`Private path in ${path}`);
        const bytes = deflateRawSync(data, { level: 9 }); const n = Buffer.from(name); const crc = crc32(data);
        const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(8, 8);
        local.writeUInt16LE(0x21, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(bytes.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(n.length, 26);
        locals.push(local, n, bytes);
        const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8); central.writeUInt16LE(8, 10); central.writeUInt16LE(0x21, 14);
        central.writeUInt32LE(crc, 16); central.writeUInt32LE(bytes.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(n.length, 28); central.writeUInt32LE(offset, 42);
        centrals.push(central, n); offset += local.length + n.length + bytes.length;
    }
    const cd = Buffer.concat(centrals); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, cd, end]);
}
const distributions = [
    [`opencode-go-bridge-${version}-source.zip`, source.map(p => [`opencode-go-bridge/${p}`, p])],
    [`opencode-go-bridge-${version}-extension.zip`, [...frontend, ...docs].map(p => [p, p])],
];
await mkdir(join(root, 'dist'), { recursive: true }); const sums = [];
for (const [name, entries] of distributions) {
    const data = await zip(entries); await writeFile(join(root, 'dist', name), data);
    sums.push(`${createHash('sha256').update(data).digest('hex')}  ${name}`);
    console.log(`${name}: ${entries.length} files, ${data.length} bytes`);
}
await writeFile(join(root, `dist/SHA256SUMS-${version}`), sums.join('\n') + '\n'); console.log(sums.join('\n'));

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const npm = process.env.npm_execpath;
assert.ok(npm, 'Run npm run pack:check.');
const output = execFileSync(process.execPath, [npm, 'pack', '--dry-run', '--offline', '--ignore-scripts', '--json'], {
  cwd: root, encoding: 'utf8',
});
const [packed] = JSON.parse(output);
const files = packed.files.map(({ path }) => path);
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

for (const filename of ['package.json', 'index.js', 'client.js', manifest.dsh.bundle.patch, manifest.exports['./icon'],
  'locale/zh.json', 'locale/en.json', ...['dafeiyu', 'dafeilong', 'jingjing', 'claude', 'gemini'].map(id => `assets/avatars/${id}.webp`)]) {
  assert.ok(files.includes(filename.replace(/^\.\//, '')), `Missing package entry: ${filename}`);
}
const privatePath = /^(?:\.github|\.local[^/]*|\.scratch|client|scripts|test|video)(?:\/|$)|^\.(?:gitattributes|gitignore|editorconfig)$/;
for (const filename of files) {
  assert.ok(!privatePath.test(filename), `Unexpected development file in package: ${filename}`);
}

// Resolve the Host's static imports using only files selected by npm pack.
// Importing the entry registers nothing until the Host calls apply().
const staged = mkdtempSync(join(tmpdir(), 'persona-package-'));
try {
  for (const filename of files) {
    const destination = join(staged, filename);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(root, filename), destination);
  }
  const host = await import(pathToFileURL(join(staged, 'index.js')));
  assert.equal(typeof host.apply, 'function', 'The packaged Host must export apply().');
} finally {
  rmSync(staged, { recursive: true, force: true });
}

console.log(`Package check passed (${files.length} files, both client and Host entries present).`);

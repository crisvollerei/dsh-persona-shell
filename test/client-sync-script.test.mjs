import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

const script = 'scripts/build-client-sync.mjs';
const shared = [
  'lib/remote-contract.js', 'lib/client-transport.js', 'lib/report-reading.js',
  'lib/report-theme.js', 'lib/chat-palette.js', 'lib/floating-layout.js',
];
const normalize = (value) => value.replace(/\r\n/g, '\n');

function fixture(t, { clientEol = '\n', sharedEol = '\n' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'persona-client-sync-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const parts = readdirSync(new URL('../client/', import.meta.url)).map(name => 'client/' + name);
  for (const file of ['package.json', script, 'client.js', ...shared, ...parts]) {
    const destination = join(root, file);
    const source = readFileSync(new URL('../' + file, import.meta.url), 'utf8');
    const eol = file === 'client.js' ? clientEol : shared.includes(file) ? sharedEol : '\n';
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, normalize(source).replace(/\n/g, eol));
  }
  const client = join(root, 'client.js');
  return {
    read: () => readFileSync(client, 'utf8'),
    write: (source) => writeFileSync(client, source),
    editSource(file, edit) {
      const path = join(root, 'client', file);
      writeFileSync(path, edit(readFileSync(path, 'utf8')));
    },
    run: (...args) => spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8' }),
  };
}

for (const [description, clientEol, sharedEol] of [
  ['LF', '\n', '\n'], ['CRLF', '\r\n', '\r\n'],
  ['CRLF client with LF shared source', '\r\n', '\n'],
  ['LF client with CRLF shared source', '\n', '\r\n'],
]) {
  test(`client sync preserves ${description}`, (t) => {
    const project = fixture(t, { clientEol, sharedEol });
    const before = project.read();
    const checked = project.run('--check');
    assert.equal(checked.status, 0, checked.stderr);
    assert.equal(project.read(), before);
    const generated = project.run();
    assert.equal(generated.status, 0, generated.stderr);
    assert.equal(project.read(), before);
  });
}

test('check accepts mixed line endings without rewriting the file', (t) => {
  const project = fixture(t);
  const before = project.read().replace('BEGIN GENERATED STATE TRANSPORT\n', 'BEGIN GENERATED STATE TRANSPORT\r\n');
  assert.match(before, /BEGIN GENERATED STATE TRANSPORT\r\n/);
  project.write(before);
  const checked = project.run('--check');
  assert.equal(checked.status, 0, checked.stderr);
  assert.equal(project.read(), before);
});

test('check rejects real drift, and generation repairs the exact client artifact', (t) => {
  const project = fixture(t, { clientEol: '\r\n' });
  const original = project.read();
  const stale = original.replace('function createRemoteContract()', 'function staleRemoteContract()');
  assert.notEqual(stale, original);
  project.write(stale);
  const checked = project.run('--check');
  assert.equal(checked.status, 1);
  assert.match(checked.stderr, /client\.js is out of date/);
  assert.equal(project.read(), stale);

  const generated = project.run();
  assert.equal(generated.status, 0, generated.stderr);
  assert.equal(project.read(), original);
  assert.equal(project.run('--check').status, 0);
});

test('editing a handwritten source fragment also invalidates the generated client', (t) => {
  const project = fixture(t);
  const original = project.read();
  const comment = '    // New client source comment.\n';
  project.editSource('shell-mount.js.part', source => comment + source);
  assert.equal(project.run('--check').status, 1);
  assert.equal(project.read(), original);
  assert.equal(project.run().status, 0);
  assert.equal(project.read(), original.replace('    return {\n      inject:', comment + '    return {\n      inject:'));
});

test('generation rejects duplicate source section markers without writing', (t) => {
  const project = fixture(t);
  const original = project.read();
  project.editSource('floating.js', source => source + '    // END GENERATED FLOATING LAYOUT\n');
  const generated = project.run();
  assert.equal(generated.status, 1);
  assert.match(generated.stderr, /FLOATING LAYOUT/);
  assert.equal(project.read(), original);
});

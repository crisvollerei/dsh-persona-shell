// Keep the dependency-free browser contract identical to the Host contract.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRemoteContract } from '../lib/remote-contract.js';
import { createClientTransport } from '../lib/client-transport.js';
import { createReportReadingPlan } from '../lib/report-reading.js';
import { createReportTheme } from '../lib/report-theme.js';
import { createChatPalette } from '../lib/chat-palette.js';
import { createFloatingLayout } from '../lib/floating-layout.js';

const file = new URL('../client.js', import.meta.url);
const PARTS = [
  'shell-head.js.part', 'state-sync.js', 'session-controls.js', 'floating.js',
  'chat-state.js', 'chat-window.js', 'report-reader.js', 'report-overlay.js',
  'settings.js', 'shell-mount.js.part',
];
const SECTIONS = [
  ['STATE TRANSPORT', [createRemoteContract, createClientTransport]],
  ['REPORT READING', [createReportReadingPlan]],
  ['REPORT THEME', [createReportTheme]],
  ['CHAT PALETTE', [createChatPalette]],
  ['FLOATING LAYOUT', [createFloatingLayout]],
];
const normalizeEol = (value) => value.replace(/\r\n/g, '\n');
const check = process.argv.includes('--check');
const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
const readPart = (part) => normalizeEol(readFileSync(new URL(`../client/${part}`, import.meta.url), 'utf8'));
const settingsSections = new Map();
for (const name of ['persona', 'memory', 'chat', 'usage']) {
  const file = `settings-${name}.js`;
  for (const match of readPart(file).matchAll(/^\/\/ SECTION (\w+)\n([\s\S]*?)(?=^\/\/ SECTION |(?![\s\S]))/gm)) {
    settingsSections.set(`${file}#${match[1]}`, match[2]);
  }
}
let output = PARTS.map(readPart).join('').replace(/^    \/\/ INCLUDE ([\w.#-]+)\n/gm, (_, key) => {
  if (!settingsSections.has(key)) throw new Error(`Missing settings section: ${key}`);
  const source = settingsSections.get(key);
  settingsSections.delete(key);
  return source;
});
if (settingsSections.size) throw new Error(`Unused settings sections: ${[...settingsSections.keys()]}`);

for (const [name, functions] of SECTIONS) {
  const marker = new RegExp(`^    // (BEGIN|END) GENERATED ${name}(?=\\r?$)`, 'gm');
  const matches = [...output.matchAll(marker)];
  const [begin, end] = matches;
  if (matches.length !== 2 || begin[1] !== 'BEGIN' || end[1] !== 'END') {
    throw new Error(`Invalid generated ${name} markers in client source`);
  }
  const start = begin.index + begin[0].length;
  if (output.slice(start, end.index).trim()) {
    throw new Error(`Generated ${name} markers must be empty in client source`);
  }
  const generated = '\n' + functions.map((fn) => `    ${normalizeEol(fn.toString())}`).join('\n\n') + '\n';
  output = output.slice(0, start) + generated + output.slice(end.index);
}

if (normalizeEol(current) !== output) {
  if (check) throw new Error('Generated client.js is out of date. Run npm run sync:client.');
  const eol = current.match(/\r?\n/)?.[0] ?? '\n';
  writeFileSync(file, output.replace(/\n/g, eol));
}

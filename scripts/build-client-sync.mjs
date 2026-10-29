// Keep the dependency-free browser contract identical to the Host contract.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRemoteContract } from '../lib/remote-contract.js';
import { createClientTransport } from '../lib/client-transport.js';

const file = new URL('../client.js', import.meta.url);
const source = readFileSync(file, 'utf8');
const start = '    // BEGIN GENERATED STATE TRANSPORT';
const end = '    // END GENERATED STATE TRANSPORT';
const generated = [createRemoteContract, createClientTransport].map((fn) => `    ${fn.toString()}`).join('\n\n');
const next = source.replace(new RegExp(`${start}[\\s\\S]*?${end}`), `${start}\n${generated}\n${end}`);
if (next === source && !source.includes(generated)) throw new Error('Missing generated transport markers');
if (process.argv.includes('--check')) {
  if (next !== source) throw new Error('Run node scripts/build-client-sync.mjs');
} else if (next !== source) writeFileSync(file, next);

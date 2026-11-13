// Keep the dependency-free browser contract identical to the Host contract.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRemoteContract } from '../lib/remote-contract.js';
import { createClientTransport } from '../lib/client-transport.js';
import { createReportReadingPlan } from '../lib/report-reading.js';
import { createReportTheme } from '../lib/report-theme.js';
import { createChatPalette } from '../lib/chat-palette.js';
import { createFloatingLayout } from '../lib/floating-layout.js';

const file = new URL('../client.js', import.meta.url);
const source = readFileSync(file, 'utf8');
const start = '    // BEGIN GENERATED STATE TRANSPORT';
const end = '    // END GENERATED STATE TRANSPORT';
const generated = [createRemoteContract, createClientTransport].map((fn) => `    ${fn.toString()}`).join('\n\n');
const readingStart = '    // BEGIN GENERATED REPORT READING';
const readingEnd = '    // END GENERATED REPORT READING';
const reading = `    ${createReportReadingPlan.toString()}`;
if (!source.includes(start) || !source.includes(end)) throw new Error('Missing generated transport markers');
const withTransport = source.replace(new RegExp(`${start}[\\s\\S]*?${end}`), () => `${start}\n${generated}\n${end}`);
if (!withTransport.includes(readingStart) || !withTransport.includes(readingEnd)) throw new Error('Missing generated report reading markers');
const withReading = withTransport.replace(new RegExp(`${readingStart}[\\s\\S]*?${readingEnd}`), () => `${readingStart}\n${reading}\n${readingEnd}`);
const themeStart = '    // BEGIN GENERATED REPORT THEME';
const themeEnd = '    // END GENERATED REPORT THEME';
if (!withReading.includes(themeStart) || !withReading.includes(themeEnd)) throw new Error('Missing generated report theme markers');
const withTheme = withReading.replace(new RegExp(`${themeStart}[\\s\\S]*?${themeEnd}`), () => `${themeStart}\n    ${createReportTheme.toString()}\n${themeEnd}`);
const paletteStart='    // BEGIN GENERATED CHAT PALETTE',paletteEnd='    // END GENERATED CHAT PALETTE';
if(!withTheme.includes(paletteStart)||!withTheme.includes(paletteEnd))throw Error('Missing generated chat palette markers');
const withPalette=withTheme.replace(new RegExp(`${paletteStart}[\\s\\S]*?${paletteEnd}`),()=>`${paletteStart}\n    ${createChatPalette.toString()}\n${paletteEnd}`);
const floatingStart='    // BEGIN GENERATED FLOATING LAYOUT',floatingEnd='    // END GENERATED FLOATING LAYOUT';
if(!withPalette.includes(floatingStart)||!withPalette.includes(floatingEnd))throw Error('Missing generated floating layout markers');
const next=withPalette.replace(new RegExp(`${floatingStart}[\\s\\S]*?${floatingEnd}`),()=>`${floatingStart}\n    ${createFloatingLayout.toString()}\n${floatingEnd}`);
if (process.argv.includes('--check')) {
  if (next !== source) throw new Error('Run node scripts/build-client-sync.mjs');
} else if (next !== source) writeFileSync(file, next);

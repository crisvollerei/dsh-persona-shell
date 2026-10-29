// Runs the installed Desktop with an isolated DSH_HOME and Electron user-data dir.
// No user profile, credentials, existing sessions or real model calls are used.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, writeFileSync, openSync, closeSync, symlinkSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { executable: { type: 'string' }, 'browser-deps': { type: 'string' } } });
assert.ok(values.executable && values['browser-deps'], 'Pass --executable <installed Desktop.exe> --browser-deps <playwright package.json>');
const { chromium } = createRequire(path.resolve(values['browser-deps']))('playwright');
const output = mkdtempSync(path.join(os.tmpdir(), 'persona-shell-desktop-'));
const home = path.join(output, 'home');
const profile = path.join(home, 'profiles', 'desktop');
mkdirSync(path.join(profile, 'node_modules'), { recursive: true });
symlinkSync(fileURLToPath(new URL('../../', import.meta.url)), path.join(profile, 'node_modules', 'dsh-persona-shell'), 'junction');
writeFileSync(path.join(profile, 'package.json'), JSON.stringify({ name: 'persona-shell-desktop-test', private: true,
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-persona-shell'] } },
  dependencies: { 'dsh-persona-shell': `link:${fileURLToPath(new URL('../../', import.meta.url)).replaceAll('\\', '/')}` },
}));
writeFileSync(path.join(profile, 'cordis.yml'), '[]\n');
writeFileSync(path.join(profile, 'cordis.patch.yml'), `
- id: persona-shell
  config:
    enabled: true
    memory: false
    progressNotices: false
- id: ui-settings-general
  config:
    welcomeNoticeVersion: 2026-08-13.1
- id: ui-settings-account
  config:
    version: 1
    step: done
    usage: basic
    developerTools: true
    purpose: null
    process: standard
    completion: api-key
`);
const port = 39000 + Math.floor(Math.random() * 9000);
const log = openSync(path.join(output, 'desktop.log'), 'w');
const child = spawn(values.executable, [`--user-data-dir=${path.join(output, 'electron')}`, `--remote-debugging-port=${port}`], {
  env: { ...process.env, DSH_HOME: home }, windowsHide: true, stdio: ['ignore', log, log],
});
closeSync(log);
let browser;
const observations = [];
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
console.log(JSON.stringify({ output, pid: child.pid, debuggingPort: port }));
try {
  for (let i = 0; i < 180; i++) {
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); break; }
    catch { if (child.exitCode !== null) throw new Error(`Desktop exited: ${child.exitCode}`); await pause(500); }
  }
  assert.ok(browser, 'Desktop exposes its isolated test renderer');
  let page;
  for (let i = 0; i < 180; i++) {
    page = browser.contexts().flatMap((context) => context.pages()).find((candidate) => candidate.url().startsWith('dsh-app://app'));
    if (page) break;
    await pause(500);
  }
  assert.ok(page, 'Desktop opened its main app');
  const request = (route, body) => page.evaluate(async ({ route, body }) => {
    const response = await fetch(`/persona-shell/${route}`, body === undefined ? undefined : {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: response.status, value: await response.json() };
  }, { route, body });
  let ping;
  for (let i = 0; i < 180; i++) {
    try {
      ping = (await request('ping')).value;
      if (ping?.stateSync?.client === 'ready') break;
      if (ping?.stateSync?.client === 'blocked') {
        const detail = (await request('diagnostics')).value.stateTransport;
        throw Object.assign(new Error(`Desktop stream blocked: ${JSON.stringify(detail)}`), { terminal: true });
      }
    } catch (error) { if (error.terminal) throw error; }
    await pause(500);
  }
  observations.push({ phase: 'boot', ping });
  assert.equal(ping?.stateSync?.client, 'ready', 'installed Desktop uses the official push stream');
  assert.equal(ping.hostBuild, ping.clientBuild);
  assert.equal((await request('settings')).value.settings.memory, false);
  const base = await page.evaluate(() => globalThis.__DSH_TRANSPORT__?.streamBaseUrl);
  assert.ok(base, 'Desktop supplied its official Host stream carrier');
  const unauthenticated = await fetch(`${base}/persona-shell/settings`);
  assert.ok([401, 403].includes(unauthenticated.status), 'the external unauthenticated settings request is refused');
  observations.push({ phase: 'unauthenticated-rejected', status: unauthenticated.status });
  const baseline = ping.stateSync.deltas;
  assert.equal((await request('settings', { enabled: false })).status, 200);
  await pause(250);
  ping = (await request('ping')).value;
  observations.push({ phase: 'disabled', ping });
  assert.equal(ping.stateSync.client, 'ready'); assert.ok(ping.stateSync.deltas > baseline);
  assert.equal((await request('settings', { enabled: true })).status, 200);
  await pause(250);
  ping = (await request('ping')).value;
  observations.push({ phase: 're-enabled', ping });
  assert.ok(ping.stateSync.deltas > baseline + 1, 'control stream survives global disable/re-enable');

  // No periodic settings/state requests once the official control stream is ready.
  await page.evaluate(() => {
    const original = globalThis.fetch;
    globalThis.__personaTestReads = [];
    globalThis.fetch = (input, ...args) => {
      if (/\/persona-shell\/(?:state|settings)(?:\?|$)/.test(String(input))) globalThis.__personaTestReads.push(String(input));
      return original(input, ...args);
    };
  });
  await pause(6100);
  assert.deepEqual(await page.evaluate(() => globalThis.__personaTestReads), []);
  observations.push({ phase: 'idle', stateAndSettingsRequests: 0 });

  await page.reload();
  for (let i = 0; i < 60; i++) {
    try { ping = (await request('ping')).value;
      if (ping.stateSync.active === 1 && ping.stateSync.client === 'ready') break; } catch {}
    await pause(250);
  }
  assert.equal(ping.stateSync.active, 1, 'page reload did not leak its old subscription');
  const beforeReconnect = ping.stateSync.snapshots;
  // Only this isolated Electron browser context goes offline, not the machine.
  // Use the real socket and Connection offline lifecycle, not a WS proxy.
  await page.context().setOffline(true);
  await pause(1500);
  await page.context().setOffline(false);
  for (let i = 0; i < 80; i++) {
    await pause(250);
    try { ping = (await request('ping')).value;
      if (ping.stateSync.snapshots > beforeReconnect && ping.stateSync.active === 1 && ping.stateSync.client === 'ready') break;
    } catch {}
  }
  assert.ok(ping.stateSync.snapshots > beforeReconnect, 'official Connection reopened the stream with a new baseline');
  assert.equal(ping.stateSync.active, 1);
  assert.equal(ping.stateSync.client, 'ready');
  observations.push({ phase: 'page-reload-and-carrier-reconnect', ping });
  await page.screenshot({ path: path.join(output, 'desktop.png') });
  writeFileSync(path.join(output, 'result.json'), JSON.stringify({ result: 'passed', observations,
    limitations: 'No real model or user transcript; native reasoning/image delegation has a separate renderer integration.' }, null, 2));
  console.log(JSON.stringify({ result: 'passed', output, observations }, null, 2));
} catch (error) {
  writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ message: error.message, observations }, null, 2));
  if (browser) {
    const pages = browser.contexts().flatMap((context) => context.pages());
    for (let i = 0; i < pages.length; i++) {
      try { await pages[i].screenshot({ path: path.join(output, `failure-${i}.png`) });
        writeFileSync(path.join(output, `failure-${i}.txt`), (await pages[i].locator('body').innerText()).slice(0, 10000)); } catch {}
    }
  }
  throw error;
} finally {
  // This is only the process launched above with a fresh isolated profile.
  try { const session = await browser?.newBrowserCDPSession();
    await Promise.race([session?.send('Browser.close').catch(() => {}), pause(2000)]); } catch {}
  await browser?.close().catch(() => {});
  for (let i = 0; i < 30 && child.exitCode === null; i++) await pause(100);
  if (child.exitCode === null) child.kill();
  assert.ok(existsSync(output));
}

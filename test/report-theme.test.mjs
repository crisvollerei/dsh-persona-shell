import test from 'node:test';
import assert from 'node:assert/strict';
import { createReportTheme } from '../lib/report-theme.js';

const ids = ['catppuccin', 'nord', 'rosepine'];
const modes = ['light', 'dark'];
const textRoles = ['ink', 'muted', 'heading-1', 'heading-2', 'link', 'accent', 'conclusion', 'risk', 'support'];
const relativeLuminance = hex => {
  const channels = hex.slice(1).match(/../g).map(value => parseInt(value, 16) / 255)
    .map(value => value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4));
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
};
const ratio = (foreground, background) => {
  const a = relativeLuminance(foreground), b = relativeLuminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};

test('reading themes expose the chosen family, paired flavours and original background palettes', () => {
  const pairs = [
    ['catppuccin', 'Catppuccin', 'Latte', 'Mocha', '#eff1f5', '#1e1e2e'],
    ['nord', 'Nord', 'Snow Storm', 'Polar Night', '#eceff4', '#2e3440'],
    ['rosepine', 'Rosé Pine', 'Dawn', 'Main', '#faf4ed', '#191724'],
  ];
  for (const [id, name, lightFlavour, darkFlavour, lightBackground, darkBackground] of pairs) {
    for (const [appearance, flavour, background] of [['light', lightFlavour, lightBackground], ['dark', darkFlavour, darkBackground]]) {
      const theme = createReportTheme(id, appearance);
      assert.equal(theme.id, id); assert.equal(theme.name, name); assert.equal(theme.appearance, appearance);
      assert.equal(theme.flavour, flavour); assert.equal(theme.vars['--rr-bg'], background); assert.equal(theme.adapted, true);
      assert.ok(Object.values(theme.vars).every(value => /^#[\da-f]{6}$/u.test(value)));
    }
  }
});

test('following DSH retains host semantic colors and does not pin a fixed light or dark document', () => {
  for (const mode of modes) {
    const theme = createReportTheme('system', mode);
    assert.equal(theme.id, 'system'); assert.equal(theme.name, '跟随 DSH'); assert.equal(theme.appearance, mode);
    assert.equal(theme.adapted, false); assert.match(theme.vars['--rr-bg'], /var\(--dsw-alias-bg-layer-1/u);
    assert.match(theme.vars['--rr-ink'], /var\(--dsw-alias-label-primary/u);
    assert.match(theme.vars['--rr-heading-1'], /var\(--dsw-alias-brand-primary/u);
    assert.deepEqual(theme.vars, createReportTheme('system', modes.find(value => value !== mode)).vars);
  }
});

test('all fixed-theme reading text remains legible on both document and control surfaces', () => {
  for (const id of ids) for (const mode of modes) {
    const { vars } = createReportTheme(id, mode);
    for (const role of textRoles) for (const surface of ['bg', 'soft']) {
      assert.ok(ratio(vars['--rr-' + role], vars['--rr-' + surface]) >= 4.5,
        `${id}/${mode} ${role} on ${surface} must retain 4.5:1 contrast`);
    }
    assert.ok(ratio(vars['--rr-on-accent'], vars['--rr-accent']) >= 4.5,
      `${id}/${mode} filled controls need a readable foreground`);
  }
});

test('body ink remains legible on the actual translucent annotation backgrounds', () => {
  const channels = hex => hex.slice(1).match(/../gu).map(value => parseInt(value, 16) / 255);
  const luminance = rgb => rgb.map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
    .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
  for (const id of ids) for (const mode of modes) {
    const { vars } = createReportTheme(id, mode);
    const ink = luminance(channels(vars['--rr-ink']));
    for (const surface of ['bg', 'soft']) for (const [role, opacity] of [['conclusion', 0.15], ['risk', 0.15], ['support', 0.08]]) {
      const base = channels(vars['--rr-' + surface]), mark = channels(vars['--rr-' + role]);
      // color-mix(in srgb, role N%, transparent) composites in sRGB before
      // conversion to relative luminance; keep fractional channels unrounded.
      const background = luminance(base.map((value, index) => value * (1 - opacity) + mark[index] * opacity));
      const contrast = (Math.max(ink, background) + 0.05) / (Math.min(ink, background) + 0.05);
      assert.ok(contrast >= 4.5, `${id}/${mode} ink over ${role} ${opacity * 100}% on ${surface} must retain 4.5:1 contrast`);
    }
  }
});

test('risk remains a warm distinct role rather than adopting a decorative or success color', () => {
  for (const id of ids) for (const mode of modes) {
    const { vars } = createReportTheme(id, mode);
    const [red, green, blue] = vars['--rr-risk'].slice(1).match(/../g).map(value => parseInt(value, 16));
    assert.ok(red >= green && red > blue, `${id}/${mode} retains a warm warning hue`);
    assert.notEqual(vars['--rr-risk'], vars['--rr-heading-1']);
    assert.notEqual(vars['--rr-risk'], vars['--rr-support']);
  }
});

test('unknown and hostile preference values can never become CSS or trigger coercion', () => {
  const baseline = createReportTheme();
  const object = { toString() { assert.fail('preference values must not be coerced'); } };
  for (const id of ['__proto__', 'constructor', '</style><script>run()</script>', 'url(https://invalid.test)', '', null, 4, object, Symbol('theme')]) {
    assert.deepEqual(createReportTheme(id, object), baseline);
  }
  for (const mode of ['auto', 'DARK', 'dark; background:url(https://invalid.test)', null, object, Symbol('appearance')]) {
    assert.deepEqual(createReportTheme('nord', mode), createReportTheme('nord', 'light'));
  }
});

test('theme objects have no shared mutable preference state', () => {
  const first = createReportTheme('catppuccin', 'light');
  first.vars['--rr-bg'] = '#ffffff'; first.id = 'nord';
  const second = createReportTheme('catppuccin', 'light');
  assert.equal(second.id, 'catppuccin'); assert.equal(second.vars['--rr-bg'], '#eff1f5');
});

test('the browser copy executes without module closures, imports or DOM access', () => {
  const browserCopy = Function('"use strict"; return (' + createReportTheme.toString() + ');')();
  for (const id of ['system', ...ids]) for (const mode of modes)
    assert.deepEqual(browserCopy(id, mode), createReportTheme(id, mode));
});

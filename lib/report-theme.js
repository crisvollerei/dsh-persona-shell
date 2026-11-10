/** Reading-only palette roles. Keep this function self-contained for the browser copy. */
export function createReportTheme(theme = 'system', appearance = 'light') {
  const id = ['system', 'catppuccin', 'nord', 'rosepine'].includes(theme) ? theme : 'system';
  const mode = appearance === 'dark' ? 'dark' : 'light';
  if (id === 'system') return {
    id, appearance: mode, name: '跟随 DSH', flavour: mode === 'dark' ? '深色' : '浅色', adapted: false,
    vars: {
      '--rr-bg': 'var(--dsw-alias-bg-layer-1,#fff)',
      '--rr-soft': 'var(--dsw-alias-bg-layer-2,#f5f7fa)',
      '--rr-ink': 'var(--dsw-alias-label-primary,#243244)',
      '--rr-muted': 'var(--dsw-alias-label-secondary,#687788)',
      '--rr-border': 'var(--dsw-alias-border-l1,#dce3eb)',
      '--rr-accent': 'var(--dsw-alias-brand-primary,#436cba)',
      '--rr-on-accent': 'var(--dsw-alias-label-primary-foreground,var(--dsw-alias-label-on-color,#fff))',
      '--rr-heading-1': 'var(--dsw-alias-brand-primary,#436cba)',
      '--rr-heading-2': 'color-mix(in srgb,var(--dsw-alias-brand-primary,#436cba) 75%,var(--dsw-alias-label-primary,#243244))',
      '--rr-link': 'var(--dsw-alias-brand-primary,#436cba)',
      '--rr-conclusion': 'var(--dsw-alias-brand-primary,#436cba)',
      '--rr-risk': 'color-mix(in srgb,#b47a24 78%,var(--dsw-alias-label-primary,#243244))',
      '--rr-support': 'color-mix(in srgb,#398b91 73%,var(--dsw-alias-label-primary,#243244))',
    },
  };
  // Based on the official Catppuccin, Nord and Rosé Pine palettes. Accent values
  // are adapted for small reading controls as well as headings, not syntax tokens.
  const families = {
    catppuccin: {
      name: 'Catppuccin',
      light: { flavour: 'Latte', bg: '#eff1f5', soft: '#e6e9ef', ink: '#4c4f69', muted: '#6c6f85', border: '#ccd0da', h1: '#8839ef', h2: '#1e66f5', risk: '#df8e1d', support: '#179299' },
      dark: { flavour: 'Mocha', bg: '#1e1e2e', soft: '#181825', ink: '#cdd6f4', muted: '#a6adc8', border: '#45475a', h1: '#cba6f7', h2: '#89b4fa', risk: '#f9e2af', support: '#94e2d5' },
    },
    nord: {
      name: 'Nord',
      light: { flavour: 'Snow Storm', bg: '#eceff4', soft: '#e5e9f0', ink: '#2e3440', muted: '#4c566a', border: '#d8dee9', h1: '#5e81ac', h2: '#5e81ac', risk: '#d08770', support: '#8fbcbb' },
      dark: { flavour: 'Polar Night', bg: '#2e3440', soft: '#3b4252', ink: '#eceff4', muted: '#d8dee9', border: '#4c566a', h1: '#88c0d0', h2: '#81a1c1', risk: '#ebcb8b', support: '#8fbcbb' },
    },
    rosepine: {
      name: 'Rosé Pine',
      light: { flavour: 'Dawn', bg: '#faf4ed', soft: '#fffaf3', ink: '#464261', muted: '#797593', border: '#dfdad9', h1: '#907aa9', h2: '#286983', risk: '#ea9d34', support: '#56949f' },
      dark: { flavour: 'Main', bg: '#191724', soft: '#1f1d2e', ink: '#e0def4', muted: '#908caa', border: '#403d52', h1: '#c4a7e7', h2: '#9ccfd8', risk: '#f6c177', support: '#9ccfd8' },
    },
  };
  const family = families[id], palette = family[mode];
  const rgb = hex => [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16));
  const luminance = hex => rgb(hex).map(value => {
    const channel = value / 255;
    return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
  }).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
  const contrast = (a, b) => {
    const x = luminance(a), y = luminance(b);
    return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
  };
  const mix = (a, b, fraction) => {
    const from = rgb(a), to = rgb(b);
    return '#' + from.map((value, index) => Math.round(value * (1 - fraction) + to[index] * fraction).toString(16).padStart(2, '0')).join('');
  };
  const readable = color => {
    // The same roles appear on the document and the secondary controls. Check
    // both surfaces so a readable title does not become a faint small label.
    for (let step = 0; step <= 64; step++) {
      const value = mix(color, palette.ink, step / 64);
      if ([palette.bg, palette.soft].every(surface => contrast(value, surface) >= 4.5)) return value;
    }
    return palette.ink;
  };
  const accent = readable(palette.h2);
  return {
    id, appearance: mode, name: family.name, flavour: palette.flavour, adapted: true,
    vars: {
      '--rr-bg': palette.bg,
      '--rr-soft': palette.soft,
      '--rr-ink': palette.ink,
      '--rr-muted': readable(palette.muted),
      '--rr-border': palette.border,
      '--rr-accent': accent,
      '--rr-on-accent': palette.bg,
      '--rr-heading-1': readable(palette.h1),
      '--rr-heading-2': accent,
      '--rr-link': accent,
      '--rr-conclusion': accent,
      '--rr-risk': readable(palette.risk),
      '--rr-support': readable(palette.support),
    },
  };
}

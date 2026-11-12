window.__ModuleLoader__.load({
  id: 'dsh-persona-shell',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    let flushChatSync;
    try { flushChatSync=require('react-dom').flushSync; } catch { /* Older clients settle surface changes without snapshots. */ }
    let createChatRoot;
    try { createChatRoot = require('react-dom/client').createRoot; } catch {
      try { createChatRoot = require('react-dom').createRoot; } catch { /* The chat entry explains unsupported hosts. */ }
    }
    /** Run before paint when the shell's React provides it (the test mock does not). */
    const useLayoutEffect = typeof React.useLayoutEffect === 'function' ? React.useLayoutEffect : React.useEffect;

    const ROUTE = '/persona-shell';

    // BEGIN GENERATED STATE TRANSPORT
    function createRemoteContract() {
  const boundedString = (value, max) => {
    if (typeof value !== 'string' || value.length > max) throw new TypeError('Invalid state subscription');
    return value;
  };
  const codec = (name, parse) => ({ mode: 'strict', typeSymbol: `persona-shell#${name}`, create: () => ({ parse }) });
  const session = codec('SessionKey', (value) => boundedString(value, 200));
  const view = codec('ViewLease', (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some((key) => !['viewer', 'revision', 'visible'].includes(key))
      || typeof value.visible !== 'boolean' || !Number.isSafeInteger(value.revision) || value.revision < 0
      || boundedString(value.viewer, 100) === '') throw new TypeError('Invalid view lease');
    return value;
  });
  const frame = codec('StateFrame', (value) => {
    if (!value || !['snapshot', 'delta'].includes(value.type)
      || typeof value.instanceId !== 'string' || !value.instanceId
      || !Number.isSafeInteger(value.rev) || value.rev < 0) throw new TypeError('Invalid state frame');
    return value;
  });
  return {
    package: 'dsh-persona-shell',
    descriptors: [{
      id: 'dsh-persona-shell#personaShell/observe', service: 'personaShell', namespace: 'personaShell',
      method: 'observe', mode: 'stream', invocation: { kind: 'direct' },
      parameters: [{ name: 'key', wire: 'key', source: 'json', codec: session }],
      cancellation: { parameter: 'signal' }, uplink: { codec: view }, result: frame,
    }],
  };
}

    function createClientTransport({ remote, SnapshotStream, CarrierError, contribution, onState, onStatus,
  nextRequest, viewer, bindRemote, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const entries = new Map();
  const pendingCloses = new Set();
  const compatibility = new Set(['gateway/definition-unavailable', 'gateway/invocation-unavailable',
    'gateway/method-unavailable', 'gateway/service-unavailable', 'gateway/interactions-forbidden']);
  let stopped = false;
  let mounted = false;
  let mounting;
  let unmount;
  let unbind;
  let boundRemote = remote;
  let leaseTimer;
  let view;

  const status = (entry, value, error) => {
    if (entry.status === value && error === undefined) return;
    entry.status = value;
    onStatus(entry.key, value, error);
  };
  const trackClose = (promise) => {
    const task = Promise.resolve(promise).catch(() => {});
    pendingCloses.add(task);
    void task.finally(() => pendingCloses.delete(task));
    return task;
  };
  const close = (entry) => {
    clearTimer(entry.deadline);
    entry.token = undefined;
    const stream = entry.stream;
    entry.stream = undefined;
    entry.handle = undefined;
    return stream ? trackClose(stream.dispose()) : Promise.resolve();
  };
  const sendView = (entry) => {
    if (!entry.handle || entry.key === '') return;
    const visible = view?.visible === true && view.sessionId === entry.key;
    try { entry.handle.send({ viewer, revision: view?.revision ?? 0, visible }); } catch { /* generation is closing */ }
  };
  const scheduleLease = () => {
    clearTimer(leaseTimer);
    leaseTimer = undefined;
    if (stopped || view?.visible !== true) return;
    const entry = entries.get(view.sessionId);
    if (!entry?.handle) return;
    leaseTimer = setTimer(() => { sendView(entry); scheduleLease(); }, 15000);
  };

  function open(entry) {
    if (stopped || !mounted || !entry.count || entry.stream) return;
    const token = {};
    entry.token = token;
    const current = () => !stopped && entry.token === token && entries.get(entry.key) === entry;
    status(entry, 'starting');
    let baseline;
    let request;
    const failed = (error) => {
      if (!current()) return;
      const carrier = error instanceof CarrierError || error?.cause instanceof CarrierError;
      const fallback = compatibility.has(error?.code) || carrier || error?.code === 'persona-shell/stream-timeout';
      // Auth/business/protocol failures remain visible diagnostics, not compatibility probes.
      status(entry, fallback ? 'fallback' : 'blocked', error);
      void close(entry);
      scheduleLease();
    };
    const publish = (frame, snapshot) => {
      if (!current()) return;
      contribution.descriptors[0].result.create().parse(frame);
      if (!frame.settings || typeof frame.settings !== 'object') throw new Error('Missing state settings');
      if (snapshot) {
        if (!Array.isArray(frame.rows)) throw new Error('Missing state baseline');
        baseline = { ...frame };
      } else {
        if (!baseline || baseline.instanceId !== frame.instanceId || baseline.rev !== frame.baseRev
          || frame.rev < baseline.rev || !Array.isArray(frame.upsert) || !Array.isArray(frame.removed)) {
          throw new Error('State delta does not follow its baseline');
        }
        const rows = new Map(baseline.rows.map((row) => [row.seq, row]));
        for (const seq of frame.removed) rows.delete(seq);
        for (const row of frame.upsert) rows.set(row.seq, row);
        baseline = { ...frame, rows: [...rows.values()].sort((a, b) => a.seq - b.seq) };
      }
      if (onState(entry.key, baseline, request) === false) return;
      clearTimer(entry.deadline);
      status(entry, 'ready');
    };
    const logical = remote.$stream({ name: `persona-shell:${entry.key || 'control'}`,
      open(signal) {
        request = nextRequest();
        baseline = undefined;
        const handle = boundRemote.personaShell.observe(entry.key, signal);
        entry.handle = handle;
        signal.addEventListener('abort', () => {
          if (entry.handle === handle) { entry.handle = undefined; scheduleLease(); }
        }, { once: true });
        sendView(entry); scheduleLease();
        return handle;
      },
      ended: () => new CarrierError('Persona Shell state stream ended'),
    });
    entry.stream = new SnapshotStream(logical, {
      name: 'persona-shell', isSnapshot: (frame) => frame?.type === 'snapshot',
      replace: (frame) => publish(frame, true), update: (frame) => publish(frame, false), failed,
    });
    entry.deadline = setTimer(() => {
      const error = Object.assign(new Error('State stream did not open'), { code: 'persona-shell/stream-timeout' });
      failed(error);
    }, 10000);
    entry.stream.start();
  }

  return {
    start() {
      return mounting ??= (async () => {
        try {
          unmount = await remote.$mount(contribution);
          if (stopped) return;
          const bind = (value) => {
            if (stopped) return;
            boundRemote = value;
            mounted = value !== undefined;
            for (const entry of entries.values()) {
              if (mounted) open(entry);
              else { void close(entry); status(entry, 'fallback'); }
            }
          };
          if (bindRemote) unbind = bindRemote(bind);
          else bind(remote);
        } catch (error) {
          if (!stopped) for (const entry of entries.values()) status(entry, 'fallback', error);
        }
      })();
    },
    subscribe(key) {
      let entry = entries.get(key);
      if (!entry) { entry = { key, count: 0, status: 'fallback' }; entries.set(key, entry); }
      entry.count += 1;
      open(entry);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (--entry.count > 0) return;
        entries.delete(key);
        void close(entry);
        scheduleLease();
      };
    },
    status: (key) => entries.get(key)?.status ?? 'fallback',
    setView(value) {
      view = value;
      for (const entry of entries.values()) sendView(entry);
      scheduleLease();
    },
    restart() {
      for (const entry of entries.values()) {
        if (!entry.stream && entry.status !== 'blocked') open(entry);
      }
    },
    async dispose() {
      stopped = true;
      clearTimer(leaseTimer);
      await Promise.all([...entries.values()].map(close));
      entries.clear();
      await Promise.all([...pendingCloses]);
      await mounting;
      const withdraw = unbind;
      unbind = undefined;
      await withdraw?.();
      const release = unmount;
      unmount = undefined;
      await release?.();
    },
  };
}
    // END GENERATED STATE TRANSPORT

    // BEGIN GENERATED REPORT READING
    function createReportReadingPlan(source, result) {
  const empty = { sourceHash: typeof source?.hash === 'string' ? source.hash : null, entries: [], navigation: [] };
  if (!source || typeof source.text !== 'string' || source.text.length > 24000 || !/^[a-f0-9]{64}$/.test(source.hash ?? '')
    || !Array.isArray(source.blocks) || source.blocks.length > 256 || !Array.isArray(source.caveatRefs)) return empty;
  const ids = new Set(), blocks = [];
  let offset = 0;
  for (const block of source.blocks) {
    if (!block || typeof block.id !== 'string' || !block.id || ids.has(block.id) || typeof block.text !== 'string'
      || !['text', 'code'].includes(block.kind)) return empty;
    ids.add(block.id); blocks.push({ ...block, start: offset, end: offset + block.text.length }); offset += block.text.length;
  }
  if (blocks.map(block => block.text).join('') !== source.text) return empty;
  const roles = new Set(['result', 'risk', 'decision', 'evidence', 'next', 'detail']);
  const plain = value => value && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
  const validReading = value => plain(value) && Object.keys(value).every(key => ['blockId', 'role', 'importance', 'relatedRefs'].includes(key))
    && ids.has(value.blockId) && roles.has(value.role) && [1, 2, 3].includes(value.importance) && Array.isArray(value.relatedRefs)
    && value.relatedRefs.length <= 16 && value.relatedRefs.every(ref => typeof ref === 'string' && ids.has(ref));
  const reading = new Map(), repeated = new Set();
  if (result?.schemaVersion === 2 && Array.isArray(result.reading) && result.reading.length <= 256) {
    for (const value of result.reading) {
      if (plain(value) && ids.has(value.blockId)) {
        if (reading.has(value.blockId) || repeated.has(value.blockId)) { reading.delete(value.blockId); repeated.add(value.blockId); continue; }
        if (validReading(value)) reading.set(value.blockId, value);
        else repeated.add(value.blockId);
      }
    }
  }
  const byId = new Map(blocks.map(block => [block.id, block])), marked = new Map();
  const annotationRoles = { conclusion: 'result', risk: 'risk', evidence: 'evidence', next: 'next' };
  const roleOrder = { risk: 0, decision: 1, result: 2, next: 3, evidence: 4 };
  for (const value of result?.schemaVersion === 2 && Array.isArray(result.annotations) ? result.annotations.slice(0, 72) : []) {
    const block = byId.get(value?.blockId), role = annotationRoles[value?.kind], quote = value?.quote;
    if (!block || block.kind === 'code' || !role || typeof quote !== 'string' || quote.length < 4 || ![1, 2, 3].includes(value.importance)) continue;
    const at = source.text.indexOf(quote);
    if (at < block.start || at + quote.length > block.end || source.text.indexOf(quote, at + 1) !== -1
      || (value.start !== undefined && value.start !== at) || (value.end !== undefined && value.end !== at + quote.length)) continue;
    const previous = marked.get(block.id);
    if (!previous || roleOrder[role] < roleOrder[previous.role]) marked.set(block.id, { role, importance: value.importance });
  }
  const caveats = new Set(source.caveatRefs.filter(id => ids.has(id)));
  // These are keep guards, not assertions that a failure occurred or a decision is still pending.
  // Match actual conditions and polarity phrases, not individual Chinese
  // characters in neutral words such as 不同、未来、需求、无缝 or 刚才.
  const condition = /风险|限制|注意|尚未|必须|需要|仅(?:在|限|有|供|当|对|用于|支持|适用|涉及|提供|处理|完成|修改|包含|保留|允许|执行|验证|测试|覆盖|表示|代表|说明|进行|使用|本|这|仅)|只有|除非|否则|前提|条件|依赖|仍(?:需|未|不)|可能|失败|警告|建议|后续|下一步|手动|人工|审批|批准|确保|以免|避免|直到|才(?:能|可|会|算|允许|执行|生效)|取决于|是否|要不要|选哪|哪个方案|以上|以下|至少|至多|大于|小于|[<>]=|[≥≤]|(?:^|[，。；：\s])若|如果|假如|假设|在[^。\n]{0,60}(?:环境|范围|平台|版本)|(?:当|等到|一旦)[^。\n]{0,80}(?:时|后|才|再)|(?:完成|成功|确认|通过|满足|就绪|重启|恢复|加载|连接|保存|读取|安装|生成|结束|打开|更新|迁移|启动|登录)[^。\n]{0,12}(?:后|前|时)(?:才|再|可|能|需|会|不|请|应|执行|重试|继续)|待(?:确认|验证|测试|处理|完善|实现|检查|审批|批准|发布|接入|用户|修复|解决|完成|补充|部署)|需(?:确认|提供|保证|满足|先|等|由|用|在|获|重|手动|另行|核对|通过|准备|安装)|\b(?:if|unless|only|except|without|not|never|must|should|required?|requires?|assuming|depends?|dependent|cannot|pending|unverified|untested|unknown|may|might|risk|limitation|caveat|prerequisite|warning|failed|failure|remaining|missing)\b/iu;
  const polarity = /不(?!同|一样|过(?!期|关)|但|仅|光(?!滑)|妨|错(?!过)|约而同|知不觉|由自主|好意思)|未(?!来|央)|无(?!缝|论|数|聊|与伦比)|没(?!关系|事|想到)|需(?!求)|仅|仍/u;
  const englishCondition = /\b(?:no|none|provided|until|when|whenever|once|before|after)\b|\b(?:subject\s+to|as\s+long\s+as|depending\s+on|in\s+case|on\s+condition|in\s+the\s+event|at\s+least|at\s+most|no\s+(?:more|less)\s+than|or\s+(?:higher|lower|above|below|newer|older))\b|\b(?:can|won|shouldn|isn|wasn)['’]t\b/iu;
  const riskSignal = /风险|限制|尚未|未验证|未测试|未覆盖|未上线|待验证|不支持|无法|不保证|前提|仅在|只有|除非|否则|必须|取决于|失败|警告|至少|至多|以上|以下|[<>]=|[≥≤]|如果|假如|假设|在[^。\n]{0,100}(?:环境|范围|平台|版本)[^。\n]{0,40}才|\b(?:risk|limitations?|caveats?|prerequisites?|warnings?|failed|failure|unverified|untested|unsupported|unavailable|cannot|unless|only|assuming|depends?|requires?)\b|\bnot\s+(?:yet\s+)?(?:supported|tested|verified|covered|guaranteed)\b/iu;
  const completedDecision = /无需|不需|不用|不必|已(?:经)?确认|确认(?:完成|通过)|\balready\s+(?:confirmed|approved|decided)|\bno\s+(?:confirmation|approval|decision)\s+(?:is\s+)?(?:needed|required)|\bdoes\s+not\s+require\b/iu;
  const decision = /(?:请|需要|需|等待|待)[^。\n]{0,24}(?:你|用户)[^。\n]{0,24}(?:确认|决定|选择|批准)|(?:请|需要|需|待)(?:确认|决定|选择|批准)|\b(?:please\s+confirm|your\s+(?:decision|approval)|awaiting\s+(?:your\s+)?(?:confirmation|approval)|choose\s+(?:between|one)|decide\s+whether|approval\s+required)\b/iu;
  const riskHeading = /风险|限制|前提|条件|注意|边界|兼容|提醒|未完成|未验证|待验证|待确认|待办|运行环境|系统要求|适用范围|支持范围|使用条件|\b(?:risk|limitations?|caveats?|warnings?|prerequisites?|known\s+issues|remaining|pending|todo|open\s+questions|system\s+requirements|supported\s+platforms|environment)\b/iu;
  const continuation = /^(?:但|不过|然而|否则|其中|同时|另外|此外|上述|前述|该项|这项|此项|相应|适用|部署|上线|使用|满足|前提|only\b|however\b|otherwise\b|provided\b|subject\b)/iu;
  const headingStack = [];
  const protectedRefs = new Set();
  for (const value of reading.values()) for (const ref of value.relatedRefs) protectedRefs.add(ref);
  // Only a whole, simple paragraph can map to one native <p>. Complex Markdown stays visible.
  const paragraphText = block => {
    if (block.kind !== 'text') return null;
    const original = block.text.replace(/\r\n?/g, '\n');
    if (/^(?: {4}|\t)\S/mu.test(original)) return null;
    let text = original.trim();
    if (!text || /\n\s*\n/u.test(text) || /^ {0,3}(?:#{1,6}[ \t]|>|[-+*][ \t]|\d+[.)][ \t]|`{3,}|~{3,}|(?:[-*_][ \t]*){3,}$)/mu.test(text)
      || /^(?: {4}|\t)/mu.test(text) || /[|<>\[\]\\$\uE000\uE001]/u.test(text)
      || /&(?:#[xX][\da-f]+|#\d+|[a-z][a-z\d]+);/iu.test(text) || /\n {0,3}(?:=+|-+)[ \t]*$/u.test(text)) return null;
    const code = [];
    text = text.replace(/`([^`\n]+)`/gu, (_, value) => {
      const literal = value.startsWith(' ') && value.endsWith(' ') && value.trim() ? value.slice(1, -1) : value;
      code.push(literal); return '\uE000' + (code.length - 1) + '\uE001';
    });
    text = text.replace(/\*\*([^*\n]+)\*\*/gu, '$1').replace(/__([^_\n]+)__/gu, '$1')
      .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/gu, '$1').replace(/(?<!_)_([^_\n]+)_(?!_)/gu, '$1');
    if (/[*_`~]/u.test(text)) return null;
    return text.replace(/\uE000(\d+)\uE001/gu, (_, index) => code[Number(index)]).replace(/\s+/gu, ' ').trim();
  };
  const entries = blocks.map(block => {
    const raw = block.text.trim(), lines = raw.split(/\r?\n/u);
    let heading = false;
    if (block.kind === 'text') for (let index = 0; index < lines.length; index++) {
      const atx = /^ {0,3}(#{1,6})[ \t]+(.*)$/u.exec(lines[index]);
      const setext = index + 1 < lines.length && /^ {0,3}(=+|-+)[ \t]*$/u.exec(lines[index + 1]);
      if (!atx && !setext) continue;
      heading = true;
      const level = atx ? atx[1].length : setext[1][0] === '=' ? 1 : 2;
      const text = atx ? atx[2] : lines[index];
      while (headingStack.length && headingStack.at(-1).level >= level) headingStack.pop();
      headingStack.push({ level, guarded: riskHeading.test(text) });
      if (setext) index++;
    }
    const chosen = reading.get(block.id), annotation = marked.get(block.id);
    const localDecision = block.kind === 'text' && !completedDecision.test(raw) && decision.test(raw);
    const localCondition = block.kind === 'text' && (caveats.has(block.id) || condition.test(raw) || polarity.test(raw) || englishCondition.test(raw) || completedDecision.test(raw));
    const localRisk = block.kind === 'text' && riskSignal.test(raw);
    const guardedSection = headingStack.some(value => value.guarded);
    let role = block.kind === 'code' ? 'unknown' : localDecision ? 'decision' : localRisk || guardedSection ? 'risk'
      : annotation?.role ?? chosen?.role ?? 'unknown';
    if (role === 'decision' && completedDecision.test(raw)) role = 'unknown';
    const importance = Math.min(chosen?.importance ?? 3, annotation?.importance ?? 3,
      localCondition || localDecision || guardedSection ? 1 : 3);
    const matchText = paragraphText(block);
    const reason = localDecision ? 'decision' : localRisk || guardedSection ? 'risk' : localCondition ? 'condition'
      : protectedRefs.has(block.id) ? 'related-context' : annotation ? 'marked' : heading || matchText === null ? 'structure'
        : !chosen ? 'unknown' : chosen.role !== 'detail' || chosen.importance !== 3 ? 'important' : 'detail';
    const foldable = reason === 'detail' && role === 'detail' && importance === 3;
    return { blockId: block.id, start: block.start, end: block.end, role, importance, keep: !foldable, foldable, matchText, reason };
  });
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (!entry.foldable || !continuation.test(blocks[index].text.trim())) continue;
    if ([entries[index - 1], entries[index + 1]].some(other => other && ['result', 'risk', 'decision', 'evidence', 'next'].includes(other.role))) {
      Object.assign(entry, { keep: true, foldable: false, reason: 'adjacent-context' });
    }
  }
  const matches = new Map();
  for (const entry of entries) if (entry.matchText) matches.set(entry.matchText, (matches.get(entry.matchText) ?? 0) + 1);
  for (const entry of entries) if (entry.foldable && matches.get(entry.matchText) > 1)
    Object.assign(entry, { keep: true, foldable: false, reason: 'ambiguous-paragraph' });
  const opening = entries.find(entry => entry.matchText !== null);
  if (opening?.foldable) Object.assign(opening, { keep: true, foldable: false, reason: 'opening-context' });
  const navigation = entries.filter(entry => ['result', 'risk', 'decision', 'evidence', 'next'].includes(entry.role)).map(entry => ({
    kind: entry.role, blockId: entry.blockId,
    label: (entry.matchText ?? byId.get(entry.blockId).text.trim().replace(/^ {0,3}#{1,6}[ \t]+/u, '')).slice(0, 96),
  }));
  return { sourceHash: source.hash, entries, navigation };
}
    // END GENERATED REPORT READING

    // BEGIN GENERATED REPORT THEME
    function createReportTheme(theme = 'system', appearance = 'light') {
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
    // END GENERATED REPORT THEME

    /**
     * Bumped whenever the client changes shape.
     *
     * Sent on load and on the first render, so "is the page running the code I
     * just installed?" is answerable instead of assumed. A stale bundle and a
     * broken one look identical otherwise.
     */
    // BEGIN GENERATED CHAT PALETTE
    function createChatPalette() {
  const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
  const wrap=value=>(value%360+360)%360;
  const distance=(a,b)=>Math.min(Math.abs(a-b),360-Math.abs(a-b));
  const hash=value=>{let result=2166136261;for(let i=0;i<value.length;i++)result=Math.imul(result^value.charCodeAt(i),16777619);return result>>>0;};
  const builtins={ '大肥鱼（默认）':{h:222,s:58,offset:-4},'鲸鲸（实验性）':{h:205,s:52,offset:-18},
    '大肥龙':{h:255,s:44,offset:-14},'Claude小姐':{h:25,s:62,offset:0},Gemini:{h:280,s:56,offset:24} };
  function dominant(pixels) {
    if(!pixels||pixels.length<4||pixels.length%4||pixels.length>128*128*4)return null;
    const bins=Array.from({length:24},()=>({weight:0,x:0,y:0,s:0}));
    for(let at=0;at<pixels.length;at+=4){
      const r=pixels[at]/255,g=pixels[at+1]/255,b=pixels[at+2]/255,a=pixels[at+3]/255;
      if(![r,g,b,a].every(Number.isFinite)||a<.5)continue;
      const max=Math.max(r,g,b),min=Math.min(r,g,b),delta=max-min,l=(max+min)/2;
      if(delta<.055||l<.1||l>.93)continue;
      const s=delta/(1-Math.abs(2*l-1));if(s<.12)continue;
      let h=max===r?((g-b)/delta)%6:max===g?(b-r)/delta+2:(r-g)/delta+4;h=wrap(h*60);
      const skin=h<52&&l>.62&&r>g&&g>b&&g-b<.2,weight=a*(.2+s*s)*(skin?0.25:1);
      const bin=bins[Math.round(h/15)%24];bin.weight+=weight;bin.x+=Math.cos(h*Math.PI/180)*weight;
      bin.y+=Math.sin(h*Math.PI/180)*weight;bin.s+=s*weight;
    }
    const best=bins.reduce((a,b)=>a.weight>=b.weight?a:b);if(best.weight<1)return null;
    return{h:Math.round(wrap(Math.atan2(best.y,best.x)*180/Math.PI)),s:Math.round(clamp(best.s/best.weight*100,30,68))};
  }
  function allocate(people) {
    const tones=new Map(),used=[];
    const members=(Array.isArray(people)?people:[]).filter((person,index,all)=>typeof person?.id==='string'&&person.id.length<=200
      &&all.findIndex(other=>other?.id===person.id)===index).slice(0,64).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
    for(const person of members){
      const seed=hash(person.id),builtin=Object.hasOwn(builtins,person.id)?builtins[person.id]:null;
      const sampled=person.color&&Number.isFinite(person.color.h)&&Number.isFinite(person.color.s)?person.color:null;
      const base=sampled??builtin??{h:210+seed%65,s:38},offset=sampled?(builtin?.offset??seed%17-8):0;
      const desired=wrap(base.h+offset),s=Math.round(clamp(base.s,44,66)),gap=members.length<=6?14:10;
      let h=desired;
      for(const step of [0,-1,1,-2,2,-3,3,-4,4,-5,5]){
        const candidate=wrap(desired+step*gap);if(used.every(other=>distance(candidate,other)>=gap)){h=candidate;break;}
      }
      used.push(h);tones.set(person.id,{h:Math.round(h),s});
    }
    return tones;
  }
  const style=tone=>tone?{'--chat-persona-color':`hsl(${wrap(tone.h)} ${clamp(tone.s,44,66)}% 48%)`}:undefined;
  return{dominant,allocate,style};
}
    // END GENERATED CHAT PALETTE

const CLIENT_BUILD = 2026111201;

    // --- host data -----------------------------------------------------------

    /** sessionId → newest state payload from the host half. */
    const states = new Map();
    let hostInstance;
    let requestSequence = 0;
    let instanceRequestFloor = 0;
    let controlRevision = -1;
    let clientStopped = false;
    const retiredInstances = new Set();

    /** Instance changes replace the baseline; late replies cannot resurrect it. */
    function acceptInstance(value, request) {
      const instance = value?.instanceId;
      if (typeof instance !== 'string' || instance === '') return hostInstance === undefined;
      if (instance === hostInstance) return true;
      if (retiredInstances.has(instance) || request < instanceRequestFloor) return false;
      if (hostInstance !== undefined) retiredInstances.add(hostInstance);
      hostInstance = instance;
      instanceRequestFloor = request;
      states.clear();
      freshDecided.clear();
      branchHistory.clear();
      sessionSwitchRev = -1;
      controlRevision = -1;
      switchReady = false;
      sessionOff.clear();
      return true;
    }
    /**
     * Cache key for one row.
     *
     * `seq` is only unique inside a session, so keying these maps by `seq` alone
     * let session A's verdict about `seq: 1` be reused for session B's unrelated
     * `seq: 1` — a step could be treated as history in a session that had just
     * created it.
     */
    const rowKey = (sessionId, seq) => `${sessionId}:${seq}`;
    /** `${sessionId}:${seq}` → last rendered branch, for spotting a visible flash. */
    const branchHistory = new Map();
    /** `${sessionId}:${seq}` → whether the step was new when first seen. */
    const freshDecided = new Map();
    /** `${sessionId}:${seq}` → this step was rendered while it was running. */
    const liveSeen = new Set();
    /** `${sessionId}:${seq}` → the branch sequence, capped. */
    const diagnosticsTrail = new Map();
    const listeners = new Set();
    /** `${sessionId}` → poll handle, so several steps share one timer. */
    const pollers = new Map();
    const stateSubscriptions = new Set();
    let stateTransport;

    function syncSubscription(entry) {
      const status = stateTransport?.status(entry.sessionId);
      if (status === 'ready' || status === 'blocked') {
        entry.poll?.(); entry.poll = undefined;
      } else if (!entry.poll) entry.poll = watchPolling(entry.sessionId, entry.seq);
    }

    function watch(sessionId, seq) {
      const entry = { sessionId, seq };
      stateSubscriptions.add(entry);
      entry.remote = stateTransport?.subscribe(sessionId);
      syncSubscription(entry);
      return () => {
        stateSubscriptions.delete(entry);
        entry.poll?.(); entry.remote?.();
      };
    }

    /**
     * Per-session switch overrides. Only an explicit `false` is kept; a missing
     * entry means "follow the global switch", which keeps old sessions on.
     */
    const sessionOff = new Map();
    /** Monotonic map revision, matching the Host's answer. */
    let sessionSwitchRev = -1;
    /** Whether the first switch map has arrived; before that the UI is pending. */
    let switchReady = false;
    /** Listeners for components showing one session's switch. */
    const switchListeners = new Set();
    /** Last confirmed value of the global switch; false until the Host answers. */
    let globalEnabled = false;
    let progressEnabled = false;
    const PROGRESS_WATCH = -1;
    const PROGRESS_PREFIX = '◈';
    const progressViewerId = `persona-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    let progressViewRevision = 0;
    let progressViewerSession;
    /** Listeners for the global-switch state (the session switch respects it). */
    const globalListeners = new Set();

    function emit() {
      for (const listener of listeners) listener();
    }

    /** How long the Host may hold a state request before answering "no change". */
    const STATE_WAIT_MS = 15000;
    /** Backoff cap after a failed state request. */
    const STATE_ERROR_MAX_MS = 8000;

    /** An AbortError is the expected result of waking a held request. */
    function isAbortError(error) {
      return error !== null && typeof error === 'object' && error.name === 'AbortError';
    }

    /**
     * Read one session's state, optionally as a long-poll.
     *
     * `rev` is the revision the page already has. With `wait`, the Host holds
     * the request until a `touch()` moves that revision or the budget expires,
     * so a rewrite lands as soon as it moves instead of on a fixed cadence.
     * @param {string} sessionId
     * @param {{ rev?: number, wait?: number, signal?: AbortSignal }} [options]
     * @returns {Promise<{ ok: boolean, aborted?: boolean }>}
     */
    async function refresh(sessionId, options = {}) {
      const request = ++requestSequence;
      const { rev, wait, signal } = options;
      const query = new URLSearchParams({ session: sessionId });
      if (progressViewerSession === sessionId && (typeof document === 'undefined' || document.visibilityState !== 'hidden')) {
        query.set('viewing', '1'); query.set('viewer', progressViewerId); query.set('viewRev', String(progressViewRevision));
      }
      if (rev !== undefined) query.set('rev', String(rev));
      if (wait !== undefined) query.set('wait', String(wait));
      try {
        const response = await fetch(
          `${ROUTE}/state?${query.toString()}`,
          signal === undefined ? undefined : { signal },
        );
        if (!response.ok) {
          // Only failures are reported. A rejected fetch is the difference
          // between "no data yet" and "the route refuses this request", and it
          // is the one case with no other symptom — the transcript just stays
          // plain. Successes would be a write per poll for no extra insight.
          reportDiagnostics({ lastFetchError: { status: response.status, at: Date.now() } });
          return { ok: false };
        }
        const value = await response.json();
        if (clientStopped || signal?.aborted || !acceptInstance(value, request)) return { ok: true };
        applyState(sessionId, value);
        return { ok: true };
      } catch (error) {
        if (isAbortError(error)) return { ok: false, aborted: true };
        reportDiagnostics({
          lastFetchError: { error: error instanceof Error ? error.message : String(error), at: Date.now() },
        });
        return { ok: false };
      }
    }

    function applyState(sessionId, value) {
        const previous = states.get(sessionId);
        // A stale response must not overwrite a newer snapshot; the same rev can
        // still carry a meaningful switch-readiness transition after storage opens.
        if (previous !== undefined && Number.isFinite(previous.rev)
          && Number.isFinite(value?.rev) && value.rev < previous.rev) return;
        const changed = previous === undefined
          || previous.rev !== value?.rev
          || previous.sessionEnabled !== value?.sessionEnabled
          || previous.switchesReady !== value?.switchesReady
          || previous.settings?.enabled !== value?.settings?.enabled;
        states.set(sessionId, value);
        if (changed) emit();
    }

    /**
     * Keep one session's rewrites fresh with a long-poll loop.
     *
     * One poller per session, tracking every seq that asked for it. The previous
     * design asked on a fixed 100/300/6000ms cadence: a rewrite could finish just
     * after a poll and land in the visible jump the plugin exists to avoid. The
     * Host now holds the request open until something changes, and the client
     * immediately reissues it, so the loop only spends requests when there is
     * news (and still works through the Desktop IPC fetch carrier, unlike an
     * EventSource).
     */
    function watchPolling(sessionId, seq) {
      const key = sessionId;
      let poller = pollers.get(key);
      if (poller === undefined) {
        /** seq → subscriber count. Refcounted because several rows share a session. */
        const watched = new Map();
        let stopped = false;
        /** The single pending timer, or undefined when a request is in flight. */
        let timer;
        /** Whether a request is running. At most one, always. */
        let inFlight = false;
        /** Set when a sooner wake arrived while a request was running. */
        let wakePending = false;
        /** The AbortController of the request in flight, when the page has one. */
        let controller;
        let failures = 0;
        const canAbort = typeof AbortController === 'function';

        /** Schedule the next request, never creating a second timer. */
        const schedule = (delay) => {
          if (stopped) return;
          if (inFlight) {
            // A sooner wake arrived: abort the held request so a new row does
            // not wait out the Host's hold window.
            wakePending = true;
            if (delay === 0 && controller !== undefined) controller.abort();
            return;
          }
          if (timer !== undefined) clearTimeout(timer);
          timer = setTimeout(tick, delay);
        };

        /** Stop this poller and release its held request. */
        const stop = () => {
          stopped = true;
          if (timer !== undefined) clearTimeout(timer);
          if (controller !== undefined) controller.abort();
          pollers.delete(key);
        };

        const tick = async () => {
          timer = undefined;
          if (stopped) return;
          if (watched.size === 0) {
            // Nothing needs this session any more; release the poller.
            stop();
            return;
          }
          inFlight = true;
          controller = canAbort ? new AbortController() : undefined;
          // A held request that never settles would freeze this session's view
          // forever. The Host's own wait is 15s; abort a little later.
          const watchdog = canAbort
            ? setTimeout(() => { if (controller !== undefined) controller.abort(); }, STATE_WAIT_MS + 5000)
            : undefined;
          const currentRev = states.get(sessionId)?.rev;
          const knownRev = typeof currentRev === 'number';
          const started = Date.now();
          const result = await refresh(sessionId, {
            rev: knownRev ? currentRev : undefined,
            // No known revision means there is nothing to compare yet; fetch the
            // first state directly instead of asking the Host to hold. Without
            // AbortController a held request cannot be woken early, so use a
            // shorter hold instead of leaving a new row waiting 15s.
            wait: knownRev ? (canAbort ? STATE_WAIT_MS : 3000) : 0,
            signal: controller === undefined ? undefined : controller.signal,
          });
          if (watchdog !== undefined) clearTimeout(watchdog);
          inFlight = false;
          controller = undefined;
          if (stopped) return;
          if (result.aborted) {
            if (wakePending) {
              wakePending = false;
              schedule(0);
            } else {
              // Timeout/connection abort: retry, but do not spin.
              schedule(1000);
            }
            return;
          }
          if (result.ok) {
            failures = 0;
            wakePending = false;
            const afterRev = states.get(sessionId)?.rev;
            // A Host that does not implement `wait` answers immediately with the
            // same revision; do not turn that into a busy loop.
            const held = Date.now() - started > 200;
            schedule(afterRev !== currentRev || held ? 0 : 500);
            return;
          }
          failures += 1;
          schedule(Math.min(STATE_ERROR_MAX_MS, 500 * 2 ** Math.min(failures, 4)));
        };

        poller = {
          add(candidate) {
            if (typeof candidate !== 'number') return () => {};
            // Refcount, not a Set of ids.
            //
            // Two subscribers can watch the same seq — the shipped chat renders
            // one assistant node for both its reasoning and response partitions,
            // and this entry is asked about both. With a Set, the first unmount
            // removed the id and stopped polling while the other subscriber was
            // still displaying it.
            const next = (watched.get(candidate) ?? 0) + 1;
            watched.set(candidate, next);
            // A newly watched row must not wait behind the current hold.
            schedule(0);
            let released = false;
            return () => {
              if (released) return;
              released = true;
              const remaining = (watched.get(candidate) ?? 1) - 1;
              if (remaining <= 0) watched.delete(candidate);
              else watched.set(candidate, remaining);
              if (watched.size === 0) stop();
            };
          },
          /** Host-side teardown path: stop the held request and its timer. */
          stop,
        };
        pollers.set(key, poller);
      }
      return poller.add(seq);
    }

    // --- session-level switch -------------------------------------------------

    /** Installed by apply(); recomputes the chat takeover from both switches. */
    let refreshChatTakeover = () => {};

    function refreshTakeover() {
      refreshChatTakeover();
    }

    /**
     * Whether the page-level chat takeover should be installed.
     *
     * Registration is page-wide because `conversation.chat.node` is a keyed slot;
     * the Web UI shows one Session at a time, so gating on the active Session is
     * what makes "off" mean the official renderer comes back in full.
     */
    function chatTakeoverEnabled(global, sessionId, off) {
      return global === true && (sessionId === undefined || off.get(sessionId) !== false);
    }

    /** The Session whose header switch is currently mounted. */
    let activeSessionId;

    function setActiveSession(sessionId) {
      if (activeSessionId === sessionId) return;
      activeSessionId = sessionId;
      if (chatRuntime.opened && usableSessionId(sessionId)) chatRuntime.foreground(sessionId);
      // Warm the state cache before the chat rows mount. The header switch often
      // mounts first; this removes the cold-state gap for restored conversations.
      if (usableSessionId(sessionId)) void refresh(sessionId);
      refreshTakeover();
    }

    /** Update the client copy of the per-session switch map. */
    function applySessionSwitches(payload, request = ++requestSequence) {
      if (payload === null || typeof payload !== 'object') return;
      if (!acceptInstance(payload, request)) return;
      const rev = Number.isInteger(payload.rev) ? payload.rev : 0;
      // A settings poll that started before a newer toggle reply must not undo
      // the answer: the switch revision is monotonic on the Host.
      if (rev < sessionSwitchRev) return;
      sessionSwitchRev = rev;
      switchReady = true;
      sessionOff.clear();
      const values = payload.values !== null && typeof payload.values === 'object' ? payload.values : {};
      for (const [sessionId, value] of Object.entries(values)) {
        if (value === false) sessionOff.set(sessionId, false);
      }
      for (const listener of switchListeners) listener();
      refreshTakeover();
    }

    function applyControls(value, request) {
      if (!acceptInstance(value?.sessionSwitches ?? value, request)) return false;
      const rev = value.controlRev ?? value.rev;
      if (Number.isFinite(rev)) {
        if (rev < controlRevision) return false;
        controlRevision = rev;
      }
      if (typeof value.settings?.enabled === 'boolean') setGlobalEnabled(value.settings.enabled);
      setProgressEnabled(value.settings?.progressNotices === true);
      if (value.switchesReady !== false) applySessionSwitches(value.sessionSwitches, request);
      return true;
    }

    function useSessionSwitch(sessionId) {
      const [version, setVersion] = React.useState(0);
      React.useEffect(() => {
        const listener = () => setVersion((value) => value + 1);
        switchListeners.add(listener);
        return () => switchListeners.delete(listener);
      }, []);
      return sessionOff.get(sessionId) !== false;
    }

    function useSwitchReady() {
      const [version, setVersion] = React.useState(0);
      React.useEffect(() => {
        const listener = () => setVersion((value) => value + 1);
        switchListeners.add(listener);
        return () => switchListeners.delete(listener);
      }, []);
      return switchReady;
    }

    function useGlobalEnabled() {
      const [version, setVersion] = React.useState(0);
      React.useEffect(() => {
        const listener = () => setVersion((value) => value + 1);
        globalListeners.add(listener);
        return () => globalListeners.delete(listener);
      }, []);
      return globalEnabled;
    }

    function setGlobalEnabled(value) {
      if (globalEnabled === value) return;
      globalEnabled = value;
      for (const listener of globalListeners) listener();
      refreshTakeover();
    }

    function setProgressEnabled(value) {
      if (progressEnabled === value) return;
      progressEnabled = value;
      for (const listener of globalListeners) listener();
    }

    /** Explicit view changes release leases; existing long-polls renew them. */
    function announceProgressView(sessionId) {
      progressViewerSession = sessionId;
      progressViewRevision += 1;
      const visible = usableSessionId(sessionId) && (typeof document === 'undefined' || document.visibilityState !== 'hidden');
      stateTransport?.setView({ sessionId, revision: progressViewRevision, visible });
      // The legacy route also releases any lease left by a fallback generation.
      void fetch(`${ROUTE}/progress-view`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ viewer: progressViewerId, revision: progressViewRevision, visible,
          sessionId: visible ? sessionId : undefined }),
      }).catch(() => {});
    }

    /** A separate composer-dock status, never a synthetic assistant message. */
    function ProgressNotice({ sessionId, t }) {
      const master = useGlobalEnabled();
      const sessionOn = useSessionSwitch(sessionId);
      const enabled = master && progressEnabled && sessionOn;
      const [visible, setVisible] = React.useState(typeof document === 'undefined' || document.visibilityState !== 'hidden');
      React.useEffect(() => {
        if (!enabled || !usableSessionId(sessionId)) return undefined;
        const update = () => {
          const shown = typeof document === 'undefined' || document.visibilityState !== 'hidden';
          setVisible(shown);
          announceProgressView(shown ? sessionId : undefined);
        };
        update();
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', update);
        return () => {
          if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', update);
          // Do not let an old Session's cleanup release a newer Session's lease.
          if (progressViewerSession === sessionId) announceProgressView(undefined);
        };
      }, [sessionId, enabled]);
      // This subscriber exists even before the first assistant node is committed.
      const { state } = useHostState(sessionId, enabled && visible ? PROGRESS_WATCH : undefined);
      const notice = enabled && visible && state?.settings?.progressNotices === true
        && state?.settings?.enabled !== false && state?.sessionEnabled !== false ? state?.progress : undefined;
      if (typeof notice?.text !== 'string' || notice.text === '') return null;
      const label = shellTranslate(t)('shell.progressNotice') ?? '静默状态播报（插件生成，不是主模型消息）';
      return h('div', {
        'data-persona-shell': 'progress', role: 'status', 'aria-live': 'polite', 'aria-atomic': true, 'aria-label': label,
        style: { display: 'flex', gap: '8px', padding: '8px 12px', minWidth: 0, maxWidth: '100%',
          color: 'var(--dsw-alias-label-secondary)', background: 'var(--dsw-alias-bg-layer-2)',
          borderRadius: '8px', fontSize: '13px', lineHeight: '1.6', overflowWrap: 'anywhere' },
      }, h('span', { 'aria-hidden': true, title: `${label}\n${notice.source ?? ''}`,
        style: { color: 'var(--dsw-alias-brand-primary)', flex: 'none', cursor: 'help' } }, PROGRESS_PREFIX),
      h('span', { style: { minWidth: 0, whiteSpace: 'pre-wrap' } }, notice.text));
    }

    /**
     * The per-session switch in the conversation header.
     *
     * It also tells the controller which Session is on screen: the chat
     * takeover is page-wide, so "this session is off" is implemented by
     * releasing it while that Session is viewed, which gives the official
     * renderer back in full (reasoning, images, interrupted/running states).
     */
    function SessionPersonaSwitch({ sessionId, t, useInput, inputActions, useSessions }) {
      const enabled = useSessionSwitch(sessionId);
      const ready = useSwitchReady();
      const global = useGlobalEnabled();
      const [pending, setPending] = React.useState(false);
      const [failed, setFailed] = React.useState(false);
      const [panel, setPanel] = React.useState(false);
      const { state } = useHostState(sessionId, -2);
      const conversation = state?.conversation;

      useLayoutEffect(() => {
        if (typeof sessionId !== 'string') return undefined;
        setActiveSession(sessionId);
        return () => setActiveSession(undefined);
      }, [sessionId]);
      const toggle = async () => {
        if (pending || global !== true || typeof sessionId !== 'string') return;
        setPending(true);
        setFailed(false);
        const request = ++requestSequence;
        try {
          const response = await fetch(`${ROUTE}/session-switch`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId, enabled: !enabled }),
          });
          if (!response.ok) throw new Error(String(response.status));
          const value = await response.json();
          applySessionSwitches(value?.sessionSwitches, request);
        } catch {
          setFailed(true);
        } finally {
          setPending(false);
        }
      };

      const label = t?.('shell.personaSwitch') ?? '人格';
      const stateText = !ready
        ? '…'
        : pending
          ? '…'
          : enabled
            ? (t?.('shell.personaSwitchOn') ?? '开')
            : (t?.('shell.personaSwitchOff') ?? '关');
      const title = !ready
        ? (t?.('shell.personaSwitchLoading') ?? '正在读取会话开关')
        : global !== true
          ? (t?.('shell.personaSwitchGlobalOff') ?? '总开关已关闭')
          : failed
            ? (t?.('shell.personaSwitchFailed') ?? '保存失败')
            : (t?.('shell.personaSwitchHint') ?? '仅对当前会话生效');

      return h(React.Fragment, null, h(WorkInputBridge,{sessionId,useInput,inputActions,useSessions}),h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': enabled,
        title,
        disabled: !ready || pending || global !== true,
        onClick: toggle,
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          gap: '4px',
          height: '24px',
          padding: '0 8px',
          borderRadius: '999px',
          border: `0.5px solid ${enabled ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l2)'}`,
          background: enabled ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
          color: failed
            ? 'var(--dsw-alias-state-error-primary)'
            : enabled
              ? 'var(--dsw-alias-brand-primary)'
              : 'var(--dsw-alias-label-tertiary)',
          fontSize: '12px',
          lineHeight: '1',
          cursor: pending || global !== true ? 'default' : 'pointer',
          opacity: pending ? 0.6 : 1,
        },
      }, h('span', null, label), h('span', null, stateText)),
      h('button', { type: 'button', onClick: () => setPanel(true), style: headerButtonStyle,
        'aria-haspopup': 'dialog', title: '设置当前会话的人格、转述范围与接力' },
        '会话设置'),
      panel ? h(ConversationPanel, { key: sessionId, sessionId, conversation, onClose: () => setPanel(false) }) : null,
      h(PersonaChatLauncher, { sessionId, conversation }));
    }

    const chatDrafts = new Map();
    const chatWorkDrafts = new Map();
    const workInputBindings = new Map(), workInputListeners = new Set();
    const notifyWorkInput = () => { for(const update of workInputListeners)update(); };
    function WorkInputBridge(props){
      return typeof props.useInput==='function'&&typeof props.inputActions?.captureInsertion==='function'&&typeof props.inputActions?.insertText==='function'
        ?typeof props.useSessions==='function'?h(NamedWorkInput,props):h(BoundWorkInput,props):null;
    }
    function NamedWorkInput(props){const title=props.useSessions(list=>list.byId[props.sessionId]?.displayTitle??'');return h(BoundWorkInput,{...props,title});}
    function BoundWorkInput({sessionId,useInput,inputActions,title}){
      const state=useInput(value=>value),own=React.useMemo(()=>({actions:inputActions,state:null}),[sessionId,inputActions]);
      own.state=state;own.title=title;
      useLayoutEffect(()=>{if(typeof sessionId!=='string')return;workInputBindings.set(sessionId,own);notifyWorkInput();
        return()=>{if(workInputBindings.get(sessionId)===own){workInputBindings.delete(sessionId);notifyWorkInput();}};},[sessionId,own]);
      useLayoutEffect(notifyWorkInput,[state,title]);
      return null;
    }
    const chatRoomLayout = { wide:false, composeExpanded:false };
    const chatRetryIds = new Map();
    const chatAnimatedAttempts = new Set();
    const markChatAnimation=id=>{chatAnimatedAttempts.add(id);while(chatAnimatedAttempts.size>200)chatAnimatedAttempts.delete(chatAnimatedAttempts.values().next().value);};
    const chatLaunchListeners = new Set();
    const floatingDocks=new Set();
    function layoutFloatingDocks(){
      const gap=7;
      const nodes=[...floatingDocks].filter(node=>node.isConnected).sort((a,b)=>(Number(a.dataset.dockOrder)||0)-(Number(b.dataset.dockOrder)||0));
      let bottom=0;
      for(const node of nodes){
        const height=node.offsetHeight;
        node.style.right='max(16px, env(safe-area-inset-right))';
        node.style.bottom='calc(max(16px, env(safe-area-inset-bottom)) + '+bottom+'px)';
        bottom+=height+gap;
      }
    }
    function useFloatingDock(ref,active){
      useLayoutEffect(()=>{
        const node=ref.current;if(!active||!node)return;
        floatingDocks.add(node);layoutFloatingDocks();
        const observer=typeof ResizeObserver==='function'?new ResizeObserver(layoutFloatingDocks):null;observer?.observe(node);
        if(floatingDocks.size===1)window.addEventListener('resize',layoutFloatingDocks);
        return()=>{observer?.disconnect();floatingDocks.delete(node);if(!floatingDocks.size)window.removeEventListener('resize',layoutFloatingDocks);layoutFloatingDocks();};
      },[active]);
    }
    const chatUpdates = new Set();
    const chatProfileUpdates = new Set();
    const chatUserAddressState={draft:null,saving:false,notice:''},chatUserAddressListeners=new Set();
    let chatUserAddressDraftVersion=0;
    const userAddressProblem=value=>/[\p{Cc}\p{Cs}\u2028\u2029\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\u200b\u2060\ufeff]/u.test(value)
      ?'称呼不能包含换行、控制字符或不可见字符。':Array.from(value.trim()).length>40?'最多 40 个字符，复杂表情可能占多个字符。':'';
    const notifyUserAddress=()=>{for(const update of chatUserAddressListeners)update();};
    const chatPersonaChoices = new Map();
    let chatContextCache;
    let chatForegroundSession;
    const chatForegroundListeners = new Set();
    let chatSurfaceMotion;
    const chatMotionReduced=()=>typeof window.matchMedia==='function'&&window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const cancelChatMotion=()=>chatSurfaceMotion?.cancel();
    // Only browser snapshots move. The actual view, source lease and focus settle in the update callback.
    function changeChatSurface(update,kind){
      cancelChatMotion();
      let applied=false;
      const commit=()=>{if(applied)return;applied=true;if(typeof flushChatSync==='function')flushChatSync(update);else update();};
      if(typeof document.startViewTransition!=='function'||typeof flushChatSync!=='function'||chatMotionReduced()
        ||document.visibilityState==='hidden'||document.activeViewTransition){commit();return;}
      const root=document.documentElement,previous=root.getAttribute('data-dsh-chat-motion');
      const preference=typeof window.matchMedia==='function'?window.matchMedia('(prefers-reduced-motion: reduce)'):null;
      const motion={transition:null,cancel:null};let timer;
      const cleanup=()=>{
        clearTimeout(timer);preference?.removeEventListener?.('change',skip);document.removeEventListener('visibilitychange',visibility);
        if(chatSurfaceMotion!==motion)return;chatSurfaceMotion=undefined;
        if(previous===null)root.removeAttribute('data-dsh-chat-motion');else root.setAttribute('data-dsh-chat-motion',previous);
      };
      const skip=()=>{try{motion.transition?.skipTransition();}catch{/* The real view must still settle. */}commit();cleanup();};
      const visibility=()=>{if(document.visibilityState==='hidden')skip();};
      motion.cancel=skip;chatSurfaceMotion=motion;root.setAttribute('data-dsh-chat-motion',kind);
      try{
        motion.transition=document.startViewTransition(commit);
        Promise.resolve(motion.transition.ready).catch(()=>{});
        Promise.resolve(motion.transition.updateCallbackDone).catch(()=>{commit();});
        Promise.resolve(motion.transition.finished).catch(()=>{}).finally(()=>{commit();cleanup();});
        preference?.addEventListener?.('change',skip,{once:true});document.addEventListener('visibilitychange',visibility);
        timer=setTimeout(skip,1000);
      }catch{commit();cleanup();}
    }
    function enterChatSurface(node){
      if(!node||chatSurfaceMotion||document.activeViewTransition||chatMotionReduced()||document.visibilityState==='hidden'||typeof node.animate!=='function')return;
      const dock=node.classList.contains('dsh-persona-chat-dock');
      try{const animation=node.animate([{opacity:0,transform:dock?'translateY(5px) scale(.94)':'translateY(9px) scale(.985)'},
          {opacity:1,transform:'none'}],{duration:dock?160:190,easing:'cubic-bezier(.2,.8,.2,1)'});
        const preference=typeof window.matchMedia==='function'?window.matchMedia('(prefers-reduced-motion: reduce)'):null;
        const detach=()=>preference?.removeEventListener?.('change',cancel);
        const cancel=()=>{animation.cancel();detach();};
        preference?.addEventListener?.('change',cancel,{once:true});
        Promise.resolve(animation.finished).catch(()=>{}).finally(detach);
        return cancel;
      }catch{/* Animation support must not affect the window's controls. */}
    }
    const chatRuntime = {
      opened: false, minimized: false, root: undefined, container: undefined, motionStyle:undefined, revision:0,sessionId: undefined, conversation: undefined, focusAt: 0,
      setMinimized(value) {
        if (!this.opened || this.minimized===value) return;
        this.minimized=value;const revision=++this.revision;
        changeChatSurface(()=>{if(!this.opened||this.revision!==revision)return;for(const update of chatLaunchListeners)update();},value?'minimize':'restore');
      },
      foreground(sessionId) {
        if (!sessionId) return;
        const changed = chatForegroundSession!==sessionId; chatForegroundSession=sessionId;
        if (changed) for (const update of chatForegroundListeners) update();
        if (!this.opened || this.minimized || document.visibilityState==='hidden' || !chatContextCache?.initialized || (!changed && Date.now()-this.focusAt<5000)) return;
        this.focusAt=Date.now();
        void fetch(ROUTE+'/chat-context',{method:'POST',headers:{'content-type':'application/json'},
          body:JSON.stringify({action:'focus',roomId:chatContextCache.roomId,sessionId,viewer:'foreground'})}).catch(()=>{});
      },
      open(sessionId,conversation) {
        reportReadingRuntime.minimize();
        this.foreground(sessionId);
        if (!this.root) {
          if (typeof createChatRoot!=='function') throw Error('当前客户端暂不支持独立聊天室，请升级 DSH。');
          this.container=document.createElement('div');this.container.dataset.personaShell='chat-runtime';document.body.appendChild(this.container);
          this.root=createChatRoot(this.container);
          this.motionStyle=document.createElement('style');this.motionStyle.dataset.personaShell='chat-motion';
          this.motionStyle.textContent=CHAT_MOTION_CSS;document.head.appendChild(this.motionStyle);
        }
        if (this.opened) { if(this.minimized)this.setMinimized(false);else document.getElementById('dsh-persona-chat-input')?.focus();return; }
        const revision=++this.revision;cancelChatMotion();this.opened=true;this.minimized=false;
        if (!this.sessionId) {this.sessionId=sessionId;this.conversation=conversation;}
        this.root.render(h(RoomChatWorkspace,{sessionId:chatForegroundSession??this.sessionId,conversation:this.conversation,onClose:()=>this.close()}));
        for(const update of chatLaunchListeners)update();
        requestAnimationFrame(()=>{if(this.opened&&!this.minimized&&this.revision===revision)document.getElementById('dsh-persona-chat-input')?.focus({preventScroll:true});});
      },
      close() {for(const flush of chatUiFlushers.values())flush();this.opened=false;this.minimized=false;const revision=++this.revision;
        changeChatSurface(()=>{if(this.revision!==revision||this.opened)return;this.root?.render(null);chatAnimatedAttempts.clear();for(const update of chatLaunchListeners)update();},'close');},
      dispose() {this.revision++;this.opened=false;this.minimized=false;cancelChatMotion();this.root?.unmount();this.container?.remove();this.motionStyle?.remove();this.motionStyle=undefined;this.root=undefined;this.container=undefined;this.sessionId=undefined;this.conversation=undefined;chatContextCache=undefined;window.removeEventListener?.('storage',chatUiStorageEvent);},
    };
    const chatNonce = () => window.crypto?.randomUUID?.() ?? `chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const emptyChatDraft = () => ({ text: '', requestId: chatNonce() });
    const chatUi = new Map(),chatUiListeners=new Set(),chatUiDurableDrafts=new Map(),chatUiDirtyDrafts=new Map(),chatUiIssues=new Map(),chatUiFlushers=new Map();
    let chatUiNamespace,chatUiInstance,chatUiScope,chatUiReadFailed=false;
    const chatUiIssue=(id,text)=>{if((chatUiIssues.get(id)??'')===text)return;if(text)chatUiIssues.set(id,text);else chatUiIssues.delete(id);
      Promise.resolve().then(()=>{for(const notify of chatUiListeners)notify();});};
    const chatUiId=value=>typeof value==='string'&&value.length>0&&value.length<=200;
    const chatUiNumber=value=>Number.isSafeInteger(value)&&value>=0?value:0;
    const chatUiKey=()=>chatUiNamespace?'dsh-persona-shell:room-ui:v1:'+chatUiNamespace:null;
    const chatUiQuote=value=>value&&chatUiId(value.roomId)&&['user','assistant'].includes(value.kind)
      ?{roomId:value.roomId,generation:chatUiNumber(value.generation),kind:value.kind,
        ...(value.kind==='user'&&chatUiId(value.messageId)?{messageId:value.messageId}:{}),
        ...(value.kind==='assistant'&&chatUiId(value.turnId)&&chatUiId(value.attemptId)&&Number.isInteger(value.index)&&value.index>=0&&value.index<6
          ?{turnId:value.turnId,attemptId:value.attemptId,index:value.index}:{})}:null;
    function normalizeChatUi(value){
      if(!value||typeof value!=='object')return null;
      const text=typeof value.draft?.text==='string'&&value.draft.text.length<=4000?value.draft.text:'';
      const position=value.reading,anchor=position?.anchor;
      return{generation:chatUiNumber(value.generation),scopeKey:typeof value.scopeKey==='string'?value.scopeKey.slice(0,200):null,
        draft:{text,requestId:chatUiId(value.draft?.requestId)?value.draft.requestId:chatNonce(),quoteRef:chatUiQuote(value.draft?.quoteRef)},
        selection:{start:Math.min(text.length,chatUiNumber(value.selection?.start)),end:Math.min(text.length,chatUiNumber(value.selection?.end))},
        reading:position&&typeof position==='object'?{atBottom:position.atBottom!==false,scrollTop:Math.max(0,Math.min(1000000,Number(position.scrollTop)||0)),
          anchor:anchor&&chatUiId(anchor.turnId)&&['user','assistant'].includes(anchor.kind)?{turnId:anchor.turnId,kind:anchor.kind,index:Math.min(5,chatUiNumber(anchor.index)),
            ...(anchor.kind==='user'&&chatUiId(anchor.messageId)?{messageId:anchor.messageId}:{})}:null,
          offset:Number.isFinite(position.offset)?Math.max(-100000,Math.min(100000,position.offset)):0,
          known:(Array.isArray(position.known)?position.known:[]).filter(chatUiId).slice(-256)}:null,
        visitedAt:chatUiNumber(value.visitedAt),updatedAt:chatUiNumber(value.updatedAt)};
    }
    function readChatUiStorage(){
      chatUiReadFailed=false;
      try{const raw=localStorage.getItem(chatUiKey());if(!raw)return{};if(raw.length>800000){chatUiReadFailed=true;return{};}const value=JSON.parse(raw);
        if(value?.version!==1||!value.rooms||typeof value.rooms!=='object'){chatUiReadFailed=true;return{};}
        return Object.fromEntries(Object.entries(value.rooms).filter(([id])=>chatUiId(id)).slice(-32).map(([id,record])=>[id,normalizeChatUi(record)]).filter(([,record])=>record));
      }catch{chatUiReadFailed=true;return{};}
    }
    function persistChatUi(id,patch,expectedDraft,explicitDraft=false){
      if(!chatUiKey())return;
      try{const rooms=readChatUiStorage(),old=rooms[id];
        if(chatUiReadFailed){chatUiIssue(id,'暂时无法读取本地草稿存储，当前输入仍保留在此页。');return;}
        const cached=chatUi.get(id),dirty=chatUiDirtyDrafts.get(id);
        if(dirty&&old&&old.generation>cached.generation){chatUiDirtyDrafts.delete(id);chatUi.set(id,old);chatDrafts.delete(id);return old;}
        if(dirty&&!explicitDraft&&old&&old.draft.requestId!==chatUiDurableDrafts.get(id)&&old.draft.requestId!==dirty){
          chatUiIssue(id,'另一页面也修改了草稿。本页未保存的输入已保留，请先核对再继续。');return;}
        if(!old&&!Object.hasOwn(patch,'draft')&&chatUiDurableDrafts.has(id)&&!dirty){
          chatUi.delete(id);chatDrafts.delete(id);chatWorkDrafts.delete(id);chatUiDurableDrafts.delete(id);return null;
        }
        const next={...(old??cached),...patch,updatedAt:Date.now()};
        if(dirty&&!explicitDraft&&cached?.draft.requestId===dirty)next.draft=cached.draft;
        if(expectedDraft&&old?.draft?.requestId!==expectedDraft){delete next.draft;next.draft=old?.draft??chatUi.get(id)?.draft;}
        rooms[id]=normalizeChatUi(next);
        const entries=Object.entries(rooms).filter(([,record])=>record).sort((a,b)=>b[1].updatedAt-a[1].updatedAt).slice(0,32);
        localStorage.setItem(chatUiKey(),JSON.stringify({version:1,rooms:Object.fromEntries(entries)}));
        chatUiDurableDrafts.set(id,rooms[id].draft.requestId);if(chatUiDirtyDrafts.get(id)===rooms[id].draft.requestId)chatUiDirtyDrafts.delete(id);chatUiIssue(id,'');return rooms[id];
      }catch{chatUiIssue(id,'本地草稿暂未保存，当前输入仍保留在此页。');}
    }
    function updateChatUi(id,patch,expectedDraft,explicitDraft=false){
      if(!chatUiId(id))return;
      const old=chatUi.get(id)??normalizeChatUi({draft:chatDrafts.get(id)}),next=normalizeChatUi({...old,...patch,updatedAt:Date.now()});
      chatUi.set(id,next);while(chatUi.size>32)chatUi.delete([...chatUi].sort((a,b)=>a[1].updatedAt-b[1].updatedAt)[0][0]);
      const persisted=persistChatUi(id,patch,expectedDraft,explicitDraft);if(persisted)chatUi.set(id,persisted);
    }
    function saveChatDraft(id,draft,expectedDraft,room,scopeKey){
      if(expectedDraft&&chatUiDirtyDrafts.has(id)&&chatUiDirtyDrafts.get(id)!==expectedDraft)return room?restoreChatUi(room,scopeKey):chatDrafts.get(id);
      if(expectedDraft&&chatUiKey()){
        const stored=readChatUiStorage()[id];
        if(stored?.draft?.requestId&&stored.draft.requestId!==expectedDraft){chatUi.set(id,stored);
          const other={text:stored.draft.text,requestId:stored.draft.requestId};chatDrafts.set(id,other);return room?restoreChatUi(room,scopeKey):other;}
      }
      if(!expectedDraft)chatUiDirtyDrafts.set(id,draft.requestId);
      keepDraft(chatDrafts,id,draft);updateChatUi(id,{draft:{text:draft.text,requestId:draft.requestId,quoteRef:draft.quote?.ref??null}},expectedDraft,!expectedDraft);return draft;
    }
    function clearChatUi(id){
      chatDrafts.delete(id);chatWorkDrafts.delete(id);chatUi.delete(id);chatUiDurableDrafts.delete(id);chatUiDirtyDrafts.delete(id);chatUiIssues.delete(id);
      if(chatUiKey())try{const rooms=readChatUiStorage();if(chatUiReadFailed)return;delete rooms[id];localStorage.setItem(chatUiKey(),JSON.stringify({version:1,rooms}));}catch{}
    }
    const chatUiStorageEvent=event=>{
      if(event.key!==chatUiKey()||!chatUiKey())return;
      const rooms=readChatUiStorage();if(chatUiReadFailed)return;let oldRooms={};try{oldRooms=JSON.parse(event.oldValue??'null')?.rooms??{};}catch{}
      for(const[id,record]of Object.entries(oldRooms))if(!rooms[id]){
        const local=chatUi.get(id);
        if(local&&!chatUiDirtyDrafts.has(id)&&local.updatedAt<=(record?.updatedAt??0)&&local.draft.requestId===record?.draft?.requestId){chatUi.delete(id);chatDrafts.delete(id);chatWorkDrafts.delete(id);chatUiDurableDrafts.delete(id);}
      }
      for(const[id,record]of Object.entries(rooms)){
        const local=chatUi.get(id),dirty=chatUiDirtyDrafts.get(id);
        if(local&&record.generation>local.generation){chatUiDirtyDrafts.delete(id);chatDrafts.delete(id);chatUi.set(id,record);continue;}
        if(dirty&&record.draft.requestId!==dirty){chatUiIssue(id,'另一页面也修改了草稿。本页未保存的输入已保留，请先核对再继续。');continue;}
        if(!local||record.updatedAt>=local.updatedAt)chatUi.set(id,record);
      }
      for(const notify of chatUiListeners)notify();
    };
    function useChatUiNamespace(value,instance){
      const changedInstance=chatUiInstance!==undefined&&chatUiInstance!==instance;
      chatUiInstance=instance;
      if(!chatUiId(value)){
        if(changedInstance){chatUi.clear();chatDrafts.clear();chatWorkDrafts.clear();chatUiDurableDrafts.clear();chatUiDirtyDrafts.clear();chatUiIssues.clear();chatUiScope=undefined;}
        chatUiNamespace=undefined;window.removeEventListener?.('storage',chatUiStorageEvent);return;
      }
      if(value===chatUiNamespace)return;
      if(chatUiScope&&chatUiScope!==value||changedInstance&&chatUiScope!==value){chatUi.clear();chatDrafts.clear();chatWorkDrafts.clear();chatUiDurableDrafts.clear();chatUiDirtyDrafts.clear();chatUiIssues.clear();}
      chatUiNamespace=value;chatUiScope=value;
      for(const[id,record]of Object.entries(readChatUiStorage())){chatUiDurableDrafts.set(id,record.draft.requestId);if((chatUi.get(id)?.updatedAt??0)<=record.updatedAt)chatUi.set(id,record);}
      window.removeEventListener?.('storage',chatUiStorageEvent);window.addEventListener?.('storage',chatUiStorageEvent);
    }
    function restoreChatUi(room,scopeKey){
      if(!room)return;
      let record=chatUi.get(room.id);
      if(record&&record.generation>(room.generation??0)){const empty=emptyChatDraft();chatDrafts.set(room.id,empty);return empty;}
      if(record&&record.generation!==(room.generation??0)){clearChatUi(room.id);record=null;}
      if(!record){updateChatUi(room.id,{generation:room.generation??0,scopeKey:scopeKey??null});record=chatUi.get(room.id)??normalizeChatUi({generation:room.generation??0,scopeKey});chatUi.set(room.id,record);}
      let quote;
      if(record.scopeKey===(scopeKey??null)&&record.draft.quoteRef){const source=chatQuotedSource(room,record.draft.quoteRef,scopeKey??null);
        if(source)quote={ref:record.draft.quoteRef,text:source.text,author:record.draft.quoteRef.kind==='user'?{role:'user',name:'我'}
          :{role:'assistant',id:source.turn.recipientId,name:source.turn.speakerName}};}
      const current=chatDrafts.get(room.id),draft={text:record.draft.text,requestId:record.draft.requestId,...(quote?{quote}:{})};
      if(!current||current.requestId!==draft.requestId||!!current.quote!==!!draft.quote)chatDrafts.set(room.id,draft);
      if(record.scopeKey!==(scopeKey??null)||!!record.draft.quoteRef!==!!quote)updateChatUi(room.id,{scopeKey:scopeKey??null,draft:{...record.draft,quoteRef:quote?.ref??null}});
      return chatDrafts.get(room.id);
    }
    const chatErrorText = (code) => ({
      'storage-not-ready': '聊天记录暂时无法保存，请稍后重试。输入仍保留。',
      'chat-save-failed': '保存没有完成，请重试。输入仍保留。',
      'chat-conflict': '聊天记录刚有更新，已重新读取，请核对后再操作。',
      'chat-id-conflict': '这条消息已提交过不同内容，请重新编辑后发送。',
      'chat-busy': '这位角色还在回复，可以先写下一条，或停止这次回复。',
      'chat-context-changed': '参考来源已变化，请核对来源后重新发送。输入仍保留。',
      'chat-context-unsaved': '参考来源还未保存，请打开来源面板刷新后重试。消息仍保留。',
      'context-not-open': '参考服务尚未连接，请打开参考来源后重试。输入仍保留。',
      'chat-capacity': '已达到 32 个聊天室上限，请在房间资料中删除不再需要的聊天室。',
      'chat-primary-limit': '每条消息最多 @ 两位主讲。先取消一位，即可换人。',
      'chat-legacy-mentions': '这条消息点名的人数超过房间上限，请重新选择回复对象。',
      'chat-quote-unavailable':'引用的消息已更改或不在当前参考范围，请取消引用或重新选择。输入仍保留。',
      'persona-not-found': '这位角色已经移除，保留的记录仍可查看。',
      'chat-room-not-found': '这个聊天室已移除，请重新选择或新建。',
      'chat-recipient-not-member': '这位角色已不在房间中，请重新选择回复对象。',
      'invalid-chat-members': '每个聊天室需要 1–8 位不同的人格。',
    }[code] ?? '暂时没有连接成功，输入仍保留，可以稍后重试。');
    const DIRECTOR_ISSUE_REASONS=Object.freeze({
      'wire-type':'调度返回类型不符合要求','wire-size':'调度结果超过长度上限',control:'调度返回的选项格式未能识别',scene:'话题关联选项未通过校验',contribution:'本次接话方向未能确认',json:'调度结果不是完整的 JSON',
      'duplicate-key':'调度结果包含重复字段',shape:'调度结果结构不符合要求',choice:'所选接话项不在本次候选中',
      goal:'接话目标未能识别',actor:'接话角色不在本次候选中',event:'所选发言不在本次对话范围',
      evidence:'接话依据未能对应原话','stale-event':'所选原话已经处理或不再适用',author:'接话对象与原话作者未能对应',
      'normal-ineligible':'该角色当前没有普通接话机会','peer-ineligible':'该角色当前没有同伴接话机会',
      'peer-call':'尚不能确认这次是对她的直接邀请','non-stop':'调度回复未完整结束','too-long':'调度结果超过长度上限',
      'tool-call':'调度返回了不支持的工具请求',
    });
    const chatDirectorIssueReason=issue=>{
      if(typeof issue?.reason==='string'&&Object.hasOwn(DIRECTOR_ISSUE_REASONS,issue.reason))return DIRECTOR_ISSUE_REASONS[issue.reason];
      const defaults={invalid:'接话安排未通过校验',timeout:'调度判断超时',unavailable:'调度调用暂不可用'};
      return typeof issue?.code==='string'&&Object.hasOwn(defaults,issue.code)?defaults[issue.code]:'调度未完成';
    };
    const chatReplyStateText = (turn, running) => turn.status === 'pending' && running ? '输入中…' : ({
      format: '回复格式暂未识别，消息已保留，可以重试。',
      'too-long': '回复过长，未保存不完整内容，可以重试。',
      length: '模型回复达到长度限制，消息已保留，可以重试。',
      timeout: '回复超时，消息已保留，可以重试。',
      unavailable: '聊天模型暂不可用，请检查聊天室模型设置。',
      auth: '模型认证或访问权限未通过，请检查提供方设置。',
      'rate-limit': '模型调用较频繁，请稍后重试。',
      network: '连接模型时中断，消息已保留，可以重试。',
      model: '模型调用未成功，消息已保留，可以重试。',
      incomplete: '模型回复未正常结束，消息已保留，可以重试。',
      'source-changed': '参考来源已更新，旧回复已停止。',
      'persona-changed': '人格设定已更新，旧回复已停止。',
      'memory-changed': '记忆偏好已更新，旧回复已停止。',
      'member-removed':'原回复对象已移出聊天室，回复已停止。',
      save: '回复保存未完成，消息已保留，可以重试。',
    }[turn.failure] ?? (turn.status === 'cancelled' ? '回复已停止' : '上次回复未完成，消息已保留'));
    const CHAT_MOTION_CSS = `
      .dsh-persona-chat,.dsh-persona-chat-dock{transform-origin:bottom right}
      html[data-dsh-chat-motion] :is(.dsh-persona-chat,.dsh-persona-chat-dock){view-transition-name:dsh-persona-chat-surface}
      html[data-dsh-chat-motion]{view-transition-name:none}
      html[data-dsh-chat-motion]::view-transition{pointer-events:none}
      html[data-dsh-chat-motion]::view-transition-group(*){animation-duration:0s}
      html[data-dsh-chat-motion]::view-transition-old(*),html[data-dsh-chat-motion]::view-transition-new(*){animation:none;mix-blend-mode:normal}
      html[data-dsh-chat-motion]::view-transition-group(dsh-persona-chat-surface){animation-duration:240ms;animation-timing-function:cubic-bezier(.22,.8,.2,1);overflow:hidden;border-radius:16px}
      html[data-dsh-chat-motion]::view-transition-image-pair(dsh-persona-chat-surface){isolation:isolate}
      html[data-dsh-chat-motion]::view-transition-old(dsh-persona-chat-surface){animation:dsh-chat-surface-out 140ms ease-out both}
      html[data-dsh-chat-motion]::view-transition-new(dsh-persona-chat-surface){animation:dsh-chat-surface-in 200ms 35ms ease-out both}
      @keyframes dsh-chat-surface-out{to{opacity:0}}
      @keyframes dsh-chat-surface-in{from{opacity:0}}
      @keyframes dsh-chat-panel-in{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:none}}
      @keyframes dsh-chat-message-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
      .dsh-persona-chat{transition:width 210ms cubic-bezier(.2,.8,.2,1),height 210ms cubic-bezier(.2,.8,.2,1)}
      .dsh-persona-chat .dsh-persona-chat-compose textarea{transition:height 190ms ease,border-color 120ms ease,box-shadow 120ms ease}
      .dsh-persona-chat :is(button,select):not(:where(.dsh-persona-chat-body *)),.dsh-persona-chat-dock button{transition:background-color 120ms ease,border-color 120ms ease,color 120ms ease,box-shadow 120ms ease,opacity 120ms ease}
      .dsh-persona-chat :is(.dsh-persona-work-draft,.dsh-persona-chat-room-panel,.dsh-persona-chat-appearance,.dsh-persona-chat-sources),.dsh-persona-chat-info[role=group]{animation:dsh-chat-panel-in 160ms ease-out}
      .dsh-persona-chat-message[data-arriving=true],.dsh-persona-chat-typing{animation:dsh-chat-message-in 170ms ease-out}
      @media(prefers-reduced-motion:reduce){
        .dsh-persona-chat,.dsh-persona-chat-dock,.dsh-persona-chat :is(button,select,textarea):not(:where(.dsh-persona-chat-body *)),.dsh-persona-chat-dock button{transition:none!important}
        .dsh-persona-chat :is(.dsh-persona-work-draft,.dsh-persona-chat-room-panel,.dsh-persona-chat-appearance,.dsh-persona-chat-sources,.dsh-persona-chat-info,.dsh-persona-chat-message){animation:none!important}
        html[data-dsh-chat-motion]::view-transition-group(*),html[data-dsh-chat-motion]::view-transition-old(*),html[data-dsh-chat-motion]::view-transition-new(*){animation:none!important}
      }
    `;
    const CHAT_CSS = `
      .dsh-persona-chat-message[data-chat-persona]>.dsh-persona-chat-bubble{background:color-mix(in srgb,var(--chat-persona-color,var(--chat-brand)) 12%,var(--chat-bg));border-color:color-mix(in srgb,var(--chat-persona-color,var(--chat-brand)) 25%,var(--chat-border))}
      .dsh-persona-chat-message[data-chat-persona] .dsh-persona-chat-speaker{color:color-mix(in srgb,var(--chat-text) 65%,var(--chat-persona-color,var(--chat-brand)))}
      .dsh-persona-chat{--chat-bg:var(--dsw-alias-bg-layer-1,#fff);--chat-soft:var(--dsw-alias-bg-layer-2,#f3f5f8);--chat-border:var(--dsw-alias-border-l1,#d6dfe9);--chat-text:var(--dsw-alias-label-primary,#203044);--chat-muted:var(--dsw-alias-label-secondary,#65758a);--chat-brand:var(--dsw-alias-brand-primary,#3976c3);position:fixed;right:20px;bottom:20px;width:min(430px,calc(100vw - 32px));height:min(650px,calc(100dvh - 40px));z-index:1100;display:flex;flex-direction:column;min-width:0;border:1px solid var(--chat-border);border-radius:16px;background:var(--chat-bg);color:var(--chat-text);box-shadow:0 18px 70px #0003;font:14px/1.65 system-ui,sans-serif;overflow:hidden}
      .dsh-persona-chat[data-wide=true]{width:min(740px,calc(100vw - 32px));height:min(780px,calc(100dvh - 40px))}
      .dsh-persona-chat-sources{max-height:36%;overflow:auto;flex:none}.dsh-persona-chat-sources p{font-size:11px;margin:8px 0}.dsh-persona-chat-sources button{font-size:11px;min-height:26px;padding:2px 7px}.dsh-persona-source-item{display:flex;align-items:center;gap:8px;margin:7px 0}.dsh-persona-source-item>span{flex:1;min-width:0;overflow-wrap:anywhere}.dsh-persona-chat-source-actions{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0}.dsh-persona-chat-source-actions select{min-width:0;max-width:100%;font-size:12px;border:1px solid var(--chat-border);border-radius:6px;background:var(--chat-bg);padding:5px}.dsh-persona-context-notices{flex:none;max-height:20%;overflow:auto;padding:8px 14px;border-bottom:1px solid var(--chat-border);font-size:12px}.dsh-persona-context-notices summary{cursor:pointer}
      /* The room owns its controls; MarkdownText owns the controls inside a reply. */
      .dsh-persona-chat :not(:where(.dsh-persona-chat-body *)){box-sizing:border-box}
      .dsh-persona-chat :is(button,select,textarea):not(:where(.dsh-persona-chat-body *)){font:inherit;color:inherit}
      .dsh-persona-chat button:not(:where(.dsh-persona-chat-body *)){cursor:pointer;border:1px solid var(--chat-border);border-radius:7px;background:var(--chat-bg);padding:5px 10px;min-height:32px}
      .dsh-persona-chat button:not(:where(.dsh-persona-chat-body *)):disabled{opacity:.5;cursor:default}
      .dsh-persona-chat :is(button,select,textarea):not(:where(.dsh-persona-chat-body *)):focus-visible{outline:2px solid var(--chat-brand);outline-offset:2px}
      .dsh-persona-chat-top{flex:none;min-height:64px;height:auto;margin:0;transform:none;overflow:visible;display:flex;align-items:center;gap:10px;padding:13px 15px;border-bottom:1px solid var(--chat-border);background:var(--chat-bg)}.dsh-persona-chat-title{min-width:0;flex:1}.dsh-persona-chat-title strong{display:block;font-size:14px}.dsh-persona-chat-title small{display:block;color:var(--chat-muted);font-size:11px}.dsh-persona-chat-top button{padding:3px 8px;font-size:12px}
      .dsh-persona-chat select:not(:where(.dsh-persona-chat-body *)){max-width:100%;min-width:0;border:0;border-radius:5px;background:var(--chat-soft);padding:3px 5px;font-size:13px}
      .dsh-persona-chat-avatar{flex:none;display:grid;place-items:center;width:32px;height:32px;border-radius:10px;background:var(--chat-soft);border:1px solid var(--chat-border);font-size:13px;font-weight:600}.dsh-persona-chat-top>.dsh-persona-chat-avatar{color:var(--chat-brand);width:36px;height:36px}
      .dsh-persona-chat-avatar-spacer{display:block;flex:none;width:32px;height:32px}.dsh-persona-chat-message[data-chat-continuation=true]{margin-top:-6px}
      .dsh-persona-chat-input-state{display:flex;align-items:center;justify-content:flex-end;flex-wrap:wrap;gap:7px;margin:-5px 0 13px;font-size:10px;line-height:1.6;color:var(--chat-muted)}.dsh-persona-chat-input-state button{font-size:10px!important;min-height:24px!important;padding:1px 7px!important}
      .dsh-persona-chat-thread{position:relative;min-height:0;flex:1;overflow:auto;overscroll-behavior:contain;padding:16px 14px;background:var(--chat-soft);scroll-padding:14px}.dsh-persona-chat-time{text-align:center;font-size:10px;color:var(--chat-muted);margin:0 0 14px}.dsh-persona-chat-message{display:flex;align-items:flex-start;gap:8px;margin:0 0 12px}.dsh-persona-chat-message[data-user=true]{flex-direction:row-reverse}.dsh-persona-chat-bubble{max-width:calc(100% - 48px);white-space:pre-wrap;overflow-wrap:anywhere;background:var(--chat-bg);border:1px solid var(--chat-border);border-radius:3px 12px 12px;padding:9px 12px}.dsh-persona-chat-message[data-user=true]>.dsh-persona-chat-bubble{background:var(--chat-brand);color:#fff;border-color:transparent;border-radius:12px 3px 12px 12px}.dsh-persona-chat-turn-state{font-size:11px;color:var(--chat-muted);text-align:right;margin:-5px 0 14px}.dsh-persona-chat-turn-state button{font-size:11px;padding:2px 8px;min-height:26px;margin-left:8px}
      .dsh-persona-chat-empty{height:100%;min-height:150px;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;color:var(--chat-muted);gap:8px;padding:18px}.dsh-persona-chat-empty strong{font-size:15px;color:var(--chat-text)}.dsh-persona-chat-empty p{margin:0;font-size:12px;max-width:270px}.dsh-persona-chat-compose{flex:none;padding:12px 14px;background:var(--chat-bg);border:0}.dsh-persona-chat-compose textarea{display:block;width:100%;min-height:70px;max-height:140px;resize:vertical;border:0;outline:0;background:transparent;line-height:1.65;padding:2px;color:var(--chat-text)}.dsh-persona-chat-compose-row{margin-top:6px;display:flex;align-items:center;justify-content:space-between;gap:10px}.dsh-persona-chat-compose-row small{font-size:10px;color:var(--chat-muted)}.dsh-persona-chat-compose button[data-primary]{background:var(--chat-brand);color:#fff;border-color:transparent;min-width:68px}.dsh-persona-chat-info{flex:none;font-size:11px;color:var(--chat-muted);padding:7px 14px;border-bottom:1px solid var(--chat-border);overflow-wrap:anywhere}.dsh-persona-chat-info button{font-size:11px;min-height:25px;margin-left:6px}
      .dsh-persona-chat-suggest{padding-bottom:8px;margin-bottom:7px;border-bottom:1px solid var(--chat-border)}.dsh-persona-chat-suggest-head{display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:11px}.dsh-persona-chat-suggest-head label{display:flex;align-items:center;gap:5px}.dsh-persona-chat-suggest-head button{font-size:11px;min-height:28px;padding:3px 8px}.dsh-persona-chat-suggest small{display:block;font-size:10px;color:var(--chat-muted);margin:5px 0}.dsh-persona-chat-suggestions{max-height:155px;overflow:auto;display:grid;gap:5px}.dsh-persona-chat-suggestions button{font-size:12px;text-align:left;white-space:pre-wrap;overflow-wrap:anywhere;background:var(--chat-soft)}
      @media(max-width:520px){.dsh-persona-chat,.dsh-persona-chat[data-wide=true]{right:8px;bottom:max(8px,env(safe-area-inset-bottom));width:calc(100vw - 16px);height:calc(100dvh - 24px);border-radius:12px}.dsh-persona-chat-top{padding:10px}.dsh-persona-chat-compose-row small{max-width:200px}.dsh-persona-chat-top button{font-size:11px;padding:3px 6px}}
      .dsh-persona-chat{--chat-brand:#4f6cdb}.dsh-persona-chat-top{display:grid;grid-template-columns:36px minmax(0,1fr) repeat(4,auto);gap:9px}.dsh-persona-chat-title{display:contents}.dsh-persona-chat-title strong{grid-column:2;grid-row:1}.dsh-persona-chat-title select{grid-column:1/-1;grid-row:2;width:100%;padding:7px 9px;background:var(--chat-soft);border:1px solid var(--chat-border);border-radius:7px}.dsh-persona-chat-top>.dsh-persona-chat-avatar{grid-column:1;grid-row:1}.dsh-persona-chat-top>button{grid-row:1}
      .dsh-persona-chat-compose textarea{padding:9px 10px;border:1px solid var(--chat-border);border-radius:9px;background:var(--chat-soft);font-size:13px;box-shadow:none}.dsh-persona-chat-compose textarea:focus-visible{outline:none!important;border-color:#7890e8;box-shadow:0 0 0 2px #7185e520}
      .dsh-persona-chat-thread-wrap{position:relative;min-height:0;flex:1;display:flex;overflow:hidden}
      /* Sticky code banners belong to the scrolling messages, below room panels and the jump button. */
      .dsh-persona-chat-thread{isolation:isolate;min-width:0;width:100%}
      .dsh-persona-chat .dsh-persona-chat-quote-action{align-self:center;flex:none;width:22px;min-height:24px;padding:0;border:0;background:transparent;color:var(--chat-muted);font-size:15px;opacity:0;pointer-events:none}
      .dsh-persona-chat-message:has(>.dsh-persona-chat-quote-action)>.dsh-persona-chat-bubble{max-width:calc(100% - 70px)}
      .dsh-persona-chat-message:hover>.dsh-persona-chat-quote-action,.dsh-persona-chat-message:focus-within>.dsh-persona-chat-quote-action{opacity:1;pointer-events:auto}
      .dsh-persona-chat-quote{display:flex;align-items:flex-start;gap:8px;border-inline-start:2px solid currentColor;padding:4px 8px;margin:2px 0 7px;min-width:0;opacity:.9;font-size:11px;line-height:1.5;white-space:normal}
      .dsh-persona-chat-quote>div{flex:1;min-width:0}.dsh-persona-chat-quote strong{display:block;font-size:10px}.dsh-persona-chat-quote-text{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere;white-space:pre-wrap}.dsh-persona-chat-quote[data-expanded=true] .dsh-persona-chat-quote-text{display:block;max-height:min(160px,22dvh);overflow:auto;overscroll-behavior:contain}.dsh-persona-chat-quote small{display:block;margin-top:3px}.dsh-persona-chat-quote-heading{display:flex;align-items:center;justify-content:space-between;gap:8px}.dsh-persona-chat-quote>.dsh-persona-chat-quote-actions{display:flex;align-items:center;gap:3px;flex:none}
      .dsh-persona-chat .dsh-persona-chat-quote button{flex:none;min-height:22px;min-width:22px;padding:0 4px;border:0;background:transparent;color:inherit}
      .dsh-persona-chat-quote[data-draft=true]{flex:none;margin:0;padding:6px 9px;border-color:var(--chat-brand);border-radius:3px;background:var(--chat-soft);color:var(--chat-muted)}
      .dsh-persona-chat-quoted-highlight{outline:2px solid var(--chat-brand);outline-offset:3px;border-radius:10px}
      @media(hover:none){.dsh-persona-chat .dsh-persona-chat-quote-action{opacity:.65;pointer-events:auto}}
      .dsh-persona-chat-bubble{min-width:0;font-family:inherit;line-height:1.7}.dsh-persona-chat-body{white-space:normal;font:var(--dsw-font-markdown-base,inherit);line-height:1.7;min-width:0;max-width:100%;overflow-wrap:anywhere}.dsh-persona-chat-body>div{margin-block:0}.dsh-persona-chat-body :is(p,ul,ol,blockquote,pre):first-child{margin-top:0}.dsh-persona-chat-body :is(p,ul,ol,blockquote,pre):last-child{margin-bottom:0}.dsh-persona-chat-body pre{max-width:100%;overflow-x:auto}.dsh-persona-chat-body table{max-width:100%}.dsh-persona-chat-body img{max-width:100%;height:auto}
      .dsh-persona-chat-typing .dsh-persona-chat-bubble{display:flex;align-items:center;gap:1px;min-height:40px;padding:8px 12px;color:var(--chat-muted);background:var(--chat-bg);border-style:dashed;border-radius:3px 12px 12px;font-size:12px}.dsh-persona-chat-typing-dots{display:inline-flex;width:1.8em;font-family:ui-monospace,monospace;overflow:hidden;vertical-align:bottom}.dsh-persona-chat-typing-dots>span{display:inline-block;width:0;overflow:hidden;white-space:nowrap;animation:dsh-persona-chat-ellipsis 1.4s steps(3,end) infinite}
      @keyframes dsh-persona-chat-ellipsis{0%,10%{width:0}80%,100%{width:1.8em}}
      .dsh-persona-chat button.dsh-persona-chat-jump{position:absolute;right:14px;bottom:12px;z-index:1;border-radius:18px;padding:4px 12px;min-height:30px;font-size:11px;box-shadow:0 3px 12px #0002;color:var(--chat-muted);background:var(--chat-bg)}
      .dsh-persona-chat-wait{flex:none;margin:0;padding:3px 12px 6px;color:var(--chat-muted);font-size:11px;line-height:1.6;overflow-wrap:anywhere}.dsh-persona-chat-wait summary{cursor:pointer}.dsh-persona-chat-wait>span{display:block;padding-top:3px}
      @media(prefers-reduced-motion:reduce){.dsh-persona-chat-typing-dots>span{animation:none;width:1.8em}}
      @media(max-width:520px){.dsh-persona-chat-top{gap:7px;grid-template-columns:32px minmax(0,1fr) repeat(4,auto)}.dsh-persona-chat-top>.dsh-persona-chat-avatar{width:32px;height:32px}}
      .dsh-persona-chat{--chat-top-safe:max(52px,env(safe-area-inset-top,0px));box-sizing:border-box;right:16px;bottom:max(12px,env(safe-area-inset-bottom,0px));height:min(650px,calc(100dvh - var(--chat-top-safe) - max(12px,env(safe-area-inset-bottom,0px))));max-height:calc(100dvh - var(--chat-top-safe) - max(12px,env(safe-area-inset-bottom,0px)));-webkit-app-region:no-drag}
      .dsh-persona-chat[data-wide=true]{width:min(780px,calc(100vw - 32px));height:min(780px,calc(100dvh - var(--chat-top-safe) - max(12px,env(safe-area-inset-bottom,0px))))}
      .dsh-persona-chat-top{grid-template-columns:28px minmax(0,1fr) auto;gap:6px 8px;min-height:0;padding:9px 12px 8px}.dsh-persona-chat-top>.dsh-persona-chat-avatar{width:28px;height:28px}.dsh-persona-chat-title{display:block;grid-column:2;grid-row:1;font-size:14px;line-height:28px;min-width:0}.dsh-persona-chat-actions{grid-column:3;grid-row:1;display:flex;align-items:center;gap:4px}.dsh-persona-chat-actions button{min-height:27px;padding:2px 7px;font-size:11px}
      .dsh-persona-chat-context-row{grid-column:1/-1;grid-row:2;display:flex;align-items:center;gap:7px;min-width:0}.dsh-persona-chat-context-row select{flex:1;min-width:0;width:0;max-width:100%;padding:4px 7px;border:1px solid var(--chat-border);background:var(--chat-soft);font-size:12px;line-height:20px;height:29px;border-radius:6px}.dsh-persona-chat-context-row button{flex:none;font-size:11px;min-height:29px;padding:3px 8px;white-space:nowrap}.dsh-persona-chat-sources{max-height:28%;flex:0 1 auto;min-height:0;padding:6px 12px}.dsh-persona-chat-sources>p:first-child{margin-top:0}
      .dsh-persona-chat-thread-wrap{min-height:min(84px,18dvh)}.dsh-persona-chat-thread{padding:12px}.dsh-persona-chat-empty{min-height:0;gap:7px;padding:12px}.dsh-persona-chat-empty strong{font-size:14px}.dsh-persona-chat-empty p{font-size:11px;max-width:240px;line-height:1.65}
      .dsh-persona-chat-compose{padding:8px 12px;min-height:0;max-height:56%;display:flex;flex-direction:column;gap:6px;overflow:auto}.dsh-persona-chat-compose textarea{flex:0 1 auto;height:56px;min-height:48px;max-height:none;resize:none;padding:7px 9px;border-radius:8px;font-size:13px}.dsh-persona-chat[data-compose-expanded=true] .dsh-persona-chat-compose textarea{height:clamp(88px,26dvh,220px);min-height:64px}.dsh-persona-chat-compose-row{flex:none;display:flex;align-items:center;gap:7px;margin-top:0;min-height:29px}.dsh-persona-chat-compose-row>label{display:flex;align-items:center;gap:5px;font-size:11px;white-space:nowrap}.dsh-persona-chat-compose-row input[type=checkbox]{margin:0;accent-color:var(--chat-brand)}.dsh-persona-chat-compose-row small{font-size:10px;color:var(--chat-muted);margin-left:auto;white-space:nowrap}.dsh-persona-chat-compose-row>button{min-height:29px;padding:3px 9px;font-size:12px}.dsh-persona-chat-compose-row button[data-primary]{min-width:56px}.dsh-persona-chat-compose-row .dsh-persona-chat-compose-expand{margin-left:auto;display:grid;place-items:center;width:28px;min-width:28px;padding:4px;background:transparent;border-color:transparent;color:var(--chat-muted)}.dsh-persona-chat-compose-row small+.dsh-persona-chat-compose-expand{margin-left:0}.dsh-persona-chat-compose-expand:hover{background:var(--chat-soft);border-color:var(--chat-border)}.dsh-persona-chat-compose-expand svg{display:block}
      .dsh-persona-chat-suggest{flex:0 1 auto;min-height:0;max-height:150px;overflow:auto;padding-bottom:6px;margin:0;border-bottom:1px solid var(--chat-border)}.dsh-persona-chat-suggest-head{font-size:11px;color:var(--chat-muted)}.dsh-persona-chat-suggest-head>small{margin:0;flex:1}.dsh-persona-chat-suggest-head>button{flex:none}.dsh-persona-chat-suggestions{max-height:110px}
      @media(max-width:520px){.dsh-persona-chat,.dsh-persona-chat[data-wide=true]{right:8px;bottom:max(8px,env(safe-area-inset-bottom,0px));width:calc(100vw - 16px);height:calc(100dvh - var(--chat-top-safe) - max(8px,env(safe-area-inset-bottom,0px)));max-height:calc(100dvh - var(--chat-top-safe) - max(8px,env(safe-area-inset-bottom,0px)))}.dsh-persona-chat-top{grid-template-columns:28px minmax(0,1fr) auto;padding:8px 10px 7px;gap:5px 7px}.dsh-persona-chat-top>.dsh-persona-chat-avatar{width:28px;height:28px}.dsh-persona-chat-actions{gap:3px}.dsh-persona-chat-actions button{padding:2px 6px}.dsh-persona-chat-compose{padding:7px 10px}}
      @media(max-width:420px){.dsh-persona-chat-compose-row small{display:none}.dsh-persona-chat-compose-row button.dsh-persona-chat-compose-expand{margin-left:auto}}
    `;
    const CHAT_APPEARANCE_CSS = `
      .dsh-persona-chat-appearance{position:absolute;z-index:2;top:8px;right:8px;width:calc(100% - 16px);height:calc(100% - 16px);max-height:calc(100% - 16px);box-sizing:border-box;display:flex;flex-direction:column;overflow:hidden;padding:0;border:1px solid var(--chat-border);border-radius:12px;background:var(--chat-bg);box-shadow:0 12px 32px #0003}
      .dsh-persona-chat-settings-heading{position:relative;flex:none;display:flex;align-items:center;justify-content:space-between;gap:12px;margin:0;padding:12px 14px 10px;background:var(--chat-bg,var(--dsw-alias-bg-layer-1,#fff))}
      .dsh-persona-chat-settings-body{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;scrollbar-gutter:stable;box-sizing:border-box;padding:4px 14px 14px;background:var(--chat-bg,var(--dsw-alias-bg-layer-1,#fff))}
    `;
    const ROOM_CHAT_CSS = `
      .dsh-persona-chat-dock{--chat-bg:var(--dsw-alias-bg-layer-1,#fff);--chat-border:var(--dsw-alias-border-l1,#d6dfe9);--chat-soft:var(--dsw-alias-bg-layer-2,#f3f5f8);--chat-muted:var(--dsw-alias-label-secondary,#65758a);--chat-text:var(--dsw-alias-label-primary,#203044);--chat-brand:var(--dsw-alias-brand-primary,#3976c3);position:fixed;z-index:1100;right:max(16px,env(safe-area-inset-right));bottom:max(16px,env(safe-area-inset-bottom));display:flex;align-items:center;gap:2px;max-width:calc(100vw - 32px);padding:3px 4px 3px 3px;border:1px solid var(--chat-border);border-radius:18px;background:var(--chat-bg);box-shadow:0 3px 16px #0002;color:var(--chat-text);font:12px/1.35 system-ui,sans-serif}
      .dsh-persona-chat-dock button{display:inline-flex;align-items:center;justify-content:center;gap:7px;padding:2px 6px;border:0;border-radius:12px;background:transparent;color:inherit;cursor:pointer;font:inherit}.dsh-persona-chat-dock button:hover{background:var(--chat-soft)}.dsh-persona-chat-dock button:focus-visible{outline:2px solid var(--chat-brand);outline-offset:1px}.dsh-persona-chat-dock button:first-of-type{padding-left:2px;min-height:36px}.dsh-persona-chat-dock button:last-of-type{color:var(--chat-muted);width:24px;height:28px;font-size:16px}.dsh-persona-chat-dock .dsh-persona-room-avatar{width:30px;height:30px}
      .dsh-persona-chat-dock-count{min-width:16px;box-sizing:border-box;padding:2px 4px;border-radius:10px;text-align:center;background:var(--chat-brand);color:#fff;font:600 10px/1.2 system-ui,sans-serif;font-variant-numeric:tabular-nums}.dsh-persona-chat-dock-status{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
      @keyframes dsh-persona-chat-arrived{0%,100%{transform:scale(1)}45%{transform:scale(1.22)}}@media(prefers-reduced-motion:no-preference){.dsh-persona-chat-dock-count{animation:dsh-persona-chat-arrived .52s ease-out 2}}
      @media(max-width:380px){
        .dsh-persona-chat .dsh-persona-chat-top[data-room=true]{grid-template-columns:40px minmax(0,1fr) repeat(3,30px);gap:2px 4px}
        .dsh-persona-chat-top[data-room=true] .dsh-persona-room-avatar-display{grid-column:1;grid-row:1/span 2}
        .dsh-persona-chat-top[data-room=true] :is(.dsh-persona-chat-room-heading,.dsh-persona-chat-actions){display:contents}
        .dsh-persona-chat-top[data-room=true] .dsh-persona-chat-room-title{grid-column:2;grid-row:1}
        .dsh-persona-chat-top[data-room=true] .dsh-persona-chat-room-tools{grid-column:2;grid-row:2}
        .dsh-persona-chat-top[data-room=true] .dsh-persona-chat-actions button{padding:1px;min-height:24px;font-size:11px;grid-row:1}
        .dsh-persona-chat-top[data-room=true] .dsh-persona-chat-actions button:nth-child(-n+2){grid-row:2;min-height:20px;border:none;color:var(--chat-muted)}
        .dsh-persona-chat-actions button:nth-child(3){grid-column:3}.dsh-persona-chat-actions button:is(:nth-child(1),:nth-child(4)){grid-column:4}.dsh-persona-chat-actions button:is(:nth-child(2),:nth-child(5)){grid-column:5}
      }
      .dsh-persona-chat-top[data-room=true]{grid-template-columns:44px minmax(0,1fr) auto}.dsh-persona-chat-room-heading{grid-column:2;grid-row:1;min-width:0;display:flex;flex-direction:column;gap:2px}.dsh-persona-chat-room-title{display:flex;align-items:center;gap:5px;min-width:0;min-height:20px!important;border:0!important;background:transparent!important;padding:0!important;text-align:left;font-weight:600;font-size:13px!important;line-height:20px}.dsh-persona-chat-room-title>span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dsh-persona-chat-room-title>span:last-child{font-size:10px;color:var(--chat-muted)}.dsh-persona-room-avatar-display{grid-column:1;grid-row:1;align-self:center}.dsh-persona-chat-room-tools{display:flex;align-items:center;gap:10px;min-width:0}.dsh-persona-chat-room-tools button{border:0;min-height:20px;padding:0;font-size:10px;background:transparent;white-space:nowrap;color:var(--chat-muted)}.dsh-persona-chat-room-tools button:hover{color:var(--chat-brand)}.dsh-persona-chat-room-tools button[aria-expanded=true]{color:var(--chat-brand)}.dsh-persona-chat-room-heading+.dsh-persona-chat-actions{align-self:start}
      .dsh-persona-room-avatar{--room-avatar-letter:9px;position:relative;display:block;width:44px;height:44px;flex:none;isolation:isolate}.dsh-persona-room-avatar-tile{position:absolute;display:block;border:1px solid var(--chat-bg);border-radius:24%;background:var(--chat-bg);transform:translate(-50%,-50%) rotate(var(--tile-angle,0deg));transform-origin:center;box-shadow:0 1px 0 var(--chat-border),0 2px 4px #0002}.dsh-persona-room-avatar-tile::after{content:'';position:absolute;inset:0;border-radius:inherit;background:linear-gradient(135deg,#ffffff0c,transparent 55%);pointer-events:none}.dsh-persona-room-avatar[data-count='1']{--room-avatar-letter:12px}.dsh-persona-room-avatar[data-count='2']{--room-avatar-letter:10px}.dsh-persona-room-avatar-more{display:grid;place-items:center;color:var(--chat-muted);background:var(--chat-soft);font-size:var(--room-avatar-letter);line-height:1;font-weight:600}.dsh-persona-chat-empty>.dsh-persona-room-avatar{--room-avatar-letter:12px;width:64px;height:64px;margin-bottom:5px}.dsh-persona-chat-mentions{display:block;font-size:9px;line-height:1.4;opacity:.72;margin-bottom:3px;font-weight:400}
      .dsh-persona-chat-participants{min-width:0;flex:none;container-type:inline-size}
      .dsh-persona-chat-recipient{display:flex;flex-wrap:wrap;align-items:center;gap:2px 5px;min-width:0;padding:2px}
      .dsh-persona-chat button.dsh-persona-chat-recipient-option{display:inline-flex;align-items:center;gap:5px;min-width:0;max-width:142px;min-height:30px;padding:3px 7px 3px 4px;border:0;border-radius:9px;background:transparent;font:inherit;font-size:11px;line-height:18px;color:var(--chat-muted);text-align:start}
      .dsh-persona-chat-recipient-option>span:last-child{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .dsh-persona-chat-recipient-portrait{position:relative;display:inline-flex;flex:none}
      .dsh-persona-chat-recipient-option .dsh-persona-chat-avatar{width:22px;height:22px;border-radius:7px;font-size:9px}
      .dsh-persona-chat button.dsh-persona-chat-recipient-option[aria-checked=true]{background:color-mix(in srgb,var(--chat-brand) 12%,var(--chat-bg));color:var(--chat-text);font-weight:600}
      .dsh-persona-chat-recipient-option[aria-checked=true] .dsh-persona-chat-recipient-portrait::after{content:'✓';position:absolute;right:-2px;bottom:-1px;display:grid;place-items:center;width:11px;height:11px;border:1px solid var(--chat-bg);border-radius:50%;background:var(--chat-brand);color:white;font:bold 8px/1 system-ui}
      .dsh-persona-chat-recipient-option[aria-checked=true] .dsh-persona-chat-recipient-portrait[data-order]::after{content:attr(data-order)}
      .dsh-persona-chat-recipient-option:not(:disabled):hover{background:var(--chat-soft)}
      @container(max-width:620px){.dsh-persona-chat-recipient[data-crowded=true]{display:grid;grid-template-columns:repeat(4,minmax(0,1fr))}.dsh-persona-chat-recipient[data-crowded=true]>button{max-width:100%}}
      @container(max-width:335px){.dsh-persona-chat-recipient[data-crowded=true]{grid-template-columns:repeat(3,minmax(0,1fr))}}
      .dsh-persona-chat-room-panel{position:absolute;z-index:5;inset:84px 10px auto;max-height:calc(100% - 98px);overflow:auto;padding:12px;border:1px solid var(--chat-border);border-radius:11px;background:var(--chat-bg);box-shadow:0 12px 35px #0003;font-size:12px}.dsh-persona-chat-room-panel header{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px}.dsh-persona-chat-room-panel header button{min-height:25px;padding:2px 7px;font-size:11px}.dsh-persona-chat-room-panel p{font-size:11px;color:var(--chat-muted);line-height:1.7}.dsh-persona-chat-room-panel input[type=text]{box-sizing:border-box;width:100%;padding:7px 9px;margin:6px 0 10px;border:1px solid var(--chat-border);border-radius:7px;background:var(--chat-soft);font:inherit;color:inherit}.dsh-persona-chat-room-list{display:grid;gap:5px}.dsh-persona-chat-room-list>button{display:flex;align-items:center;gap:9px;width:100%;text-align:left}.dsh-persona-chat-room-list>button[aria-pressed=true]{border-color:var(--chat-brand);background:var(--chat-soft)}.dsh-persona-chat-room-list>button>span:last-child{min-width:0;display:grid;gap:2px}.dsh-persona-chat-room-list strong{font-size:12px;white-space:nowrap;text-overflow:ellipsis;overflow:hidden}.dsh-persona-chat-room-list small{font-size:10px;color:var(--chat-muted)}.dsh-persona-chat-room-buttons{display:flex;flex-wrap:wrap;gap:7px;margin-top:12px}.dsh-persona-chat-room-buttons button{font-size:12px;min-height:29px}
      .dsh-persona-chat-room-members{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;margin:8px 0}.dsh-persona-chat-room-members label{display:flex;align-items:center;gap:6px;min-width:0;padding:6px;border:1px solid var(--chat-border);border-radius:7px}.dsh-persona-chat-room-members label>span:last-child{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dsh-persona-chat-room-members .dsh-persona-chat-avatar{width:26px;height:26px;font-size:10px}.dsh-persona-chat-speaker{display:block;font-size:10px;line-height:1.5;color:var(--chat-muted);margin-bottom:3px}.dsh-persona-chat-message[data-user=true] .dsh-persona-chat-speaker{color:inherit;opacity:.8}.dsh-persona-chat-room-loading{padding:24px;display:grid;gap:10px;font-size:12px}
    `;
    const chatPalette=createChatPalette(),avatarColors=new Map(),avatarColorListeners=new Set();
    function sampleAvatarColor(src,image,catPortrait){
      if(avatarColors.has(src)||!src?.startsWith(ROUTE+'/avatar/'))return;
      let color=null;
      try{
        const canvas=document.createElement('canvas');canvas.width=32;canvas.height=32;
        const context=canvas.getContext('2d',{willReadFrequently:true}),w=image.naturalWidth,h=image.naturalHeight;
        if(context&&w>0&&h>0){const square=Math.min(w,h),size=square/(catPortrait?2.15:1);
          context.drawImage(image,(w-size)/2,(h-square)*(catPortrait?0.07:0.5),size,size,0,0,32,32);
          color=chatPalette.dominant(context.getImageData(0,0,32,32).data);}
      }catch{/* A blocked/unreadable image keeps its stable local fallback. */}
      avatarColors.set(src,color);while(avatarColors.size>128)avatarColors.delete(avatarColors.keys().next().value);
      for(const update of avatarColorListeners)update();
    }
    function useChatBubbleColors(contacts,room){
      const [,redraw]=React.useState(0);
      React.useEffect(()=>{const update=()=>redraw(value=>value+1);avatarColorListeners.add(update);update();return()=>avatarColorListeners.delete(update);},[]);
      const ids=new Set([...(room?.memberIds??[]),...(room?.turns??[]).map(turn=>turn.recipientId)]);
      return chatPalette.allocate((contacts??[]).filter(person=>ids.has(person.id)).map(person=>({id:person.id,color:avatarColors.get(person.avatar)})));
    }
    function PersonaAvatar({ src, name = '角色', id, fallback = true, className = '', style }) {
      const [failed, setFailed] = React.useState(false);
      React.useEffect(() => setFailed(false), [src]);
      const safe = typeof src === 'string' && (src.startsWith(ROUTE + '/avatar/') || src.startsWith(ROUTE + '/chat-profile/avatar?'));
      if ((!safe || failed) && !fallback) return null;
      const defaults = { '大肥鱼（默认）': '鲸', '大肥龙': '龙', 'Claude小姐': 'C', '鲸鲸（实验性）': '鱼', Gemini: '猫' };
      const catPortrait = safe && src.endsWith('&frame=cat-portrait');
      const initials = Object.hasOwn(defaults, id) ? defaults[id]
        : (/^[a-z]/i.test(name) ? name.slice(0, 2).toUpperCase() : Array.from(name).slice(0, 2).join(''));
      return h('span', { className, role: 'img', 'aria-label': name + '头像', style: { overflow: 'hidden', ...style } },
        safe && !failed ? h('img', { src, alt: '', draggable: false, referrerPolicy: 'no-referrer',
          style: { display: 'block', width: '100%', height: '100%', objectFit: 'cover', borderRadius: 'inherit',
            ...(catPortrait ? { objectPosition: 'center 7%', transform: 'scale(2.15)', transformOrigin: 'center top' } : {}) },
          onLoad:event=>sampleAvatarColor(src,event.currentTarget,catPortrait),onError: () => setFailed(true) }) : initials);
    }
    // Only the official display-safe account projection is read. No account
    // identity, address or credential is kept in plugin storage or model input.
    function createAccountAvatarSource() {
      const subscribers = new Set(), timers = new Map();
      let remote, metadata, url = null, generation = 0, stream;
      const publish = (next) => { url = next; for (const fn of subscribers) fn(); };
      const deadline = (promise) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => { timers.delete(timer); reject(Error('account-timeout')); }, 5000);
        timers.set(timer, () => { clearTimeout(timer); reject(Error('account-stopped')); });
        Promise.resolve(promise).then(resolve, reject).finally(() => { clearTimeout(timer); timers.delete(timer); });
      });
      const stop = () => {
        generation++; const current = stream; stream = undefined;
        try { Promise.resolve(current?.dispose()).catch(() => {}); } catch { /* Optional account service. */ }
        for (const cancel of timers.values()) cancel(); timers.clear(); publish(null);
      };
      const profile = async (token) => {
        try {
          const result = await deadline(remote.account.getProfile(metadata()));
          if (token !== generation || !subscribers.size) return;
          const raw = result?.ok && result.value?.status === 'ready' ? result.value.value?.avatarUrl : null;
          let safe = null;
          if (typeof raw === 'string' && raw.length <= 4096) {
            try { const parsed = new URL(raw); if (parsed.protocol === 'https:' && !parsed.username && !parsed.password) safe = parsed.href; } catch { /* Hide invalid addresses. */ }
          }
          publish(safe);
        } catch { if (token === generation) publish(null); }
      };
      const refresh = async () => {
        if (!remote?.account || !subscribers.size) return;
        const token = ++generation; publish(null);
        try {
          const state = await deadline(remote.account.getState());
          if (token !== generation || !subscribers.size) return;
          if (state?.ok && state.value?.status === 'credential-stored') await profile(token);
        } catch { if (token === generation) publish(null); }
      };
      const start = () => {
        if (!remote?.account || !subscribers.size) return;
        if (typeof remote.$stream !== 'function' || typeof remote.account.watch !== 'function') { void refresh(); return; }
        try {
          const opened = remote.$stream({ name: 'persona-shell.account-avatar', open: (signal) => remote.account.watch(signal),
            ended: () => Error('account-stream-ended') }); stream = opened;
          void (async () => {
            for await (const frame of opened) {
              if (stream !== opened) return;
              const token = ++generation; publish(null); frame.accept();
              if (frame.value?.status === 'credential-stored') void profile(token);
            }
          })().catch(() => { if (stream === opened) { generation++; publish(null); } });
        } catch { void refresh(); }
      };
      return {
        read: () => url, refresh,
        subscribe(fn) { subscribers.add(fn); if (subscribers.size === 1) start(); return () => { subscribers.delete(fn); if (!subscribers.size) stop(); }; },
        bind(value, clientMetadata) { stop(); remote = value; metadata = clientMetadata; start(); return () => { if (remote === value) { stop(); remote = undefined; } }; },
      };
    }
    const accountAvatarSource = createAccountAvatarSource();
    function useAccountAvatar(enabled) {
      const [url, setUrl] = React.useState(null);
      React.useEffect(() => {
        if (!enabled) { setUrl(null); return; }
        const update = () => setUrl(accountAvatarSource.read());
        const unsubscribe = accountAvatarSource.subscribe(update); update();
        const focus = () => { void accountAvatarSource.refresh(); };
        window.addEventListener?.('focus', focus);
        return () => { unsubscribe(); window.removeEventListener?.('focus', focus); };
      }, [enabled]);
      return enabled ? url : null;
    }
    const userAvatarMode = (profile) => profile?.avatarMode ?? (profile?.avatar ? 'custom' : 'account');
    function UserChatAvatar({ profile, accountUrl, className }) {
      const mode = userAvatarMode(profile);
      const src = mode === 'account' ? accountUrl : mode === 'custom' ? profile?.avatar : null;
      const [failed, setFailed] = React.useState(false);
      React.useEffect(() => setFailed(false), [src]);
      const safe = typeof src === 'string' && (mode === 'account' ? /^https:\/\//.test(src) : src.startsWith(ROUTE + '/chat-profile/avatar?'));
      if (!safe || failed) return null;
      return h('span', { className, role: 'img', 'aria-label': '你的头像', style: { overflow: 'hidden' } },
        h('img', { src, alt: '', draggable: false, referrerPolicy: 'no-referrer', onError: () => setFailed(true),
          style: { display: 'block', width: '100%', height: '100%', objectFit: 'cover', borderRadius: 'inherit' } }));
    }
    function PersonaChatLauncher({ sessionId, conversation } = {}) {
      const [open, setOpen] = React.useState(false);
      const [error,setError]=React.useState('');
      React.useEffect(() => {
        const update = () => setOpen(chatRuntime.opened&&!chatRuntime.minimized);
        chatLaunchListeners.add(update);
        update(); return () => chatLaunchListeners.delete(update);
      }, []);
      React.useEffect(()=>{if(sessionId)chatRuntime.foreground(sessionId);},[sessionId]);
      return h(React.Fragment, null,
        h('button', { type: 'button', style: headerButtonStyle, 'aria-haspopup': 'dialog', 'aria-expanded':open, title:error||'打开聊天室', onClick: () => {
          try {chatRuntime.open(sessionId,conversation);setError('');}catch(e){setError(e.message);}
        } }, '聊天室'));
    }
    function useChatContext(sessionId,roomId,paused) {
      const [value,setValue]=React.useState(()=>chatContextCache?.roomId===roomId?chatContextCache:undefined),[error,setError]=React.useState(''),[busy,setBusy]=React.useState(false);
      const state=React.useRef({live:false,request:0,sequence:0,viewer:chatNonce(),abort:null,busy:false,value});
      state.current.value=value;
      const accept=next=>{chatContextCache=next;setValue(next);};
      const action=async(body,quiet=false)=>{
        const own=state.current;if(!own.live||(own.busy&&!quiet))return;
        const token=++own.request;if(!quiet){own.busy=token;setBusy(true);}own.abort?.abort();const abort=new AbortController();own.abort=abort;
        try{
          const response=await fetch(ROUTE+'/chat-context',{method:'POST',headers:{'content-type':'application/json'},signal:abort.signal,
            body:JSON.stringify({...body,roomId,viewer:own.viewer,sequence:++own.sequence,revision:own.value?.revision})});
          const next=await response.json();if(!own.live||token!==own.request)return;
          if(!response.ok){if(next.state?.initialized)accept(next.state);throw Error(next.error);}
          if(body.action!=='sessions')accept(next);setError('');return next;
        }catch(e){if(own.live&&token===own.request&&!abort.signal.aborted)setError(e.message==='context-capacity'
          ?'最多同时接入 6 个会话，请先移除不需要的来源。':e.message==='chat-context-changed'
            ?'参考来源已在其他窗口更新，请核对当前列表后再操作。':'参考信息暂未更新，已有来源保留，可以重试。');}
        finally{if(!quiet&&own.busy===token){own.busy=false;if(own.live)setBusy(false);}}
      };
      React.useEffect(()=>{
        if(paused)return;
        const own=state.current;own.live=true;own.busy=false;setBusy(false);let timer,active=true;
        const loop=async()=>{
          clearTimeout(timer);if(!own.live||document.visibilityState==='hidden')return;
          if(!own.busy){
            if(!own.value?.initialized)await action({action:'open',sessionId,visible:true},true);
            else{
              const token=++own.request;const abort=new AbortController();own.abort?.abort();own.abort=abort;
              try{const r=await fetch(ROUTE+'/chat-context?'+new URLSearchParams({...(roomId?{room:roomId}:{}),viewer:own.viewer,sequence:String(++own.sequence)}),{signal:abort.signal});
                const next=await r.json();if(own.live&&token===own.request){if(r.ok){accept(next);setError('');}else{chatContextCache=undefined;own.value=undefined;setError('参考服务需要重新连接，正在重试。');}}}catch{if(own.live&&!abort.signal.aborted)setError('参考信息暂未更新，已有来源保留。');}
            }
          }
          if(active&&document.visibilityState!=='hidden')timer=setTimeout(loop,15000);
        };
        const presence=()=>{
          clearTimeout(timer);own.abort?.abort();
          if(document.visibilityState==='hidden')void fetch(ROUTE+'/chat-context',{method:'POST',headers:{'content-type':'application/json'},
            body:JSON.stringify({action:'presence',roomId,viewer:own.viewer,sequence:++own.sequence,visible:false})}).catch(()=>{});
          else void action({action:'open',sessionId,visible:true},true).then(()=>{if(active)timer=setTimeout(loop,15000);});
        };
        void action({action:'open',sessionId,visible:document.visibilityState!=='hidden'},true).then(()=>{if(active&&document.visibilityState!=='hidden')timer=setTimeout(loop,15000);});
        document.addEventListener('visibilitychange',presence);
        return()=>{active=false;own.live=false;own.request++;own.abort?.abort();clearTimeout(timer);document.removeEventListener('visibilitychange',presence);
          if(chatContextCache?.roomId===roomId)chatContextCache=undefined;
          void fetch(ROUTE+'/chat-context',{method:'POST',headers:{'content-type':'application/json'},keepalive:true,
            body:JSON.stringify({action:'presence',roomId,viewer:own.viewer,sequence:++own.sequence,visible:false})}).catch(()=>{});};
      },[paused]);
      return{value,error,busy,action};
    }
    const CHAT_ROUND_SEATS=32;
    const CHAT_SILENT_RECEIPTS=8;
    const roomLiveConnections=new Map();
    function subscribeRoomLive(roomId,instance,attempt,listener) {
      const key=JSON.stringify([roomId,instance]);let own=roomLiveConnections.get(key);
      if(!own){
        own={listeners:new Map(),abort:null,generation:0,connected:false,frames:[],live:true,timer:null,delay:750};roomLiveConnections.set(key,own);
        const emit=()=>{for(const update of own.listeners.keys())update(own.frames,own.connected);};
        const needed=()=>[...own.listeners.values()].some(id=>!own.frames.some(f=>f.attemptId===id&&['ready','failed','cancelled','silent'].includes(f.status)));
        own.start=async()=>{
          if(!own.live||own.abort||own.timer!==null||!needed()||document.visibilityState==='hidden')return;
          const token=++own.generation,abort=new AbortController();own.abort=abort;
          try{
            const response=await fetch(ROUTE+'/chat/live?'+new URLSearchParams({room:roomId,batch:'1'}),{signal:abort.signal});
            if(!response.ok||!response.body?.getReader)throw Error('stream-unavailable');
            if(!own.live||token!==own.generation){abort.abort();return;}own.connected=true;emit();
            const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
            try{while(own.live&&token===own.generation&&!abort.signal.aborted){const chunk=await reader.read();if(chunk.done||!own.live||token!==own.generation||abort.signal.aborted)break;
              buffer+=decoder.decode(chunk.value,{stream:true});if(buffer.length>262144)throw Error('stream-too-large');let end;
              while((end=buffer.indexOf('\n\n'))>=0){const event=buffer.slice(0,end);buffer=buffer.slice(end+2);if(!event.startsWith('data:'))continue;
                const value=JSON.parse(event.slice(5));if(value.instanceId!==instance||value.roomId!==roomId||!Array.isArray(value.frames)
                  ||value.frames.length>CHAT_ROUND_SEATS+CHAT_SILENT_RECEIPTS||value.frames.filter(frame=>frame?.status==='silent').length>CHAT_SILENT_RECEIPTS
                  ||value.frames.filter(frame=>frame?.status!=='silent').length>CHAT_ROUND_SEATS)continue;
                own.frames=value.frames;if(value.status==='streaming')own.delay=750;emit();if(value.status!=='streaming')return;
              }
            }}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
          }catch{/* Canonical snapshot polling remains available. */}
          finally{if(own.live&&token===own.generation){own.abort=null;own.connected=false;emit();
            if(needed()&&document.visibilityState!=='hidden'){
              own.timer=setTimeout(()=>{own.timer=null;void own.start();},own.delay);own.delay=Math.min(8000,own.delay*2);
            }}}
        };
        own.visibility=()=>{own.generation++;clearTimeout(own.timer);own.timer=null;own.abort?.abort();own.abort=null;own.connected=false;own.delay=750;emit();if(document.visibilityState!=='hidden')void own.start();};
        document.addEventListener('visibilitychange',own.visibility);
      }
      own.listeners.set(listener,attempt);listener(own.frames,own.connected);void own.start();
      return()=>{own.listeners.delete(listener);if(!own.listeners.size){own.live=false;own.generation++;clearTimeout(own.timer);own.abort?.abort();
        document.removeEventListener('visibilitychange',own.visibility);roomLiveConnections.delete(key);}};
    }
    function useChatLive(personaId,turn,instance,onFinish,roomId) {
      const [frame,setFrame]=React.useState(null),[connected,setConnected]=React.useState(false);
      const finish=React.useRef(onFinish);finish.current=onFinish;
      const attempt=turn?.status==='pending'?turn.attemptId:undefined;
      React.useEffect(()=>{
        if(!attempt){setConnected(false);return;}
        let live=true,abort,generation=0;setFrame(null);
        if(roomId){let finished=false;const stop=subscribeRoomLive(roomId,instance,attempt,(frames,online)=>{
          if(!live)return;setConnected(online);const value=frames.find(f=>f.attemptId===attempt&&f.personaId===personaId);
          if(!value||value.instanceId!==instance||value.roomId!==roomId||value.turnId!==turn.id||!Number.isSafeInteger(value.revision)||value.revision<0
            ||!['queued','streaming','ready','failed','cancelled','silent'].includes(value.status)
            ||!Array.isArray(value.messages)||value.messages.length>6||value.status==='silent'&&value.messages.length!==0
            ||value.messages.some(m=>typeof m.text!=='string'||m.text.length>2000||typeof m.complete!=='boolean'))return;
          setFrame(previous=>previous?.attemptId===attempt&&previous.revision>value.revision?previous:value);
          if(!['streaming','queued'].includes(value.status)&&!finished){finished=true;finish.current?.();}
        });return()=>{live=false;stop();};}
        let retryTimer,delay=750,terminal=false;
        const start=async()=>{
          if(document.visibilityState==='hidden')return;
          const token=++generation,controller=new AbortController();abort=controller;
          try{
            const response=await fetch(ROUTE+'/chat/live?'+new URLSearchParams({persona:personaId,attempt,...(roomId?{room:roomId}:{})}),{signal:controller.signal});
            if(!response.ok||!response.body?.getReader)throw Error('stream-unavailable');
            if(!live||token!==generation){controller.abort();return;}setConnected(true);
            const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
            try{while(live&&token===generation&&!controller.signal.aborted){const chunk=await reader.read();if(chunk.done||!live||token!==generation)break;buffer+=decoder.decode(chunk.value,{stream:true});
              if(buffer.length>65536)throw Error('stream-too-large');let end;
              while((end=buffer.indexOf('\n\n'))>=0){const event=buffer.slice(0,end);buffer=buffer.slice(end+2);if(!event.startsWith('data:'))continue;
                const value=JSON.parse(event.slice(5));if(value.instanceId!==instance||value.personaId!==personaId||value.attemptId!==attempt||value.turnId!==turn.id
                  ||!Number.isSafeInteger(value.revision)||value.revision<0||(roomId&&value.roomId!==roomId))continue;
                if(!['streaming','ready','failed','cancelled','closed','silent'].includes(value.status)||!Array.isArray(value.messages)||value.messages.length>6
                  ||value.status==='silent'&&value.messages.length!==0
                  ||value.messages.some(m=>typeof m.text!=='string'||m.text.length>2000||typeof m.complete!=='boolean'))continue;
                if(live)setFrame(previous=>previous?.attemptId===attempt&&previous.revision>value.revision?previous:value);
                if(value.status!=='streaming'){terminal=value.status!=='closed';if(live)finish.current?.();return;}
                delay=750;
              }
            }}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
          }catch{/* The canonical snapshot poller remains the compatibility fallback. */}
          finally{if(live&&token===generation){setConnected(false);if(!terminal&&document.visibilityState!=='hidden'){
            retryTimer=setTimeout(start,delay);delay=Math.min(8000,delay*2);
          }}}
        };
        const visibility=()=>{generation++;clearTimeout(retryTimer);abort?.abort();delay=750;setConnected(false);if(!terminal&&document.visibilityState!=='hidden')void start();};
        void start();document.addEventListener('visibilitychange',visibility);
        return()=>{live=false;generation++;clearTimeout(retryTimer);abort?.abort();document.removeEventListener('visibilitychange',visibility);};
      },[personaId,attempt,instance,roomId]);
      return {frame,connected};
    }
    function chatQuotedSource(room,ref,scope){
      if(!room||!ref||ref.roomId!==room.id||(ref.generation??0)!==(room.generation??0))return null;
      const turn=ref.kind==='user'?room.turns.find(t=>chatUserParts(t).some(part=>part.id===ref.messageId)):room.turns.find(t=>t.id===ref.turnId&&t.attemptId===ref.attemptId);
      if(!turn||(turn.scopeKey??turn.contextKey??null)!==scope)return null;
      const text=ref.kind==='user'?chatUserParts(turn).find(part=>part.id===ref.messageId)?.text:turn.status==='ready'?turn.assistant[ref.index]:null;
      return typeof text==='string'?{turn,text}:null;
    }
    function ChatQuotedMessage({quote,available,onJump,draft=false,onCancel}){
      const [expanded,setExpanded]=React.useState(false),key=JSON.stringify(quote.ref),long=quote.text.length>100||quote.text.includes('\n');
      React.useEffect(()=>setExpanded(false),[key]);
      return h('div',{className:'dsh-persona-chat-quote','data-draft':draft,'data-expanded':expanded,'aria-label':draft?'正在引用的消息':'引用的原消息'},
        h('div',null,h('div',{className:'dsh-persona-chat-quote-heading'},h('strong',null,(draft?'引用 ':'')+(quote.author.role==='user'?'我':quote.author.name)),
          long?h('button',{type:'button','aria-expanded':expanded,'aria-label':expanded?'收起引用全文':'展开引用全文',onClick:()=>setExpanded(!expanded)},expanded?'收起':'全文'):null),
          h('span',{className:'dsh-persona-chat-quote-text',tabIndex:expanded?0:undefined,'aria-label':expanded?'引用原话全文':undefined},quote.text),
          !available?h('small',{role:draft?'status':undefined},'原消息已更改或不在当前参考范围，请重新选择。'):null),
        h('div',{className:'dsh-persona-chat-quote-actions'},onJump?h('button',{type:'button',disabled:!available,'aria-label':'查看引用原消息',title:available?'定位到原消息':'原消息暂不可用',onClick:onJump},'↗'):null,
          draft?h('button',{type:'button','aria-label':'取消引用',title:'取消引用 · Esc',onClick:onCancel},'×'):null));
    }
    function ChatReplyBubbles({turn,frame,avatar,colorStyle,onProgress,onPresented,latest=true,running=false,showSpeaker=false,onQuote}) {
      const animate=latest&&(chatAnimatedAttempts.has(turn.attemptId)||turn.status==='pending');
      const [entrance]=React.useState(()=>animate&&!chatSurfaceMotion);
      const messages=turn.status==='ready'?turn.assistant.map(text=>({text,complete:true}))
        :turn.status==='pending'&&frame?.attemptId===turn.attemptId?frame.messages??[]:[];
      const [count,setCount]=React.useState(()=>animate?1:messages.length);
      const visible=animate?messages.slice(0,count):messages;
      const displayed=visible.map((message,index)=>({message,index})).filter(({message})=>message.text);
      const waiting = (turn.status === 'pending' && running) || (turn.status === 'ready' && animate && count < messages.length);
      const typing = waiting && (!visible.at(-1)?.text || visible.at(-1).complete);
      React.useEffect(()=>{
        if(!animate)return;
        if(turn.status==='pending')markChatAnimation(turn.attemptId);
        if(turn.status!=='pending'&&turn.status!=='ready'){chatAnimatedAttempts.delete(turn.attemptId);return;}
        if(count>=messages.length){if(turn.status==='ready'){chatAnimatedAttempts.delete(turn.attemptId);onPresented?.(turn);}return;}
        if(count===0){setCount(1);return;}
        if(!messages[count-1]?.complete)return;
        const wait=Math.min(1250,650+messages[count-1].text.length*12);
        const timer=setTimeout(()=>setCount(n=>n+1),wait);return()=>clearTimeout(timer);
      },[turn.attemptId,turn.status,count,messages.length,messages[Math.max(0,count-1)]?.complete,animate]);
      useLayoutEffect(()=>{onProgress?.();},[count,typing,visible.map(m=>m.text).join('\n')]);
      const portrait=continuation=>continuation?h('span',{className:'dsh-persona-chat-avatar-spacer','aria-hidden':true}):avatar();
      return h(React.Fragment,null,...displayed.map(({message,index},position)=>h('div',{key:index,className:'dsh-persona-chat-message','data-user':'false','data-chat-bubble':index,'data-arriving':entrance||undefined,
        'data-chat-persona':turn.recipientId,style:colorStyle,
        'data-chat-continuation':position>0||undefined,'data-provisional':turn.status==='pending'},portrait(position>0),h('div',{className:'dsh-persona-chat-bubble','data-live':!message.complete},
          showSpeaker&&position===0?h('small',{className:'dsh-persona-chat-speaker'},turn.speakerName):null,
          h('div',{className:'dsh-persona-chat-body'},renderMarkdown(message.text,turn.status==='pending'&&!message.complete,{margin:0}))),
          onQuote&&turn.status==='ready'?h('button',{type:'button',className:'dsh-persona-chat-quote-action','aria-label':'引用'+turn.speakerName+'的第'+(index+1)+'条消息',title:'引用这句；回复对象仍按 @ 选择',onClick:()=>onQuote(turn,index,message.text)},'↩'):null)),
        typing ? h('div', { key:visible.length, className:'dsh-persona-chat-message dsh-persona-chat-typing', 'data-user':'false',
          'data-chat-persona':turn.recipientId,style:colorStyle,
          'data-chat-continuation':displayed.length>0||undefined,role:'status','aria-label':turn.status==='pending'?'角色输入中':'还有后续消息','aria-live':'polite','aria-atomic':true }, portrait(displayed.length>0),
          h('div',{className:'dsh-persona-chat-bubble'},turn.status==='pending'?'输入中':'',h('span',{className:'dsh-persona-chat-typing-dots','aria-hidden':true},h('span',null,'...')))) : null);
    }
    function chatDateBoundary(at,previous){
      const next=new Date(at),before=new Date(previous);if(!Number.isFinite(next.getTime())||!Number.isFinite(before.getTime()))return false;
      return next.getFullYear()!==before.getFullYear()||next.getMonth()!==before.getMonth()||next.getDate()!==before.getDate();
    }
    function chatMessageTime(at,now=Date.now()){
      if(!Number.isFinite(at))return null;const date=new Date(at);if(!Number.isFinite(date.getTime()))return null;
      const today=new Date(now),yesterday=new Date(now);yesterday.setDate(yesterday.getDate()-1);
      const pad=value=>String(value).padStart(2,'0'),clock=pad(date.getHours())+':'+pad(date.getMinutes());
      const day=date.getFullYear()+'/'+(date.getMonth()+1)+'/'+date.getDate(),full=day+' '+clock+':'+pad(date.getSeconds());
      const label=!chatDateBoundary(at,today.getTime())?clock:!chatDateBoundary(at,yesterday.getTime())?'昨天 '+clock:day+' '+clock;
      return{label,title:full,dateTime:date.toISOString()};
    }
    function ChatMessageTime({at,now}){
      const value=chatMessageTime(at,now);return value?h('p',{className:'dsh-persona-chat-time'},h('time',{dateTime:value.dateTime,title:value.title,'aria-label':value.title},value.label)):null;
    }
    function chatClientTime(){
      const value={};try{const offset=-new Date().getTimezoneOffset();if(Number.isInteger(offset)&&Math.abs(offset)<=840)value.utcOffsetMinutes=offset;}catch{}
      try{const zone=Intl.DateTimeFormat().resolvedOptions().timeZone;if(typeof zone==='string'&&zone.length>0&&zone.length<=80&&!/[\s\u0000-\u001f\u007f]/u.test(zone))value.timeZone=zone;}catch{}
      return Object.keys(value).length?value:undefined;
    }
    function chatUserParts(turn){
      const parts=turn?.userParts;
      if(Array.isArray(parts)&&!parts.length)return[];
      return Array.isArray(parts)&&parts.length&&parts.every(part=>part&&chatUiId(part.id)&&typeof part.text==='string'&&part.text.length<=4000&&Number.isFinite(part.at))
        ?parts:[{id:turn?.messageId,text:turn?.user??'',at:turn?.at}];
    }
    function SlowChatStatus({data,minimized}){
      const [clock,setClock]=React.useState(Date.now()),[visible,setVisible]=React.useState(document.visibilityState!=='hidden');
      const anchor=React.useRef({id:null,elapsed:0,at:Date.now()});
      const reported=Math.max(0,Number(data?.roundElapsedMs)||0);
      if(anchor.current.id!==data?.roundId||reported!==anchor.current.reported)anchor.current={id:data?.roundId,reported,elapsed:reported,at:Date.now()};
      React.useEffect(()=>{const update=()=>setVisible(document.visibilityState!=='hidden');document.addEventListener('visibilitychange',update);return()=>document.removeEventListener('visibilitychange',update);},[]);
      React.useEffect(()=>{if(!data?.running||!data.roundId||minimized||!visible)return;setClock(Date.now());const timer=setInterval(()=>setClock(Date.now()),1000);return()=>clearInterval(timer);},[data?.running,data?.roundId,minimized,visible]);
      if(!data?.running||!data.roundId||minimized||!visible)return null;
      const elapsed=Math.max(reported,anchor.current.elapsed+clock-anchor.current.at);if(elapsed<8000)return null;
      const active=data.room?.turns.find(turn=>turn.status==='pending'&&data.activeAttemptIds?.includes(turn.attemptId));
      const stage=data.roundPhase==='preparing'?'还在准备这次回应…':data.roundPhase==='listening'?'还在等这一轮的后续回应…':active?'还在等'+active.speakerName+'的回复…':'还在接收本轮回应…';
      const timing='本轮已用时 '+Math.floor(elapsed/1000)+' 秒',model=typeof data.roundModel?.model==='string'?data.roundModel.model:null;
      return h('details',{className:'dsh-persona-chat-wait','aria-label':'本轮等待情况',title:timing+(model?' · 模型 '+model:'')},
        h('summary',null,stage),h('span',null,timing,model?' · 当前调用模型：'+model+(data.roundModel.provider?'（'+data.roundModel.provider+'）':''):' · 尚未取得模型信息'));
    }
    function ChatExpandIcon({ expanded }) {
      return h('svg', { width:16,height:16,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',strokeWidth:1.7,
        strokeLinecap:'round',strokeLinejoin:'round','aria-hidden':true,focusable:false },
        h('path', { d:expanded ? 'M20 4l-6 6M14 4v6h6M4 20l6-6M4 14h6v6' : 'M14 4h6v6M20 4l-6 6M10 20H4v-6M4 20l6-6' }));
    }
    function ChatTurnReply({turn,instance,roomId,running,started,onFinish,onSilent,held,...props}) {
      const live=useChatLive(turn.recipientId,turn,instance,onFinish,roomId);
      const silent=live.frame?.attemptId===turn.attemptId&&live.frame.status==='silent';
      useLayoutEffect(()=>{if(silent)onSilent?.(turn);},[silent,turn.attemptId]);
      return held||silent?null:h(ChatReplyBubbles,{...props,turn,running:running&&(live.frame?live.frame.status==='streaming':started),frame:live.frame});
    }
    function RoomAvatar({ memberIds = [], contacts = [] }) {
      const count=memberIds.length,visible=memberIds.slice(0,count>4?3:4);
      const layout=count===1?[[50,50,82,0]]:count===2?[[32,32,64,-2],[68,68,64,2]]
        :count===3?[[27,27,55,-2],[73,27,55,2],[50,73,55,0]]:[[25,25,46,0],[75,25,46,0],[25,75,46,0],[75,75,46,0]];
      const position=index=>{const [left,top,size,angle]=layout[index];return{left:left+'%',top:top+'%',width:size+'%',height:size+'%',
        '--tile-angle':angle+'deg',zIndex:index+1};};
      const names=memberIds.map(id=>contacts.find(p=>p.id===id)?.name??'已移除的人格');
      return h('span',{className:'dsh-persona-room-avatar','data-count':String(count),'data-visible-count':String(visible.length),role:'img',
        'aria-label':count?'聊天室成员：'+names.join('、')+'，共 '+count+' 位':'暂无成员的聊天室'},
        ...visible.map((id,index)=>{const person=contacts.find(p=>p.id===id);return h('span',{key:id,'aria-hidden':true,
          className:'dsh-persona-room-avatar-tile',style:position(index)},h(PersonaAvatar,{id,name:person?.name??'角色',src:person?.avatar,
            style:{display:'grid',placeItems:'center',width:'100%',height:'100%',borderRadius:'inherit',background:'var(--chat-soft)',
              color:'var(--chat-text)',fontSize:'var(--room-avatar-letter)'}}));}),
        count>4?h('span',{className:'dsh-persona-room-avatar-tile dsh-persona-room-avatar-more','aria-hidden':true,style:position(3)},'+'+(count-3)):null);
    }
    function RoomRecipient({ contacts, memberIds, value, disabled, onChange }) {
      const root=React.useRef(null);
      if(memberIds.length<2)return null;
      const targets=value.filter(id=>memberIds.includes(id)&&contacts.some(p=>p.id===id&&!p.archived));
      return h('div',{className:'dsh-persona-chat-recipient',ref:root,role:'group','aria-label':'回复对象','aria-description':targets.length?'已选 '+targets.length+' 位，第一位优先回应，其余按顺序关注':'发给房间，未指定回复对象','data-crowded':memberIds.length>4,title:'不点名时发给房间；第一位点名对象优先，其余依次关注',onKeyDown:e=>{
        if(disabled||!['ArrowRight','ArrowLeft','ArrowDown','ArrowUp','Home','End'].includes(e.key))return;
        e.preventDefault();const options=[...root.current.querySelectorAll('[role=checkbox]:not(:disabled)')];
        if(!options.length)return;const index=options.indexOf(document.activeElement);
        const next=e.key==='Home'?0:e.key==='End'?options.length-1:(index+(['ArrowRight','ArrowDown'].includes(e.key)?1:-1)+options.length)%options.length;
        options[next].focus({preventScroll:true});
      }},
        !targets.length?h('small',{style:{fontSize:11,color:'var(--chat-muted)',whiteSpace:'nowrap'}},'发给房间'):null,
        ...memberIds.map(id=>{const person=contacts.find(p=>p.id===id),selected=targets.includes(id);
        const order=selected&&targets.length>1?targets.indexOf(id)+1:undefined;
        const hint=person?.archived?'这位角色已移除':selected?targets.indexOf(id)===0?'优先回应，点击取消 @'+person.name:'第 '+order+' 位关注对象，点击取消 @'+person.name:'同时 @'+(person?.name??'角色');
        return h('button',{
        key:id,type:'button',role:'checkbox',className:'dsh-persona-chat-recipient-option','aria-label':person?.name??'已移除的人格',
        'aria-checked':selected,'aria-description':hint,disabled:disabled||!person||person.archived,
        title:(person?.name??'已移除的人格')+' · '+hint,onClick:()=>{const next=selected?targets.filter(p=>p!==id):[...targets,id];void onChange(next);}},
        h('span',{className:'dsh-persona-chat-recipient-portrait','data-order':order},h(PersonaAvatar,{id,name:person?.name??'已移除的人格',src:person?.avatar,className:'dsh-persona-chat-avatar'})),
        h('span',null,((id==='大肥鱼（默认）'&&person?.name==='大肥鱼（默认）')?'大肥鱼':(id==='鲸鲸（实验性）'&&person?.name==='小肥鱼（实验性）')?'小肥鱼':person?.name??'已移除的人格')+(person?.archived?'（已移除）':'')));}));
    }
    function roomReferenceHint(context, foreground) {
      if (!context?.initialized) return { text: '连接中', title: '正在初始化参考来源', different: false };
      const sources = Array.isArray(context.sources) ? context.sources : [];
      const primary = sources.find(source => source.sessionId === context.primarySessionId) ?? sources[0];
      const name = typeof primary?.name === 'string' ? primary.name.trim() : '';
      const different = !!foreground && !!primary?.sessionId && foreground !== primary.sessionId;
      const names = sources.map(source => typeof source.name === 'string' ? source.name.trim() : '').filter(Boolean);
      return {
        text: name ? (different ? '固定 · ' : '来源 · ') + name + (sources.length > 1 ? ' +' + (sources.length - 1) : '') : '来源 · ' + sources.length,
        title: '固定参考 · ' + (names.length ? names.join('、') : sources.length + ' 个会话')
          + '。切换工作页不会更换来源。' + (different ? '主要参考与当前工作页不同。' : ''),
        different,
      };
    }

    function WorkDraftPanel({roomId,scopeKey,generation,discussionRevision,onClose,onMinimize}){
      const [saved,setSaved]=React.useState(()=>chatWorkDrafts.get(roomId)??{instruction:'',refs:[],draft:'',basis:null});
      const [data,setData]=React.useState(null),[loading,setLoading]=React.useState(false),[busy,setBusy]=React.useState(false),[placing,setPlacing]=React.useState(false);
      const [info,setInfo]=React.useState(''),[filter,setFilter]=React.useState(''),[confirmation,setConfirmation]=React.useState(null),[,redraw]=React.useState(0);
      const own=React.useRef({live:true,token:0,abort:null,requestId:null,busy:false,editing:0}),state=React.useRef(saved),output=React.useRef(null),heading=React.useRef(null);
      const confirmationRoot=React.useRef(null),draftAction=React.useRef(null),conclusionAction=React.useRef(null);
      useLayoutEffect(()=>{if(confirmation)confirmationRoot.current?.querySelector('button')?.focus();},[confirmation]);
      const cancelConfirmation=()=>{const action=confirmation?.intent.mode==='conclusion'?conclusionAction:draftAction;setConfirmation(null);action.current?.focus({preventScroll:true});};
      state.current=saved;
      const refKey=ref=>JSON.stringify(ref),choices=data?.choices??[],selected=saved.refs.map(ref=>choices.find(q=>refKey(q.ref)===refKey(ref)));
      const unavailable=selected.filter(q=>!q).length,available=selected.filter(Boolean);
      const keep=value=>{state.current=value;keepDraft(chatWorkDrafts,roomId,value);setSaved(value);};
      const stop=(update=true)=>{const current=own.current,id=current.requestId;current.token++;current.abort?.abort();current.abort=null;current.requestId=null;current.busy=false;
        if(id)void fetch(ROUTE+'/chat-work-draft',{method:'POST',headers:{'content-type':'application/json'},keepalive:true,body:JSON.stringify({action:'cancel',roomId,requestId:id})}).catch(()=>{});
        if(update&&current.live){setBusy(false);setPlacing(false);setLoading(false);setConfirmation(null);}};
      const load=async()=>{
        if(own.current.busy)return;const current=own.current,token=++current.token;current.abort?.abort();const abort=new AbortController();current.abort=abort;
        let timedOut=false;const timeout=setTimeout(()=>{timedOut=true;abort.abort();},10000);
        setLoading(true);setInfo('');setData(null);setConfirmation(null);
        try{const response=await fetch(ROUTE+'/chat-work-draft?room='+encodeURIComponent(roomId),{signal:abort.signal}),value=await response.json();
          if(!response.ok)throw Error(value.error);if(value.room?.id!==roomId||!Array.isArray(value.choices))throw Error('invalid');
          if(current.live&&current.token===token&&!abort.signal.aborted)setData(value);
        }catch{if(current.live&&current.token===token&&(!abort.signal.aborted||timedOut))setInfo('暂时无法读取原话，草稿保留。请重试。');}
        finally{clearTimeout(timeout);if(current.live&&current.token===token)setLoading(false);}
      };
      React.useEffect(()=>{own.current.live=true;heading.current?.focus({preventScroll:true});void load();
        const refresh=()=>redraw(v=>v+1);workInputListeners.add(refresh);chatForegroundListeners.add(refresh);
        return()=>{own.current.live=false;stop(false);workInputListeners.delete(refresh);chatForegroundListeners.delete(refresh);};},[]);
      const context=React.useRef({scopeKey,generation,discussionRevision});
      React.useEffect(()=>{const previous=context.current;context.current={scopeKey,generation,discussionRevision};
        if(previous.scopeKey===scopeKey&&previous.generation===generation&&previous.discussionRevision===discussionRevision)return;
        stop();setData(null);setInfo('房间参考或讨论状态已变化，请刷新核对原话。已有草稿保留。');
      },[scopeKey,generation,discussionRevision]);
      const edit=value=>{own.current.editing++;setConfirmation(null);keep({...state.current,...value});};
      const sameBasis=(basis,expected)=>basis?.roomId===roomId&&basis.scopeKey===expected.scopeKey&&basis.epoch===expected.epoch
        &&basis.discussionRevision===expected.discussionRevision&&JSON.stringify(basis.refs)===JSON.stringify(expected.refs);
      const emptyInput=value=>value?.phase==='plain'&&value.draft===''
        &&Array.isArray(value.attachmentIds)&&value.attachmentIds.length===0&&Array.isArray(value.occurrences)&&value.occurrences.length===0;
      const captureTarget=()=>{
        const fixed=chatForegroundSession,adapter=workInputBindings.get(fixed),snapshot=adapter?.state;
        if(!fixed||!adapter){setInfo('工作输入框暂不可用。可先整理草稿并复制。');return null;}
        if(!emptyInput(snapshot)){setInfo('工作输入框已有文字、附件或正在发送。请先处理原输入，也可以只整理草稿。');return null;}
        let span;try{span=adapter.actions.captureInsertion();}catch{setInfo('工作输入框暂不可用，草稿保留，可以复制。');return null;}
        if(span?.start!==0||span.end!==0||span.draftRev!==snapshot.draftRev){setInfo('工作输入框已变化，请重新核对后再试。');return null;}
        const captured = {fixed,adapter,span,title:adapter.title||'当前工作会话'};
        own.current.targetTitle = captured.title;
        return captured;
      };
      const targetUnchanged=captured=>captured&&chatForegroundSession===captured.fixed&&workInputBindings.get(captured.fixed)===captured.adapter
        &&emptyInput(captured.adapter.state)&&captured.adapter.state.draftRev===captured.span.draftRev;
      const insertDraft=async(value,captured,token,editing,abort,automatic)=>{
        const current=own.current;if(!targetUnchanged(captured))throw Error('target-changed');
        setPlacing(true);let timedOut=false;const timeout=setTimeout(()=>{timedOut=true;abort.abort();},10000);
        try{const response=await fetch(ROUTE+'/chat-work-draft',{method:'POST',headers:{'content-type':'application/json'},signal:abort.signal,
          body:JSON.stringify({action:'validate',...value.basis,instruction:value.instruction})}),checked=await response.json();
          if(!response.ok||checked.valid!==true||!sameBasis(checked.basis,value.basis))throw Error('source-changed');
          if(!current.live||current.token!==token||abort.signal.aborted)return false;
          if(current.editing!==editing||!targetUnchanged(captured))throw Error('target-changed');
          if(captured.adapter.actions.insertText(value.draft,captured.span)!==true)throw Error('target-changed');
          try{captured.adapter.actions.persistDraft?.();}catch{/* The native draft already contains the text; never duplicate the insertion. */}
          setInfo('已填入工作会话输入框，请在工作区检查后发送。');
          if(automatic)onMinimize?.({preserveWorkFocus:true});
          return true;
        }catch(error){if(timedOut)throw Object.assign(Error('source-changed'),{timedOut:true});throw error;}
        finally{clearTimeout(timeout);}
      };
      const begin=async mode=>{
        if(own.current.busy||!data||!saved.refs.length||unavailable)return;
        const captured=mode==='conclusion'?captureTarget():null;if(mode==='conclusion'&&!captured)return;
        const current=own.current,editing=current.editing,token=++current.token,abort=new AbortController(),previous=data;
        current.targetTitle = captured?.title ?? null;
        const intent={mode,captured,editing,basis:{roomId,epoch:data.epoch,scopeKey:data.scopeKey,discussionRevision:data.discussionRevision,refs:saved.refs},instruction:saved.instruction};
        current.abort?.abort();current.abort=abort;current.busy=true;setLoading(true);setInfo('');setConfirmation(null);
        let checkedIntent=null,timedOut=false;const timeout=setTimeout(()=>{timedOut=true;abort.abort();},10000);
        try{const response=await fetch(ROUTE+'/chat-work-draft?room='+encodeURIComponent(roomId),{signal:abort.signal}),value=await response.json();
          if(!response.ok)throw Error(value.error);
          if(!current.live||current.token!==token||abort.signal.aborted)return;
          if(value.room?.id!==roomId||!Array.isArray(value.choices))throw Error('invalid');
          if(value.scopeKey!==intent.basis.scopeKey||value.discussionRevision!==intent.basis.discussionRevision){
            setData(value);setInfo('房间参考或讨论状态已变化，请刷新核对原话。已有草稿保留。');return;}
          if(current.editing!==editing){setData(value);setInfo('你已修改选择或草稿，请核对后重新整理。');return;}
          const missing=intent.basis.refs.filter(ref=>!value.choices.some(q=>refKey(q.ref)===refKey(ref)));
          if(missing.length){
            const validation=await fetch(ROUTE+'/chat-work-draft',{method:'POST',headers:{'content-type':'application/json'},signal:abort.signal,
              body:JSON.stringify({action:'validate',...intent.basis,instruction:intent.instruction})}),valid=await validation.json();
            if(!current.live||current.token!==token||abort.signal.aborted)return;
            if(!validation.ok||valid.valid!==true||!sameBasis(valid.basis,intent.basis)){setData(value);setInfo('所选原话已变化，请刷新核对。已有草稿保留。');return;}
            for(const ref of missing){const quote=previous.choices.find(q=>refKey(q.ref)===refKey(ref));if(quote)value.choices.push(quote);}
          }
          if(!current.live||current.token!==token||abort.signal.aborted)return;
          if(current.editing!==editing){setInfo('你已修改选择或草稿，请核对后重新整理。');return;}
          setData(value);checkedIntent={...intent,defaultThinking:value.thinking===true};
        }catch{if(current.live&&current.token===token&&(!abort.signal.aborted||timedOut))setInfo('暂时无法核对原话与思考设置，已有草稿保留。请重试。');}
        finally{clearTimeout(timeout);if(current.live&&current.token===token){current.busy=false;setLoading(false);}}
        if(!checkedIntent||!current.live||current.token!==token)return;
        if(checkedIntent.mode==='conclusion'&&!targetUnchanged(checkedIntent.captured)){setInfo('工作会话或输入框已变化，没有开始整理。请重新核对目标。');return;}
        if(state.current.draft){setConfirmation({stage:'replace',intent:checkedIntent});return;}chooseThinking(checkedIntent);
      };
      const chooseThinking=intent=>{
        if(own.current.busy||intent.editing!==own.current.editing)return;
        if(intent.mode==='conclusion'&&!targetUnchanged(intent.captured)){setConfirmation(null);setInfo('工作会话或输入框已变化，没有开始整理。请重新核对目标。');return;}
        if(intent.defaultThinking===true)void generate(intent,true);else setConfirmation({stage:'thinking',intent});
      };
      const generate=async(intent,thinking)=>{
        if(own.current.busy||!data||intent.editing!==own.current.editing)return;
        if(intent.mode==='conclusion'&&!targetUnchanged(intent.captured)){setConfirmation(null);setInfo('工作会话或输入框已变化，没有开始整理。请重新核对目标。');return;}
        const current=own.current,token=++current.token,editing=current.editing,abort=new AbortController(),requestId=chatNonce();
        current.targetTitle = intent.captured?.title ?? null;
        current.abort?.abort();current.abort=abort;current.requestId=requestId;current.busy=true;setBusy(true);setInfo('');setConfirmation(null);
        const basis=intent.basis;
        let timedOut=false;const timeout=setTimeout(()=>{timedOut=true;abort.abort();
          void fetch(ROUTE+'/chat-work-draft',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'cancel',roomId,requestId})}).catch(()=>{});},thinking?70000:25000);
        try{const response=await fetch(ROUTE+'/chat-work-draft',{method:'POST',headers:{'content-type':'application/json'},signal:abort.signal,
          body:JSON.stringify({action:'generate',requestId,...basis,instruction:intent.instruction,thinking})}),value=await response.json();
          if(!response.ok)throw Object.assign(Error(value.error),{status:response.status});
          if(current.live&&current.token===token&&!abort.signal.aborted){
            if(value.requestId!==requestId||!sameBasis(value.basis,basis)||typeof value.draft!=='string'||value.draft.length>6000||value.thinking!==thinking
              ||!['enabled','unavailable','unknown','off'].includes(value.thinkingStatus))throw Error('invalid');
            if(current.editing!==editing){setInfo('整理已结束，但你已修改草稿，保留你的编辑。');return;}
            const next={...state.current,draft:value.draft,basis:value.basis,thinking:value.thinking,thinkingStatus:value.thinkingStatus};keep(next);
            clearTimeout(timeout);current.requestId=null;
            if(thinking&&value.thinkingStatus==='unavailable'){setInfo('模型不支持本次思考，已保留草稿。请核对后手动填入。');return;}
            if(intent.mode==='conclusion'&&thinking&&value.thinkingStatus==='unknown'){
              setInfo('无法确认模型本次思考方式，结论已保留为草稿。请核对后手动填入。');return;}
            if(intent.mode==='conclusion')await insertDraft(next,intent.captured,token,editing,abort,true);
            else setInfo(value.thinkingStatus==='unknown'?'草稿已整理；思考方式由模型提供方决定。请核对后使用。':'草稿已整理，可修改后复制，或填入当前工作输入框。不会自动发送。');
          }
        }catch(error){if(current.live&&current.token===token&&(!abort.signal.aborted||timedOut||error.timedOut))setInfo(error.status===409
          ?'所选原话或讨论状态已变化，请刷新核对。已有草稿保留。':error.message==='target-changed'
            ?'工作会话或输入框已变化，没有填入。结论草稿已保留，可核对后手动填入或复制。':error.message==='source-changed'
              ?'原话依据已变化或暂不可核对，没有填入。结论草稿已保留。':'这次未能整理完成，要求、选择和已有草稿都保留，可以重试。');}
        finally{clearTimeout(timeout);if(current.live&&current.token===token){current.busy=false;current.requestId=null;setBusy(false);setPlacing(false);}}
      };
      const copy=async()=>{const text=state.current.draft;if(!text.trim())return;
        try{if(typeof navigator.clipboard?.writeText!=='function')throw Error('unavailable');await navigator.clipboard.writeText(text);
          if(own.current.live)setInfo('已复制工作指令草稿；尚未发送到工作会话。');
        }catch{if(own.current.live){output.current?.focus();output.current?.select();setInfo('复制未完成，已选中文本，请按 Ctrl+C 或长按复制。');}};
      };
      const target=chatForegroundSession,binding=workInputBindings.get(target);
      const capturedTargetTitle = confirmation?.intent?.captured?.title ?? (own.current.busy ? own.current.targetTitle : null);
      const targetTitle = capturedTargetTitle ? capturedTargetTitle
        : target ? binding?.title || '当前工作会话（名称暂不可用）' : '暂无前台工作会话';
      const place=async()=>{
        const value=state.current,current=own.current;if(current.busy||!value.draft.trim()||!value.basis)return;
        const captured=captureTarget();if(!captured)return;
        const token=++current.token,abort=new AbortController(),editing=current.editing;current.abort?.abort();current.abort=abort;current.busy=true;setPlacing(true);setInfo('');
        try{await insertDraft(value,captured,token,editing,abort,false);
        }catch(error){if(current.live&&current.token===token&&(!abort.signal.aborted||error.timedOut))setInfo(error.message==='target-changed'
          ?'工作会话或输入框已变化，没有填入。草稿保留，可重新核对或复制。':'原话依据已变化或暂不可核对，没有填入。请刷新后重新整理，也可以复制草稿。');}
        finally{if(current.live&&current.token===token){current.busy=false;setPlacing(false);}}
      };
      const selectedKeys=new Set(saved.refs.map(refKey)),filtered=choices.filter(q=>!filter.trim()||(q.author.name+' '+q.text).toLowerCase().includes(filter.trim().toLowerCase()));
      return h('section',{className:'dsh-persona-work-draft',role:'region','aria-label':'工作指令草稿',onKeyDown:event=>{
        if(event.key==='Escape'&&!event.nativeEvent?.isComposing&&confirmation){event.stopPropagation();event.preventDefault();cancelConfirmation();}
      }},h('style',null,
        `.dsh-persona-work-draft{position:absolute;z-index:4;inset:80px 10px 10px;overflow:auto;overscroll-behavior:contain;background:var(--chat-bg);border:1px solid var(--chat-border);border-radius:11px;box-shadow:0 12px 35px #0002;padding:12px;min-width:0;font-size:12px}.dsh-persona-work-draft header{position:sticky;top:-12px;z-index:1;display:flex;align-items:center;gap:10px;margin:-12px -12px 8px;padding:10px 12px;background:var(--chat-bg);border-bottom:1px solid var(--chat-border)}.dsh-persona-work-draft header strong{flex:1;font-size:14px}.dsh-persona-work-draft p{margin:7px 0;color:var(--chat-muted);line-height:1.65;overflow-wrap:anywhere}.dsh-persona-work-draft label{display:block;margin:9px 0}.dsh-persona-work-draft input[type=search],.dsh-persona-work-draft textarea{width:100%;min-width:0;font:inherit;line-height:1.65;color:var(--chat-text);background:var(--chat-soft);border:1px solid var(--chat-border);border-radius:7px;padding:7px 9px;box-sizing:border-box}.dsh-persona-work-draft textarea{resize:vertical;min-height:62px}.dsh-persona-work-draft .dsh-persona-work-output{min-height:170px}.dsh-persona-work-choice-list{max-height:190px;overflow:auto;border-block:1px solid var(--chat-border);padding:5px 0}.dsh-persona-work-choice{display:flex;align-items:start;gap:7px;padding:5px 0}.dsh-persona-work-choice input{flex:none;margin-top:5px;accent-color:var(--chat-brand)}.dsh-persona-work-choice details{min-width:0;flex:1}.dsh-persona-work-choice summary{cursor:pointer;line-height:1.7;overflow-wrap:anywhere}.dsh-persona-work-choice blockquote{white-space:pre-wrap;overflow-wrap:anywhere;margin:7px 0;padding:7px 9px;border-inline-start:2px solid var(--chat-brand);max-height:130px;overflow:auto}.dsh-persona-work-draft-actions{display:flex;gap:7px;flex-wrap:wrap;margin:10px 0}.dsh-persona-work-draft-actions button{font-size:11px;min-height:29px}.dsh-persona-work-draft-status{font-size:11px}@media(max-width:420px){.dsh-persona-work-draft{inset:70px 7px 7px;padding:10px}.dsh-persona-work-draft header{top:-10px;margin:-10px -10px 8px;padding:9px 10px}.dsh-persona-work-choice-list{max-height:160px}}`),
        h('style',null,'.dsh-persona-work-draft-actions button[data-primary]{background:var(--chat-brand);color:#fff;border-color:transparent}'),
        h('header',null,h('strong',{ref:heading,tabIndex:-1},'整理工作指令'),h('button',{type:'button','aria-label':'收起指令草稿',onClick:onClose},'收起')),
        h('p',null,'选择本房间原话，整理成可编辑的工作指令。生成只在你点击后进行；不会自动发送或写入记忆。'),
        h('div',{className:'dsh-persona-work-draft-actions'},h('button',{type:'button',disabled:busy||placing||loading,onClick:load},loading?'正在读取原话…':'刷新可选原话'),h('span',null,'已选 '+saved.refs.length+'/12')),
        data?h(React.Fragment,null,h('label',null,'筛选原话',h('input',{type:'search','aria-label':'筛选整理原话',value:filter,onChange:e=>setFilter(e.target.value)})),
          unavailable?h('p',{role:'status'},'有 '+unavailable+' 条原话已失效，请取消选择后重新核对。',h('button',{type:'button',disabled:busy||placing,onClick:()=>edit({refs:available.map(q=>q.ref)})},'清除失效选择')):null,
          h('div',{className:'dsh-persona-work-choice-list','aria-label':'可整理的原话'},...filtered.map((q,index)=>{const key=refKey(q.ref),checked=selectedKeys.has(key),author=q.author.role==='user'?'我':q.author.name;
            return h('div',{key,className:'dsh-persona-work-choice'},h('input',{type:'checkbox','aria-label':'选择原话 '+author+' '+q.text.slice(0,28),checked,disabled:busy||placing||(!checked&&saved.refs.length>=12),onChange:()=>edit({refs:checked?saved.refs.filter(ref=>refKey(ref)!==key):[...saved.refs,q.ref]})}),
              h('details',null,h('summary',null,author+' · '+Array.from(q.text.replace(/\s+/g,' ')).slice(0,70).join('')),h('blockquote',null,q.text)));}),
            !choices.length?h('p',null,'当前范围还没有可整理的原话，先聊几句再来。'):!filtered.length?h('p',null,'没有匹配的原话，试试其他关键词。'):null)) :null,
        h('label',null,'整理要求（可选）',h('textarea',{'aria-label':'工作指令整理要求',maxLength:2000,rows:2,value:saved.instruction,disabled:busy||placing,onChange:e=>edit({instruction:e.target.value})})),
        h('p',{'data-work-draft-target':'conclusion'},'填入目标：'+targetTitle+'。'+(capturedTargetTitle?'本次目标已固定，不会改投其他会话。':'只填入空输入框，由你在工作区发送。')),
        h('div',{className:'dsh-persona-work-draft-actions'},h('button',{type:'button',ref:draftAction,disabled:loading||busy||placing||!data||!saved.refs.length||!!unavailable,onClick:()=>begin('draft')},busy?'正在整理…':'整理草稿'),
          h('button',{type:'button',ref:conclusionAction,'data-primary':'',disabled:loading||busy||placing||!data||!saved.refs.length||!!unavailable,onClick:()=>begin('conclusion')},'整理结论并填入'),
          busy?h('button',{type:'button',onClick:()=>{stop();setInfo('已停止这次整理，已有草稿保留。');}},'停止整理'):null),
        confirmation?h('div',{ref:confirmationRoot,className:'dsh-persona-chat-info',role:'group','aria-label':confirmation.stage==='thinking'?'本次结论思考设置':'重新整理确认'},
          confirmation.stage==='replace'?h(React.Fragment,null,'重新整理会替换下方已有草稿。',
            h('button',{type:'button',onClick:()=>chooseThinking(confirmation.intent)},'确认重新整理'),
            h('button',{type:'button',onClick:cancelConfirmation},'保留当前草稿'))
            :h(React.Fragment,null,h('strong',null,'这次整理是否开启思考？'),h('p',null,'只影响本次整理，不改变聊天室设置。思考能力以模型支持为准。'),
              confirmation.intent.mode==='conclusion'?h('p',null,'结论将填入：'+confirmation.intent.captured.title+'。成功后聊天室会最小化，仍由你修改并发送。'):null,
              h('button',{type:'button',onClick:()=>void generate(confirmation.intent,true)},'开启思考并继续'),
              h('button',{type:'button',onClick:()=>void generate(confirmation.intent,false)},'保持关闭并继续'),
              h('button',{type:'button',onClick:cancelConfirmation},'取消本次整理'))):null,
        h('p',{className:'dsh-persona-work-draft-status',role:'status','aria-live':'polite'},info),
        h('label',null,'工作指令草稿',h('textarea',{ref:output,className:'dsh-persona-work-output','aria-label':'可编辑的工作指令草稿',maxLength:6000,rows:7,value:saved.draft,onChange:e=>edit({draft:e.target.value})})),
        saved.thinkingStatus==='unknown'?h('p',null,'本次思考方式由模型提供方决定，请核对结论。'):saved.thinkingStatus==='unavailable'?h('p',null,'模型不支持本次思考。草稿保留供你核对，不会自动填入。'):null,
        h('div',{className:'dsh-persona-work-draft-actions'},h('button',{type:'button',disabled:!saved.draft.trim(),onClick:()=>void copy()},'复制草稿'),
          h('button',{type:'button',disabled:busy||placing||!saved.draft.trim()||!saved.basis||!binding||!emptyInput(binding.state),onClick:()=>void place()},placing?'正在核对…':'填入当前工作输入框')),
        h('p',{'data-work-draft-target':'manual'},'填入目标：'+targetTitle+'。'+(!binding?'宿主尚未提供可用的输入框接口，可以复制草稿。':!emptyInput(binding.state)?'输入框已有文字、附件或正在发送时不会填入。':'只填入空输入框，由你在工作区确认发送。')));
    }
    function RoomChatWorkspace({sessionId,conversation,onClose}) {
      const [data,setData]=React.useState(null),[roomId,setRoomId]=React.useState(null),[panel,setPanel]=React.useState(null);
      const [notice,setNotice]=React.useState(''),[busy,setBusy]=React.useState(false),[name,setName]=React.useState(''),[members,setMembers]=React.useState([]),[deleting,setDeleting]=React.useState(false);
      const [search,setSearch]=React.useState('');
      const openingSurface=React.useRef(null);
      // The loading surface already represents this opening. Replacing its content must not restart the fade.
      useLayoutEffect(()=>enterChatSurface(openingSurface.current),[]);
      const lifetime=React.useRef({live:true,sequence:0,busy:false,readAbort:null,needsFirstRoom:true}),selected=React.useRef(null),creation=React.useRef(chatNonce()),editVersion=React.useRef(0);
      const draftMembersEdited=React.useRef(false);
      const accept=value=>{useChatUiNamespace(value.localStateKey,value.instanceId);restoreChatUi(value.room,value.scopeKey);
        if(value.ready&&Array.isArray(value.rooms)){const ids=new Set(value.rooms.map(room=>room.id));for(const id of chatUi.keys())if(!ids.has(id))clearChatUi(id);}
        if(value.room&&selected.current!==value.room.id)updateChatUi(value.room.id,{visitedAt:Date.now()});
        setData(value);selected.current=value.room?.id??null;if(selected.current)lifetime.current.needsFirstRoom=false;setRoomId(selected.current);};
      const readChat=async(signal)=>{
        const query=new URLSearchParams(),foreground=chatForegroundSession??sessionId;
        if(selected.current)query.set('room',selected.current);if(foreground)query.set('session',foreground);
        const response=await fetch(ROUTE+'/chat?'+query,{signal}),value=await response.json();
        if(!response.ok)throw Error(value.error);return value;
      };
      const request=async(body)=>{const response=await fetch(ROUTE+'/chat-rooms',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
        const value=await response.json();if(!response.ok)throw Object.assign(Error(value.error),{state:value.state});return value;};
      const load=async(createDefault=false)=>{
        const own=lifetime.current,token=++own.sequence;setNotice('');
        own.readAbort?.abort();const abort=new AbortController();own.readAbort=abort;
        try{let value=await readChat(abort.signal);
          if(!own.live||token!==own.sequence)return;
          if(value.chatSchema!==3||value.discussionVersion!==2){accept(value);setNotice('聊天室后台需要重新加载，请完整退出并重新打开 DSH。');return;}
          if(!value.room&&createDefault&&value.ready){const id=value.reportPersonaId??value.defaultPersonaId,person=value.contacts.find(p=>p.id===id&&!p.archived);
            if(person)value=await request({action:'ensure-first',requestId:creation.current,name:('与'+person.name+'的聊天').slice(0,60),memberIds:[id],targetPersonaId:id,epoch:value.epoch});}
          if(own.live&&token===own.sequence)accept(value);
        }catch(error){if(own.live&&token===own.sequence&&!abort.signal.aborted)setNotice(chatErrorText(error.message));}
      };
      React.useEffect(()=>{lifetime.current.live=true;void load(true);return()=>{lifetime.current.live=false;lifetime.current.sequence++;lifetime.current.readAbort?.abort();};},[]);
      const change=async(body)=>{
        const own=lifetime.current;if(own.busy)return;own.busy=true;setBusy(true);setNotice('');const token=++own.sequence;
        chatUiFlushers.get(selected.current)?.();
        try{const value=await request({...body,epoch:data.epoch});if(!own.live||token!==own.sequence)return;
          if(body.action==='delete')clearChatUi(body.roomId);
          accept(value);setPanel(value.room?null:'rooms');setDeleting(false);return true;
        }catch(error){if(own.live&&token===own.sequence){if(error.state?.room?.id===selected.current)setData(error.state);
          setNotice(error.message==='chat-conflict'?'聊天室资料已变化，草稿保留。请重新载入成员核对后保存。':chatErrorText(error.message));}return false;
        }finally{own.busy=false;if(own.live)setBusy(false);}
      };
      const openCreate=()=>{creation.current=chatNonce();let number=1;while(data?.rooms?.some(r=>r.name==='新聊天室 '+number))number++;
        setName('新聊天室 '+number);draftMembersEdited.current=false;setMembers([]);setPanel('create');setDeleting(false);setNotice('');};
      React.useEffect(()=>{
        if(panel!=='create')return;
        // Read the foreground work persona when starting this draft. Room snapshots normally describe the fixed source.
        const abort=new AbortController();
        void readChat(abort.signal).then(value=>{
          if(abort.signal.aborted)return;
          const id=value.reportPersonaId??value.defaultPersonaId;
          if(!value.ready||!value.contacts.some(p=>p.id===id&&!p.archived))throw Error('persona-unavailable');
          setData(previous=>previous?{...previous,contacts:value.contacts}:previous);
          if(!draftMembersEdited.current)setMembers([id]);
        }).catch(()=>{if(!abort.signal.aborted&&!draftMembersEdited.current)setNotice('暂时无法读取当前汇报人格，请手动选择参与人格。');});
        return()=>abort.abort();
      },[panel]);
      const openEdit=()=>{if(!data?.room)return;setName(data.room.name);setMembers([...data.room.memberIds]);editVersion.current=data.room.configRevision;setPanel('edit');setDeleting(false);setNotice('');};
      const openRooms=()=>{setPanel('rooms');setDeleting(false);void load(false);};
      const contacts=data?.contacts??[],room=data?.room;
      const matchingRooms=(data?.rooms??[]).filter(item=>!search.trim()||(item.name+' '+item.memberIds.map(id=>contacts.find(person=>person.id===id)?.name??'').join(' ')).toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()))
        .sort((a,b)=>(chatUi.get(b.id)?.visitedAt??b.at??0)-(chatUi.get(a.id)?.visitedAt??a.at??0));
      const panelView=panel?h('div',{className:'dsh-persona-chat-room-panel',role:'region','aria-label':panel==='rooms'?'聊天室列表':panel==='create'?'创建聊天室':'管理聊天室'},
        h('header',null,h('strong',null,panel==='rooms'?'聊天室':panel==='create'?'新建聊天室':'房间资料与成员'),h('button',{type:'button',onClick:()=>setPanel(null)},'收起面板')),
        notice?h('p',{role:'status'},notice):null,
        panel==='rooms'?h(React.Fragment,null,h('input',{type:'search','aria-label':'搜索聊天室',value:search,placeholder:'搜索房间或成员',onChange:event=>setSearch(event.target.value),style:{width:'100%',minWidth:0,marginBottom:10,padding:'7px 9px',border:'1px solid var(--chat-border)',borderRadius:7,background:'var(--chat-soft)',color:'inherit'}}),
          h('div',{className:'dsh-persona-chat-room-list'},...matchingRooms.map(item=>h('button',{
          key:item.id,type:'button','aria-label':'打开聊天室 '+item.name,'aria-pressed':item.id===roomId,disabled:busy,onClick:()=>void change({action:'select',roomId:item.id})},
          h(RoomAvatar,{memberIds:item.memberIds,contacts}),h('span',null,h('strong',null,item.name),h('small',null,item.memberIds.length+' 位人格 · '+item.turnCount+' 轮聊天'
            +((chatDrafts.get(item.id)?.text.trim()||chatDrafts.get(item.id)?.quote||chatUi.get(item.id)?.draft.text.trim()||chatUi.get(item.id)?.draft.quoteRef)?' · 有草稿':'')+(item.running?' · 正在回复':'')))))),
          !matchingRooms.length?h('p',{role:'status'},'没有找到匹配的聊天室。'):null,
          h('div',{className:'dsh-persona-chat-room-buttons'},h('button',{type:'button',disabled:busy||!data?.ready,onClick:openCreate},'新建聊天室'),h('button',{type:'button',disabled:busy,onClick:()=>void load(false)},'刷新列表')))
          :h(React.Fragment,null,h('label',null,'聊天室名称',h('input',{type:'text','aria-label':'聊天室名称',maxLength:60,value:name,disabled:busy,onChange:e=>setName(e.target.value)})),
            h('strong',null,'参与人格 · '+members.length+'/8'),
            h('div',{className:'dsh-persona-chat-room-members'},...contacts.map(person=>h('label',{key:person.id},h('input',{type:'checkbox','aria-label':'成员 '+person.name,
              checked:members.includes(person.id),disabled:busy||(person.archived&&!members.includes(person.id))||(!members.includes(person.id)&&members.length>=8),onChange:e=>{draftMembersEdited.current=true;const checked=e.target.checked;setMembers(previous=>checked?[...previous,person.id]:previous.filter(id=>id!==person.id));}}),
              h(PersonaAvatar,{id:person.id,name:person.name,src:person.avatar,className:'dsh-persona-chat-avatar'}),h('span',null,person.name+(person.archived?'（已移除）':''))))),
            h('p',null,'加入的角色可以阅读本房间近期聊天。其他房间的记录和各人格的私有记忆仍分别隔离；修改成员不会自动发言。'),
            h('div',{className:'dsh-persona-chat-room-buttons'},h('button',{type:'button','data-primary':'',disabled:busy||!name.trim()||!members.length,onClick:()=>void change(panel==='create'
              ?{action:'create',requestId:creation.current,name:name.trim(),memberIds:members,targetPersonaId:members[0]}
              :{action:'update',roomId,configRevision:editVersion.current,name:name.trim(),memberIds:members})},busy?'保存中…':panel==='create'?'创建聊天室':'保存聊天室'),
              panel==='edit'?h('button',{type:'button',disabled:busy,onClick:openEdit},'重新载入成员'):null,
              panel==='edit'?h('button',{type:'button',disabled:busy,onClick:()=>setDeleting(true)},'删除聊天室'):null),
            deleting?h('div',null,h('p',null,'删除这个聊天室及其聊天记录？其他聊天室、人格和长期记忆都会保留。'),h('div',{className:'dsh-persona-chat-room-buttons'},
              h('button',{type:'button',disabled:busy,onClick:()=>void change({action:'delete',roomId,revision:room.revision})},'确认删除聊天室'),
              h('button',{type:'button',onClick:()=>setDeleting(false)},'取消删除'))):null)) : null;
      if(roomId&&room&&data.chatSchema===3&&data.discussionVersion===2)return h(PersonaChatWindow,{key:roomId,roomId,initialState:data,roomBusy:busy,sessionId:chatForegroundSession??sessionId,conversation,onClose,animateEntrance:false,
        roomPanel:panelView,onDismissPanel:()=>setPanel(null),onOpenRooms:openRooms,onOpenMembers:openEdit,
        onRoomState:value=>{if(lifetime.current.live&&value.room?.id===selected.current)setData(value);},onRoomMissing:()=>{selected.current=null;setRoomId(null);setPanel('rooms');void load(false);}});
      return h('section',{ref:openingSurface,className:'dsh-persona-chat','data-wide':String(chatRoomLayout.wide),role:'dialog','aria-label':'聊天室',onKeyDown:e=>{if(e.key==='Escape'&&!e.nativeEvent?.isComposing){e.stopPropagation();if(panel)setPanel(null);else onClose();}}},h('style',null,CHAT_CSS,ROOM_CHAT_CSS),
        h('header',{style:{display:'flex',justifyContent:'space-between',padding:'12px'}},h('strong',null,'聊天室'),h('button',{type:'button','aria-label':'关闭聊天室',onClick:onClose},'关闭')),
        h('div',{className:'dsh-persona-chat-room-loading'},h('p',{role:'status'},notice||(!data?'正在读取聊天室…':!data.ready?'聊天存储正在准备，稍后可重新读取。':'选择一个聊天室，或新建一段讨论。')),
          h('button',{type:'button',onClick:()=>void load(lifetime.current.needsFirstRoom)},'重新读取'),data?.chatSchema===3&&data.ready&&!panel?h('button',{type:'button',onClick:openCreate},'新建聊天室'):null),panelView);
    }
    function PersonaChatWindow({ onClose, sessionId, conversation,roomId:explicitRoomId,initialState,roomBusy=false,onRoomState,onRoomMissing,
      roomPanel,onDismissPanel,onOpenRooms,onOpenMembers,animateEntrance=true }) {
      const [minimized,setMinimized]=React.useState(()=>chatRuntime.minimized);
      const dockButton=React.useRef(null),dockSession=React.useRef(null),surface=React.useRef(null);
      useFloatingDock(surface,minimized);
      useLayoutEffect(()=>{const update=()=>setMinimized(chatRuntime.minimized);chatLaunchListeners.add(update);update();
        return()=>chatLaunchListeners.delete(update);},[]);
      const contextState=useChatContext(sessionId,explicitRoomId,minimized),context=contextState.value;
      const fixedSessionId=context?.primarySessionId??sessionId;
      const fixedReportPersona=context?.reportPersonaId??conversation?.effectivePersonaId;
      const [foreground,setForeground]=React.useState(chatForegroundSession??sessionId);
      const [sourcesOpen,setSourcesOpen]=React.useState(false),[projectId,setProjectId]=React.useState(''),[sessionChoices,setSessionChoices]=React.useState([]);
      const [sessionChoice,setSessionChoice]=React.useState('');
      React.useEffect(()=>{const update=()=>setForeground(chatForegroundSession);chatForegroundListeners.add(update);return()=>chatForegroundListeners.delete(update);},[]);
      const [data, setData] = React.useState(initialState);
      const [silenced,setSilenced]=React.useState({owner:null,attempts:[]});
      const latestData=React.useRef(initialState),roomMembers=React.useRef(initialState?.room?.memberIds??[]);
      const windowOwner = React.useRef({});
      const scope = '@global-chat';
      const [choice, setChoice] = React.useState(() => chatPersonaChoices.get(scope) ?? '');
      const [persona, setPersona] = React.useState(() => explicitRoomId?initialState?.personaId:chatPersonaChoices.get(scope) || fixedReportPersona);
      const personaRef = React.useRef(persona); personaRef.current = persona;
      const draftScope=explicitRoomId??persona;
      const [draft, setDraft] = React.useState(() => chatDrafts.get(explicitRoomId??persona) ?? emptyChatDraft());
      const [busy, setBusy] = React.useState(false);
      const busyRef = React.useRef(false);
      const [info, setInfo] = React.useState('');
      const [syncDelayed,setSyncDelayed]=React.useState(false);
      const [wide, setWide] = React.useState(()=>explicitRoomId?chatRoomLayout.wide:false);
      const [composeExpanded, setComposeExpanded] = React.useState(()=>explicitRoomId?chatRoomLayout.composeExpanded:false);
      const firstSurface=React.useRef(true);
      useLayoutEffect(()=>{const initial=firstSurface.current;firstSurface.current=false;
        if(initial&&!animateEntrance)return;return enterChatSurface(surface.current);},[minimized]);
      const [clearConfirm, setClearConfirm] = React.useState(false);
      const [retryConfirm, setRetryConfirm] = React.useState(null);
      const [appearance, setAppearance] = React.useState(false);
      const [workOpen,setWorkOpen]=React.useState(false);
      const [suggestMode, setSuggestMode] = React.useState(false);
      const [suggestions, setSuggestions] = React.useState([]);
      const [suggestBusy, setSuggestBusy] = React.useState(false);
      const [suggestInfo, setSuggestInfo] = React.useState('');
      const suggestRequest = React.useRef({ revision: 0, abort: undefined, busy: false });
      const [scrolledUp, setScrolledUp] = React.useState(false);
      const [newReplies,setNewReplies]=React.useState(0);
      const readRevision = React.useRef(0), live = React.useRef(true), reading = React.useRef(undefined);
      const host = React.useRef({ id: undefined, retired: new Set() });
      const input = React.useRef(null), thread = React.useRef(null), atBottom = React.useRef(chatUi.get(explicitRoomId)?.reading?.atBottom!==false), appearanceButton = React.useRef(null),workButton=React.useRef(null);
      const readingRestore=React.useRef(chatUi.get(explicitRoomId)?.reading??null),readingRestored=React.useRef(false),readingTimer=React.useRef(null);
      const knownReading=React.useRef(new Set(chatUi.get(explicitRoomId)?.reading?.known??(initialState?.room?.turns??[]).filter(turn=>turn.status==='ready'&&turn.phase!=='anchor').map(turn=>turn.attemptId)));
      const knownGeneration=React.useRef(initialState?.room?.generation??0);
      const boundUiScope=React.useRef(chatUiNamespace);
      const layoutTop=(node,root)=>{let top=0;for(let current=node;current&&current!==root;current=current.offsetParent)top+=current.offsetTop;return top;};
      const saveReading=()=>{
        if(!explicitRoomId||!thread.current?.isConnected||!readingRestored.current||chatUi.get(explicitRoomId)?.generation!==(latestData.current?.room?.generation??0))return;
        const element=thread.current;
        const bubble=[...element.querySelectorAll('.dsh-persona-chat-message')].find(node=>layoutTop(node,element)+node.offsetHeight>element.scrollTop+8);
        if(!bubble&&latestData.current?.room?.turns.length)return;
        const owner=bubble?.closest('[data-chat-turn],[data-chat-user-head]'),anchor=owner?{turnId:owner.getAttribute('data-chat-turn')??owner.getAttribute('data-chat-user-head'),kind:bubble.dataset.user==='true'?'user':'assistant',index:Number(bubble.dataset.chatBubble??0),
          ...(bubble.dataset.user==='true'&&bubble.dataset.chatUserPart?{messageId:bubble.dataset.chatUserPart}:{})}:null;
        updateChatUi(explicitRoomId,{selection:{start:input.current?.selectionStart??0,end:input.current?.selectionEnd??0},reading:{
          atBottom:atBottom.current,scrollTop:element.scrollTop,anchor,offset:bubble?layoutTop(bubble,element)-element.scrollTop:0,known:[...knownReading.current].slice(-256)}});
      };
      const scheduleReading=()=>{clearTimeout(readingTimer.current);readingTimer.current=setTimeout(saveReading,120);};
      const noteReadyReplies=value=>{
        const ids=(value.room?.turns??[]).filter(turn=>turn.status==='ready'&&turn.phase!=='anchor').map(turn=>turn.attemptId);
        if(atBottom.current){knownReading.current=new Set(ids);setNewReplies(0);}
        else{knownReading.current=new Set(ids.filter(id=>knownReading.current.has(id)));setNewReplies(ids.filter(id=>!knownReading.current.has(id)).length);}
      };
      const minimize=(options={})=>{
        saveReading();
        const snapshot=latestData.current;
        const known=new Set((snapshot?.room?.turns??[]).filter(t=>t.status==='ready'&&t.phase!=='anchor').map(t=>t.attemptId));
        for(const id of known)chatAnimatedAttempts.delete(id);
        dockSession.current={instance:snapshot?.instanceId,generation:snapshot?.room?.generation,known,count:0,
          scroll:thread.current?.scrollTop??0,start:input.current?.selectionStart,end:input.current?.selectionEnd,preserveWorkFocus:options.preserveWorkFocus===true};
        chatRuntime.setMinimized(true);
      };
      useLayoutEffect(()=>{
        if(minimized){if(!dockSession.current?.preserveWorkFocus)dockButton.current?.focus({preventScroll:true});return;}
        const last=dockSession.current;if(!last)return;
        dockSession.current=null;
        if(last.missing){onRoomMissing?.();return;}
        if(thread.current)thread.current.scrollTop=atBottom.current?thread.current.scrollHeight:last.scroll;
        input.current?.focus({preventScroll:true});if(last.start!=null)input.current?.setSelectionRange(last.start,last.end);
        if(!busyRef.current)void currentLoad.current(undefined,true);
      },[minimized]);
      const closeAppearance = () => { setAppearance(false); appearanceButton.current?.focus(); };
      const closeWorkDraft = () => {setWorkOpen(false);workButton.current?.focus({preventScroll:true});};
      const focusOnce = React.useRef(true);
      const contact = data?.contacts?.find((p) => p.id === persona);
      const bubbleColors=useChatBubbleColors(data?.contacts,data?.room);
      const ready = data?.personaId === persona && (!explicitRoomId||data?.room?.id===explicitRoomId) && data?.ready && context?.initialized;
      roomMembers.current=data?.room?.memberIds??[];
      const turns = ready ? data.room?.turns ?? [] : [];
      const chatNow=Date.now();
      const committedInputs=new Set(),userPartsByTurn=new Map();
      for(const turn of turns){const parts=chatUserParts(turn).filter(part=>!committedInputs.has(part.id));if(parts.length)userPartsByTurn.set(turn.id,parts);for(const part of parts)committedInputs.add(part.id);}
      const activeAttempts=new Set(data?.activeAttemptIds??[]),emitted=turn=>Number.isSafeInteger(turn.emittedOrder)&&turn.emittedOrder>=0&&turn.emittedOrder<CHAT_ROUND_SEATS;
      const silenceOwner=JSON.stringify([data?.instanceId,explicitRoomId??persona]);
      const silenceKey=turn=>JSON.stringify([turn.id,turn.attemptId]);
      const silentAttempts=new Set(silenced.owner===silenceOwner?silenced.attempts:[]);
      const rememberSilence=turn=>setSilenced(previous=>{
        const attempts=previous.owner===silenceOwner?previous.attempts:[],key=silenceKey(turn);
        return attempts.includes(key)?previous:{owner:silenceOwner,attempts:[...attempts.slice(-255),key]};
      });
      const groups=[],byMessage=new Map();
      for(const turn of turns){let group=byMessage.get(turn.messageId);if(!group){group={id:turn.messageId,head:turn,parts:[],turns:[]};byMessage.set(turn.messageId,group);groups.push(group);}group.parts.push(...(userPartsByTurn.get(turn.id)??[]));group.turns.push(turn);}
      for(const group of groups)group.responses=group.turns.map((turn,index)=>({turn,index})).filter(({turn})=>turn.phase!=='anchor'&&!silentAttempts.has(silenceKey(turn))&&(turn.status!=='pending'||emitted(turn)||activeAttempts.has(turn.attemptId))
          &&!(turn.status==='cancelled'&&!emitted(turn)&&!turn.assistant?.length&&['reaction','followup'].includes(turn.phase)))
        .sort((a,b)=>(emitted(a.turn)?a.turn.emittedOrder:a.index)-(emitted(b.turn)?b.turn.emittedOrder:b.index)||a.index-b.index).map(({turn})=>turn);
      const responseTurns=groups.flatMap(group=>group.responses),responseIndex=new Map(responseTurns.map((turn,index)=>[turn.id,index]));
      const queuedInputs=(ready&&Array.isArray(data.queuedInputs)?data.queuedInputs:[]).map(batch=>({...batch,
        parts:(Array.isArray(batch.parts)?batch.parts:[]).filter(part=>part&&chatUiId(part.id)&&typeof part.text==='string'&&!committedInputs.has(part.id))})).filter(batch=>chatUiId(batch.id)&&batch.parts.length);
      const queueWaiting=queuedInputs.some(batch=>batch.status==='pending'||batch.status==='sending');
      const queuedKey=queuedInputs.map(batch=>batch.id+':'+batch.status+':'+batch.parts.map(part=>part.id).join('|')).join(';');
      const latestMessage=turns.at(-1)?.messageId;
      const directorIssue=data?.directorFailure&&data.directorFailure.messageId===latestMessage?data.directorFailure:null;
      const directorAnswered=!!directorIssue&&turns.some(turn=>turn.messageId===latestMessage&&turn.phase!=='anchor'&&turn.status==='ready'&&turn.assistant?.length);
      const directorIssueReason=directorIssue?chatDirectorIssueReason(directorIssue):'';
      const [presented,setPresented]=React.useState({messageId:null,attempts:[]});
      const afterPresentation=turn=>setPresented(old=>{
        const attempts=old.messageId===turn.messageId?old.attempts:[];
        return attempts.includes(turn.attemptId)?old:{messageId:turn.messageId,attempts:[...attempts.slice(1-CHAT_ROUND_SEATS),turn.attemptId]};
      });
      // A queued speaker can receive stream updates, but cannot appear ahead of an earlier speaker's last bubble.
      // Historical groups render immediately, including when the user sends a new message during local playback.
      const presentationPending=t=>t.status==='pending'||(t.status==='ready'&&chatAnimatedAttempts.has(t.attemptId)
        &&!(presented.messageId===latestMessage&&presented.attempts.includes(t.attemptId)));
      const barrier=responseTurns.findIndex(t=>t.messageId===latestMessage&&presentationPending(t));
      const responseHeld=t=>barrier>=0&&responseIndex.get(t.id)>barrier&&(t.status!=='ready'||presentationPending(t));
      const pending = ready && data.running;
      const stopMessageId=pending && data.roundId && (data.roundMessageId??latestMessage);
      const pendingTurn=stopMessageId?turns.find(t=>t.messageId===stopMessageId && t.status==='pending'):undefined;
      const stopTurn=pendingTurn??(stopMessageId && ['preparing','listening'].includes(data.roundPhase)?turns.find(t=>t.messageId===stopMessageId):undefined);
      const currentContextKey = context?.id ? context.id + ':' + context.revision : null;
      const quoteScope=context?.scopeKey??data?.scopeKey??null;
      useLayoutEffect(()=>{
        if(!ready||minimized||readingRestored.current||!thread.current)return;
        const saved=readingRestore.current,element=thread.current;
        if(saved){atBottom.current=saved.atBottom;const owner=[...element.querySelectorAll('[data-chat-turn],[data-chat-user-head]')].find(node=>(node.getAttribute('data-chat-turn')??node.getAttribute('data-chat-user-head'))===saved.anchor?.turnId);
          const bubble=saved.anchor?.kind==='user'?(saved.anchor.messageId?[...element.querySelectorAll('[data-user=true][data-chat-user-part]')].find(node=>node.dataset.chatUserPart===saved.anchor.messageId):owner?.querySelector('[data-user=true]')):owner?.querySelector('[data-chat-bubble="'+(saved.anchor?.index??0)+'"]');
          element.scrollTop=saved.atBottom?element.scrollHeight:saved.scrollTop;
          if(!saved.atBottom&&bubble)element.scrollTop=layoutTop(bubble,element)-saved.offset;
          setScrolledUp(!saved.atBottom);
        }else{element.scrollTop=element.scrollHeight;atBottom.current=true;}
        const selection=chatUi.get(explicitRoomId)?.selection;if(selection)input.current?.setSelectionRange(selection.start,selection.end);
        readingRestored.current=true;noteReadyReplies(latestData.current);saveReading();
      },[ready,minimized,turns.length]);
      useLayoutEffect(()=>{const save=()=>saveReading();window.addEventListener('pagehide',save);if(explicitRoomId)chatUiFlushers.set(explicitRoomId,save);
        return()=>{clearTimeout(readingTimer.current);saveReading();window.removeEventListener('pagehide',save);if(chatUiFlushers.get(explicitRoomId)===save)chatUiFlushers.delete(explicitRoomId);};},[]);
      React.useEffect(()=>{
        if(!explicitRoomId||!data?.room)return;
        const next=restoreChatUi(data.room,quoteScope);if(next)setDraft(next);
      },[quoteScope,data?.room?.generation]);
      React.useEffect(()=>{const update=()=>{
        const snapshot=latestData.current;if(!snapshot?.room||!explicitRoomId)return;
        if(chatUiIssues.has(explicitRoomId))setInfo(chatUiIssues.get(explicitRoomId));
        if(!chatUi.has(explicitRoomId)||chatUi.get(explicitRoomId).generation>(snapshot.room.generation??0)){void currentLoad.current();return;}
        const old=chatDrafts.get(explicitRoomId),next=restoreChatUi(snapshot.room,snapshot.scopeKey);
        if(next&&old?.requestId!==next.requestId){setDraft(next);setInfo('此房间的草稿已在另一页面更新，已同步最新内容。');}
      };chatUiListeners.add(update);return()=>chatUiListeners.delete(update);},[]);
      const quoteAvailable=!draft.quote||!!chatQuotedSource(data?.room,draft.quote.ref,quoteScope);
      const avatar = (id, name) => h(PersonaAvatar, { src:data?.contacts?.find(p=>p.id===id)?.avatar, id, name, className: 'dsh-persona-chat-avatar' });
      const accept = (value, token) => {
        if (!live.current || token !== readRevision.current || (explicitRoomId?value.room?.id!==explicitRoomId:personaRef.current && value.personaId !== personaRef.current)) return;
        if (host.current.retired.has(value.instanceId) || retiredInstances.has(value.instanceId)) return;
        if(latestData.current?.instanceId===value.instanceId&&latestData.current.room?.id===value.room?.id
          &&latestData.current.room?.revision>value.room?.revision)return;
        const previousInput=latestData.current;
        if(previousInput?.instanceId===value.instanceId&&previousInput.room?.id===value.room?.id
          &&previousInput.room?.generation===value.room?.generation&&previousInput.scopeKey===value.scopeKey
          &&Number.isSafeInteger(value.inputRevision)&&previousInput.inputRevision>value.inputRevision)
          value={...value,inputRevision:previousInput.inputRevision,queuedInputs:previousInput.queuedInputs,nextReplyAt:previousInput.nextReplyAt};
        if (host.current.id && host.current.id !== value.instanceId) host.current.retired.add(host.current.id);
        host.current.id = value.instanceId;
        personaRef.current = value.personaId; setPersona(value.personaId);
        // Reactions or retry successors may finish between two snapshots. Pace those new attempts
        // just like the original recipients, without replaying a room's saved history on opening.
        useChatUiNamespace(value.localStateKey,value.instanceId);restoreChatUi(value.room,value.scopeKey);
        if(knownGeneration.current!==(value.room?.generation??0)||boundUiScope.current!==chatUiNamespace){knownGeneration.current=value.room?.generation??0;boundUiScope.current=chatUiNamespace;
          const stored=chatUi.get(explicitRoomId)?.reading;knownReading.current=new Set(stored?.known??[]);readingRestore.current=stored??null;
          readingRestored.current=false;atBottom.current=stored?.atBottom!==false;setScrolledUp(!atBottom.current);setNewReplies(0);}
        const previous=latestData.current,lastMessage=value.room?.turns.at(-1)?.messageId;
        if(lastMessage&&previous?.instanceId===value.instanceId&&previous.room?.id===value.room.id
          &&(previous.room.turns.at(-1)?.messageId===lastMessage||chatAnimatedAttempts.has(lastMessage))){
          const known=new Set(previous.room.turns.filter(t=>t.messageId===lastMessage).map(t=>t.attemptId));
          for(const t of value.room.turns)if(t.phase!=='anchor'&&t.messageId===lastMessage&&!known.has(t.attemptId))markChatAnimation(t.attemptId);
        }
        if(previous?.instanceId===value.instanceId&&previous.room?.id===value.room.id){const queuedIds=new Set((previous.queuedInputs??[]).flatMap(batch=>(batch.parts??[]).map(part=>part.id)));
          for(const turn of value.room.turns)if(turn.messageId===lastMessage&&chatUserParts(turn).some(part=>queuedIds.has(part.id)))markChatAnimation(turn.attemptId);}
        latestData.current=value;
        noteReadyReplies(value);
        setData((previous) => previous?.instanceId === value.instanceId && (previous.userProfile?.revision ?? -1) > (value.userProfile?.revision ?? -1)
          ? { ...value, userProfile: previous.userProfile } : value);
        const key=explicitRoomId??value.personaId;
        for(const turn of value.room?.turns??[])if(chatRetryIds.get(key+':'+turn.id)===turn.attemptId)chatRetryIds.delete(key+':'+turn.id);
        const current = chatDrafts.get(key);
        const acknowledged=current&&((value.queuedInputs??[]).some(batch=>batch.parts?.some(part=>part.id===current.requestId&&part.text===current.text))
          ||value.room?.turns.some(turn=>chatUserParts(turn).some(part=>part.id===current.requestId&&part.text===current.text)));
        if (acknowledged) {
          for(const turn of value.room.turns)if(turn.phase!=='anchor'&&turn.messageId===current.requestId)markChatAnimation(turn.attemptId);
          const empty = saveChatDraft(key,emptyChatDraft(),current.requestId,value.room,value.scopeKey);setDraft(empty);
        } else setDraft(current ?? emptyChatDraft());
        // Only durable replies completed while this particular room was tucked away are unread.
        // A streaming delta, a cancelled attempt and the three bubbles of a single answer are not three replies.
        const dock=dockSession.current;
        if(dock&&chatRuntime.minimized){
          const reset=dock.instance!==value.instanceId||dock.generation!==value.room?.generation;
          if(reset){dock.instance=value.instanceId;dock.generation=value.room?.generation;dock.known.clear();dock.count=0;}
          for(const t of value.room?.turns??[])if(t.status==='ready'&&t.phase!=='anchor'){
            if(!reset&&!dock.known.has(t.attemptId))dock.count++;
            dock.known.add(t.attemptId);chatAnimatedAttempts.delete(t.attemptId);
          }
        }
        onRoomState?.(value);
      };
      const load = async (id = personaRef.current, background = false) => {
        reading.current?.abort();
        const abort = new AbortController(); reading.current = abort;
        let timedOut=false;
        const timeout=setTimeout(()=>{timedOut=true;abort.abort();},10000);
        const token = ++readRevision.current;
        try {
          const query = new URLSearchParams(); if(explicitRoomId)query.set('room',explicitRoomId);else if (id) query.set('persona', id); if (fixedSessionId) query.set('session', fixedSessionId);
          const response = await fetch(ROUTE + '/chat' + (query.size ? '?' + query : ''), { signal: abort.signal });
          if (!live.current || token !== readRevision.current) return;
          if (response.status === 404 && id) {
            if(explicitRoomId){
              if(chatRuntime.minimized&&dockSession.current){
                // Another window removed the room. Stay tucked away until the user opens the room list.
                dockSession.current.missing=true;setSyncDelayed(false);setData(old=>old?.running?{...old,running:false}:old);return true;
              }
              onRoomMissing?.();return;
            }
            personaRef.current = undefined; chatPersonaChoices.delete(scope); setChoice(''); setPersona(undefined); void load(undefined); return;
          }
          const value = await response.json();
          if (!live.current||token!==readRevision.current||abort.signal.aborted)return;
          if (!response.ok) throw new Error(value.error);
          accept(value, token);setSyncDelayed(false);return true;
        } catch (error) {
          if (live.current && token === readRevision.current && (!abort.signal.aborted||timedOut)) {
            setSyncDelayed(true);
            if(!background&&error.message!=='Failed to fetch')setInfo(chatErrorText(error.message));
          }
          return false;
        }finally{clearTimeout(timeout);}
      };
      const currentLoad=React.useRef(load);currentLoad.current=load;
      React.useEffect(() => {
        live.current = true; const previous = typeof document !== 'undefined' ? document.activeElement : undefined;
        const update = (id, owner) => { if (owner !== windowOwner.current && (explicitRoomId?id===explicitRoomId||roomMembers.current.includes(id):id === personaRef.current) && !busyRef.current) void load(id); };
        const profileUpdate = (value) => setData((previous) => previous?.instanceId === value.instanceId
          && (previous.userProfile?.revision ?? -1) <= value.revision ? { ...previous, userProfile: value } : previous);
        chatUpdates.add(update);
        chatProfileUpdates.add(profileUpdate);
        void load(); input.current?.focus();
        return () => { live.current = false; chatUpdates.delete(update); chatProfileUpdates.delete(profileUpdate); readRevision.current += 1; reading.current?.abort();
          if(explicitRoomId)for(const turn of latestData.current?.room?.turns??[])chatAnimatedAttempts.delete(turn.attemptId);
          suggestRequest.current.revision += 1; suggestRequest.current.abort?.abort(); if (previous?.isConnected) previous.focus(); };
      }, []);
      React.useEffect(()=>{if(explicitRoomId&&initialState)accept(initialState,readRevision.current);},[initialState]);
      React.useEffect(() => {
        if (explicitRoomId || choice || !fixedReportPersona || personaRef.current === fixedReportPersona) return;
        const id = fixedReportPersona;
        personaRef.current = id; setPersona(id); setData(undefined); setInfo(''); setClearConfirm(false);
        atBottom.current = true; setScrolledUp(false); void load(id);
      }, [choice, fixedReportPersona]);
      const accountAvatar = useAccountAvatar(!minimized && !!data?.userProfile && userAvatarMode(data.userProfile) === 'account');
      React.useEffect(() => {
        if (ready && focusOnce.current) { input.current?.focus(); focusOnce.current = false; }
      }, [ready]);
      React.useEffect(() => {
        if ((!pending&&!queueWaiting&&!syncDelayed) || busy) return;
        let timer,sequence=0,alive=true,interval=1000;
        const poll=async()=>{
          if(!alive||busyRef.current||document.visibilityState==='hidden')return;
          const token=++sequence,ok=await currentLoad.current(undefined,true);
          if(!alive||token!==sequence||document.visibilityState==='hidden'||(ok&&!latestData.current?.running&&!(latestData.current?.queuedInputs??[]).some(batch=>batch.status==='pending'||batch.status==='sending')))return;
          interval=ok?1000:Math.min(8000,interval*2);
          timer=setTimeout(poll,interval);
        };
        const visibility=()=>{sequence++;clearTimeout(timer);interval=1000;
          if(document.visibilityState!=='hidden')void poll();else reading.current?.abort();
        };
        if(document.visibilityState!=='hidden')timer=setTimeout(poll,interval);
        document.addEventListener('visibilitychange',visibility);
        return()=>{alive=false;sequence++;clearTimeout(timer);document.removeEventListener('visibilitychange',visibility);};
      }, [pending,queueWaiting,syncDelayed,busy,explicitRoomId,persona,data?.instanceId]);
      React.useEffect(() => {
        if (atBottom.current && thread.current) thread.current.scrollTop = thread.current.scrollHeight;
      }, [data?.room?.revision, queuedKey, persona]);
      const resetSuggestions = () => {
        suggestRequest.current.revision += 1; suggestRequest.current.abort?.abort(); suggestRequest.current.busy = false;
        setSuggestions([]); setSuggestBusy(false); setSuggestInfo('');
      };
      const chatGeneration=explicitRoomId?(data?.room?.generation??0):data?.epoch;
      React.useEffect(resetSuggestions, [persona, data?.room?.id, data?.room?.revision, data?.instanceId, chatGeneration, suggestMode, context?.id, context?.revision]);
      React.useEffect(() => setRetryConfirm(null), [persona, data?.room?.revision, data?.instanceId, chatGeneration, currentContextKey]);
      const edit = (text) => {
        resetSuggestions();
        const next = { ...draft,text, requestId: chatNonce() }; saveChatDraft(draftScope, next); setDraft(next);
      };
      const chooseQuote=(turn,index,text,partId)=>{
        resetSuggestions();
        const ref={roomId:explicitRoomId,generation:data.room.generation??0,...(index===null?{kind:'user',messageId:partId??turn.messageId}
          :{kind:'assistant',turnId:turn.id,attemptId:turn.attemptId,index})};
        const author=index===null?{role:'user',name:'我'}:{role:'assistant',id:turn.recipientId,name:turn.speakerName};
        const next={...draft,requestId:chatNonce(),quote:{ref,author,text}};saveChatDraft(draftScope,next);setDraft(next);input.current?.focus();
      };
      const cancelQuote=()=>{const next={text:draft.text,requestId:chatNonce()};saveChatDraft(draftScope,next);setDraft(next);resetSuggestions();input.current?.focus();};
      const jumpQuote=ref=>{
        const source=chatQuotedSource(data.room,ref,quoteScope);if(!source||!thread.current)return;
        const node=[...thread.current.querySelectorAll('[data-chat-turn]')].find(el=>el.getAttribute('data-chat-turn')===source.turn.id);
        const target=ref.kind==='user'?[...thread.current.querySelectorAll('[data-user=true]')].find(element=>element.dataset.chatUserPart===ref.messageId):node?.querySelector('[data-chat-bubble="'+ref.index+'"]');
        if(!target)return;
        thread.current.querySelectorAll('.dsh-persona-chat-quoted-highlight').forEach(el=>el.classList.remove('dsh-persona-chat-quoted-highlight'));
        atBottom.current=false;setScrolledUp(true);target.scrollIntoView({block:'center',behavior:'instant'});target.tabIndex=-1;target.focus({preventScroll:true});
        target.classList.add('dsh-persona-chat-quoted-highlight');target.addEventListener('blur',()=>target.classList.remove('dsh-persona-chat-quoted-highlight'),{once:true});
      };
      const generateSuggestions = async () => {
        if (!ready || !suggestMode || suggestRequest.current.busy || pending || queueWaiting || contact?.archived) return;
        const abort = new AbortController(), token = ++suggestRequest.current.revision;
        suggestRequest.current.abort = abort; suggestRequest.current.busy = true;
        setSuggestBusy(true); setSuggestInfo(''); setSuggestions([]);
        try {
          const response = await fetch(ROUTE + '/chat/suggestions', { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ personaId: persona, roomId: data.room?.id ?? null, revision: data.room?.revision ?? 0, epoch: data.epoch, instruction: draft.text,
              contextKey:context?.id?context.id+':'+context.revision:undefined }), signal: abort.signal });
          const value = await response.json();
          if (!live.current || token !== suggestRequest.current.revision || abort.signal.aborted) return;
          if (!response.ok) throw new Error(value.error);
          setSuggestions(value.suggestions);
        } catch (error) {
          if (live.current && token === suggestRequest.current.revision && !abort.signal.aborted) setSuggestInfo(error.message === 'suggestions-context-changed'
            ? '讨论或参考来源已经更新，请重新生成参考。' : error.message==='suggestions-no-context'
              ?'请先在当前参考范围下聊几句，或在输入框中说明希望生成什么。':'暂时没有生成参考，输入仍保留，可以重试。');
        } finally {
          if (token === suggestRequest.current.revision) { suggestRequest.current.busy = false; if (live.current) setSuggestBusy(false); }
        }
      };
      const act = async (body,endpoint='chat') => {
        if (busyRef.current || !ready) return;
        busyRef.current = true; setBusy(true); setInfo(''); reading.current?.abort();
        const id = persona, token = ++readRevision.current;
        try {
          const { ok, value } = await actionRequest(endpoint, { ...body,roomId:explicitRoomId, personaId: id, epoch: data.epoch,
            contextKey:context?.id?context.id+':'+context.revision:undefined });
          if(ok&&body.action==='send')for(const turn of (value?.state??value)?.room?.turns??[])if(turn.phase!=='anchor'&&chatUserParts(turn).some(part=>part.id===body.requestId))markChatAnimation(turn.attemptId);
          if (value?.state) accept(value.state, token); else if (ok) accept(value, token);
          if (!ok) throw new Error(value.error);
          if (body.action === 'clear' && live.current && personaRef.current === id) {
            setClearConfirm(false); setInfo('已清空此角色的聊天记录，已保存偏好仍在设置中管理。');
            if (!value.contacts?.some((p) => p.id === id)) { personaRef.current = undefined; setPersona(undefined); void load(); }
          }
        } catch (error) {
          if (live.current && token === readRevision.current) { setInfo(chatErrorText(error.message)); void load(id); }
        } finally {
          busyRef.current = false; if (live.current) setBusy(false);
          for (const update of chatUpdates) update(explicitRoomId??id, windowOwner.current);
        }
      };
      const send = () => {
        if (!draft.text.trim() || !quoteAvailable || (pending&&!data?.canQueue&&!data?.canYield) || roomBusy || contact?.archived || !data?.modelReady || contextState.busy) return;
        resetSuggestions();
        saveChatDraft(draftScope, draft); atBottom.current = true; setScrolledUp(false);
        markChatAnimation(draft.requestId);
        return act({ action: 'send', requestId: draft.requestId, content: draft.text, revision: data.room?.revision ?? 0,clientTime:chatClientTime(),
          ...(draft.quote?{quote:draft.quote.ref}:{}),
          ...(explicitRoomId?{recipientIds:data.room.targetPersonaIds}:{}),
          ...(data.canYield&&!data.canQueue?{afterMessageId:data.roundMessageId,configRevision:data.room.configRevision}:{}) });
      };
      const retry = (turn, confirmed = false) => {
        if (!ready || busyRef.current || roomBusy || contextState.busy || pending || !data.modelReady) return;
        const sameScope=explicitRoomId&&turn.scopeKey&&turn.scopeKey===(context?.scopeKey??data.scopeKey);
        if ((turn.contextKey ?? null) !== currentContextKey && !sameScope && !confirmed) { setRetryConfirm(turn); return; }
        setRetryConfirm(null); resetSuggestions(); atBottom.current = true; setScrolledUp(false);
        const key = draftScope + ':' + turn.id, id = chatRetryIds.get(key) ?? chatNonce();
        keepDraft(chatRetryIds, key, id); markChatAnimation(id);
        return act({ action: 'retry', id: turn.id, attemptId: id, revision: data.room.revision,clientTime:chatClientTime(),
          ...(confirmed ? { previousContextKey: turn.contextKey ?? null } : {}) });
      };
      const unread=dockSession.current?.count??0;
      const sourceHint = roomReferenceHint(context, foreground);
      const view = minimized?h('aside',{ref:surface,className:'dsh-persona-chat-dock','data-dock-order':0,'aria-label':'已最小化的聊天室'},
        h('style',null,ROOM_CHAT_CSS),
        h('button',{type:'button',ref:dockButton,'aria-label':'还原聊天室'+(unread?'，'+unread+' 条新回复':''),title:'还原 · '+(data?.room?.name??'聊天室'),onClick:()=>chatRuntime.setMinimized(false)},
          h('span',{'aria-hidden':true},h(RoomAvatar,{memberIds:data?.room?.memberIds,contacts:data?.contacts})),h('span',null,'聊天室'),
          unread?h('span',{key:unread,className:'dsh-persona-chat-dock-count','aria-hidden':true},unread>99?'99+':String(unread)):null),
        h('button',{type:'button','aria-label':'关闭聊天室',title:pending?'关闭窗口，已发送的回复会继续保存；需要中止请先停止回复。':'关闭聊天室',onClick:onClose},'×'),
        h('span',{className:'dsh-persona-chat-dock-status',role:'status','aria-live':'polite','aria-atomic':true},unread?'聊天室收到 '+unread+' 条新回复':'')):
        h('section', { ref:surface,className: 'dsh-persona-chat', 'data-wide': String(wide), 'data-compose-expanded':String(composeExpanded), role: 'dialog', 'aria-modal': false,
        'aria-label': '聊天室', onKeyDown: (event) => { if (event.key === 'Escape' && !event.nativeEvent?.isComposing) {
          event.stopPropagation(); if(workOpen){event.preventDefault();closeWorkDraft();}else if (roomPanel) onDismissPanel?.(); else if (appearance) closeAppearance(); else if(draft.quote){event.preventDefault();cancelQuote();}else onClose();
        } } },
        h('style', null, CHAT_CSS, CHAT_APPEARANCE_CSS,ROOM_CHAT_CSS),
        h('header', { className: 'dsh-persona-chat-top','data-room':String(!!explicitRoomId) }, explicitRoomId?h('span',{className:'dsh-persona-room-avatar-display'},
          h(RoomAvatar,{memberIds:data?.room?.memberIds,contacts:data?.contacts})):avatar(persona, contact?.name),
          explicitRoomId?h('div',{className:'dsh-persona-chat-room-heading'},
            h('button',{type:'button',className:'dsh-persona-chat-room-title','aria-label':'切换聊天室',disabled:roomBusy,title:'切换聊天室 · '+(data?.room?.name??'聊天室'),onClick:()=>{setWorkOpen(false);onOpenRooms?.();}},
              h('span',null,data?.room?.name??'聊天室'),h('span',{'aria-hidden':true},'⌄')),
            h('nav',{className:'dsh-persona-chat-room-tools','aria-label':'聊天室管理'},
              h('button',{type:'button','aria-label':'管理聊天室成员',disabled:roomBusy,
                title:'管理成员 · '+(data?.room?.memberIds.length??0)+' 位人格',onClick:()=>{setWorkOpen(false);onOpenMembers?.();}},'成员'),
              h('button',{type:'button','aria-label':sourcesOpen?'收起来源':'参考来源','aria-expanded':sourcesOpen,'aria-controls':'dsh-persona-chat-source-panel',
                title:sourceHint.title,'data-source-different':sourceHint.different,'data-source-count':context?.initialized?context.sources?.length??0:undefined,style:{flex:'0 1 auto',minWidth:0,maxWidth:180,overflow:'hidden',textOverflow:'ellipsis'},
                onClick:()=>{setWorkOpen(false);setSourcesOpen(!sourcesOpen);}},sourceHint.text),
              h('button',{type:'button',ref:workButton,'aria-label':'整理工作指令','aria-expanded':workOpen,disabled:roomBusy||!ready,
                onClick:()=>{onDismissPanel?.();setAppearance(false);setSourcesOpen(false);setWorkOpen(!workOpen);}},'整理指令'))):h('strong', { className:'dsh-persona-chat-title' }, '聊天室'),
          h('div', { className:'dsh-persona-chat-actions' },
            h('button', { type: 'button', onClick: () => {setWorkOpen(false);setClearConfirm(!clearConfirm);}, disabled: !turns.length || busy || roomBusy }, '清空'),
            h('button', { type: 'button', ref: appearanceButton, 'aria-label':'聊天室设置','aria-expanded': appearance, onClick: () => {setWorkOpen(false);setAppearance(!appearance);} }, '设置'),
            h('button', { type:'button',disabled:roomBusy,'aria-label':'最小化聊天室',title:'最小化到右下角，收到回复时提醒',onClick:minimize },
              h('svg',{width:13,height:13,viewBox:'0 0 16 16',fill:'none','aria-hidden':true,style:{verticalAlign:'middle'}},
                h('path',{d:'M3 11h10',stroke:'currentColor',strokeWidth:1.6,strokeLinecap:'round'}))),
            h('button', { type: 'button', onClick: () => {if(explicitRoomId)chatRoomLayout.wide=!wide;setWide(!wide);} }, wide ? '还原' : '放大'),
            h('button', { type: 'button', 'aria-label': '关闭聊天室', title:pending?'关闭窗口，已发送的回复会继续保存；需要中止请先停止回复。':'关闭聊天室', onClick: onClose }, '关闭')),
          !explicitRoomId?h('div', { className:'dsh-persona-chat-context-row' },
            h('select', { 'aria-label': '聊天人格',title:choice?contact?.name:'跟随主要参考会话的汇报人格', value: choice, disabled: busy || !data,
              onChange: (event) => {
                resetSuggestions();
                const selected = event.target.value; setChoice(selected);
                if (selected) keepDraft(chatPersonaChoices, scope, selected); else chatPersonaChoices.delete(scope);
                const id = selected || fixedReportPersona || data?.reportPersonaId || data?.defaultPersonaId;
                personaRef.current = id; setPersona(id);
                setDraft(chatDrafts.get(id) ?? emptyChatDraft()); setInfo(''); setClearConfirm(false); atBottom.current = true; setScrolledUp(false); void load(id);
              } }, !data ? h('option', { value: '' }, '正在读取…') : null,
              data ? h('option', { value: '' }, '跟随汇报 · ' + (data.contacts?.find(p => p.id === (fixedReportPersona || data.reportPersonaId || data.defaultPersonaId))?.name ?? '默认人格')) : null,
              ...(data?.contacts ?? []).map((p) => h('option', { key: p.id, value: p.id }, p.name + (p.archived ? '（已移除）' : '')))),
            h('button',{type:'button','aria-label':sourcesOpen?'收起来源':'参考来源','aria-expanded':sourcesOpen,'aria-controls':'dsh-persona-chat-source-panel',
              title:sourceHint.title,'data-source-different':sourceHint.different,'data-source-count':context?.initialized?context.sources?.length??0:undefined,style:{flex:'0 1 auto',minWidth:0,maxWidth:180,overflow:'hidden',textOverflow:'ellipsis'},
              onClick:()=>setSourcesOpen(!sourcesOpen)},sourceHint.text)):null),
        sourcesOpen || contextState.error ? h('div', { id:'dsh-persona-chat-source-panel', className: 'dsh-persona-chat-info dsh-persona-chat-sources' },
          contextState.error?h('p',{role:'status'},contextState.error,h('button',{type:'button',disabled:contextState.busy,onClick:()=>contextState.action({action:'open',sessionId,visible:true})},'重试连接')):null,
          sourcesOpen?h('div',null,
            h('p',null,'切换工作页会保留这些来源。未接入项目只显示文件夹名称，不读取会话正文。'),
            ...(context?.sources??[]).map(source=>h('div',{key:source.sessionId,className:'dsh-persona-source-item'},
              h('span',null,source.sessionId===context.primarySessionId?'主要 · ':'',source.name,source.focused?' · 焦点':'',source.error?' · 更新暂未完成':!source.available?' · 暂不可读':''),
              h('button',{type:'button',disabled:contextState.busy,'aria-label':'移除来源'+source.name,onClick:()=>contextState.action({action:'detach',sessionId:source.sessionId})},'移除'))),
            h('div',{className:'dsh-persona-chat-source-actions'},
              h('button',{type:'button',disabled:contextState.busy,onClick:()=>contextState.action({action:'refresh'})},'刷新参考'),
              h('button',{type:'button',disabled:!foreground||!context?.initialized||contextState.busy,onClick:()=>contextState.action({action:'attach',sessionId:foreground,primary:true})},'接入当前会话'),
              h('select',{'aria-label':'选择项目',value:projectId,disabled:contextState.busy,onChange:async e=>{const id=e.target.value;setProjectId(id);setSessionChoices([]);setSessionChoice('');
                if(id){const result=await contextState.action({action:'sessions',projectId:id});if(result?.items)setSessionChoices(result.items);}}},
                h('option',{value:''},'其他项目…'),...(context?.projects??[]).map(p=>h('option',{key:p.id,value:p.id},p.name))),
              projectId?h('select',{'aria-label':'选择参考会话',value:sessionChoice,onChange:e=>setSessionChoice(e.target.value)},h('option',{value:''},sessionChoices.length?'选择会话…':'没有可用会话'),
                ...sessionChoices.map(s=>h('option',{key:s.sessionId,value:s.sessionId},s.name))):null,
              sessionChoice?h('button',{type:'button',disabled:contextState.busy,onClick:()=>contextState.action({action:'attach',sessionId:sessionChoice})},'接入所选会话'):null),
            h('p',null,'焦点依据近期查看、接入和聊天操作计算，仅调整已接入来源的更新频率。改变参考范围后，后续回复使用新的来源；旧范围的聊天不自动提供给模型。')):null) : null,
          (context?.notices??[]).some(n=>!n.read)?h('details',{className:'dsh-persona-context-notices'},h('summary',null,'相关会话更新 · '+context.notices.filter(n=>!n.read).length),
            ...context.notices.filter(n=>!n.read).map(n=>h('div',{key:n.id,className:'dsh-persona-source-item'},
              h('span',null,n.name+' · '+(n.kind==='error'?'出现运行异常':'一轮汇报已结束')),
              !n.attached?h('button',{type:'button',disabled:contextState.busy,onClick:()=>contextState.action({action:'attach',sessionId:n.sessionId})},'接入查看'):null,
              h('button',{type:'button',onClick:()=>contextState.action({action:'dismiss',noticeId:n.id})},'已读')))):null,
        appearance ? h('section', { className: 'dsh-persona-chat-appearance','aria-label':'聊天室设置' },
          h('div',{className:'dsh-persona-chat-settings-heading'},h('strong',null,'聊天室设置'),h('button',{type:'button',onClick:closeAppearance},'收起设置')),
          h('div',{className:'dsh-persona-chat-settings-body'},
            h(ChatThinkingControls,{visible:!minimized,roomId:explicitRoomId,routeKey:context?.primarySessionId??fixedSessionId}),
            h('div',{className:'dsh-persona-chat-settings-appearance'},h(ChatUserSettings)))) : null,
        workOpen&&explicitRoomId?h(WorkDraftPanel,{key:explicitRoomId,roomId:explicitRoomId,scopeKey:quoteScope,generation:data?.room?.generation,
          discussionRevision:data?.room?.discussion?.revision??0,onClose:closeWorkDraft,onMinimize:minimize}):null,
        roomPanel,
        clearConfirm ? h('div', { className: 'dsh-persona-chat-info' }, explicitRoomId?'清空这个聊天室的记录？成员、参考来源和长期记忆仍保留。':'清空这个角色的聊天？已保存偏好仍保留。',
          h('button', { type: 'button', disabled: busy, onClick: () => act({ action: 'clear', revision: data.room?.revision ?? 0 }) }, '确认清空聊天'),
          h('button', { type: 'button', onClick: () => setClearConfirm(false) }, '取消清空')) : null,
        info ? h('div', { className: 'dsh-persona-chat-info', role: 'status', 'aria-live': 'polite' }, info,
          h('button', { type: 'button', onClick: () => { setInfo(''); void load(); } }, '刷新')) : null,
        syncDelayed?h('div',{className:'dsh-persona-chat-info',role:'status'},'连接暂时中断，正在重新读取回复…'):null,
        contact?.archived ? h('div', { className: 'dsh-persona-chat-info' }, explicitRoomId?'这位角色已移除，请选择其他回复对象，或在成员管理中加入新角色。原有聊天保留。':'角色已移除，可以查看或清空历史记录。') : null,
        h('div', { className: 'dsh-persona-chat-thread-wrap' }, h('div', { className: 'dsh-persona-chat-thread', ref: thread, 'aria-label': '聊天消息', onScroll: () => {
          const el = thread.current; if (!el) return;
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60; setScrolledUp(!atBottom.current);
          noteReadyReplies(latestData.current);scheduleReading();
        } }, turns.length === 0 && queuedInputs.length === 0 ? h('div', { className: 'dsh-persona-chat-empty' },
          explicitRoomId?h(RoomAvatar,{memberIds:data?.room?.memberIds,contacts:data?.contacts}):avatar(persona, contact?.name),
          h('strong', null, ready ? data?.room?.targetPersonaIds.length!==1?'和大家聊点什么吧':`和${contact?.name ?? '这位角色'}聊点什么吧` : '正在读取聊天记录…'),
          h('p', null, explicitRoomId&&data?.room?.memberIds.length>1?'不点名时发给房间，也可以在下方 @ 想先听的人。':'从一个想法，或今天的小事开始。')) : null,
          ...groups.map((group,groupIndex)=>h('div',{key:group.id,'data-chat-message':group.id},
            h('div',{'data-chat-user-head':group.head.id},
            (groupIndex === 0 || group.head.at - groups[groupIndex-1].head.at > 300000 || chatDateBoundary(group.head.at,groups[groupIndex-1].head.at)) ? h(ChatMessageTime,{at:group.head.at,now:chatNow}) : null,
            group.parts.map((part,partIndex)=>h('div', { key:part.id,className: 'dsh-persona-chat-message', 'data-user': 'true','data-chat-user-part':part.id,
              'data-arriving':group.id===latestMessage&&(group.head.status==='pending'||chatAnimatedAttempts.has(group.head.attemptId))||undefined },
              h(UserChatAvatar, { profile: data.userProfile, accountUrl: accountAvatar, className: 'dsh-persona-chat-avatar' }), h('div', { className: 'dsh-persona-chat-bubble' },
                explicitRoomId&&(group.head.memberIdsAtSend?.length>1||group.head.recipients.length>1)?h('small',{className:'dsh-persona-chat-mentions'},group.head.recipients.map(p=>'@'+p.name).join(' ')):null,
                partIndex===0&&group.head.quote?h(ChatQuotedMessage,{quote:group.head.quote,available:!!chatQuotedSource(data.room,group.head.quote.ref,quoteScope),onJump:()=>jumpQuote(group.head.quote.ref)}):null,part.text),
              explicitRoomId&&(group.head.scopeKey??group.head.contextKey??null)===quoteScope?h('button',{type:'button',className:'dsh-persona-chat-quote-action','aria-label':'引用我的消息',title:'引用这句',onClick:()=>chooseQuote(group.head,null,part.text,part.id)},'↩'):null))),
            ...group.responses.map(turn=>h('div',{key:turn.id,'data-chat-turn':turn.id},
            h(ChatTurnReply,{key:turn.attemptId,turn,instance:data.instanceId,roomId:explicitRoomId,running:data.running,
              held:responseHeld(turn),latest:turn.messageId===latestMessage,onPresented:afterPresentation,onSilent:rememberSilence,
              started:data.activeAttemptIds?.includes(turn.attemptId),
              onFinish:()=>{if(live.current&&!busyRef.current&&document.visibilityState!=='hidden')void load(undefined,true);},
              showSpeaker:!!explicitRoomId&&(data.room.memberIds.length>1||turn.recipientId!==persona),
              onQuote:explicitRoomId&&(turn.scopeKey??turn.contextKey??null)===quoteScope?chooseQuote:undefined,
              avatar:()=>avatar(turn.recipientId??persona,turn.speakerName),
              colorStyle:chatPalette.style(bubbleColors.get(turn.recipientId??persona)),
              onProgress:()=>{if(atBottom.current&&thread.current)thread.current.scrollTop=thread.current.scrollHeight;}}),
            !responseHeld(turn)&&turn.status !== 'ready' && !(turn.status === 'pending' && data.running)
              && !(turn.status==='interrupted'&&turn.messageId!==latestMessage&&['reaction','followup'].includes(turn.phase)) ? h('div', { className: 'dsh-persona-chat-turn-state', role: 'status', 'aria-live': 'polite' },
              explicitRoomId&&(data.room.memberIds.length>1||turn.recipients.length>1||turn.phase==='reaction')?h('strong',null,turn.speakerName+' · '):null,
              h('span',null,chatReplyStateText(turn, data.running)),
              turn.messageId === turns.at(-1)?.messageId && !pending
                &&(!explicitRoomId||data.room.memberIds.includes(turn.recipientId)&&!data.contacts.find(p=>p.id===turn.recipientId)?.archived)
                ? h('button', { type: 'button', disabled: busy || roomBusy || contextState.busy || !ready || !data.modelReady,
                  title:turn.directedPlanId?'只重试 '+turn.speakerName+' 的这条回复，其他已完成回复保留。':'从 '+turn.speakerName+' 开始重试；后续接话会重新生成，前面的回复保留。',onClick: () => void retry(turn) },
                  !turn.directedPlanId&&group.responses.indexOf(turn)<group.responses.length-1?'从这里重试':'重试回复') : null) : null)))),
          ...queuedInputs.map(batch=>h('div',{key:'input-'+batch.id,'data-chat-user-head':batch.id,'data-queued-input':batch.id,role:'group','aria-label':'待回应的消息'},
            ...batch.parts.map((part,partIndex)=>h('div',{key:part.id,className:'dsh-persona-chat-message','data-user':'true','data-chat-user-part':part.id},
              h(UserChatAvatar,{profile:data.userProfile,accountUrl:accountAvatar,className:'dsh-persona-chat-avatar'}),
              h('div',{className:'dsh-persona-chat-bubble'},batch.recipients?.length?h('small',{className:'dsh-persona-chat-mentions'},batch.recipients.map(person=>'@'+person.name).join(' ')):null,
                partIndex===0&&batch.quote?.ref&&typeof batch.quote.text==='string'?h(ChatQuotedMessage,{quote:batch.quote,available:!!chatQuotedSource(data.room,batch.quote.ref,quoteScope),onJump:()=>jumpQuote(batch.quote.ref)}):null,part.text))),
            h('div',{className:'dsh-persona-chat-input-state',role:'status','aria-live':'polite'},batch.status==='failed'
              ?h(React.Fragment,null,h('span',null,'这几条暂时没接上，原话已保留。'),
                h('button',{type:'button',disabled:busy||roomBusy||!ready,'aria-label':'重试这组消息',onClick:()=>act({action:'retry-input',requestId:batch.id})},'重试'),
                h('button',{type:'button',disabled:busy||roomBusy||!ready,'aria-label':'取消这组消息',onClick:()=>act({action:'cancel-input',requestId:batch.id})},'取消'))
              :batch.status==='sending'?'正在接上这几句…':'等待回应')))),
        scrolledUp && (turns.length || queuedInputs.length) ? h('button', { type: 'button', className:'dsh-persona-chat-jump', onClick: () => {
          atBottom.current = true; setScrolledUp(false);noteReadyReplies(latestData.current);if (thread.current) thread.current.scrollTop = thread.current.scrollHeight;saveReading();
        } }, newReplies?newReplies+' 条新回复 · 回到最新消息':'回到最新消息') : null),
        pending&&(data.roundPhase==='preparing'||barrier<0)?h('div',{role:'status',style:{fontSize:11,color:'var(--chat-muted)',padding:'0 12px 6px'}},data.roundPhase==='preparing'?'正在接上这句话…':data.roundPhase==='listening'?'大家在听…':'等待回应'):null,
        directorIssue&&!data?.activeAttemptIds?.length?h('div',{className:'dsh-persona-chat-info',role:'status','aria-live':'polite',style:{display:'flex',alignItems:'center',flexWrap:'wrap',gap:'4px 8px'}},
          h('span',null,directorAnswered?'后续接话暂未继续':'暂时没接上，原话已保留'),h('small',{style:{color:'var(--chat-muted)'}},directorIssueReason),
          h('button',{type:'button',disabled:busy||roomBusy||contextState.busy||!ready||!data.modelReady,title:'重新判断接话安排',
            onClick:()=>act({action:'retry-director',messageId:directorIssue.messageId})},directorAnswered?'继续接话':'重试回应')):null,
        h(SlowChatStatus,{data,minimized}),
        retryConfirm ? h('div', { className: 'dsh-persona-chat-info', role: 'status' },
          '参考来源与这条消息发送时不同。按当前来源重试同一句话？旧范围的聊天不会带入，用户消息不会重复。',
          h('button', { type: 'button', disabled: busy || contextState.busy, onClick: () => void retry(retryConfirm, true) }, '按当前来源重试'),
          h('button', { type: 'button', onClick: () => setRetryConfirm(null) }, '暂不重试')) : null,
        h('div', { className: 'dsh-persona-chat-compose' },
          explicitRoomId&&data?.room?.memberIds.length>1?h('div',{className:'dsh-persona-chat-participants'},
            h(RoomRecipient,{contacts:data?.contacts??[],memberIds:data?.room?.memberIds??[],value:data.room.targetPersonaIds,disabled:busy||roomBusy||!data,
              onChange:ids=>act({action:'update',targetPersonaIds:ids,configRevision:data.room.configRevision},'chat-rooms')})):null,
          draft.quote?h(ChatQuotedMessage,{quote:draft.quote,available:quoteAvailable,draft:true,onCancel:cancelQuote,onJump:()=>jumpQuote(draft.quote.ref)}):null,
          suggestMode ? h('div', { className: 'dsh-persona-chat-suggest' }, h('div', { className: 'dsh-persona-chat-suggest-head' },
            h('small',null,'点选参考后，可修改再发送。'),
            h('button', { type: 'button', onClick: generateSuggestions, disabled: suggestBusy || busy || !ready || pending || queueWaiting || contact?.archived
              || !data?.modelReady || (!draft.text.trim() && !turns.length) }, suggestBusy ? '正在生成…' : '生成参考')),
            suggestInfo ? h('small', { role: 'status', 'aria-live': 'polite' }, suggestInfo) : null,
            h('div', { className: 'dsh-persona-chat-suggestions', 'aria-label': '参考快捷回复' }, ...suggestions.map((text, index) =>
              h('button', { type: 'button', key: index, onClick: () => {
                const next = { ...draft,text, requestId: chatNonce() }; saveChatDraft(draftScope, next); setDraft(next); input.current?.focus(); setSuggestInfo('已填入，可修改后发送。');
              } }, text)))) : null,
          h('textarea', { id:'dsh-persona-chat-input', ref: input, value: draft.text, maxLength: 4000, rows:2,
          'aria-label': '发送给角色的消息', title:'Enter 发送 · Shift+Enter 换行', placeholder: contact?.archived ? '这位角色已移除' : '说点什么…', disabled: !ready, readOnly: contact?.archived === true,
          onSelect:()=>{if(explicitRoomId)updateChatUi(explicitRoomId,{selection:{start:input.current?.selectionStart??0,end:input.current?.selectionEnd??0}});},
          onChange: (event) => edit(event.target.value), onKeyDown: (event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent?.isComposing && event.keyCode !== 229) { event.preventDefault(); void send(); }
          } }),
          !data?.modelReady && ready ? h('p', { style: { fontSize: '11px', margin: '0 0 7px' } }, '请先在插件设置中选择聊天室或转述模型。') : null,
          h('div', { className: 'dsh-persona-chat-compose-row' },
            h('label', null, h('input', { type: 'checkbox', checked: suggestMode, 'aria-label': '快捷回复参考', onChange: (event) => setSuggestMode(event.target.checked) }), '快捷回复参考'),
            h('small', {title:'Enter 发送 · Shift+Enter 换行'}, 'Enter 发送'),
            h('button', {type:'button',className:'dsh-persona-chat-compose-expand','aria-label':composeExpanded?'收起输入框':'展开输入框',
              title:composeExpanded?'收起输入框':'展开输入框','aria-expanded':composeExpanded,'aria-controls':'dsh-persona-chat-input',
              onClick:()=>{if(explicitRoomId)chatRoomLayout.composeExpanded=!composeExpanded;setComposeExpanded(!composeExpanded);input.current?.focus({preventScroll:true});}},h(ChatExpandIcon,{expanded:composeExpanded})),
            stopTurn && !((data.canQueue||data.canYield)&&draft.text.trim()) ? h('button', { type: 'button', disabled: busy, onClick: () => {
              void act({ action: 'cancel', id: stopTurn.id, attemptId: stopTurn.attemptId,messageId:stopTurn.messageId,roundId:data.roundId,
                attempts:turns.filter(t=>t.messageId===stopTurn.messageId&&t.status==='pending').map(t=>({id:t.id,attemptId:t.attemptId})) });
            } }, data.roundPhase==='listening'?'停止接话':'停止回复') : h('button', { type: 'button', 'data-primary': '', disabled: !quoteAvailable || (pending&&!data.canQueue&&!data.canYield) || busy || roomBusy || contextState.busy || !ready || !draft.text.trim() || contact?.archived || !data?.modelReady,
              title:data?.canQueue&&draft.text.trim()?'发送后先保留这几句，再一起回应':data?.canYield&&draft.text.trim()?'发送新消息，结束本轮接话':undefined,
              onClick: send }, pending&&!data.canQueue&&!data.canYield ? (data.roundPhase==='preparing'?'正在确认…':'同步中…') : busy ? '发送中…' : '发送'))));
      // The workspace already has a dedicated body root; another portal would remount the loaded window.
      return view;
    }

    // Drafts stay on the client; closing a dialog never submits or discards them.
    const conversationDrafts = new Map();
    const feedbackDrafts = new Map();
    function keepDraft(map, key, value) {
      if (!map.has(key) && map.size >= 100) map.delete(map.keys().next().value);
      map.set(key, value);
    }
    const ACTION_CSS = `
      .dsh-persona-action[data-native]{box-sizing:border-box;position:fixed;inset:0;margin:auto;transform:none;width:min(520px,calc(100vw - 32px));height:fit-content;max-width:calc(100vw - 32px);max-height:calc(100dvh - 48px);border:0;padding:0;background:transparent;color:var(--dsw-alias-label-primary);overflow:visible;text-align:left}
      .dsh-persona-action::backdrop{background:#0007}
      .dsh-persona-action-surface{box-sizing:border-box;position:relative;width:100%;max-width:100%;min-width:0;max-height:calc(100dvh - 48px);overflow:auto;overscroll-behavior:contain;padding:24px;border-radius:14px;background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l1);box-shadow:0 20px 80px #0003;font-size:14px;line-height:1.65;overflow-wrap:anywhere}
      .dsh-persona-action-top{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:18px}
      .dsh-persona-action-top h2{font-size:18px;margin:0}.dsh-persona-action-top button{flex:none}
      .dsh-persona-action-surface label{display:grid;gap:6px;margin:14px 0}
      .dsh-persona-action-surface select,.dsh-persona-action-surface textarea{box-sizing:border-box;width:100%;font:inherit;color:inherit;background:var(--dsw-alias-bg-layer-2,#f6f8fb);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:9px;min-width:0}
      .dsh-persona-action-surface textarea{min-height:96px;resize:vertical}
      .dsh-persona-action-surface button{font:inherit;color:inherit;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:6px 12px;background:var(--dsw-alias-bg-layer-2,#f6f8fb);cursor:pointer;min-height:34px}
      .dsh-persona-action-surface button:disabled{opacity:.5;cursor:default}.dsh-persona-action-surface button:focus-visible,.dsh-persona-action-surface select:focus-visible,.dsh-persona-action-surface textarea:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:3px}
      .dsh-persona-action-surface button[data-primary]{background:var(--dsw-alias-brand-primary,#386fba);color:var(--dsw-alias-on-brand-primary,var(--dsw-alias-bg-layer-1,#fff));border-color:transparent}
      .dsh-persona-action-note{color:var(--dsw-alias-label-secondary);font-size:12px;margin:8px 0}
      .dsh-persona-action-box{padding:12px 14px;border-radius:10px;background:var(--dsw-alias-bg-layer-2,#f6f8fb);margin:16px 0}
      .dsh-persona-action-buttons{display:flex;gap:8px;flex-wrap:wrap;margin-top:16px}
      @media(max-width:520px){.dsh-persona-action-surface{padding:18px}}
    `;
    function ActionDialog({ title, onClose, children }) {
      const surface = React.useRef(null);
      useLayoutEffect(() => lockComparisonScroll(surface.current.ownerDocument), []);
      // Native top-layer geometry is independent of the header container and host Modal sizing.
      return h(NativeComparisonModal, { onClose, title, className: 'dsh-persona-action' },
        h('style', null, ACTION_CSS), h('div', { ref: surface, className: 'dsh-persona-action-surface' },
          h('div', { className: 'dsh-persona-action-top' }, h('h2', null, title),
            h('button', { type: 'button', onClick: onClose, 'aria-label': `关闭${title}` }, '关闭')), children));
    }
    const actionError = (error) => ({
      'conversation-conflict': '会话选择已在别处更新。已读入最新状态，请核对后重新保存。',
      'relay-conflict': '这次接力状态已经变化，请核对最新状态。',
      'relay-already-pending': '已有一项等待中的接力，请先取消。',
      'relay-same-persona': '请选择另一位接手角色。',
      'session-capacity': '独立会话选择已达上限，暂时无法新增。已有会话仍可调整。',
      'persona-not-found': '这个人格已经被删除，请重新选择。',
      'storage-not-ready': '保存服务尚未就绪，请稍后重试。输入已经保留。',
      'memory-capacity': '记忆已满，请先在设置里整理旧条目。输入已经保留。',
      'memory-conflict': '保存期间记忆又有更新，请核对后重试。输入已经保留。',
      'memory-disabled': '记忆已关闭。可以只调整这一次，或先到设置开启记忆。',
      'report-conflict': '这份汇报已经更新，请核对后再提交。输入已经保留。',
      'feedback-in-progress': '这份汇报正在调整，请等本次完成。',
      'rewrite-disabled': '当前转述已关闭，开启后可以重试。',
      'source-unavailable': '这份旧汇报没有保存原始来源，暂时不能重新转述。',
      'report-incomplete': '这份汇报还没有完成，请等正文稳定后再调整。',
      'report-no-prose': '这份汇报没有可调整的文字，代码等原样保留。',
      'feedback-rewrite-failed': '这次调整没有完成，已保留原来的汇报和你的输入。',
    }[error] ?? '没有保存成功，请重试。你的输入已经保留。');
    async function actionRequest(path, body) {
      const response = await fetch(`${ROUTE}/${path}`, body === undefined ? undefined
        : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const value = await response.json();
      return { ok: response.ok, value };
    }

    const REPORT_THEME_PREFERENCE_KEY='dsh-persona-shell:report-reading-appearance:v1';
    const reportThemePreference=value=>({theme:['system','catppuccin','nord','rosepine'].includes(value?.theme)?value.theme:'system',
      appearance:['auto','light','dark'].includes(value?.appearance)?value.appearance:'auto'});
    function parseReportThemePreference(raw){
      try{return typeof raw==='string'&&raw.length<=1024?reportThemePreference(JSON.parse(raw)):reportThemePreference(null);}
      catch{return reportThemePreference(null);}
    }
    function readReportThemePreference(){try{return parseReportThemePreference(localStorage.getItem(REPORT_THEME_PREFERENCE_KEY));}catch{return reportThemePreference(null);}}
    function reportHostAppearance(){
      const root=document.documentElement,body=document.body;
      // The native ThemePresenter marks the actual appearance on body, including an empty boolean attribute.
      if(body?.hasAttribute('data-ds-dark-theme'))return'dark';
      if(root.hasAttribute('data-ds-theme-source'))return'light';
      for(const node of [root,body].filter(Boolean)){
        for(const name of ['data-theme','data-color-scheme','data-color-mode','data-theme-mode']){
          const value=node.getAttribute(name)?.toLowerCase();if(value==='dark'||value==='light')return value;
        }
        if(node.classList.contains('dark')||node.classList.contains('theme-dark')||node.classList.contains('dark-theme'))return'dark';
        if(node.classList.contains('light')||node.classList.contains('theme-light')||node.classList.contains('light-theme'))return'light';
      }
      const scheme=getComputedStyle(root).colorScheme?.trim();if(scheme==='dark'||scheme==='light')return scheme;
      const background=body?getComputedStyle(body):getComputedStyle(root);
      const colors=[background.getPropertyValue('--dsw-alias-bg-layer-1'),background.backgroundColor,getComputedStyle(root).backgroundColor];
      for(const color of colors){
        const value=color.trim(),hex=/^#([\da-f]{3}|[\da-f]{6})$/iu.exec(value),rgb=/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/iu.exec(value);
        const channels=hex? (hex[1].length===3?[...hex[1]].map(part=>parseInt(part+part,16)):[0,2,4].map(index=>parseInt(hex[1].slice(index,index+2),16)))
          :rgb&&(!rgb[4]||Number(rgb[4])>.9)?rgb.slice(1,4).map(Number):null;
        if(channels)return channels.reduce((total,part,index)=>total+part*[.2126,.7152,.0722][index],0)<128?'dark':'light';
      }
      return typeof window.matchMedia==='function'&&window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';
    }
    function useReportTheme(){
      const [preference,setPreference]=React.useState(readReportThemePreference),[hostAppearance,setHostAppearance]=React.useState(reportHostAppearance),[notice,setNotice]=React.useState('');
      const current=React.useRef(preference);current.current=preference;
      React.useEffect(()=>{
        const update=()=>setHostAppearance(previous=>{const next=reportHostAppearance();return previous===next?previous:next;});
        const media=typeof window.matchMedia==='function'?window.matchMedia('(prefers-color-scheme: dark)'):null;
        const observer=typeof MutationObserver==='function'?new MutationObserver(update):null;
        const options={attributes:true,attributeFilter:['class','style','data-theme','data-color-scheme','data-color-mode','data-theme-mode','data-ds-dark-theme','data-ds-theme-source']};
        observer?.observe(document.documentElement,options);if(document.body)observer?.observe(document.body,options);
        media?.addEventListener?.('change',update);
        const storage=event=>{if(event.key!==REPORT_THEME_PREFERENCE_KEY)return;const next=parseReportThemePreference(event.newValue);current.current=next;setPreference(next);setNotice('');};
        window.addEventListener('storage',storage);update();
        return()=>{observer?.disconnect();media?.removeEventListener?.('change',update);window.removeEventListener('storage',storage);};
      },[]);
      const change=patch=>{const next=reportThemePreference({...current.current,...patch});current.current=next;setPreference(next);setNotice('');
        try{localStorage.setItem(REPORT_THEME_PREFERENCE_KEY,JSON.stringify({version:1,...next}));}
        catch{setNotice('本页配色已应用，暂时无法保存在本机。');}};
      const appearance=preference.theme==='system'||preference.appearance==='auto'?hostAppearance:preference.appearance;
      const theme=React.useMemo(()=>createReportTheme(preference.theme,appearance),[preference.theme,appearance]);
      return{preference,theme,change,notice};
    }
    const REPORT_READING_CSS = `
      .dsh-report-reading,.dsh-report-reading-dock{--rr-bg:var(--dsw-alias-bg-layer-1,#fff);--rr-soft:var(--dsw-alias-bg-layer-2,#f5f7fa);--rr-ink:var(--dsw-alias-label-primary,#243244);--rr-muted:var(--dsw-alias-label-secondary,#687788);--rr-border:var(--dsw-alias-border-l1,#dce3eb);--rr-accent:var(--dsw-alias-brand-primary,#436cba);--rr-risk:color-mix(in srgb,#b47a24 78%,var(--rr-ink));--rr-support:color-mix(in srgb,#398b91 73%,var(--rr-ink));box-sizing:border-box;color:var(--rr-ink);font:13px/1.65 system-ui,'Microsoft YaHei',sans-serif;-webkit-app-region:no-drag}
      .dsh-report-reading{position:fixed;z-index:1150;right:max(16px,env(safe-area-inset-right));bottom:max(14px,env(safe-area-inset-bottom));width:min(860px,calc(100vw - 32px));height:min(820px,calc(100dvh - 72px));max-height:calc(100dvh - 72px);display:flex;flex-direction:column;overflow:hidden;background:var(--rr-bg);border:1px solid var(--rr-border);border-radius:15px;box-shadow:0 18px 70px #0003;animation:rr-enter 180ms ease-out both}
      .dsh-report-reading[data-wide=true]{width:min(1120px,calc(100vw - 32px));height:calc(100dvh - 72px)}
      .dsh-report-reading button:not(:where(.rr-document *)),.dsh-report-reading-dock button{font:inherit;color:inherit;cursor:pointer;border:1px solid var(--rr-border);border-radius:7px;background:var(--rr-bg);padding:4px 9px;min-height:29px;line-height:1.45}.dsh-report-reading button:not(:where(.rr-document *)):hover,.dsh-report-reading-dock button:hover{background:var(--rr-soft)}.dsh-report-reading button:not(:where(.rr-document *)):disabled{opacity:.45;cursor:default}.dsh-report-reading :focus-visible:not(:where(.rr-document *)),.dsh-report-reading-dock :focus-visible{outline:2px solid var(--rr-accent);outline-offset:2px}.dsh-report-reading button[data-primary]:not(:where(.rr-document *)){background:var(--rr-accent);color:var(--rr-on-accent,#fff);border-color:transparent}
      .dsh-report-reading .rr-head{display:flex;align-items:center;gap:10px;padding:13px 17px;border-bottom:1px solid var(--rr-border);flex:none}.dsh-report-reading .rr-head-title{flex:1;min-width:0}.dsh-report-reading .rr-head-title h2{font-size:14px;font-weight:650;margin:0}.dsh-report-reading .rr-head-title small{display:block;color:var(--rr-muted);font-size:10px;margin-top:1px}.dsh-report-reading .rr-head-actions{display:flex;gap:4px;flex:none}.dsh-report-reading .rr-head-actions button{font-size:11px;padding:4px 7px}
      .dsh-report-reading .rr-toolbar{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;padding:10px 17px;flex:none}
      .dsh-report-reading .rr-reading-mode{display:flex;align-items:center;gap:3px;padding:2px;border:1px solid var(--rr-border);border-radius:8px}.dsh-report-reading .rr-reading-mode button{border:0;background:transparent;min-height:27px;padding:3px 10px;font-size:11px;color:var(--rr-muted)}.dsh-report-reading .rr-reading-mode button[aria-pressed=true]{background:var(--rr-soft);color:var(--rr-ink);font-weight:600}.dsh-report-reading .rr-appearance{position:relative;font-size:10px;color:var(--rr-muted)}.dsh-report-reading .rr-appearance summary{cursor:pointer;list-style:none;padding:4px}.dsh-report-reading .rr-appearance summary::-webkit-details-marker{display:none}.dsh-report-reading .rr-appearance summary:after{content:'⌄';margin-left:5px}.dsh-report-reading .rr-appearance[open] summary:after{content:'⌃'}.dsh-report-reading .rr-appearance-options{position:absolute;z-index:3;top:calc(100% + 5px);right:0;width:max-content;max-width:calc(100vw - 42px);padding:9px;border:1px solid var(--rr-border);border-radius:9px;box-shadow:0 7px 22px #0002;background:var(--rr-bg)}.dsh-report-reading .rr-guide{display:flex;align-items:center;gap:3px 9px;flex-wrap:wrap;flex:none;margin:0 17px;padding:0 0 9px;border-bottom:1px solid var(--rr-border);font-size:10px;color:var(--rr-muted)}.dsh-report-reading .rr-guide>span{font-size:9px;margin-right:2px}.dsh-report-reading .rr-guide button{display:inline-flex;align-items:center;gap:5px;font-size:10px;border:0;border-radius:5px;background:transparent;min-height:24px;padding:2px 5px;color:var(--rr-muted)}.dsh-report-reading .rr-guide button[aria-pressed=true]{color:var(--rr-accent);background:var(--rr-soft)}.dsh-report-reading .rr-guide button[data-kind=risk]{color:var(--rr-risk)}.dsh-report-reading .rr-guide button>span{font-variant-numeric:tabular-nums;font-size:9px;opacity:.75}.dsh-report-reading .rr-reading-status{margin:0 auto 16px;max-width:740px;font-size:10px;line-height:1.75;color:var(--rr-muted)}.dsh-report-reading .rr-sr-only{position:absolute;clip:rect(0,0,0,0);clip-path:inset(50%);width:1px;height:1px;overflow:hidden;white-space:nowrap}.dsh-report-reading .rr-document [data-rr-hidden=true]{display:none!important}.dsh-report-reading .rr-document button.rr-fold-toggle{display:flex;align-items:center;gap:7px;min-height:29px;max-width:100%;margin:.45em 0 .85em;padding:3px 7px;border:0;border-radius:5px;background:var(--rr-soft);color:var(--rr-muted);font:10px/1.7 system-ui,'Microsoft YaHei',sans-serif;text-align:left;cursor:pointer}.dsh-report-reading .rr-document button.rr-fold-toggle:before{content:'›';font-size:15px;line-height:1;transform-origin:center}.dsh-report-reading .rr-document button.rr-fold-toggle[aria-expanded=true]:before{transform:rotate(90deg)}.dsh-report-reading .rr-document button.rr-fold-toggle:hover{color:var(--rr-ink)}.dsh-report-reading .rr-document button.rr-fold-toggle:focus-visible,.dsh-report-reading .rr-document p:focus-visible{outline:2px solid var(--rr-accent);outline-offset:3px}.dsh-report-reading .rr-document p[data-rr-locate]{position:relative}.dsh-report-reading .rr-document p[data-rr-locate]:before{content:"";position:absolute;inset-inline-start:-11px;top:.28em;width:2px;height:1.35em;border-radius:2px;background:var(--rr-accent);pointer-events:none;animation:rr-locate 2200ms ease-out both}.dsh-report-reading .rr-document p[data-rr-locate=risk]:before{background:var(--rr-risk)}

      .dsh-report-reading .rr-content{overflow:auto;overscroll-behavior:contain;min-width:0;min-height:0;flex:1;padding:29px 34px 38px;scrollbar-gutter:stable}.dsh-report-reading .rr-document{max-width:740px;margin:0 auto;font-size:14px;line-height:1.95;overflow-wrap:anywhere}.dsh-report-reading .rr-document h1{font-size:1.65em;line-height:1.5;margin:1.4em 0 .75em;letter-spacing:-.02em}.dsh-report-reading .rr-document h2{font-size:1.3em;line-height:1.6;margin:1.65em 0 .7em;letter-spacing:-.01em}.dsh-report-reading .rr-document h3{font-size:1.1em;line-height:1.65;margin:1.4em 0 .55em}.dsh-report-reading .rr-document :is(h1,h2,h3):first-child{margin-top:0}.dsh-report-reading .rr-document p{margin:0 0 1.05em}.dsh-report-reading .rr-document strong{font-weight:650}.dsh-report-reading .rr-document :is(ul,ol){padding-inline-start:1.65em;margin:.7em 0 1.25em}.dsh-report-reading .rr-document li{padding-left:.15em;margin:.4em 0}.dsh-report-reading .rr-document li>p{margin:.45em 0}.dsh-report-reading .rr-document :not(pre)>code{font-size:.9em;overflow-wrap:anywhere}.dsh-report-reading .rr-document pre{max-width:100%;overflow:auto;border-radius:9px}.dsh-report-reading .rr-document table{max-width:100%;display:block;overflow:auto;border-collapse:collapse;font-size:.92em;margin:1.2em 0}.dsh-report-reading .rr-document :is(td,th){padding:8px 11px;border:1px solid var(--rr-border)}.dsh-report-reading .rr-document blockquote{margin:1.3em 0;padding:.1em 0 .1em 1em;border-left:2px solid var(--rr-border);color:var(--rr-muted)}.dsh-report-reading .rr-document hr{border:0;border-top:1px solid var(--rr-border);margin:1.8em 0}.dsh-report-reading .rr-document img{max-width:100%}
      .dsh-report-reading .rr-intro,.dsh-report-reading .rr-unavailable{max-width:740px;margin:0 auto 22px;color:var(--rr-muted);font-size:12px;line-height:1.8}.dsh-report-reading .rr-intro{display:flex;gap:12px;align-items:center;justify-content:space-between;padding:0 0 17px;border-bottom:1px solid var(--rr-border)}.dsh-report-reading .rr-intro p{margin:0}.dsh-report-reading .rr-intro button{white-space:nowrap;font-size:11px}.dsh-report-reading .rr-unavailable{padding:28px 0}.dsh-report-reading .rr-unavailable h3{color:var(--rr-ink);font-size:17px;margin:0 0 10px}.dsh-report-reading .rr-unavailable button{margin-top:10px}.dsh-report-reading .rr-note{font-size:11px;color:var(--rr-muted);margin:12px auto 0;max-width:740px;line-height:1.75}
      .dsh-report-reading .rr-explanation{max-width:740px;margin:0 auto 18px;font-size:11px;color:var(--rr-muted);line-height:1.75}.dsh-report-reading .rr-explanation summary{cursor:pointer}.dsh-report-reading .rr-explanation p{margin:6px 0 0}.dsh-report-reading .rr-status{padding:7px 17px;background:var(--rr-soft);font-size:11px;flex:none;line-height:1.75}.dsh-report-reading .rr-status p{margin:0}.dsh-report-reading .rr-status details{margin-top:3px}.dsh-report-reading .rr-status summary{cursor:pointer}.dsh-report-reading .rr-footer{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:9px 17px;border-top:1px solid var(--rr-border);font-size:10px;color:var(--rr-muted);flex:none}.dsh-report-reading .rr-footer>span{flex:1;min-width:120px;overflow-wrap:anywhere}.dsh-report-reading .rr-footer button{font-size:11px;min-height:27px}
      .dsh-report-reading-dock{position:fixed;z-index:1100;right:max(16px,env(safe-area-inset-right));bottom:max(16px,env(safe-area-inset-bottom));display:flex;align-items:center;gap:2px;max-width:calc(100vw - 32px);padding:3px 4px 3px 3px;background:var(--rr-bg);border:1px solid var(--rr-border);border-radius:18px;box-shadow:0 3px 16px #0002;animation:rr-enter 150ms ease-out both;font:12px/1.35 system-ui,sans-serif}.dsh-report-reading-dock button{border:0;background:transparent;border-radius:12px;min-height:28px;padding:2px 6px}.dsh-report-reading-dock button:first-child{display:flex;gap:7px;align-items:center;min-height:36px;padding-left:4px}.dsh-report-reading-dock .rr-dock-icon{display:inline-flex;align-items:center;justify-content:center;width:24px;height:26px;font-size:18px;color:var(--rr-accent)}.dsh-report-reading-dock button:last-child{width:24px;height:28px;color:var(--rr-muted);font-size:16px}.dsh-report-reading-dock[data-busy=true] .rr-dock-icon{opacity:.6}
      .dsh-report-reading .rr-document>div{color:var(--rr-ink)}.dsh-report-reading .rr-document h1{color:var(--rr-heading-1,var(--rr-accent))}.dsh-report-reading .rr-document h2{color:var(--rr-heading-2,var(--rr-accent))}.dsh-report-reading .rr-document :is(h3,h4,h5,h6){color:var(--rr-ink)}.dsh-report-reading .rr-document li::marker{color:var(--rr-muted)}.dsh-report-reading .rr-document a:not(:where(pre *,code *)){color:var(--rr-link,var(--rr-accent))}.dsh-report-reading .rr-document :not(pre)>code{color:var(--dsw-alias-label-primary,var(--rr-ink))}
      .dsh-report-reading .rr-theme-fields{display:grid;gap:8px}.dsh-report-reading .rr-theme-field{display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:11px;color:var(--rr-ink)}.dsh-report-reading .rr-theme-field select{font:inherit;color:var(--rr-ink);background:var(--rr-bg);border:1px solid var(--rr-border);border-radius:6px;padding:4px 7px;min-height:29px;min-width:145px;max-width:190px}.dsh-report-reading .rr-theme-field select:disabled{opacity:.65}.dsh-report-reading .rr-theme-current,.dsh-report-reading .rr-theme-notice{margin:0;font-size:10px;color:var(--rr-muted);line-height:1.7;max-width:290px}.dsh-report-reading .rr-theme-notice{padding-top:3px}
      .dsh-report-reading .rr-appearance{margin-inline-start:auto}.dsh-report-reading .rr-readable-note{max-width:740px;margin:0 auto 24px;display:flex;align-items:flex-start;gap:12px;color:var(--rr-muted);font-size:11px}.dsh-report-reading .rr-readable-note p{flex:1;margin:0}.dsh-report-reading .rr-readable-note button{flex:none;font-size:10px}.dsh-report-reading .rr-readable-passage{margin-bottom:1.15em;min-width:0}.dsh-report-reading .rr-readable-source{margin:-.45em 0 1.1em;font-size:10px;color:var(--rr-muted)}.dsh-report-reading .rr-readable-source summary{cursor:pointer;width:fit-content;padding:2px 0;list-style-position:inside}.dsh-report-reading .rr-readable-source summary:focus-visible{outline:2px solid var(--rr-accent);outline-offset:3px}.dsh-report-reading .rr-readable-source pre{font:11px/1.9 ui-monospace,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere;border-left:2px solid var(--rr-border);border-radius:0;margin:8px 0 14px;padding:2px 0 2px 12px;color:var(--rr-muted);background:transparent}
      @keyframes rr-enter{from{opacity:0;transform:translateY(7px) scale(.99)}to{opacity:1;transform:none}}@keyframes rr-locate{0%,70%{opacity:.9}100%{opacity:0}}@media(prefers-reduced-motion:reduce){.dsh-report-reading,.dsh-report-reading-dock{animation:none;scroll-behavior:auto}.dsh-report-reading .rr-document p[data-rr-locate]:before{animation:none;opacity:.9}}
      .dsh-report-reading .rr-review-nav,.dsh-report-reading .rr-review-marker{display:flex;align-items:center;gap:4px 10px;flex-wrap:wrap;font-size:12px;color:var(--rr-muted)}
      .dsh-report-reading .rr-review-nav{max-width:740px;margin:0 auto 18px;padding-bottom:8px;border-bottom:1px solid var(--rr-border)}
      .dsh-report-reading .rr-review-marker{margin:0 0 5px}.dsh-report-reading .rr-review-marker span{border-inline-start:2px solid var(--rr-accent);padding-inline-start:7px}
      .dsh-report-reading :is(.rr-review-nav,.rr-review-marker) button{font:inherit;color:var(--rr-accent);border:0;background:transparent;padding:3px 2px;text-decoration:underline;text-underline-offset:3px}
      .dsh-report-reading .rr-readable-passage:focus-visible{outline:2px solid var(--rr-accent);outline-offset:4px}
      @media(max-width:600px){.dsh-report-reading,.dsh-report-reading[data-wide=true]{right:7px;bottom:max(7px,env(safe-area-inset-bottom));width:calc(100vw - 14px);height:calc(100dvh - 60px);max-height:calc(100dvh - 60px);border-radius:12px}.dsh-report-reading .rr-head{padding:10px;gap:5px}.dsh-report-reading .rr-head-title h2{font-size:13px}.dsh-report-reading .rr-head-title small{font-size:9px}.dsh-report-reading .rr-head-actions{gap:3px}.dsh-report-reading .rr-head-actions button{font-size:10px;padding:4px 6px}.dsh-report-reading .rr-toolbar{padding:9px 10px;gap:4px}.dsh-report-reading .rr-content{padding:23px 17px 30px}.dsh-report-reading .rr-document{font-size:14px;line-height:1.95}.dsh-report-reading .rr-intro{align-items:flex-start;gap:9px;font-size:11px}.dsh-report-reading .rr-footer{padding:8px 10px}.dsh-report-reading .rr-status{padding:7px 10px}}
      @media(max-width:330px){.dsh-report-reading .rr-head-title small{display:none}.dsh-report-reading .rr-head-actions button{padding:3px 5px;min-width:26px}.dsh-report-reading .rr-toolbar{align-items:flex-start}.dsh-report-reading .rr-content{padding:18px 13px}}
    `;
    const reportReadingListeners=new Set();
    const reportReadingRuntime={root:null,container:null,target:null,minimized:false,previousFocus:null,
      open(sessionId,seq){
        if(typeof createChatRoot!=='function')throw Error('当前客户端暂不支持独立阅读页，请升级 DSH。');
        if(chatRuntime.opened&&!chatRuntime.minimized)chatRuntime.setMinimized(true);
        if(!this.root){this.container=document.createElement('div');this.container.dataset.personaShell='report-reading-runtime';document.body.appendChild(this.container);this.root=createChatRoot(this.container);}
        this.previousFocus=document.activeElement;this.minimized=false;this.target={sessionId,seq};
        this.root.render(h(ReportVisualizationWindow,{key:rowKey(sessionId,seq),sessionId,seq,onClose:()=>this.close()}));
        for(const notify of reportReadingListeners)notify(false);
      },
      minimize(){if(!this.target||this.minimized)return;this.minimized=true;for(const notify of reportReadingListeners)notify(true);},
      restore(){if(!this.target)return;if(chatRuntime.opened&&!chatRuntime.minimized)chatRuntime.setMinimized(true);this.minimized=false;for(const notify of reportReadingListeners)notify(false);},
      close(){this.root?.render(null);this.target=null;this.minimized=false;if(this.previousFocus?.isConnected)this.previousFocus.focus({preventScroll:true});},
      dispose(){this.root?.unmount();this.container?.remove();this.root=null;this.container=null;this.target=null;this.minimized=false;reportReadingListeners.clear();}
    };
    const reportReadingError=reason=>({
      'report-not-found':'这份报告尚未保留完整原文。可以在后续任务的最终汇报中使用阅读页。',
      'report-unavailable':'这份报告尚未保留完整原文。可以在后续任务的最终汇报中使用阅读页。',
      'source-unavailable':'这份报告没有可读取的完整原文。',
      'report-incomplete':'报告还没有完整结束，请等最终汇报完成后再打开。',
      'report-too-long':'原报告超过本次分析的上限，没有截断处理。请在工作会话查看完整原文。',
      'too-long':'原报告超过本次可整理的上限，没有截断处理。',
      'report-source-changed':'这份报告的原文已更新，请重新读取后再整理。',
      'report-visualization-conflict':'报告原文或整理设置已变化，请重新读取后再试。',
      'report-visualization-invalid':'这次整理未通过内容或原文依据检查，原报告和已有阅读页均保留。',
      'report-invalid-output':'这次整理未通过检查，原报告和已有阅读页均保留。',
      'report-visualization-busy':'这份报告正在整理，请稍后重新读取。',
      'report-busy':'这份报告正在整理，请稍后重新读取。',
      'report-request-conflict':'本次整理请求已变化，请重新读取后再试。',
      'report-capacity':'同时整理的报告较多，请等已有任务完成后再试。',
      'report-model-unavailable':'暂时没有可用模型，请在设置中选择转述或报告阅读模型。',
      'report-save-failed':'这次阅读页没有保存成功，原报告和已有阅读页均保留，可以重新整理。',
      'report-timeout':'这次整理等待超时，原报告和已有阅读页均保留，可以手动重试。',
      'report-cancelled':'这次整理已停止，原报告和已有阅读页均保留。',
      'storage-not-ready':'本地保存服务尚未就绪，请稍后重新读取。',
      'model-unavailable':'暂时没有可用模型，请在设置中选择转述或报告阅读模型。',
      'disposed':'插件已重载，请关闭后重新打开阅读页。',
    }[reason]??'这次读取或整理没有完成，原报告和已有阅读页均保留，可以手动重试。');
    function reportIssueExplanation(issue){
      const code=typeof issue?.code==='string'?issue.code:'';
      if(code==='readable-all-fallback')return'这次返回的正文没有可采用的段落。当前显示的仍是上次保存的顺畅稿，没有自动重试。';
      if(code==='source-invalid')return'原文快照暂时无法核对。请先重新读取这份报告，再决定是否重新生成。';
      if(/(?:refs?|reference|citation|evidence)/i.test(code))return'有内容缺少有效的原文依据，无法安全整理。请先查看原文，或手动重新生成一次。';
      if(/(?:number|literal|command|path|version|ground)/i.test(code))return'有数字、路径或命令无法与引用的原文对应。为避免改错技术内容，这次没有采用该结果。';
      if(/(?:length|long|limit|budget)/i.test(code))return'返回的内容超过阅读页的长度限制。原文没有被截断；可以尝试使用输出更简洁的模型。';
      if(/(?:state|badge|status)/i.test(code))return'返回的验证状态无法从原文确认，这次没有把它当成已验证的结果。';
      if(/(?:unsafe|execut|script|html)/i.test(code))return'返回内容含有阅读页不支持的代码或界面指令，因此没有显示。原文仍可查看。';
      if(/(?:json|schema|format|field|type|duplicate|structure|template)/i.test(code))return'模型返回的结构没有完整匹配阅读页格式。这通常是输出格式问题，原文和已有结果没有改变。';
      return'这次返回内容未能完成格式或原文依据核对。没有自动追加模型调用，原文与已有阅读页仍然保留。';
    }
    function useReportReadingLayout(root,source,plan,focused,jump,onStatus,active=true){
      const opened=React.useRef({hash:source.hash,ids:new Set()}),handledJump=React.useRef(null),continuity=React.useRef(null),locator=React.useRef(null),activeView=React.useRef(active);
      activeView.current=active;
      const clearLocator=()=>{const own=locator.current;if(!own)return;locator.current=null;own.view.clearTimeout(own.timer);
        if(own.blur)own.node.removeEventListener('blur',own.blur);
        for(const [name,value]of own.attrs){if(own.node.getAttribute(name)!==value.written)continue;if(value.before===null)own.node.removeAttribute(name);else own.node.setAttribute(name,value.before);}};
      useLayoutEffect(()=>{if(!active)clearLocator();return clearLocator;},[active,source.hash]);
      if(opened.current.hash!==source.hash){opened.current={hash:source.hash,ids:new Set()};handledJump.current=null;continuity.current=null;}
      useLayoutEffect(()=>{
        const element=root.current,view=element?.ownerDocument.defaultView;if(!element||!view)return;
        let frame,live=true,observer,records=[],targets=new Map(),foldRecords=[];
        const normalize=text=>String(text??'').replace(/\s+/gu,' ').trim();
        const remember=(node,name,value)=>{let record=records.find(item=>item.node===node);if(!record){record={node,attrs:new Map()};records.push(record);}if(!record.attrs.has(name))record.attrs.set(name,{before:node.getAttribute(name),written:value});else record.attrs.get(name).written=value;
          if(value===null)node.removeAttribute(name);else node.setAttribute(name,value);};
        const clear=()=>{for(const item of foldRecords)item.button.remove();foldRecords=[];
          for(const {node,attrs}of records)for(const [name,value]of attrs){if(node.getAttribute(name)!==value.written)continue;if(value.before===null)node.removeAttribute(name);else node.setAttribute(name,value.before);}records=[];};
        const report=()=>onStatus?.({targets:[...targets.keys()],foldable:[...targets.values()].filter(item=>item.entry.foldable===true&&item.entry.keep===false).length,folded:foldRecords.filter(item=>!opened.current.ids.has(item.entry.blockId)).length});
        const observe=()=>observer?.observe(element,{subtree:true,childList:true,characterData:true});
        const visibleAnchor=()=>{const content=element.closest('.rr-content');if(!content)return null;const top=content.getBoundingClientRect().top;
          const node=[...element.querySelectorAll('p')].find(paragraph=>!paragraph.closest('[hidden]')&&paragraph.getBoundingClientRect().bottom>top+10);
          return node?{node,top:node.getBoundingClientRect().top-top,hash:source.hash}:null;};
        const setDisclosure=(record,expanded)=>{
          if(expanded){remember(record.node,'hidden',null);remember(record.node,'data-rr-hidden',null);}else{remember(record.node,'hidden','');remember(record.node,'data-rr-hidden','true');}
          record.button.textContent=expanded?'收起这段说明':'展开这段说明';record.button.setAttribute('aria-expanded',String(expanded));
          const preview=record.entry.matchText.slice(0,96);record.button.title=preview;
          record.button.setAttribute('aria-label',(expanded?'收起':'展开')+'第 '+record.index+' 段说明：'+preview);
        };
        const apply=()=>{frame=undefined;if(!live||!element.isConnected)return;observer?.disconnect();
          const focusedBlock=foldRecords.find(item=>item.button===element.ownerDocument.activeElement)?.entry.blockId;
          const content=element.closest('.rr-content'),previous=continuity.current?.hash===source.hash&&continuity.current.node.isConnected?continuity.current:visibleAnchor();continuity.current=null;
          const anchor=previous?.node,oldTop=previous?.top;
          clear();targets=new Map();
          if(plan?.sourceHash!==source.hash||!Array.isArray(plan?.entries)||source.blocks.map(block=>block.text).join('')!==source.text){report();observe();return;}
          const paragraphs=[...element.querySelectorAll('p')],byText=new Map(),entryTexts=new Map(),sourceBlocks=new Map();let offset=0;
          for(const block of source.blocks){sourceBlocks.set(block.id,{...block,start:offset});offset+=block.text.length;}
          for(const node of paragraphs){const text=normalize(node.textContent);if(text)byText.set(text,[...(byText.get(text)??[]),node]);}
          for(const entry of plan.entries)if(typeof entry.matchText==='string'&&normalize(entry.matchText))entryTexts.set(normalize(entry.matchText),(entryTexts.get(normalize(entry.matchText))??0)+1);
          for(const entry of plan.entries){const text=typeof entry.matchText==='string'?normalize(entry.matchText):'',matches=byText.get(text),block=sourceBlocks.get(entry.blockId);
            if(!text||entryTexts.get(text)!==1||matches?.length!==1||!block||block.kind==='code'||entry.start!==block.start||entry.end!==block.start+block.text.length)continue;
            const node=matches[0];if(node.closest('li,table,blockquote,pre,code,button,svg,math,.katex,[hidden]')||node.querySelector('a,button,input,textarea,svg,math,.katex,[data-no-emphasis]'))continue;
            targets.set(entry.blockId,{entry,node});
          }
          const pending=locator.current;if(pending&&(!pending.node.isConnected||targets.get(pending.blockId)?.node!==pending.node))clearLocator();
          const requested=activeView.current&&jump?.sourceHash===source.hash&&handledJump.current!==jump.token?targets.get(jump.blockId):null;
          if(requested)opened.current.ids.add(jump.blockId);
          if(focused)for(const {entry,node}of targets.values())if(entry.foldable===true&&entry.keep===false){
            const button=element.ownerDocument.createElement('button'),index=plan.entries.findIndex(item=>item.blockId===entry.blockId)+1;
            button.type='button';button.className='rr-fold-toggle';button.dataset.rrOwned='fold';
            const id=node.id||'rr-'+source.hash.slice(0,12)+'-'+entry.blockId;remember(node,'id',id);button.setAttribute('aria-controls',id);
            const record={entry,node,button,index};foldRecords.push(record);setDisclosure(record,opened.current.ids.has(entry.blockId));node.before(button);
            button.addEventListener('click',()=>{observer?.disconnect();const expanded=!opened.current.ids.has(entry.blockId);
              if(expanded)opened.current.ids.add(entry.blockId);else opened.current.ids.delete(entry.blockId);
              setDisclosure(record,expanded);report();observe();});
          }
          if(requested){handledJump.current=jump.token;clearLocator();
            const own={node:requested.node,blockId:jump.blockId,view,attrs:new Map(),timer:null};
            const locate=(name,value)=>{own.attrs.set(name,{before:own.node.getAttribute(name),written:value});own.node.setAttribute(name,value);};
            locate('data-rr-locate',requested.entry.role==='risk'?'risk':'context');
            if(jump.keyboard)locate('tabindex','-1');
            locator.current=own;own.timer=view.setTimeout(()=>{if(locator.current!==own)return;own.timer=null;
              const cue=own.attrs.get('data-rr-locate');if(own.node.getAttribute('data-rr-locate')===cue.written){if(cue.before===null)own.node.removeAttribute('data-rr-locate');else own.node.setAttribute('data-rr-locate',cue.before);}own.attrs.delete('data-rr-locate');
              // Removing tabindex while the paragraph is focused makes Chromium drop keyboard focus.
              if(own.attrs.has('tabindex')&&own.node.ownerDocument.activeElement===own.node){own.blur=()=>{if(locator.current===own)clearLocator();};own.node.addEventListener('blur',own.blur,{once:true});}
              else clearLocator();},2200);
            if(content){const bounds=content.getBoundingClientRect();content.scrollTop+=requested.node.getBoundingClientRect().top-bounds.top-18;}
            if(jump.keyboard)requested.node.focus({preventScroll:true});
          }else if(content&&anchor?.isConnected&&oldTop!==undefined){const replacement=anchor.hidden?foldRecords.find(item=>item.node===anchor)?.button:anchor;
            if(replacement)content.scrollTop+=replacement.getBoundingClientRect().top-content.getBoundingClientRect().top-oldTop;}
          if(!requested&&focusedBlock)foldRecords.find(item=>item.entry.blockId===focusedBlock)?.button.focus({preventScroll:true});
          report();observe();
        };
        const schedule=()=>{if(frame===undefined)frame=view.requestAnimationFrame(apply);};
        observer=typeof view.MutationObserver==='function'?new view.MutationObserver(schedule):null;apply();
        return()=>{live=false;observer?.disconnect();if(frame!==undefined)view.cancelAnimationFrame(frame);clearLocator();continuity.current=activeView.current?visibleAnchor():null;clear();};
      },[source.hash,source.text,source.blocks,plan,focused,jump]);
    }
    function ReportOriginalDocument({source,readingPlan,focused,jump,onReadingStatus,active}){
      const root=React.useRef(null);
      const markdown=React.useMemo(()=>renderMarkdown(source.text,false,{margin:0}),[source.text]);
      useReportReadingLayout(root,source,readingPlan,focused,jump,onReadingStatus,active);
      return h('div',{ref:root,className:'rr-document','data-source-hash':source.hash,'aria-label':'原始报告全文'},markdown);
    }
    function readableReportMatches(value,source){
      return value?.schemaVersion===3&&Array.isArray(value.blocks)&&value.blocks.length===source.blocks.length
        &&value.blocks.every((block,index)=>block?.ref===source.blocks[index].id&&typeof block.text==='string'&&block.text.trim());
    }
    function readableReviewLocations(warnings,length){
      const marked=new Map(),unlocated=new Set();
      for(const warning of Array.isArray(warnings)?warnings:[]){
        const code=warning?.code;
        if(code!=='readable-block-original'&&code!=='readable-wording-review')continue;
        const match=/^\$\.blocks\[(0|[1-9]\d*)\](?:\.text)?$/.exec(warning.path);
        const index=match?Number(match[1]):-1;
        if(index<0||index>=length){unlocated.add(code);continue;}
        if(!marked.has(index)||code==='readable-block-original')marked.set(index,code);
      }
      return {marked,ordered:[...marked.keys()].sort((a,b)=>a-b),unlocated};
    }
    function ReportReadableDocument({source,result,warnings}){
      const root=React.useRef(null);
      const passages=React.useMemo(()=>result.blocks.map((block,index)=>({ref:block.ref,text:block.text,
        original:source.blocks[index].text,content:renderMarkdown(block.text,false,{margin:0})})),[source,result]);
      const {marked,ordered,unlocated}=React.useMemo(()=>readableReviewLocations(warnings,passages.length),[warnings,passages.length]);
      const locate=index=>{
        const section=root.current?.children[index],pane=root.current?.closest('.rr-content');
        if(!pane||!section||section.dataset.readableRef!==passages[index]?.ref)return;
        section.focus({preventScroll:true});
        pane.scrollTop+=section.getBoundingClientRect().top-pane.getBoundingClientRect().top-18;
      };
      return h(React.Fragment,null,
        ordered.length?h('nav',{className:'rr-review-nav','aria-label':'顺畅稿段落核对'},h('span',null,'已标出 '+ordered.length+' 段'),h('button',{type:'button',onClick:()=>locate(ordered[0])},'查看第一处')):null,
        unlocated.has('readable-block-original')?h('p',{className:'rr-reading-status'},'部分段落保留了原文，可就地核对。'):null,
        unlocated.has('readable-wording-review')?h('p',{className:'rr-reading-status'},'部分表达建议对照原文核对。'):null,
        h('div',{ref:root,className:'rr-document rr-readable-document','data-source-hash':source.hash,'aria-label':'顺畅阅读稿'},
        ...passages.map((block,index)=>{
          const code=marked.get(index),label=code==='readable-block-original'?'已保留原文':'建议核对措辞';
          return h('section',{key:block.ref,className:'rr-readable-passage','data-readable-ref':block.ref,
            ...(code?{tabIndex:-1,'aria-label':'第 '+(index+1)+' 段：'+label}:{})},
          code?h('div',{className:'rr-review-marker'},h('span',null,label),ordered.length>1?h('button',{type:'button',onClick:()=>locate(ordered[(ordered.indexOf(index)+1)%ordered.length])},'下一处'):null):null,block.content,
          block.text.trim()!==block.original.trim()?h('details',{className:'rr-readable-source'},h('summary',null,'核对原文'),
            h('pre',null,block.original)):null);
        })));
    }
    const READABLE_NOTICE_KEY='dsh-persona-shell:readable-notice:v1';
    function readableLocalDate(){const date=new Date();return date.getFullYear()+'-'+String(date.getMonth()+1).padStart(2,'0')+'-'+String(date.getDate()).padStart(2,'0');}
    function readableNoticeDismissedToday(){try{return localStorage.getItem(READABLE_NOTICE_KEY)===readableLocalDate();}catch{return false;}}
    function ReadableGenerationNotice({onClose,onConfirm}){
      const [today,setToday]=React.useState(false),content=React.useRef(null),cancel=React.useRef(null);
      useLayoutEffect(()=>{const dialog=content.current?.closest('dialog');if(!dialog)return;cancel.current?.focus({preventScroll:true});
        const trap=event=>{if(event.key!=='Tab')return;const controls=[...dialog.querySelectorAll('button:not(:disabled),input:not(:disabled),[tabindex="0"]')].filter(node=>!node.closest('[hidden]'));
          const first=controls[0],last=controls.at(-1),active=dialog.ownerDocument.activeElement;
          if((event.shiftKey&&(active===first||!dialog.contains(active)))||(!event.shiftKey&&(active===last||!dialog.contains(active)))){event.preventDefault();(event.shiftKey?last:first)?.focus();}};
        dialog.addEventListener('keydown',trap,true);return()=>dialog.removeEventListener('keydown',trap,true);},[]);
      return h(ActionDialog,{title:'生成前请留意',onClose},h('div',{ref:content},
        h('p',null,'顺畅稿由模型润色，不保证信息准确，也可能遗漏内容或改变原意。重要结论和操作条件，请对照原文核对。'),
        h('label',{style:{display:'flex',alignItems:'center',gap:8}},h('input',{type:'checkbox',checked:today,onChange:event=>setToday(event.target.checked)}),'今日不再提醒'),
        h('div',{className:'dsh-persona-action-buttons'},h('button',{ref:cancel,type:'button',onClick:onClose},'取消'),
          h('button',{type:'button','data-primary':'',onClick:()=>onConfirm(today)},'确认生成'))));
    }
    function ReportVisualizationWindow({sessionId,seq,onClose}){
      const readingTheme=useReportTheme(),themeStyle={...readingTheme.theme.vars,colorScheme:readingTheme.theme.appearance};
      const [data,setData]=React.useState(null),[loading,setLoading]=React.useState(true),[busy,setBusy]=React.useState(false),[info,setInfo]=React.useState(''),[issue,setIssue]=React.useState(null);
      const [wide,setWide]=React.useState(false),[minimized,setMinimized]=React.useState(reportReadingRuntime.minimized);
      const [focused,setFocused]=React.useState(false),[readingStatus,setReadingStatus]=React.useState({targets:[],foldable:0,folded:0}),[jump,setJump]=React.useState(null),[guidePosition,setGuidePosition]=React.useState(null);
      const [readable,setReadable]=React.useState(false),[readableData,setReadableData]=React.useState(null),[readableLoading,setReadableLoading]=React.useState(false),[readableBusy,setReadableBusy]=React.useState(false),[readableInfo,setReadableInfo]=React.useState(''),[readableIssue,setReadableIssue]=React.useState(null);
      const [readableNotice,setReadableNotice]=React.useState(null),readableNoticeRef=React.useRef(null);
      const readableLifetime=React.useRef({live:true,revision:0,abort:null,task:null,loadedHash:null});
      const guideCursors=React.useRef(new Map()),jumpSequence=React.useRef(0);
      const lifetime=React.useRef({live:true,revision:0,abort:null,task:null}),heading=React.useRef(null),surface=React.useRef(null),dock=React.useRef(null),dockSurface=React.useRef(null),readingPosition=React.useRef(0);
      const modePositions=React.useRef({original:0,readable:0});
      useFloatingDock(dockSurface,minimized);
      const latest=React.useRef(data);latest.current=data;
      const clearReadableNotice=()=>{readableNoticeRef.current=null;setReadableNotice(null);};
      const stop=()=>{const own=lifetime.current,task=own.task;own.revision++;own.abort?.abort();own.abort=null;own.task=null;
        if(task)void actionRequest('report-visualization',{action:'cancel',sessionId,seq,presentation:'emphasis',requestId:task.requestId,sourceHash:task.hash}).catch(()=>{});};
      const stopReadable=()=>{clearReadableNotice();const own=readableLifetime.current,task=own.task;own.revision++;own.abort?.abort();own.abort=null;own.task=null;
        if(task)void actionRequest('report-visualization',{action:'cancel',sessionId,seq,presentation:'readable',requestId:task.requestId,sourceHash:task.hash}).catch(()=>{});};
      const acceptReadable=(value,source)=>{
        if(!value?.source||value.source.sessionId!==sessionId||value.source.seq!==seq||value.source.hash!==source.hash)throw Error('report-source-changed');
        if(value.result&&!readableReportMatches(value.result,source))throw Error('report-invalid-output');
        if(!value.result&&value.cached!==false)throw Error('report-invalid-output');
        setReadableData(value);
      };
      const loadReadable=async(force=false)=>{const own=readableLifetime.current,source=latest.current?.source;
        if(!source||(!force&&own.loadedHash===source.hash)||own.abort)return;
        stopReadable();const token=own.revision,abort=new AbortController();own.abort=abort;setReadableLoading(true);setReadableInfo('');setReadableIssue(null);
        try{const response=await fetch(ROUTE+'/report-visualization?session='+encodeURIComponent(sessionId)+'&seq='+seq+'&presentation=readable',{signal:abort.signal});const value=await response.json();
          if(!own.live||token!==own.revision)return;if(!response.ok)throw Object.assign(Error(value.error??value.reason),{issue:value.issue});
          if(latest.current?.source?.hash!==source.hash)throw Error('report-source-changed');acceptReadable(value,source);own.loadedHash=source.hash;
        }catch(error){if(own.live&&token===own.revision&&!abort.signal.aborted){setReadableInfo(reportReadingError(error.message));setReadableIssue(error.issue??null);}}
        finally{if(own.live&&token===own.revision){own.abort=null;setReadableLoading(false);}}
      };
      const generateReadable=async(regenerate=false,expectedHash)=>{const own=readableLifetime.current,source=latest.current?.source;
        // Local jobs own the live busy state. A cache read's running flag is only a snapshot;
        // the Host still rejects a conflicting job without permanently disabling this action.
        if(!source||(expectedHash&&source.hash!==expectedHash)||!own.live||own.abort||own.task||reportReadingRuntime.minimized||readableBusy||readableLoading||busy||loading||!latest.current?.available)return;
        stopReadable();const token=own.revision,abort=new AbortController(),requestId=chatNonce();own.abort=abort;own.task={requestId,hash:source.hash};setReadableBusy(true);setReadableInfo('正在整理句子，原文和已有顺畅稿保留。');setReadableIssue(null);
        try{const response=await fetch(ROUTE+'/report-visualization',{method:'POST',headers:{'content-type':'application/json'},signal:abort.signal,
          body:JSON.stringify({action:'generate',sessionId,seq,presentation:'readable',sourceHash:source.hash,requestId,...(regenerate?{regenerate:true}:{})})});const value=await response.json();
          if(!own.live||token!==own.revision)return;if(!response.ok)throw Object.assign(Error(value.error??value.reason),{issue:value.issue});
          if(latest.current?.source?.hash!==source.hash)throw Error('report-source-changed');if(!readableReportMatches(value.result,source))throw Error('report-invalid-output');acceptReadable(value,source);own.loadedHash=source.hash;setReadableInfo(own.task?.stopRequested?'已保存本次顺畅稿。':'');
        }catch(error){if(own.live&&token===own.revision&&!abort.signal.aborted){setReadableInfo(error.message==='report-cancelled'?'已停止整理，原文和已有顺畅稿保留。':error.issue?.code==='readable-all-fallback'?'这次没有可用的润色段落，已保留上次的顺畅稿。':reportReadingError(error.message));setReadableIssue(error.issue??null);}}
        finally{if(own.live&&token===own.revision){own.abort=null;own.task=null;setReadableBusy(false);}}
      };
      const requestReadable=(regenerate=false)=>{const own=readableLifetime.current,source=latest.current?.source;
        if(!source||!own.live||own.abort||own.task||readableNoticeRef.current||readableBusy||readableLoading||busy||loading||!latest.current?.available)return;
        if(readableNoticeDismissedToday()){void generateReadable(regenerate,source.hash);return;}
        const pending={hash:source.hash,regenerate};readableNoticeRef.current=pending;setReadableNotice(pending);
      };
      const confirmReadable=today=>{const pending=readableNoticeRef.current;clearReadableNotice();
        if(!pending||!readableLifetime.current.live||reportReadingRuntime.minimized||latest.current?.source?.hash!==pending.hash
          ||reportReadingRuntime.target?.sessionId!==sessionId||reportReadingRuntime.target?.seq!==seq)return;
        if(today)try{localStorage.setItem(READABLE_NOTICE_KEY,readableLocalDate());}catch{/* This confirmation still applies; a later request may remind again. */}
        void generateReadable(pending.regenerate,pending.hash);
      };
      const accept=value=>{
        if(value?.source&&(value.source.sessionId!==sessionId||value.source.seq!==seq||typeof value.source.hash!=='string'||typeof value.source.text!=='string'||!Array.isArray(value.source.blocks)))throw Error('report-source-changed');
        const compatible=value?.result?.schemaVersion===2&&Array.isArray(value.result.annotations);
        const next={...value,result:compatible?value.result:undefined,cached:compatible&&value.cached===true};setData(next);latest.current=next;
      };
      const load=async(refreshReadable=false)=>{stop();const own=lifetime.current,token=own.revision,abort=new AbortController(),previousHash=latest.current?.source?.hash;own.abort=abort;setLoading(true);setInfo('');setIssue(null);
        try{const response=await fetch(ROUTE+'/report-visualization?session='+encodeURIComponent(sessionId)+'&seq='+seq+'&presentation=emphasis',{signal:abort.signal});const value=await response.json();
          if(!own.live||token!==own.revision)return;if(!response.ok)throw Object.assign(Error(value.error??value.reason),{issue:value.issue});accept(value);
          if(!value.available)setInfo(reportReadingError(value.reason));
          else if(refreshReadable&&previousHash===value.source?.hash)await loadReadable(true);
        }catch(error){if(own.live&&token===own.revision&&!abort.signal.aborted){setInfo(reportReadingError(error.message));setIssue(error.issue??null);if(refreshReadable){setReadableInfo(reportReadingError(error.message));setReadableIssue(error.issue??null);}}}
        finally{if(own.live&&token===own.revision){setLoading(false);own.abort=null;}}
      };
      React.useEffect(()=>{lifetime.current.live=true;readableLifetime.current.live=true;void load();return()=>{lifetime.current.live=false;readableLifetime.current.live=false;stop();stopReadable();};},[sessionId,seq]);
      React.useEffect(()=>{const update=value=>{if(value){clearReadableNotice();readingPosition.current=surface.current?.querySelector('.rr-content')?.scrollTop??0;}setMinimized(value);};reportReadingListeners.add(update);return()=>reportReadingListeners.delete(update);},[]);
      useLayoutEffect(()=>{if(minimized){dock.current?.focus({preventScroll:true});return;}const content=surface.current?.querySelector('.rr-content');if(content)content.scrollTop=readingPosition.current;heading.current?.focus({preventScroll:true});return enterChatSurface(surface.current);},[minimized]);
      useLayoutEffect(()=>{const content=surface.current?.querySelector('.rr-content');if(content)content.scrollTop=modePositions.current[readable?'readable':'original'];},[readable]);
      const generate=async(regenerate=false)=>{const own=lifetime.current,source=latest.current?.source;if(busy||loading||!latest.current?.available||!source)return;
        stop();const token=own.revision,abort=new AbortController(),requestId=chatNonce();own.abort=abort;own.task={requestId,hash:source.hash};setBusy(true);setInfo('正在分析阅读重点，原始报告保持不变。');setIssue(null);
        try{const response=await fetch(ROUTE+'/report-visualization',{method:'POST',headers:{'content-type':'application/json'},signal:abort.signal,
          body:JSON.stringify({action:'generate',sessionId,seq,presentation:'emphasis',sourceHash:source.hash,requestId,...(regenerate?{regenerate:true}:{})})});const value=await response.json();
          if(!own.live||token!==own.revision)return;if(!response.ok)throw Object.assign(Error(value.error??value.reason),{issue:value.issue});
          if(value.result?.schemaVersion!==2||!Array.isArray(value.result.annotations)||value.source?.hash!==source.hash)throw Error('report-source-changed');accept(value);setInfo(own.task?.stopRequested?'已保存本次阅读重点。':'');
        }catch(error){if(own.live&&token===own.revision&&!abort.signal.aborted){setInfo(error.message==='report-cancelled'?'已停止分析，原文和已有导览保留。':reportReadingError(error.message));setIssue(error.issue??null);}}
        finally{if(own.live&&token===own.revision){setBusy(false);own.abort=null;own.task=null;}}
      };
      const source=data?.source,result=data?.result;
      const readableResult=source&&readableData?.source?.hash===source.hash&&readableReportMatches(readableData.result,source)?readableData.result:null;
      const readingPlan=React.useMemo(()=>source?createReportReadingPlan(source,result):null,[source,result]);
      React.useEffect(()=>{setFocused(false);setJump(null);setGuidePosition(null);guideCursors.current.clear();stopReadable();readableLifetime.current.loadedHash=null;setReadableData(null);setReadableLoading(false);setReadableBusy(false);setReadableInfo('');setReadableIssue(null);modePositions.current={original:0,readable:0};setReadable(false);},[source?.hash]);
      const guideLabels={result:'主要结果',risk:'风险与条件',decision:'需要你确认',evidence:'验证依据',next:'下一步'};
      const targetIds=new Set(readingStatus.targets),guideGroups=['result','risk','decision','evidence','next'].map(kind=>({kind,items:(readingPlan?.navigation??[]).filter(item=>item.kind===kind&&targetIds.has(item.blockId))})).filter(group=>group.items.length);
      const navigate=(group,event)=>{const index=((guideCursors.current.get(group.kind)??-1)+1)%group.items.length;guideCursors.current.set(group.kind,index);
        setGuidePosition({kind:group.kind,index:index+1,total:group.items.length});setJump({blockId:group.items[index].blockId,token:++jumpSequence.current,sourceHash:source.hash,keyboard:event.detail===0});};
      const warnings=Array.isArray(data?.warnings)?data.warnings:[],contentWarnings=warnings.filter(warning=>!['json-fence-normalized','schema-version-defaulted','duplicate-refs-normalized'].includes(warning?.code));
      // Keep the generation response attached: only it can report whether a pending save committed.
      const requestStop=async(isReadable)=>{
        const own=(isReadable?readableLifetime:lifetime).current,task=own.task;
        if(!own.live||!task||task.stopRequested)return;
        const show=isReadable?setReadableInfo:setInfo;
        task.stopRequested=true;show('正在请求停止…');
        try{
          const {ok,value}=await actionRequest('report-visualization',{action:'cancel',sessionId,seq,presentation:isReadable?'readable':'emphasis',requestId:task.requestId,sourceHash:task.hash});
          if(!own.live||own.task!==task)return;
          if(!ok)throw Error('cancel-request-failed');
          if(value?.outcome==='saving')show('正在保存，完成后会显示结果。');
        }catch{if(own.live&&own.task===task){task.stopRequested=false;show('停止请求未送达，仍在等待本次结果。');}}
      };
      const copy=async()=>{if(!source)return;try{await navigator.clipboard.writeText(source.text);setInfo('已复制完整原文。');}catch{setInfo('当前环境暂不支持复制，请选中原文后复制。');}};
      const copyReadable=async()=>{if(!readableResult)return;try{await navigator.clipboard.writeText(readableResult.blocks.map(block=>block.text.trim()).join('\n\n'));setReadableInfo('已复制顺畅稿。原始报告仍可在「完整原文」中核对。');}catch{setReadableInfo('当前环境暂不支持复制，请选中顺畅稿后复制。');}};
      const close=()=>{stop();stopReadable();onClose();};
      const selectReadable=value=>{if(!value)clearReadableNotice();if(value!==readable){modePositions.current[readable?'readable':'original']=surface.current?.querySelector('.rr-content')?.scrollTop??0;setReadable(value);}if(value)void loadReadable();};
      const visibleInfo=readable?readableInfo:info,visibleIssue=readable?readableIssue:issue,visibleModel=readable?readableData?.model:data?.model,anyBusy=busy||readableBusy;
      const readingChanged=value=>setReadingStatus(previous=>previous.foldable===value.foldable&&previous.folded===value.folded&&previous.targets.join('|')===value.targets.join('|')?previous:value);
      return h(React.Fragment,null,h('style',null,REPORT_READING_CSS),readableNotice&&!minimized?h(ReadableGenerationNotice,{onClose:clearReadableNotice,onConfirm:confirmReadable}):null,minimized?h('div',{ref:dockSurface,className:'dsh-report-reading-dock','data-dock-order':1,'data-busy':anyBusy,style:themeStyle,role:'region','aria-label':'已最小化的报告阅读页'},
        h('button',{ref:dock,type:'button','aria-label':'恢复报告阅读页',title:anyBusy?'正在整理报告':'原始报告与阅读导览',onClick:()=>reportReadingRuntime.restore()},h('span',{className:'rr-dock-icon','aria-hidden':true},'▤'),h('span',null,anyBusy?'整理中':'阅读页')),
        h('button',{type:'button','aria-label':'关闭报告阅读页',title:anyBusy?'关闭并停止本页未完成的生成':'关闭报告阅读页',onClick:close},'×')):null,
        h('section',{ref:surface,className:'dsh-report-reading',role:'dialog','aria-label':'报告阅读页','aria-modal':false,'data-wide':wide,'data-reading-theme':readingTheme.theme.id,'data-reading-appearance':readingTheme.theme.appearance,style:minimized?{...themeStyle,display:'none'}:themeStyle,onKeyDown:event=>{
          if(event.key==='Escape'&&!event.nativeEvent?.isComposing){event.preventDefault();event.stopPropagation();close();}}},
          h('header',{className:'rr-head'},h('div',{className:'rr-head-title'},h('h2',{ref:heading,tabIndex:-1},'报告阅读页'),h('small',null,'保留原文 · 按需展开')),
            h('div',{className:'rr-head-actions'},h('button',{type:'button','aria-label':'复制完整原文',disabled:!source,onClick:()=>void copy()},'复制'),
              h('button',{type:'button','aria-label':'最小化报告阅读页',title:'最小化',onClick:()=>reportReadingRuntime.minimize()},'—'),
              h('button',{type:'button','aria-label':wide?'还原报告阅读页':'放大报告阅读页',onClick:()=>setWide(!wide)},wide?'还原':'放大'),h('button',{type:'button','aria-label':'关闭报告阅读页',title:anyBusy?'关闭并停止本页未完成的生成':'关闭报告阅读页',onClick:close},'关闭'))),
          source?h('div',{className:'rr-toolbar'},h('div',{className:'rr-reading-mode',role:'group','aria-label':'阅读范围'},h('button',{type:'button','aria-pressed':!readable&&!focused,onClick:()=>{selectReadable(false);setFocused(false);}},'完整原文'),h('button',{type:'button','aria-pressed':!readable&&focused,onClick:()=>{selectReadable(false);setFocused(true);}},'重点阅读'),h('button',{type:'button','aria-pressed':readable,onClick:()=>selectReadable(true)},'顺畅阅读')),
            h('details',{className:'rr-appearance'},h('summary',null,'阅读外观'),h('div',{className:'rr-appearance-options'},
              h('div',{className:'rr-theme-fields'},h('label',{className:'rr-theme-field'},'阅读主题',h('select',{'aria-label':'阅读主题',value:readingTheme.preference.theme,onChange:event=>readingTheme.change({theme:event.target.value})},...[['system','跟随 DSH'],['catppuccin','Catppuccin'],['nord','Nord'],['rosepine','Rosé Pine']].map(([value,label])=>h('option',{key:value,value},label)))),
                h('label',{className:'rr-theme-field'},'外观',h('select',{'aria-label':'阅读页外观',disabled:readingTheme.preference.theme==='system',value:readingTheme.preference.theme==='system'?'auto':readingTheme.preference.appearance,title:readingTheme.preference.theme==='system'?'跟随 DSH 主题时，明暗由客户端决定':undefined,onChange:event=>readingTheme.change({appearance:event.target.value})},h('option',{value:'auto'},'跟随客户端'),h('option',{value:'light'},'浅色'),h('option',{value:'dark'},'深色'))),
                h('p',{className:'rr-theme-current'},readingTheme.theme.name+(readingTheme.theme.flavour?' · '+readingTheme.theme.flavour:'')),
                readingTheme.notice?h('p',{className:'rr-theme-notice',role:'status'},readingTheme.notice):null)))):null,
          !readable&&guideGroups.length?h('nav',{className:'rr-guide','aria-label':'原文导览'},h('span',null,'跳到'),...guideGroups.map(group=>h('button',{key:group.kind,type:'button','data-kind':group.kind,'aria-pressed':guidePosition?.kind===group.kind,'aria-label':'查看'+guideLabels[group.kind]+'，共 '+group.items.length+' 处',title:'逐处定位原文，保留原顺序',onClick:event=>navigate(group,event)},guideLabels[group.kind],h('span',{'aria-hidden':true},group.items.length))),h('span',{className:'rr-sr-only',role:'status','aria-live':'polite'},guidePosition?'已定位'+guideLabels[guidePosition.kind]+'，第 '+guidePosition.index+' 处，共 '+guidePosition.total+' 处':'')):null,
          h('main',{className:'rr-content','aria-label':'报告阅读内容'},source?h(React.Fragment,null,
            !readable&&focused?h('p',{className:'rr-reading-status',role:'status'},readingStatus.folded?'已收起 '+readingStatus.folded+' 段补充说明；结论、条件与风险仍保留，可逐段展开。':readingStatus.foldable?'补充说明已全部展开，原文顺序保持不变。':!result?'完整原文保持可读。分析阅读重点后，可收起能可靠定位的补充说明。':!Array.isArray(result.reading)?'这份分析没有段落分类，原文保持完整；可按需重新分析。':'没有可安全收起的说明，原文保持完整。'):null,
            !readable&&!result?h('div',{className:'rr-intro'},h('p',null,'原文已完整载入。按需分析阅读重点，生成段落导览和可展开的补充说明。'),h('button',{type:'button','data-primary':'',disabled:anyBusy||loading||data?.running,onClick:()=>void generate()},busy?'正在分析…':'分析阅读重点')):null,
            !readable&&warnings.length?h('details',{className:'rr-explanation','aria-label':'本次分析说明'},h('summary',null,contentWarnings.length?'部分结果未采用，原文保持完整':'已规范化分析格式'),h('p',null,'只有能与原文可靠对应的段落才会加入导览或收起。无法核对的结果会被忽略，原文保持完整。')):null,
            readable?h(React.Fragment,null,h('div',{className:'rr-readable-note'},h('p',null,'按原文顺序润色表达，重要事实、条件与风险请对照原文核对。'),
              readableResult?h('button',{type:'button',onClick:()=>void copyReadable()},'复制顺畅稿'):null),
              readableResult?h(ReportReadableDocument,{source,result:readableResult,warnings:readableData.warnings}):h('div',{className:'rr-intro'},h('p',null,readableLoading?'正在读取已有顺畅稿…':'首次生成会调用一次模型，原始报告保持不变。'),h('button',{type:'button','data-primary':'',disabled:anyBusy||loading||readableLoading||data?.running,onClick:()=>requestReadable()},readableBusy?'正在整理…':'生成顺畅稿'))):null,
            h('div',{hidden:readable,'aria-hidden':readable||undefined},h(ReportOriginalDocument,{source,readingPlan,focused,jump,onReadingStatus:readingChanged,active:!minimized&&!readable}))):
            h('div',{className:'rr-unavailable'},loading?h('p',{role:'status'},'正在读取原始报告…'):h(React.Fragment,null,h('h3',null,'这份报告暂时无法读取'),h('p',null,reportReadingError(data?.reason)),h('button',{type:'button',onClick:()=>void load()},'重新读取')))),
          visibleInfo?h('div',{className:'rr-status',role:'status','aria-live':'polite'},h('p',null,visibleInfo),visibleIssue?h('details',{'aria-label':'本次分析未完成的原因'},h('summary',null,'查看原因'),h('p',null,reportIssueExplanation(visibleIssue))):null):null,
          h('footer',{className:'rr-footer'},h('span',null,visibleModel?.model?'整理模型：'+visibleModel.model+(visibleModel.provider?' · '+visibleModel.provider:'')+((readable?readableData?.cached:data.cached)?' · 已缓存':''):'导览、展开和外观切换均在本地完成。'),
            readable?(readableBusy?h('button',{type:'button',disabled:!!readableLifetime.current.task?.stopRequested,onClick:()=>void requestStop(true)},'停止整理'):readableResult?h('button',{type:'button',disabled:loading||busy||readableLoading||!data?.available,onClick:()=>requestReadable(true)},'重新生成顺畅稿'):null):busy?h('button',{type:'button',disabled:!!lifetime.current.task?.stopRequested,onClick:()=>void requestStop(false)},'停止分析'):result?h('button',{type:'button',disabled:loading||readableBusy||!data?.available,onClick:()=>void generate(true)},'重新分析'):null,
            h('button',{type:'button',disabled:loading||anyBusy||readableLoading,onClick:()=>void load(readable)},'重新读取'))));
    }
    function ConversationPanel({ sessionId, conversation, onClose }) {
      const [data, setData] = React.useState(conversation);
      const [draft, setDraft] = React.useState(() => conversationDrafts.get(sessionId) ?? null);
      const [target, setTarget] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const busyRef = React.useRef(false);
      const [message, setMessage] = React.useState('');
      const accept = (next, request) => {
        if (!acceptInstance(next, request)) return false;
        setData((old) => {
          if (!old || old.instanceId !== next.instanceId) return next;
          if (Number.isSafeInteger(old.stateRev) && Number.isSafeInteger(next.stateRev)) {
            return next.stateRev >= old.stateRev ? next : old;
          }
          return next.revision >= old.revision ? next : old;
        });
        return true;
      };
      React.useEffect(() => { if (conversation) accept(conversation, ++requestSequence); }, [conversation]);
      React.useEffect(() => {
        let stopped = false;
        const request = ++requestSequence;
        actionRequest(`conversation?session=${encodeURIComponent(sessionId)}`).then(({ ok, value }) => {
          if (!stopped) { if (ok) accept(value, request); else setMessage(actionError(value.error)); }
        }).catch(() => { if (!stopped) setMessage('暂时无法读取会话设置，请关闭后重试。'); });
        return () => { stopped = true; };
      }, [sessionId]);
      const choice = draft ?? { personaId: data?.personaId ?? null, trigger: data?.trigger ?? 'inherit' };
      const edit = (patch) => { const next = { ...choice, ...patch }; setDraft(next); keepDraft(conversationDrafts, sessionId, next); };
      const write = async (body) => {
        if (busyRef.current || !data) return;
        busyRef.current = true; setBusy(true); setMessage('正在保存…');
        const request = ++requestSequence;
        try {
          const { ok, value } = await actionRequest('conversation', { sessionId, revision: data.revision, ...body });
          if (!ok) { if (value.conversation) accept(value.conversation, request); setMessage(actionError(value.error)); return; }
          if (!accept(value, request)) { setMessage('插件状态已更新，请核对当前会话后重试。输入已经保留。'); return; }
          if (body.action === 'select' && conversationDrafts.get(sessionId) === draft) {
            conversationDrafts.delete(sessionId); setDraft(null);
          }
          setMessage(body.action === 'relay' ? '已安排，下一份符合范围的原始汇报到达后接手。'
            : body.action === 'cancel' ? '已取消等待中的接力。' : '已保存，从后续汇报开始生效。');
          void refresh(sessionId);
        } catch { setMessage(actionError()); }
        finally { busyRef.current = false; setBusy(false); }
      };
      const presets = data?.presets ?? [];
      const relay = data?.relay;
      const name = (id) => presets.find((p) => p.id === id)?.name ?? '已删除的人格';
      const disabled = busy || !data?.ready;
      return h(ActionDialog, { title: '当前会话的人格', onClose },
        h('p', { className: 'dsh-persona-action-note' }, '只影响这个会话的后续转述。其他会话和历史署名保持各自的选择。'),
        data ? h('div', null,
          h('div', { className: 'dsh-persona-action-box' }, `正在使用：${data.effectivePersonaName}`,
            data.missingPersona ? h('p', { className: 'dsh-persona-action-note' }, '原先选择的人格已被删除，当前使用全局默认。') : null),
          data.relayError ? h('p', { role: 'status', className: 'dsh-persona-action-note' }, data.relayError) : null,
          h('label', null, '会话人格', h('select', { 'aria-label': '会话人格', value: choice.personaId ?? '', disabled,
            onChange: (e) => edit({ personaId: e.target.value || null }) }, h('option', { value: '' }, '跟随全局默认'),
            choice.personaId && !presets.some((p) => p.id === choice.personaId)
              ? h('option', { value: choice.personaId, disabled: true }, '已删除的人格，请重新选择') : null,
            presets.map((p) => h('option', { key: p.id, value: p.id }, p.name)))),
          h('label', null, '转述范围', h('select', { 'aria-label': '会话转述范围', value: choice.trigger, disabled,
            onChange: (e) => edit({ trigger: e.target.value }) },
            h('option', { value: 'inherit' }, '跟随全局设置'), h('option', { value: 'step' }, '全部汇报'),
            h('option', { value: 'report' }, '仅最终汇报'))),
          h('div', { className: 'dsh-persona-action-buttons' },
            h('button', { type: 'button', disabled: disabled || (!!choice.personaId && !presets.some((p) => p.id === choice.personaId)),
              'data-primary': '', onClick: () => write({ action: 'select', ...choice }) }, '保存会话选择'),
            draft ? h('button', { type: 'button', disabled: busy, onClick: () => { setDraft(null); conversationDrafts.delete(sessionId); setMessage('已放弃未提交的选择。'); } }, '放弃修改') : null),
          h('details', { style: { marginTop: '22px' } }, h('summary', { style: { cursor: 'pointer' } },
            relay?.status === 'pending' ? `等待${name(relay.toPersonaId)}接手 · 查看接力` : '交给另一位角色'),
            h('p', { className: 'dsh-persona-action-note' }, '从下一份原始汇报接手，不重写对方的改写稿，也不接管底层工作。仅共享偏好与适用的会话偏好会继续参考。'),
            relay ? h('div', { className: 'dsh-persona-action-box', role: 'status' },
              `${relay.status === 'pending' ? '等待接手' : relay.status === 'active' ? '上次接力已接手' : '上次接力已取消'}：${name(relay.toPersonaId)}`,
              relay.status === 'pending' ? h('div', { className: 'dsh-persona-action-buttons' },
                h('button', { type: 'button', disabled, onClick: () => write({ action: 'cancel', relayId: relay.id }) }, '取消接力')) : null) : null,
            h('label', null, '接手角色', h('select', { 'aria-label': '接手角色', disabled: disabled || relay?.status === 'pending',
              value: relay?.status === 'pending' ? relay.toPersonaId : target, onChange: (e) => setTarget(e.target.value) }, h('option', { value: '' }, '选择一位角色'),
              presets.filter((p) => p.id !== data.effectivePersonaId).map((p) => h('option', { key: p.id, value: p.id }, p.name)))),
            h('button', { type: 'button', disabled: disabled || !target || relay?.status === 'pending' || !!draft,
              onClick: () => write({ action: 'relay', toPersonaId: target }) }, '安排下一份汇报接力'),
            draft ? h('p', { className: 'dsh-persona-action-note' }, '请先保存或放弃上面的会话选择，再安排接力。') : null))
          : h('p', null, '正在读取…'),
        h('p', { role: 'status', 'aria-live': 'polite', className: 'dsh-persona-action-note' }, message || (!data?.ready ? '正在等待保存服务就绪…' : '修改后点击保存。')));
    }

    function ReportFeedback({ sessionId, row, onClose }) {
      const key = rowKey(sessionId, row.seq);
      const [target,setTarget]=React.useState(()=>({sessionId,seq:row.seq,version:row.version,personaId:row.speaker?.id,name:row.speaker?.name??'原汇报人格'}));
      const [acceptedVersion,setAcceptedVersion]=React.useState(null);
      const [draft, setDraft] = React.useState(() => {
        const existing = feedbackDrafts.get(key);
        if (existing?.scope === 'once') return existing;
        const next = { content: existing?.content ?? '', scope: 'once' };
        if (existing) keepDraft(feedbackDrafts, key, next);
        return next;
      });
      const [busy, setBusy] = React.useState(false);
      const busyRef = React.useRef(false);
      const input=React.useRef(null);
      const [message, setMessage] = React.useState('');
      const edit = (patch) => { const next = { ...draft, ...patch }; setDraft(next); keepDraft(feedbackDrafts, key, next); };
      const identityChanged=sessionId!==target.sessionId||row.seq!==target.seq||row.speaker?.id!==target.personaId;
      const awaitingOwnUpdate=!identityChanged&&acceptedVersion===target.version&&row.version<target.version;
      const stale=identityChanged||(row.version!==target.version&&!awaitingOwnUpdate);
      const unavailable=!row.canRetry||!target.personaId;
      const quickChoices=[['短一点','这次短一点，保留结论、必要条件和风险。'],['先说结论','先说结论，再按需要补充依据。'],
        ['少些调侃','少些调侃，直接说明结果和需要注意的事。'],['更正式','表达更正式一些，保留事实与不确定性。']];
      const choose=text=>{
        const old=draft.content.trim(),content=!old||quickChoices.some(([,value])=>value===old)?text:old.includes(text)?old:old+'\n'+text;
        if(content.length>240){setMessage('输入已接近上限，请先精简一些，再添加这项要求。');return;}
        edit({content});setMessage('已填入要求，可修改后再重新转述。');input.current?.focus({preventScroll:true});
      };
      const submit = async () => {
        if (busyRef.current || row.retrying || unavailable || stale || awaitingOwnUpdate || !draft.content.trim() || draft.content.length>240) return;
        busyRef.current = true; setBusy(true); setMessage('正在调整，当前正文会保留到新版本完成…');
        try {
          const { ok, value } = await actionRequest('feedback', { sessionId:target.sessionId, seq: target.seq, version: target.version,
            personaId: target.personaId, content: draft.content, scope: 'once' });
          if (!ok) { setMessage(actionError(value.error)); void refresh(sessionId); return; }
          if (feedbackDrafts.get(key) === draft) {
            feedbackDrafts.delete(key); setDraft({ content: '', scope: 'once' });
          }
          if(Number.isSafeInteger(value.version)&&value.version===target.version+1&&value.personaId===target.personaId){
            setTarget({...target,version:value.version});setAcceptedVersion(value.version);
          }
          setMessage('已按这次偏好重新转述。'); void refresh(sessionId);
        } catch { setMessage(actionError()); }
        finally { busyRef.current = false; setBusy(false); }
      };
      return h(ActionDialog, { title: '调整这份汇报的表达', onClose },
        h('p', { className: 'dsh-persona-action-note' }, `对应人格：${target.name}。只调整措辞，事实、条件和风险仍以原文为准。`),
        h('div',{className:'dsh-persona-action-buttons',role:'group','aria-label':'常用表达要求',style:{marginTop:10}},
          ...quickChoices.map(([name,text])=>h('button',{key:name,type:'button',disabled:busy||row.retrying,
            'aria-pressed':draft.content.trim()===text,title:'只填入要求，确认后再重新转述',onClick:()=>choose(text)},name))),
        h('label', null, '希望怎么说', h('textarea', { ref:input,'aria-label': '表达反馈','aria-describedby':'dsh-persona-feedback-limit', maxLength: 240,
          disabled: busy || row.retrying, value: draft.content, placeholder: '例如：少一点调侃，先说结论，再解释原因。',
          onChange: (e) => edit({ content: e.target.value }) })),
        h('p',{id:'dsh-persona-feedback-limit',className:'dsh-persona-action-note'},draft.content.length+' / 240 字符'),
        h('p', { className: 'dsh-persona-action-note' }, '仅调整这份汇报。长期偏好与记忆请在插件设置的「记忆与约定」中管理。'),
        stale?h('p',{className:'dsh-persona-action-note',role:'status'},'这份汇报的会话、版本或说话者已变化。输入已保留，请关闭后重新打开，核对目标再调整。')
          :unavailable?h('p',{className:'dsh-persona-action-note',role:'status'},actionError(row.retryUnavailableReason??(!target.personaId?'persona-not-found':'source-unavailable'))):null,
        h('div', { className: 'dsh-persona-action-buttons' },
          h('button', { type: 'button', 'data-primary': '', disabled: busy || row.retrying || !draft.content.trim() || draft.content.length>240 || unavailable || stale || awaitingOwnUpdate,
            onClick: submit }, busy || row.retrying ? '处理中…' : '重新转述'),
          h('button', { type: 'button', disabled: busy, onClick: () => { feedbackDrafts.delete(key); setDraft({ content: '', scope: 'once' }); setMessage('已清空输入。'); } }, '清空输入')),
        h('p', { role: 'status', 'aria-live': 'polite', className: 'dsh-persona-action-note' }, message || '关闭后保留未提交的输入。'));
    }

    /**
     * Whether a value is usable as a session id.
     *
     * A literal `"undefined"` or `"null"` passes a plain `typeof` check and then
     * silently fetches nothing: the host answers `rows: []` for an unknown
     * session, so every row falls back to the plain report and the whole persona
     * view disappears with no error anywhere. Rejecting those values turns a
     * silent blank into a visible one.
     * @param {unknown} value
     */
    function usableSessionId(value) {
      if (typeof value !== 'string' || value === '') return false;
      if (value === 'undefined' || value === 'null') return false;
      return true;
    }

    function useHostState(sessionId, seq) {
      const [version, setVersion] = React.useState(0);
      React.useEffect(() => {
        const listener = () => setVersion((value) => value + 1);
        listeners.add(listener);
        const stop = usableSessionId(sessionId) && typeof seq === 'number' ? watch(sessionId, seq) : () => {};
        if (!usableSessionId(sessionId)) {
          // Report once per page: this is the difference between "the plugin is
          // off" and "the plugin cannot see the session", and they look identical.
          reportDiagnostics({ sessionId: String(sessionId), sessionIdUsable: false });
        }
        return () => {
          listeners.delete(listener);
          stop();
        };
      }, [sessionId, seq]);
      return { state: states.get(sessionId), version };
    }

    // --- text rendering ------------------------------------------------------

    /**
     * The shipped markdown renderer, resolved from the shell's module table.
     *
     * `@deepseek-ai/dsh-client-ui-primitives` is part of the frozen
     * `PLATFORM_MODULES` baseline the shell seeds before any plugin runs: the
     * shipped chat package resolves it exactly this way and declares no
     * `dsh.client.external` entry for it. Reusing it means the persona view runs
     * the host's real renderer — same parser, same Shiki highlighting, same
     * KaTeX, same tables — instead of a look-alike.
     *
     * Isolated previews and role-chat bubbles use this helper; the transcript uses the full
     * official assistant adapter below. Missing primitives get plain text,
     * never an imitation Markdown implementation.
     */
    /**
     * @typedef {object} MarkdownRenderer
     * @property {(props: object) => unknown} component - renderer for one markdown document.
     */

    /**
     * Resolve the shipped markdown renderer from the shell's module table.
     *
     * `MarkdownText` is `React.memo(...)`, so its runtime value is an exotic
     * object, **not** a function: a `typeof === 'function'` check rejects the
     * very thing it is looking for. What matters for rendering is that React can
     * treat the value as an element type, which is true for memo and forwardRef
     * objects alike, so the check asks for something callable *or* one of those
     * wrapper shapes.
     * @param {unknown} value
     * @returns {boolean}
     */
    function isElementType(value) {
      if (typeof value === 'function') return true;
      if (value === null || typeof value !== 'object') return false;
      // React.memo({$$typeof: Symbol(react.memo), type}) and forwardRef both
      // carry a $$typeof marker; either one is a valid element type.
      return typeof value.$$typeof === 'symbol';
    }

    /**
     * Whether the shipped renderer resolved. Mirrored locally so the settings
     * page can warn without a round trip: the degradation is visible in the
     * transcript, but the reason belongs next to the controls that cause it.
     */
    let shippedRendererOk = true;

    function shippedMarkdownText() {
      if (markdownResolved) return markdownComponent;
      markdownResolved = true;
      try {
        const primitives = require('@deepseek-ai/dsh-client-ui-primitives');
        const candidate = primitives?.MarkdownText;
        markdownComponent = isElementType(candidate) ? candidate : undefined;
        shippedRendererOk = markdownComponent !== undefined;
        reportDiagnostics({
          ...describePrimitives(primitives, candidate),
          accepted: markdownComponent !== undefined,
        });
      } catch (error) {
        markdownComponent = undefined;
        shippedRendererOk = false;
        reportDiagnostics({
          shippedMarkdown: 'unresolvable',
          reason: error instanceof Error ? error.message : String(error),
        });
      }
      return markdownComponent;
    }

    /**
     * Describe what the module table actually handed over.
     *
     * A bare "not a function" is not enough to act on: the value could be a
     * namespace without the key, a lazy proxy, or a module object that needs a
     * different access path. Reporting the shape once per page turns guesswork
     * into a fact.
     * @param {unknown} primitives
     * @param {unknown} component
     * @returns {Record<string, unknown>}
     */
    function describePrimitives(primitives, component) {
      const accepted = isElementType(component);
      const report = {
        shippedMarkdown: accepted ? 'ok' : 'missing',
        reason: accepted ? '' : `MarkdownText is ${component === null ? 'null' : typeof component}`,
        componentType: component === null ? 'null' : typeof component,
        moduleType: typeof primitives,
      };
      try {
        if (primitives !== null && typeof primitives === 'object') {
          const keys = Object.keys(primitives);
          report.keyCount = keys.length;
          report.markdownKeys = keys.filter((key) => /mark/i.test(key)).slice(0, 12);
          report.hasDefault = 'default' in primitives;
        }
      } catch (error) {
        report.shapeError = error instanceof Error ? error.message : String(error);
      }
      return report;
    }

    /**
     * Tell the host half whether the shipped renderer resolved in this page.
     *
     * There is no way to see a page's module table from the outside, and a
     * silent fallback is indistinguishable from a working one. Reporting it once
     * per page turns "did it work?" into a queryable fact.
     * @param {{ shippedMarkdown: string, reason: string }} payload
     */
    function reportDiagnostics(payload) {
      try {
        void fetch(`${ROUTE}/diagnostics`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          // Every report carries the build id. The page cannot be force-reloaded
          // in the desktop client, so "is the running code the installed code?"
          // is otherwise unanswerable — and a stale bundle silently invalidates
          // every fix made since the last restart.
          body: JSON.stringify({ clientBuild: CLIENT_BUILD, ...payload }),
        }).catch(() => {});
      } catch {
        // Diagnostics must never interfere with rendering.
      }
    }

    let markdownResolved = false;
    let markdownComponent;

    /** Labels the shipped renderer shows on code blocks and footnote sections. */
    const MARKDOWN_LABELS = {
      code: {
        copyLabel: '复制',
        copiedLabel: '已复制',
        toolbarLabels: {
          codeLabel: '代码',
          wrapLabel: '自动换行',
          unwrapLabel: '取消换行',
        },
      },
      footnotes: '脚注',
    };

    /**
     * Last-resort body when the shipped renderer cannot be resolved.
     *
     * Intentionally obvious: plain preformatted text with no attempt to look
     * like markdown. A fake markdown renderer would hide its own gaps (no
     * highlighting, no KaTeX, no footnotes) behind a plausible appearance, so
     * the reader would keep using a broken view for months. This cannot be
     * mistaken for correct, and the settings page raises a warning alongside it.
     */
    const PLAIN_FALLBACK_STYLE = {
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
      font: 'var(--dsw-font-markdown-base, inherit)',
      margin: '16px 0',
    };

    /**
     * Render one block of markdown through the shipped renderer.
     *
     * There is deliberately no local re-implementation behind this. A copy of
     * the shipped renderer never keeps up with the original, and "looks nearly
     * right but silently lacks highlighting, KaTeX and footnotes" is a worse
     * outcome than an obviously degraded one: the first hides the problem for
     * months, the second gets reported immediately.
     *
     * If the module table ever stops carrying `MarkdownText`, the preview degrades
     * to plain preformatted text — visibly wrong, cheap to maintain — and the
     * settings page shows a warning. Fidelity is the shipped component's job.
     * @param {string} text
     * @returns {any}
     */
    function renderMarkdown(text, streaming = false, plainStyle) {
      const MarkdownText = shippedMarkdownText();
      if (MarkdownText !== undefined) {
        return h(MarkdownText, { text, streaming, labels: MARKDOWN_LABELS });
      }
      return h('div', { style: plainStyle ? { ...PLAIN_FALLBACK_STYLE, ...plainStyle } : PLAIN_FALLBACK_STYLE }, text);
    }

    // --- official assistant adapter -----------------------------------------

    const CHAT_SLOT = 'conversation.chat.node';
    const CHILD_FACTORIES = {
      'conversation.chat.reasoning.body': 'conversation.chat.reasoning.content',
      'conversation.chat.message.images': 'conversation.images.content',
    };
    let chatRendererState = { status: 'disabled', reason: '' };
    const rendererListeners = new Set();

    function setChatRendererState(status, reason = '') {
      if (chatRendererState.status === status && chatRendererState.reason === reason) return;
      chatRendererState = { status, reason };
      reportDiagnostics({ chatRenderer: status, chatRendererReason: reason });
      for (const listener of rendererListeners) listener();
    }

    function componentName(component) {
      return typeof component === 'function' ? component.name : component?.type?.name;
    }

    /** Read-only inspection; an unknown host/extension keeps its own renderer. */
    function resolveChatDelegate(slots, ownComponent) {
      const reject = (reason) => ({ ok: false, reason });
      if (['entries', 'entriesOfSlot', 'subscribe', 'snapshot', 'onEntryError'].some((key) => typeof slots?.[key] !== 'function')) {
        return reject('registry-api-unavailable');
      }
      const entries = slots.entries(CHAT_SLOT).filter((entry) => entry.options?.key === 'assistant-step'
        && entry.component !== ownComponent);
      if (entries.length !== 1) return reject(entries.length === 0 ? 'official-assistant-missing' : 'assistant-slot-conflict');
      const entry = entries[0];
      // `registrant` is a Cordis display name (often an ancestor's name), not
      // a package id. Check the supported contract, not diagnostic provenance.
      if (componentName(entry.component) !== 'AssistantNodeView' || (entry.options.priority ?? 0) !== 0
        || !isElementType(entry.component) || entry.locale !== 'chat' || typeof entry.inject !== 'function'
        || entry.store !== undefined || entry.select !== undefined) return reject('unsupported-assistant-contract');
      const childKeys = Object.keys(entry.children ?? {});
      if (childKeys.length !== 2 || childKeys.some((key) => !Object.hasOwn(CHILD_FACTORIES, key)
        || entry.children[key]?.kind !== 'single' || entry.children[key]?.scope !== 'session'
        || Object.keys(entry.children[key]).some((field) => field !== 'kind' && field !== 'scope'))) {
        return reject('unsupported-assistant-children');
      }
      const children = [];
      for (const key of childKeys) {
        const expectedName = key.endsWith('.images') ? 'MessageImages' : 'DefaultReasoningBody';
        const candidates = slots.entries(key);
        const winners = slots.entriesOfSlot(key);
        const child = winners[0];
        if (candidates.length !== 1 || winners.length !== 1 || child !== candidates[0]
          || child.options?.priority !== 100
          || componentName(child.component) !== expectedName
          || child.inject !== undefined || child.children !== undefined || child.store !== undefined
          || child.locale !== undefined || child.select !== undefined) return reject('child-slot-conflict');
        const factory = slots.snapshot(`factory:${CHILD_FACTORIES[key]}`)[0];
        if (factory?.type !== 'factory' || factory.name !== CHILD_FACTORIES[key]
          || factory.scope !== 'root' || factory.registrant !== child.registrant
          || factory.children?.length > 0) return reject('official-factory-unavailable');
        children.push(child);
      }
      return { ok: true, entry, children };
    }

    /** Only a display copy changes; the durable finalNode and other blocks stay shared. */
    function displayNode(node, text) {
      if (typeof text !== 'string' || node?.data?.status !== 'settled') return node;
      const blocks = node.data.blocks;
      if (!Array.isArray(blocks) || blocks.filter((block) => block?.kind === 'text').length !== 1) return node;
      if (blocks.some((block) => block?.kind === 'text' && block.text === text)) return node;
      return { ...node, data: { ...node.data, blocks: blocks.map((block) => block?.kind === 'text' ? { ...block, text } : block) } };
    }

    const childRendererCache = new WeakMap();
    const childAnchorStyle = { display: 'contents' };

    /** Equivalent to the two official default adapters, without claiming their children. */
    function renderOfficial(delegate, props, node = props.node) {
      if (typeof props.renderFactorySlot !== 'function') throw new Error('persona-shell: Factory renderer unavailable');
      let renderSlot = childRendererCache.get(props.renderFactorySlot);
      if (renderSlot === undefined) {
        const renderFactorySlot = props.renderFactorySlot;
        renderSlot = (key, owner) => {
          if (!Object.hasOwn(CHILD_FACTORIES, key)) throw new Error('persona-shell: unsupported official child');
          // Preserve the default outlet's addressable, layout-neutral anchor;
          // themes may select it even though we cannot borrow its authorization.
          return h('div', { 'data-slot': key, style: childAnchorStyle }, renderFactorySlot(CHILD_FACTORIES[key], owner));
        };
        childRendererCache.set(renderFactorySlot, renderSlot);
      }
      return h(delegate.entry.component, { ...props, node, renderSlot });
    }

    /** Chat owns its own locale seat; missing shell copy must not display a key. */
    function shellTranslate(t) {
      return (key) => {
        const value = t?.(key);
        return typeof value === 'string' && value !== key && !value.endsWith(`.${key}`) ? value : undefined;
      };
    }

    // --- components ----------------------------------------------------------

    const headerStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      marginBottom: '4px',
      color: 'var(--dsw-alias-label-secondary)',
      fontSize: '12px',
      lineHeight: '1.4',
    };
    const badgeStyle = {
      display: 'inline-flex',
      alignItems: 'center',
      padding: '0 6px',
      borderRadius: '4px',
      background: 'var(--dsw-alias-bg-layer-2)',
      color: 'var(--dsw-alias-label-secondary)',
      fontSize: '11px',
    };
    const toggleStyle = {
      border: 'none',
      background: 'transparent',
      color: 'var(--dsw-alias-brand-primary)',
      cursor: 'pointer',
      font: 'inherit',
      padding: 0,
    };
    const headerButtonStyle = {
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
      height: '24px', padding: '0 8px', margin: 0, borderRadius: '999px',
      border: '0.5px solid var(--dsw-alias-border-l2,#d8dce4)',
      background: 'var(--dsw-alias-bg-layer-1,#fff)', color: 'var(--dsw-alias-label-secondary,#525c6b)',
      fontFamily: 'inherit', fontSize: '12px', fontWeight: 400, lineHeight: 1, whiteSpace: 'nowrap', cursor: 'pointer',
    };
    const paneLabelStyle = {
      marginBottom: '4px',
      fontSize: '11px',
      lineHeight: '16px',
      letterSpacing: '0.04em',
      textTransform: 'uppercase',
      color: 'var(--dsw-alias-label-tertiary)',
    };

    const COMPARISON_NARROW_WIDTH = 720;
    const COMPARISON_CSS = `
      .persona-shell-comparison[role="dialog"] {
        width: min(1100px, 100%); max-width: 100%; min-width: 0;
        height: min(720px, 80vh); height: min(720px, 80dvh);
        max-height: 100%; min-height: 0; padding: 0; gap: 0;
        color: var(--dsw-alias-label-primary);
      }
      .persona-shell-comparison-surface {
        display: flex; flex-direction: column; flex: 1;
        min-width: 0; min-height: 0; overflow: hidden;
        font-size: var(--dsh-content-font-size, 14px); line-height: 1.6;
      }
      .persona-shell-comparison-header {
        display: flex; align-items: center; justify-content: space-between;
        flex: none; gap: 12px; padding: 14px 18px;
        border-bottom: 0.5px solid var(--dsw-alias-border-l1);
      }
      .persona-shell-comparison-header h2 {
        margin: 0; font-size: 16px; font-weight: 500; overflow-wrap: anywhere;
      }
      .persona-shell-comparison button {
        font: inherit; cursor: pointer; border: 0; border-radius: 4px;
        padding: 4px 10px; min-height: 32px;
        color: var(--dsw-alias-label-secondary); background: transparent;
      }
      .persona-shell-comparison button:hover { background: var(--dsw-alias-interactive-bg-hover); }
      .persona-shell-comparison-header button { flex: none; }
      .persona-shell-comparison-tabs { display: flex; flex: none; gap: 4px; padding: 8px 12px; }
      .persona-shell-comparison-tabs button { flex: 1; }
      .persona-shell-comparison-tabs [aria-selected="true"] {
        color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover);
      }
      .persona-shell-comparison-panes { display: grid; flex: 1; min-width: 0; min-height: 0; }
      .persona-shell-comparison-pane { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
      .persona-shell-comparison-pane + .persona-shell-comparison-pane {
        border-inline-start: 0.5px solid var(--dsw-alias-border-l1);
      }
      .persona-shell-comparison-surface[data-narrow="true"] .persona-shell-comparison-pane { border: 0; }
      .persona-shell-comparison-pane h3 {
        flex: none; margin: 0; padding: 10px 18px; font-size: 12px;
        font-weight: 500; color: var(--dsw-alias-label-secondary);
      }
      .persona-shell-comparison-scroll {
        flex: 1; min-width: 0; min-height: 0; padding: 4px 18px 18px;
        overflow: auto; overscroll-behavior: contain; overflow-wrap: anywhere;
        scrollbar-gutter: stable;
      }
      .persona-shell-comparison-scroll pre { max-width: 100%; overflow: auto; }
      .persona-shell-comparison [hidden] { display: none; }
      .persona-shell-comparison[data-native] {
        box-sizing: border-box; position: fixed; margin: auto;
        width: min(1100px, calc(100vw - 48px));
        max-height: calc(100dvh - 48px); border: 0;
        border-radius: var(--dsw-radius-panel, 12px); overflow: hidden;
        background: var(--dsw-alias-bg-layer-2); box-shadow: var(--dsw-elevation-prominent);
      }
      .persona-shell-comparison[data-native][open] { display: flex; flex-direction: column; }
      .persona-shell-comparison[data-native]::backdrop { background: var(--dsw-alias-bg-mask-1); }
      @media (pointer: coarse) { .persona-shell-comparison button { min-height: 44px; min-width: 44px; } }
    `;
    let nextComparisonId = 0;
    let comparisonModal;
    let comparisonModalResolved = false;
    const comparisonScrollLocks = new WeakMap();

    /** The host Modal traps focus, but wheel/page keys can still scroll the page. */
    function lockComparisonScroll(doc) {
      if (!doc.documentElement?.style || !doc.body?.style) return () => {};
      let lock = comparisonScrollLocks.get(doc);
      if (lock === undefined) {
        const root = doc.documentElement;
        const saved = [root, doc.body].map((element) => ({ element,
          overflow: ['overflow-x', 'overflow-y'].map((name) => [name, element.style.getPropertyValue(name), element.style.getPropertyPriority(name)]),
        }));
        const gutter = root.style.getPropertyValue('scrollbar-gutter');
        const gutterPriority = root.style.getPropertyPriority('scrollbar-gutter');
        const reserveGutter = doc.defaultView?.innerWidth > root.clientWidth
          && !/\bstable\b/.test(doc.defaultView.getComputedStyle(root).scrollbarGutter);
        if (reserveGutter) root.style.setProperty('scrollbar-gutter', 'stable');
        for (const { element } of saved) element.style.setProperty('overflow', 'hidden');
        lock = { count: 0, restore() {
          for (const { element, overflow } of saved) {
            if (element.style.getPropertyValue('overflow') === 'hidden') {
              element.style.removeProperty('overflow');
              for (const [name, value, priority] of overflow) if (value) element.style.setProperty(name, value, priority);
            }
          }
          if (reserveGutter && root.style.getPropertyValue('scrollbar-gutter') === 'stable') {
            if (gutter) root.style.setProperty('scrollbar-gutter', gutter, gutterPriority);
            else root.style.removeProperty('scrollbar-gutter');
          }
        } };
        comparisonScrollLocks.set(doc, lock);
      }
      lock.count += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (--lock.count !== 0) return;
        lock.restore(); comparisonScrollLocks.delete(doc);
      };
    }

    function shippedComparisonModal() {
      if (!comparisonModalResolved) {
        comparisonModalResolved = true;
        try {
          const candidate = require('@deepseek-ai/dsh-client-ui-primitives')?.Modal;
          if (isElementType(candidate)) comparisonModal = candidate;
        } catch { /* Older hosts can still use the browser's modal dialog. */ }
        if (comparisonModal === undefined) reportDiagnostics({ comparisonModal: 'native-fallback' });
      }
      return comparisonModal ?? NativeComparisonModal;
    }

    /** Only used when a host lacks Modal; native top-layer focus/escape semantics. */
    function NativeComparisonModal({ onClose, title, className, children }) {
      const ref = React.useRef(null);
      useLayoutEffect(() => {
        const dialog = ref.current;
        const previous = dialog.ownerDocument.activeElement;
        dialog.showModal();
        return () => {
          dialog.close();
          if (previous?.isConnected) previous.focus({ preventScroll: true });
        };
      }, []);
      return h('dialog', {
        ref, className, role: 'dialog', 'aria-modal': true, 'aria-label': title, 'data-native': '',
        onCancel: (event) => { event.preventDefault(); onClose(); },
        onClick: (event) => {
          if (event.target !== event.currentTarget) return;
          const rect = event.currentTarget.getBoundingClientRect();
          if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
        },
      }, children);
    }

    /** Read-only snapshots in a body portal; the live assistant is never moved. */
    function ComparisonDialog({ original, persona, onClose, t }) {
      const [active, setActive] = React.useState('original');
      const [narrow, setNarrow] = React.useState(false);
      const surfaceRef = React.useRef(null);
      const originalRef = React.useRef(null);
      const personaRef = React.useRef(null);
      const originalTabRef = React.useRef(null);
      const personaTabRef = React.useRef(null);
      const positions = React.useRef({ original: 0, persona: 0 });
      const idRef = React.useRef(null);
      if (idRef.current === null) idRef.current = `persona-shell-comparison-${++nextComparisonId}`;
      const id = idRef.current;
      useLayoutEffect(() => {
        const element = surfaceRef.current;
        const view = element.ownerDocument.defaultView;
        const releaseScroll = lockComparisonScroll(element.ownerDocument);
        const measure = () => {
          const width = element.getBoundingClientRect().width;
          if (width > 0) setNarrow(width < COMPARISON_NARROW_WIDTH);
        };
        measure();
        const observer = typeof view?.ResizeObserver === 'function' ? new view.ResizeObserver(measure) : undefined;
        observer?.observe(element);
        view?.addEventListener('resize', measure);
        return () => { observer?.disconnect(); view?.removeEventListener('resize', measure); releaseScroll(); };
      }, []);
      useLayoutEffect(() => {
        for (const [side, ref] of [['original', originalRef], ['persona', personaRef]]) {
          if (!narrow || active === side) ref.current.scrollTop = positions.current[side];
        }
      }, [active, narrow]);
      const title = t?.('shell.compareTitle') ?? '原文对照';
      const labels = { original: t?.('shell.originalLabel') ?? '原文', persona: t?.('shell.personaLabel') ?? '人格版' };
      const tabs = [['original', originalTabRef], ['persona', personaTabRef]];
      return h(shippedComparisonModal(), { open: true, onClose, title, headless: true, className: 'persona-shell-comparison' },
        h('style', null, COMPARISON_CSS),
        h('div', { ref: surfaceRef, className: 'persona-shell-comparison-surface', 'data-narrow': narrow },
          h('div', { className: 'persona-shell-comparison-header' },
            h('h2', null, title),
            h('button', { type: 'button', 'data-modal-autofocus': '', onClick: onClose,
              'aria-label': t?.('shell.compareClose') ?? '关闭原文对照' }, t?.('shell.compareCloseShort') ?? '关闭'),
          ),
          h('div', { className: 'persona-shell-comparison-tabs', role: 'tablist', 'aria-label': title, hidden: !narrow,
            onKeyDown: (event) => {
              if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey
                || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
              event.preventDefault();
              const side = event.key === 'Home' ? 'original' : event.key === 'End' ? 'persona' : active === 'original' ? 'persona' : 'original';
              setActive(side);
              (side === 'original' ? originalTabRef : personaTabRef).current.focus({ preventScroll: true });
            },
          }, tabs.map(([side, ref]) => h('button', { key: side, ref, type: 'button', role: 'tab',
            id: `${id}-${side}-tab`, 'aria-controls': `${id}-${side}`, 'aria-selected': active === side,
            tabIndex: active === side ? 0 : -1, onClick: () => setActive(side), onFocus: () => setActive(side),
          }, labels[side]))),
          h('div', { className: 'persona-shell-comparison-panes',
            style: { gridTemplateColumns: narrow ? 'minmax(0, 1fr)' : 'repeat(2, minmax(0, 1fr))' } },
            [['original', original, originalRef], ['persona', persona, personaRef]].map(([side, text, ref]) => h('section', {
              key: side, className: 'persona-shell-comparison-pane', id: `${id}-${side}`,
              role: narrow ? 'tabpanel' : 'region', hidden: narrow && active !== side,
              'aria-labelledby': `${id}-${side}-${narrow ? 'tab' : 'label'}`,
            },
            h('h3', { id: `${id}-${side}-label`, hidden: narrow }, labels[side]),
            h('div', { ref, className: 'persona-shell-comparison-scroll', 'data-comparison-side': side,
              tabIndex: 0, role: 'region', 'aria-label': labels[side],
              onScroll: (event) => { if (!narrow || active === side) positions.current[side] = event.currentTarget.scrollTop; },
            }, renderMarkdown(text)),
            )),
          ),
        ),
      );
    }

    // Cache integrity only, not a security hash. Keep in sync with lib/review.js.
    function reviewFingerprint(text) {
      let a = 0x811c9dc5;
      let b = 0x9e3779b9;
      for (let i = 0; i < text.length; i += 1) {
        const code = text.charCodeAt(i);
        a = Math.imul(a ^ code, 0x01000193);
        b = Math.imul(b ^ code, 0x85ebca6b);
      }
      return `v1:${text.length}:${(a >>> 0).toString(16)}:${(b >>> 0).toString(16)}`;
    }

    const REVIEW_REASONS = ['negation-change', 'condition-change', 'uncertainty-change', 'quantity-change', 'literal-order'];

    function reviewNeeded(row, original, settings) {
      const review = row?.review;
      if (settings?.reviewHints === false || row?.status !== 'ready'
        || typeof row.text !== 'string' || typeof original !== 'string'
        || review?.version !== 1 || review.scope !== 'message' || review.method !== 'local-lexical-v1'
        || !Number.isFinite(review.editScore) || review.editScore < 0 || review.editScore > 1
        || !Array.isArray(review.reasons) || review.reasons.some((reason) => !REVIEW_REASONS.includes(reason))
        || (review.criticalReasons !== undefined && (!Array.isArray(review.criticalReasons)
          || review.criticalReasons.some(reason => !['quantity-change','negation-change'].includes(reason) || !review.reasons.includes(reason))))) return false;
      const threshold = Number.isFinite(settings?.reviewThreshold)
        && settings.reviewThreshold >= 0 && settings.reviewThreshold <= 1 ? settings.reviewThreshold : 0.55;
      // A small edit can change a count or a local assertion. These signals
      // invite a comparison independently of the overall wording threshold.
      const factual = review.reasons.includes('quantity-change') || review.reasons.includes('literal-order') || review.criticalReasons?.length > 0;
      if (!factual && !(review.editScore > 0 && review.editScore >= threshold)) return false;
      return review.sourceHash === reviewFingerprint(original) && review.targetHash === reviewFingerprint(row.text);
    }

    let nextReviewId = 0;
    let reviewPortal;
    try { reviewPortal = require('react-dom').createPortal; } catch { /* Old/minimal hosts keep the fixed-position fallback. */ }
    const reviewPanelStyle = {
      position: 'fixed',
      left: 0,
      top: 0,
      zIndex: 100,
      boxSizing: 'border-box',
      width: 'min(560px, calc(100vw - 24px))',
      maxHeight: 'min(420px, 55vh)',
      overflow: 'auto',
      overscrollBehavior: 'contain',
      padding: '12px',
      border: '1px solid var(--dsw-alias-border-l1)',
      borderRadius: '8px',
      background: 'var(--dsw-alias-bg-layer-2)',
      color: 'var(--dsw-alias-label-primary)',
      boxShadow: '0 4px 18px #0002',
      fontSize: '13px',
      lineHeight: '1.6',
      overflowWrap: 'anywhere',
    };

    /** Prefer above when it fits; never hang a long preview underneath the composer. */
    function reviewPlacement(anchor, height, bounds) {
      const gap = 6;
      const width = Math.max(0, Math.min(560, bounds.right - bounds.left));
      const cap = Math.max(0, Math.min(420, (bounds.bottom - bounds.top) * 0.55));
      const above = Math.max(0, anchor.top - gap - bounds.top);
      const below = Math.max(0, bounds.bottom - anchor.bottom - gap);
      const onTop = above >= Math.min(height, cap) || above >= below;
      const maxHeight = Math.min(cap, onTop ? above : below);
      return {
        left: Math.max(bounds.left, Math.min(anchor.left, bounds.right - width)),
        top: onTop ? Math.max(bounds.top, anchor.top - gap - Math.min(height, maxHeight)) : anchor.bottom + gap,
        width,
        maxHeight,
      };
    }

    /** Hover/focus is a non-interactive preview; click pins an accessible dialog. */
    function ReviewHint({ original, review, t, renderOriginal }) {
      const [hovered, setHovered] = React.useState(false);
      const [focused, setFocused] = React.useState(false);
      const [pinned, setPinned] = React.useState(false);
      const [dismissed, setDismissed] = React.useState(false);
      const [position, setPosition] = React.useState(null);
      const rootRef = React.useRef(null);
      const triggerRef = React.useRef(null);
      const panelRef = React.useRef(null);
      const leaveTimer = React.useRef(undefined);
      const idRef = React.useRef(null);
      if (idRef.current == null) idRef.current = `persona-shell-review-${++nextReviewId}`;
      const id = idRef.current;
      const open = pinned || (!dismissed && (hovered || focused));
      const label = t?.('shell.reviewHint') ?? '改写变化提示，查看原文';
      const closeLabel = t?.('shell.reviewClose') ?? '关闭原文预览';
      const contains = (target) => rootRef.current?.contains(target) || panelRef.current?.contains(target);
      const cancelLeave = () => {
        if (leaveTimer.current !== undefined) clearTimeout(leaveTimer.current);
        leaveTimer.current = undefined;
      };
      const enter = () => { cancelLeave(); setHovered(true); setDismissed(false); };
      const leave = () => {
        cancelLeave();
        leaveTimer.current = setTimeout(() => { leaveTimer.current = undefined; setHovered(false); }, 150);
      };
      const dismiss = (restoreFocus) => {
        cancelLeave();
        setPinned(false);
        setDismissed(true);
        if (restoreFocus) triggerRef.current?.focus({ preventScroll: true });
      };

      React.useEffect(() => () => cancelLeave(), []);
      useLayoutEffect(() => {
        if (!open) { setPosition(null); return undefined; }
        const trigger = triggerRef.current;
        const panel = panelRef.current;
        const doc = trigger?.ownerDocument;
        const win = doc?.defaultView;
        if (!trigger || !panel || !win) return undefined;
        const scrollParents = new Set();
        const place = () => {
          const viewport = win.visualViewport;
          const width = viewport?.width ?? doc.documentElement?.clientWidth ?? win.innerWidth;
          const height = viewport?.height ?? doc.documentElement?.clientHeight ?? win.innerHeight;
          if (!(width > 0 && height > 0)) return;
          const left = viewport?.offsetLeft ?? 0;
          const top = viewport?.offsetTop ?? 0;
          const bounds = { left: left + 12, right: left + width - 12, top: top + 12, bottom: top + height - 12 };
          const clearance = Number.parseFloat(win.getComputedStyle?.(doc.documentElement).getPropertyValue('--dsh-frame-top-clearance'));
          if (Number.isFinite(clearance)) bounds.top = Math.max(bounds.top, (doc.documentElement.hasAttribute('data-fullscreen') ? 0 : clearance) + 20);
          // The chat scroller ends above the composer. Respect its vertical
          // reading area, but portal out of its clipping/transform context.
          for (let parent = trigger.parentElement; parent && parent !== doc.body; parent = parent.parentElement) {
            const overflow = win.getComputedStyle?.(parent).overflowY;
            if (!/^(auto|scroll)$/.test(overflow)) continue;
            scrollParents.add(parent);
            const rect = parent.getBoundingClientRect();
            bounds.top = Math.max(bounds.top, rect.top + 12);
            bounds.bottom = Math.min(bounds.bottom, rect.bottom - 12);
          }
          const anchor = trigger.getBoundingClientRect();
          if (anchor.bottom <= bounds.top || anchor.top >= bounds.bottom || anchor.right <= bounds.left || anchor.left >= bounds.right) {
            setHovered(false); setFocused(false); dismiss(false);
            return;
          }
          const next = reviewPlacement(anchor, panel.getBoundingClientRect().height, bounds);
          setPosition((current) => current && Object.keys(next).every((key) => current[key] === next[key]) ? current : next);
        };
        place();
        const observer = typeof win.ResizeObserver === 'function' ? new win.ResizeObserver(place) : undefined;
        observer?.observe(trigger); observer?.observe(panel);
        for (const parent of scrollParents) observer?.observe(parent);
        win.addEventListener('scroll', place, true);
        win.addEventListener('resize', place);
        win.visualViewport?.addEventListener('resize', place);
        win.visualViewport?.addEventListener('scroll', place);
        return () => {
          observer?.disconnect();
          win.removeEventListener('scroll', place, true);
          win.removeEventListener('resize', place);
          win.visualViewport?.removeEventListener('resize', place);
          win.visualViewport?.removeEventListener('scroll', place);
        };
      }, [open, pinned]);
      React.useEffect(() => {
        const doc = rootRef.current?.ownerDocument ?? (typeof document === 'undefined' ? undefined : document);
        if (!open || doc === undefined) return undefined;
        const onPointer = (event) => {
          if (!contains(event.target)) {
            setHovered(false);
            setFocused(false);
            dismiss(false);
          }
        };
        const onKey = (event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          event.stopPropagation();
          dismiss(pinned);
        };
        doc.addEventListener('pointerdown', onPointer, true);
        doc.addEventListener('keydown', onKey, true);
        return () => {
          doc.removeEventListener('pointerdown', onPointer, true);
          doc.removeEventListener('keydown', onKey, true);
        };
      }, [open, pinned]);
      React.useEffect(() => {
        if (pinned) panelRef.current?.focus({ preventScroll: true });
      }, [pinned]);

      const panel = open ? h('div', {
        id,
        ref: panelRef,
        'data-persona-shell': 'review-panel',
        role: pinned ? 'dialog' : 'tooltip',
        'aria-label': pinned ? label : undefined,
        tabIndex: pinned ? -1 : undefined,
        style: { ...reviewPanelStyle, ...position, visibility: position === null ? 'hidden' : undefined },
        onMouseEnter: enter,
        onMouseLeave: leave,
      },
      h('div', { style: { ...headerStyle, justifyContent: 'space-between' } },
        h('span', null, t?.('shell.originalLabel') ?? '原文'),
        pinned ? h('button', {
          type: 'button', style: toggleStyle, 'aria-label': closeLabel,
          onClick: () => dismiss(true),
        }, t?.('shell.reviewCloseShort') ?? '关闭') : null),
      h('div', { style: { ...paneLabelStyle, textTransform: 'none', letterSpacing: 'normal' } },
        t?.('shell.reviewNotice') ?? '本地表达对照提示，不代表事实错误；低分也不保证语义一致。',
        ` (${Math.round(review.editScore * 100)}/100)`,
        review.reasons.length > 0
          ? h('div', null, review.reasons.map((reason) => t?.(`shell.reviewReasons.${reason}`) ?? ({
            'negation-change': '否定表达变化', 'condition-change': '条件表达变化',
            'uncertainty-change': '不确定性表达变化', 'quantity-change': '数字表达变化',
            'literal-order': '字面量顺序变化',
          })[reason]).join(' · '))
          : null),
      renderOriginal?.() ?? renderMarkdown(original),
      ) : null;
      const doc = rootRef.current?.ownerDocument;
      return h('div', {
        ref: rootRef,
        'data-persona-shell': 'review-hint',
        style: { display: 'inline-flex', width: 'fit-content', verticalAlign: 'middle', marginTop: '4px' },
        onMouseEnter: enter,
        onMouseLeave: leave,
        onFocus: (event) => {
          setFocused(true);
          if (!contains(event.relatedTarget)) setDismissed(false);
        },
        onBlur: (event) => {
          if (!contains(event.relatedTarget)) setFocused(false);
        },
      },
      h('button', {
        ref: triggerRef,
        type: 'button',
        'aria-label': label,
        'aria-haspopup': 'dialog',
        'aria-expanded': open,
        'aria-controls': open ? id : undefined,
        'aria-describedby': open && !pinned ? id : undefined,
        style: {
          ...toggleStyle, color: 'var(--dsw-alias-state-warning-primary, var(--dsw-alias-brand-primary))', fontSize: '15px', fontWeight: 600,
          minWidth: '28px', minHeight: '28px', borderRadius: '4px',
        },
        onClick: () => {
          if (pinned) dismiss(false);
          else { setPinned(true); setDismissed(false); }
        },
      }, h('span', { 'aria-hidden': true }, '※')),
      panel && typeof reviewPortal === 'function' && doc?.body ? reviewPortal(panel, doc.body) : panel);
    }

    /** Text of one assistant step, in the order the blocks carry it. */
    function textOf(data) {
      const blocks = data?.blocks ?? [];
      return blocks
        .filter((block) => block !== undefined && block.kind === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n')
        .trim();
    }

    /**
     * How long a placeholder may stand in for a rewrite that is genuinely coming.
     *
     * Deliberately short. It exists to cover the second between a step settling
     * and its rewrite arriving; anything longer turns "opening an old session"
     * into a page of blank boxes, because history rows reach this branch too.
     */
    const HOLD_PLACEHOLDER_MS = 2500;

    /**
     * How long an eligible row may stay in the state-loading placeholder
     * before falling back to the official report. The host's state route is
     * local and normally answers in a frame or two; this bound only protects
     * a failed or stalled request from leaving a permanent blank.
     */
    const STATE_LOADING_MS = 500;

    /**
     * Which body one settled row should render.
     *
     * Split out as a pure function because the interesting cases are timing
     * cases, and timing is exactly what a mocked React cannot reproduce.
     * @param {{ status?: string, text?: string } | undefined} row - the host's record for this step.
     * @param {boolean} conceded - whether the hold window for a pending rewrite has expired.
     * @param {boolean} [fresh] - this step arrived while the page was live, so a
     *   rewrite is plausibly on its way. History rows opened from a restart pass
     *   `false`: nothing is coming for them and a placeholder would be a lie.
     * @returns {'persona' | 'plain' | 'placeholder' | 'streaming'}
     */
    function rowBranch(row, conceded, fresh = false, keepOriginal = false) {
      if (row !== undefined && row.status === 'ready' && typeof row.text === 'string' && row.text !== '') {
        return 'persona';
      }
      // Once the reader has seen the live original, keep it in place until a
      // complete rewrite is ready. Never erase it to replay a partial version.
      if (keepOriginal) return 'plain';
      // Streaming text arrived before the row settled: show it growing rather
      // than a placeholder that says nothing.
      if (row !== undefined && typeof row.partial === 'string' && row.partial !== '') {
        return 'streaming';
      }
      // A rewrite that already failed will never arrive, so the report is the
      // honest answer immediately.
      if (row !== undefined && row.status !== 'pending') return 'plain';
      // A pending row is the only case where text is genuinely on its way.
      // The host keeps a rewrite pending until its own timeout; conceding here
      // would show the original report while the rewrite is still running.
      if (row !== undefined) return 'placeholder';
      // No row at all: the state has not caught up with this step yet. Showing
      // the report here is what produced the flash — the row is new, its rewrite
      // is being computed, and the plain text appeared first and was replaced a
      // moment later. A placeholder is the honest body for that gap, but only for
      // a step that just arrived; a restored history row would otherwise sit on a
      // blank box until its fetch landed.
      return fresh && !conceded ? 'placeholder' : 'plain';
    }

    /**
     * Put the shielded literals back into a partial rewrite.
     *
     * The streaming text is still masked, so `[[0]]` style markers stand in for
     * code, paths and commands. Those markers are only meaningful to the host
     * that issued them, so the row carries the table alongside.
     * @param {string} text
     * @param {readonly string[] | undefined} literals
     * @returns {string}
     */
    function unmaskPartial(text, literals) {
      if (!Array.isArray(literals) || literals.length === 0) return text;
      return text.replace(/\[\[\s*(\d+)\s*\]\]/g, (whole, digits) => {
        const index = Number(digits);
        return literals[index] ?? whole;
      });
    }

    /** Explain a fallback on demand without exposing provider errors or internal codes. */
    function reportFallbackReason(row) {
      if (!row || !['failed', 'skipped'].includes(row.status)) return '';
      const reason = row.reason;
      if (['source-quantity-change', 'source-worker-change', 'source-permission-change'].includes(reason)) {
        return '这次转述的数值表达、工作归属或执行条件未通过现有检查，未采用改写。原始汇报仍可阅读；这些检查不构成完整语义核验。';
      }
      if (['dropped-marker', 'unknown-marker', 'duplicate-marker', 'invented-fence'].includes(reason)) {
        return '这次转述没有完整保留受保护的技术内容，未采用改写。原始汇报保持不变。';
      }
      if (reason === 'too-long') return '这次转述超过长度上限，未采用改写。原始汇报保持不变。';
      if (['no-route', 'no-llm'].includes(reason)) return '暂时没有可用的转述模型，当前显示原始汇报。';
      if (reason === 'persona-changed') return '转述期间人格设置已变化，这次结果未采用，当前保留原始汇报。';
      if (reason === 'no-prose') return '这份汇报没有适合转述的普通说明，保留原始内容。';
      if (['disabled', 'session-disabled', 'rewrite-disabled'].includes(reason)) return '按当前开关设置保留原始汇报。';
      if (typeof reason === 'string' && /timeout|timed.out/iu.test(reason)) return '这次转述未能在时限内完成，当前保留原始汇报。';
      return '这次转述没有完成或未被采用，当前保留原始汇报。可以按需要调整表达；不会重新执行工作。';
    }

    /** Keep the official component mounted; change only one settled text block. */
    function PersonaStep({ delegate, ...props }) {
      const { node, sessionId, groupPart } = props;
      const data = node?.data;
      const blocks = Array.isArray(data?.blocks) ? data.blocks : [];
      const seq = data?.finalNode?.seq;
      const original = textOf(data);
      const t = shellTranslate(props.t);
      const eligible = data?.status === 'settled' && groupPart !== 'reasoning'
        && (groupPart === undefined || groupPart === 'response') && typeof seq === 'number'
        && usableSessionId(sessionId) && original !== ''
        && blocks.filter((block) => block?.kind === 'text').length === 1;
      const readingEligible=data?.status==='settled'&&groupPart!=='reasoning'&&(groupPart===undefined||groupPart==='response')
        &&Number.isSafeInteger(seq)&&usableSessionId(sessionId)&&blocks.some(block=>block?.kind==='text'&&typeof block.text==='string'&&block.text.trim());
      const key = rowKey(sessionId, seq);
      const liveKey = rowKey(sessionId, node?.key);
      if (typeof node?.key === 'string' && data?.status === 'running') liveSeen.add(liveKey);
      const { state } = useHostState(sessionId, readingEligible ? seq : undefined);
      const [comparison, setComparison] = React.useState(undefined);
      const [feedbackOpen, setFeedbackOpen] = React.useState(false);
      const [expiredKey, setExpiredKey] = React.useState(undefined);
      const [stateExpiredKey, setStateExpiredKey] = React.useState(undefined);
      const [readingError,setReadingError]=React.useState('');
      const row = eligible ? state?.rows?.find((candidate) => candidate.seq === seq) : undefined;
      const switchesReady = state?.switchesReady !== false;
      const switchLoading = eligible && globalEnabled && state !== undefined && !switchesReady;
      const allowed = eligible && globalEnabled && !switchLoading && state?.sessionEnabled !== false
        && state?.settings?.enabled !== false && sessionOff.get(sessionId) !== false;
      React.useEffect(() => {
        if (!allowed) return undefined;
        const timer = setTimeout(() => setExpiredKey(key), HOLD_PLACEHOLDER_MS);
        return () => clearTimeout(timer);
      }, [allowed, key]);
      React.useEffect(() => {
        if (!allowed || state !== undefined) return undefined;
        const timer = setTimeout(() => setStateExpiredKey(key), STATE_LOADING_MS);
        return () => clearTimeout(timer);
      }, [allowed, key, state]);
      React.useEffect(() => { setComparison(undefined); }, [key, allowed, row?.status, row?.final]);
      React.useEffect(() => { setFeedbackOpen(false); }, [key]);

      if (allowed && !freshDecided.has(key) && state !== undefined) {
        freshDecided.set(key, liveSeen.has(liveKey));
      }
      const stateLoading = allowed && state === undefined && stateExpiredKey !== key;
      const keepOriginal = eligible && liveSeen.has(liveKey);
      const branch = !allowed
        ? (switchLoading && !keepOriginal ? 'placeholder' : 'plain')
        : stateLoading && !keepOriginal ? 'placeholder'
          : rowBranch(row, expiredKey === key, freshDecided.get(key) === true, keepOriginal);
      if (allowed && branchHistory.get(key) !== branch) {
        branchHistory.set(key, branch);
        const trace = diagnosticsTrail.get(key) ?? [];
        trace.push({ branch, at: Date.now() });
        diagnosticsTrail.set(key, trace.slice(-4));
        if (trace.length <= 4) reportDiagnostics({ branchTrail: { [key]: trace } });
      }
      const text = branch === 'persona' ? row.text
        : branch === 'streaming' ? unmaskPartial(row.partial, row.partialLiterals)
          : branch === 'placeholder' ? placeholderText(t) : undefined;
      const report = renderOfficial(delegate, props, displayNode(node, text));
      const ready = branch === 'persona';
      const showHeader = eligible && row?.final === true && ['ready','failed','skipped'].includes(row.status);
      const showReading=readingEligible&&(state?.reports?.some(report=>report.seq===seq&&report.final===true)
        ||(!Array.isArray(state?.reports)&&row?.final===true));
      // Original previews contain text only; images/reasoning remain in the
      // continuously mounted main renderer, not duplicated in a comparison.
      const renderOriginal = () => renderOfficial(delegate, { ...props, groupPart: 'response' }, {
        ...node, data: { ...data, blocks: blocks.filter((block) => block?.kind === 'text') },
      });
      const comparisonOpen = comparison?.key === key;
      const rewriteWaiting = allowed && keepOriginal && !comparisonOpen && (row?.status === 'pending'
        || (row === undefined && expiredKey !== key && stateExpiredKey !== key));
      // No layout wrapper or reparenting, even while the portaled modal is open.
      return h(React.Fragment, null,
        // The persona badge and original toggle belong above the report, where
        // the reader meets the row; the ※ review hint stays at the end, where
        // it does not compete with the reading flow.
        showHeader||showReading ? h('div', { style: headerStyle, 'data-persona-shell': 'controls' },
          h('span', { style: badgeStyle }, ready?(row.speaker?.name??'历史人格'):'原始汇报', ready&&row.speaker?.mode === 'relay' ? ' · 转述' : ''),
          showHeader&&ready?h('button', {
            type: 'button', style: toggleStyle, 'aria-expanded': comparisonOpen, 'aria-haspopup': 'dialog',
            onClick: () => setComparison({ key, original: blocks.find((block) => block?.kind === 'text').text, persona: row.text }),
          }, t('shell.showOriginal') ?? 'origin'):null,
          showHeader?h('button', { type: 'button', style: toggleStyle, 'aria-haspopup': 'dialog',
            onClick: () => setFeedbackOpen({key,row}) }, row.retrying ? '正在调整…' : '调整表达'):null,
          showReading?h('button',{type:'button',style:toggleStyle,'aria-haspopup':'dialog',onClick:()=>{try{reportReadingRuntime.open(sessionId,seq);setReadingError('');}catch(error){setReadingError(error.message);}}},'阅读报告'):null,
        ) : null,
        showHeader && !ready && reportFallbackReason(row) ? h('details', { 'data-persona-shell': 'fallback-reason',
          style: { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px', lineHeight: 1.6, marginBottom: '6px' } },
          h('summary', { style: { cursor: 'pointer' } }, '为什么显示原文'),
          h('span', { style: { display: 'block', maxWidth: '42em', marginTop: '3px' } }, reportFallbackReason(row))) : null,
        readingError?h('small',{role:'status',style:{display:'block',color:'var(--dsw-alias-label-secondary)'}},readingError):null,
        report,
        ready && row.final !== true && state?.settings?.processToolUsage === true
          && state?.settings?.includeToolSteps !== false && typeof row.processNote === 'string'
          && row.processNote !== '' && Array.from(row.processNote).length <= 40
          ? h('small', { 'data-persona-shell': 'process-note',
            title: t('shell.processNote') ?? '过程补充：依据本阶段工具统计与会话节奏生成，不计入正文措辞评分。',
            style: { display: 'block', marginTop: '4px', fontSize: '12px', lineHeight: '1.6',
              color: 'var(--dsw-alias-label-secondary)', overflowWrap: 'anywhere' } }, row.processNote)
          : null,
        rewriteWaiting ? h('small', { role: 'status', 'data-persona-shell': 'rewrite-pending',
          style: { display:'block', fontSize:'12px', lineHeight:1.6, color:'var(--dsw-alias-label-secondary)' } }, '正在转述，原文可继续阅读。') : null,
        ready && !comparisonOpen && reviewNeeded(row, original, state?.settings)
          ? h(ReviewHint, { key: `${key}:${row.review.sourceHash}:${row.review.targetHash}`, original, review: row.review, t, renderOriginal })
          : null,
        showHeader && ready && comparisonOpen ? h(ComparisonDialog, { original: comparison.original,
          persona: comparison.persona, t, onClose: () => setComparison(undefined) }) : null,
        eligible && feedbackOpen?.key===key ? h(ReportFeedback, { key, sessionId,
          row:!allowed?{...(row??feedbackOpen.row),canRetry:false,retryUnavailableReason:'rewrite-disabled'}
            :row??{...feedbackOpen.row,canRetry:false,retryUnavailableReason:'source-unavailable'},onClose: () => setFeedbackOpen(false) }) : null,
        showHeader && row.feedbackError ? h('small', { role: 'status', style: { display: 'block', color: 'var(--dsw-alias-label-secondary)' } }, row.feedbackError) : null,
      );
    }

    /** The three dots the placeholder shows while the rewrite is in flight. */
    function placeholderText(t) {
      const label = typeof t === 'function' ? t('shell.rewriting') : undefined;
      return typeof label === 'string' && label !== '' ? label : '…';
    }

    // --- settings page -------------------------------------------------------

    const fieldStyle = { display: 'flex', flexDirection: 'column', gap: '4px', margin: '0 0 14px' };
    /** A checkbox and its label on one line. */
    const toggleRowStyle = { display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' };
    /** A degradation notice that must not read as ordinary helper text. */
    const warningStyle = {
      margin: '10px 0 0',
      padding: '8px 10px',
      borderRadius: '6px',
      border: '0.5px solid var(--dsw-alias-border-l3)',
      background: 'var(--dsw-alias-bg-layer-2)',
      color: 'var(--dsw-alias-label-secondary)',
      fontSize: '12px',
      lineHeight: '1.5',
    };
    const labelStyle = { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' };
    const memoryLineStyle = { color: 'var(--dsw-alias-label-primary)' };
    const presetNameStyle = { color: 'var(--dsw-alias-label-primary)' };
    const presetPreviewStyle = {
      margin: '8px 0 0',
      padding: '8px 10px',
      borderRadius: '6px',
      border: '0.5px solid var(--dsw-alias-border-l1)',
      background: 'var(--dsw-alias-bg-layer-2)',
      fontSize: '12px',
      lineHeight: '1.6',
    };
    const primaryButtonStyle = {
      padding: '5px 12px',
      borderRadius: '6px',
      border: 'none',
      background: 'var(--dsw-alias-brand-primary)',
      color: '#ffffff',
      cursor: 'pointer',
      fontSize: '12px',
      fontFamily: 'inherit',
    };
    const inputStyle = {
      padding: '6px 8px',
      borderRadius: '6px',
      border: '1px solid var(--dsw-alias-border-l1)',
      background: 'var(--dsw-alias-bg-layer-1)',
      color: 'var(--dsw-alias-label-primary)',
      font: 'inherit',
      fontSize: '13px',
    };
    const hintStyle = { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', lineHeight: '1.65' };
    const sectionTitleStyle = { margin: '0 0 12px', fontSize: '15px', fontWeight: '600' };

    // These two global preferences have one draft and write order across both entrances.
    // A failed save stays here when the small room panel is closed or minimized.
    const chatThinkingListeners=new Set();
    const chatThinkingState={settings:null,drafts:{},versions:{},revision:0,ackRevision:0,routeRevision:0,pending:0,errors:{}};
    const chatThinkingSnapshots=new WeakMap();
    let chatThinkingWrites=Promise.resolve();
    const chatThinkingKeys=['chatThinking','chatReasoningEffort','chatProvider','chatModel','provider','model'];
    function notifyChatThinking(){for(const update of chatThinkingListeners)update();}
    const chatThinkingReadAt=()=>({revision:chatThinkingState.revision,ackRevision:chatThinkingState.ackRevision,pending:chatThinkingState.pending,routeRevision:chatThinkingState.routeRevision});
    function acceptChatThinking(settings,context){
      if(!settings||typeof settings!=='object')return;
      const {readAt,ack,routeAt,routeOnly=false}=context??chatThinkingSnapshots.get(settings)??{};
      const current=chatThinkingState.settings;
      const freshRead=readAt&&readAt.revision===chatThinkingState.revision&&readAt.ackRevision===chatThinkingState.ackRevision
        &&readAt.routeRevision===chatThinkingState.routeRevision&&readAt.pending===0&&chatThinkingState.pending===0;
      const acceptValues=!current||(!routeOnly&&(ack!==undefined?ack>=chatThinkingState.ackRevision:readAt?freshRead
        :chatThinkingState.revision===0));
      const acceptRoute=!current||(readAt?freshRead:routeAt!==undefined?routeAt===chatThinkingState.routeRevision:chatThinkingState.revision===0);
      const next={chatThinking:settings.chatThinking!==false,chatReasoningEffort:typeof settings.chatReasoningEffort==='string'?settings.chatReasoningEffort:'',
        chatProvider:settings.chatProvider??'',chatModel:settings.chatModel??'',provider:settings.provider??'',model:settings.model??''};
      if(!acceptValues){next.chatThinking=current.chatThinking;next.chatReasoningEffort=current.chatReasoningEffort;}
      else if(ack!==undefined)chatThinkingState.ackRevision=Math.max(chatThinkingState.ackRevision,ack);
      const routeKeys=['chatProvider','chatModel','provider','model'];
      if(!acceptRoute)for(const key of routeKeys)next[key]=current[key];
      if(!current||routeKeys.some(key=>current[key]!==next[key]))chatThinkingState.routeRevision++;
      if(context)chatThinkingSnapshots.set(settings,routeOnly?{routeOnly:true,routeAt:chatThinkingState.routeRevision}:context);
      if(chatThinkingState.settings&&chatThinkingKeys.every(key=>chatThinkingState.settings[key]===next[key]))return;
      chatThinkingState.settings=next;notifyChatThinking();
    }
    function saveChatThinking(patch,save){
      const versions={};
      for(const [key,value] of Object.entries(patch)){
        const version=++chatThinkingState.revision;
        chatThinkingState.drafts[key]=value;chatThinkingState.versions[key]=version;versions[key]=version;delete chatThinkingState.errors[key];
      }
      chatThinkingState.pending++;notifyChatThinking();
      const task=chatThinkingWrites.then(async()=>{
        const routeAt=chatThinkingState.routeRevision;
        let result;try{result=await save(patch);}catch{/* Keep the current draft on transport/save failure. */}
        if(result?.settings)acceptChatThinking(result.settings,{ack:Math.max(...Object.values(versions)),routeAt});
        for(const [key,version] of Object.entries(versions))if(chatThinkingState.versions[key]===version){
          if(result?.settings){delete chatThinkingState.drafts[key];delete chatThinkingState.versions[key];delete chatThinkingState.errors[key];}
          else chatThinkingState.errors[key]=true;
        }
        chatThinkingState.pending--;notifyChatThinking();return result;
      });
      chatThinkingWrites=task.catch(()=>{});return task;
    }
    const CHAT_THINKING_CSS=`
      .dsh-persona-chat-thinking{display:grid;gap:10px;color:var(--dsw-alias-label-primary,#203044);font-size:13px;line-height:1.55}
      .dsh-persona-chat-thinking p{margin:0;font-size:12px;color:var(--dsw-alias-label-secondary,#607080);line-height:1.6}
      .dsh-persona-chat-thinking-toggle{display:flex;align-items:center;gap:8px;cursor:pointer;font-weight:600}
      .dsh-persona-chat-thinking-toggle input{margin:0;width:15px;height:15px;flex:none;accent-color:var(--dsw-alias-brand-primary,#3976c3)}
      .dsh-persona-chat-thinking-level{display:grid;grid-template-columns:auto minmax(0,1fr);gap:12px;align-items:center}
      .dsh-persona-chat-thinking-level select{min-width:0;width:100%;max-width:100%;font:inherit;font-size:13px;padding:7px 9px;border:1px solid var(--dsw-alias-border-l1,#d8dfe7);border-radius:7px;color:inherit;background:var(--dsw-alias-bg-layer-1,#fff)}
      .dsh-persona-chat-thinking-level select:disabled{opacity:.55}
      .dsh-persona-chat-thinking-status{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;color:var(--dsw-alias-label-secondary,#607080)}
      .dsh-persona-chat-thinking-status button{font:inherit;color:var(--dsw-alias-brand-primary,#3976c3);background:none;border:0;padding:2px 0;cursor:pointer;text-decoration:underline;text-underline-offset:3px}
      .dsh-persona-chat-settings-appearance{margin-top:16px;padding-top:15px;border-top:1px solid var(--dsw-alias-border-l1,#d8dfe7)}
      @media(max-width:380px){.dsh-persona-chat-thinking-level{grid-template-columns:1fr;gap:5px}}
    `;
    function ChatThinkingControls({visible=true,settings,save=postSettings,roomId,routeKey=''}){
      const [,render]=React.useState(0),[loadError,setLoadError]=React.useState(false),[reload,setReload]=React.useState(0);
      const [metadata,setMetadata]=React.useState({status:'loading',efforts:[],defaultEffort:null});
      const read=React.useRef(0),metadataRead=React.useRef(0);
      React.useEffect(()=>{const update=()=>render(value=>value+1);chatThinkingListeners.add(update);return()=>chatThinkingListeners.delete(update);},[]);
      React.useEffect(()=>{if(settings)acceptChatThinking(settings);},[settings]);
      React.useEffect(()=>{
        if(!visible||settings)return;
        const token=++read.current,abort=new AbortController(),readAt=chatThinkingReadAt();let alive=true;
        setLoadError(false);
        void(async()=>{try{const response=await fetch(ROUTE+'/settings',{signal:abort.signal});if(!response.ok)throw Error('settings-unavailable');
          const value=await response.json();if(alive&&!abort.signal.aborted&&token===read.current){if(!value?.settings)throw Error('settings-unavailable');acceptChatThinking(value.settings,{readAt});}
        }catch{if(alive&&!abort.signal.aborted&&token===read.current)setLoadError(true);}})();
        return()=>{alive=false;read.current++;abort.abort();};
      },[visible,settings!==undefined,reload]);
      const baseline=chatThinkingState.settings,thinking=chatThinkingState.drafts.chatThinking??baseline?.chatThinking??true,
        effort=chatThinkingState.drafts.chatReasoningEffort??baseline?.chatReasoningEffort??'';
      const routeSignature=JSON.stringify([baseline?.chatProvider,baseline?.chatModel,baseline?.provider,baseline?.model]);
      React.useEffect(()=>{
        if(!visible||!baseline)return;
        const token=++metadataRead.current,abort=new AbortController();let alive=true;
        setMetadata({status:'loading',efforts:[],defaultEffort:null});
        void(async()=>{try{const query=roomId?'?room='+encodeURIComponent(roomId):'',response=await fetch(ROUTE+'/chat-model-options'+query,{signal:abort.signal});
          if(!response.ok)throw Error('metadata-unavailable');const value=await response.json();
          if(!alive||abort.signal.aborted||token!==metadataRead.current)return;
          const efforts=Array.isArray(value.efforts)?value.efforts.filter((entry,index,all)=>typeof entry?.id==='string'&&entry.id.trim()&&entry.id.length<=128
            &&entry.id!=='off'&&all.findIndex(other=>other?.id===entry.id)===index).map(entry=>({id:entry.id,name:typeof entry.name==='string'&&entry.name?entry.name:entry.id})):[];
          setMetadata({status:['available','unavailable','unknown'].includes(value.status)?value.status:'unknown',efforts,
            offAvailable:Array.isArray(value.efforts)&&value.efforts.some(entry=>entry?.id==='off'),
            defaultEffort:typeof value.defaultEffort==='string'?value.defaultEffort:null,provider:typeof value.provider==='string'?value.provider:'',model:typeof value.model==='string'?value.model:'',
            error:['metadata-unavailable','no-route'].includes(value.error)?value.error:undefined});
        }catch{if(alive&&!abort.signal.aborted&&token===metadataRead.current)setMetadata({status:'unknown',efforts:[],defaultEffort:null,error:'metadata-unavailable'});}})();
        return()=>{alive=false;metadataRead.current++;abort.abort();};
      },[visible,roomId,routeKey,routeSignature,!!baseline,reload]);
      const unknownEffort=effort&&!metadata.efforts.some(entry=>entry.id===effort),failed=Object.keys(chatThinkingState.errors).length>0;
      const defaultName=metadata.efforts.find(entry=>entry.id===metadata.defaultEffort)?.name??metadata.defaultEffort;
      const hint=metadata.status==='loading'?'正在读取当前聊天室模型的思考选项…':metadata.error==='no-route'?'暂未找到可用的聊天室模型；已保存的设置仍保留。'
        :metadata.status==='unknown'?'暂未读取到模型能力；已保存的选择仍保留，调用时采用提供方兼容策略。'
        :metadata.status==='unavailable'?'当前模型没有公开可开启的思考档；设置仍保留，调用时按模型能力兼容。'
        :!thinking&&metadata.status==='available'&&!metadata.offAvailable?'当前模型没有关闭档位，将使用最低可用档；已保存强度仍保留。'
        :!thinking?'已关闭思考，上次选择的强度仍保留。'
        :effort&&unknownEffort?'当前模型未列出这个强度，调用时回到模型默认；已保存的选择仍保留。'
        :!effort&&metadata.defaultEffort==='off'?'该模型默认关闭思考；开启时会采用最低可用思考档。'
        :!effort&&metadata.defaultEffort===null?'模型未公布默认思考档，由提供方决定；不保证已开启思考。'
        :!effort&&defaultName?'默认使用模型的「'+defaultName+'」档。':'按当前模型支持的档位调用。';
      return h('div',{className:'dsh-persona-chat-thinking','data-persona-shell':'chat-thinking'},h('style',null,CHAT_THINKING_CSS),
        h('label',{className:'dsh-persona-chat-thinking-toggle'},h('input',{type:'checkbox','aria-label':'开启聊天室思考',checked:thinking,disabled:!baseline,
          onChange:event=>void saveChatThinking({chatThinking:event.target.checked},save)}),h('span',null,'开启聊天室思考')),
        h('label',{className:'dsh-persona-chat-thinking-level'},h('span',null,'思考强度'),h('select',{'aria-label':'聊天室思考强度',value:effort,disabled:!baseline||!thinking,
          onChange:event=>void saveChatThinking({chatReasoningEffort:event.target.value},save)},h('option',{value:''},'模型默认'),
          unknownEffort?h('option',{value:effort},effort+'（已保存，当前模型未列出）'):null,
          ...metadata.efforts.map(entry=>h('option',{key:entry.id,value:entry.id},entry.name)))),
        metadata.model?h('p',null,'当前模型：'+metadata.model+(metadata.provider?' · '+metadata.provider:'')):null,
        h('p',{role:'status','aria-live':'polite'},hint),
        h('p',null,'默认开启，强度跟随模型默认。思考可能稍慢、用量稍高；这里只影响之后的聊天与快捷回复。'),
        h('div',{className:'dsh-persona-chat-thinking-status',role:'status','aria-live':'polite'},
          chatThinkingState.pending?h('span',null,'正在保存…'):failed?h('span',null,'设置未保存，当前选择已保留。'):null,
          failed?h('button',{type:'button',disabled:chatThinkingState.pending>0,onClick:()=>void saveChatThinking({...chatThinkingState.drafts},save)},'重试保存思考设置'):null,
          loadError?h('span',null,'暂时无法读取已保存的设置。'):null,
          (loadError||metadata.status==='unknown'||metadata.error==='no-route')?h('button',{type:'button',onClick:()=>setReload(value=>value+1)},'重新读取思考选项'):null));
    }

    async function postSettings(patch) {
      const routeAt=chatThinkingState.routeRevision;
      try {
        const response = await fetch(`${ROUTE}/settings`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(patch),
        });
        if (!response.ok) {
          const failure = await response.json();
          return failure?.error === 'settings-save-failed' ? failure : undefined;
        }
        const value = await response.json();
        if(value?.settings)acceptChatThinking(value.settings,{routeOnly:true,routeAt});
        if (typeof value?.settings?.progressNotices === 'boolean') setProgressEnabled(value.settings.progressNotices);
        return value;
      } catch {
        return undefined;
      }
    }

    /**
     * Send one preset operation.
     *
     * Generation is a model call, so it can take many seconds or fail outright;
     * a failure is returned as data rather than thrown, so the page can say why
     * instead of appearing to hang.
     */
    async function postPreset(body) {
      try {
        const response = await fetch(`${ROUTE}/presets`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!response.ok) {
          const detail = await response.json().catch(() => ({}));
          return { ok: false, reason: detail?.error ?? `http-${response.status}` };
        }
        return await response.json();
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : 'network' };
      }
    }

    /**
     * Settings page: the persona pack, the rewrite route, and the on/off switch.
     * Written through the plugin's own host route so no codegen is involved.
     */
    const SETTINGS_CSS = [
      '[data-persona-shell="settings"],[data-persona-shell="memory-panel"]{--dsh-persona-accent:var(--dsw-alias-brand-primary,#3976c3);--dsh-persona-border:var(--dsw-alias-border-l1,#d8dfe7);--dsh-persona-bg:var(--dsw-alias-bg-layer-1,#fff);--dsh-persona-soft:var(--dsw-alias-bg-layer-2,#f5f7fa);--dsh-persona-text:var(--dsw-alias-label-primary,#203044);--dsh-persona-muted:var(--dsw-alias-label-secondary,#607080);color:var(--dsh-persona-text)}',
      '.dsh-persona-settings{max-width:880px;width:100%;min-width:0;font:inherit;line-height:1.6;padding:2px 0 12px}',
      '.dsh-persona-settings *,.dsh-persona-memory *{box-sizing:border-box}',
      '.dsh-persona-settings-hero{display:flex;align-items:center;justify-content:space-between;gap:20px;flex-wrap:wrap;margin-bottom:22px;padding:22px 24px;border:1px solid var(--dsh-persona-border);border-radius:14px;background:var(--dsh-persona-soft);background:linear-gradient(115deg,color-mix(in srgb,var(--dsh-persona-accent) 8%,var(--dsh-persona-bg)),var(--dsh-persona-bg))}',
      '.dsh-persona-eyebrow{font-size:10px;letter-spacing:.16em;color:var(--dsh-persona-accent);font-weight:650;margin-bottom:5px}',
      '.dsh-persona-settings-hero h2{font:inherit;font-size:21px;line-height:1.4;font-weight:650;letter-spacing:-.02em;margin:0 0 7px}',
      '.dsh-persona-settings-hero p{font-size:12px;line-height:1.7;margin:0;color:var(--dsh-persona-muted)}',
      '.dsh-persona-save-state{font-size:11px;white-space:nowrap;color:var(--dsh-persona-muted);padding:4px 9px;border:1px solid var(--dsh-persona-border);border-radius:20px;background:var(--dsh-persona-bg)}',
      '.dsh-persona-section{border:1px solid var(--dsh-persona-border);border-radius:12px;margin:0 0 14px;padding:20px;background:var(--dsh-persona-bg);min-width:0}',
      '.dsh-persona-section-heading{display:flex;align-items:flex-start;gap:11px;margin-bottom:16px}',
      '.dsh-persona-step{font-size:11px;font-variant-numeric:tabular-nums;line-height:25px;color:var(--dsh-persona-accent);border-bottom:2px solid var(--dsh-persona-accent);min-width:21px}',
      '.dsh-persona-section-heading h3{font:inherit;font-weight:650;font-size:15px;margin:0 0 3px;line-height:1.5}',
      '.dsh-persona-section-heading p,.dsh-persona-section-note{font-size:12px;color:var(--dsh-persona-muted);margin:0;line-height:1.7}',
      '.dsh-persona-section-note{margin:0 0 14px}',
      '.dsh-persona-preset-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;overflow:auto;overscroll-behavior:contain;padding:1px}',
      '.dsh-persona-preset-grid[data-many="true"]{max-height:320px}',
      '.dsh-persona-preset{position:relative;display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding:13px 14px;border:1px solid var(--dsh-persona-border);border-radius:9px;min-width:0;background:var(--dsh-persona-bg)}',
      '.dsh-persona-preset-name{min-width:0;flex:1 1 130px;overflow-wrap:anywhere;font-size:13px}',
      '.dsh-persona-preset-description{display:block;font-size:11px;line-height:1.5;color:var(--dsh-persona-muted);font-weight:400;white-space:normal;margin-top:3px}',
      '.dsh-persona-preset-tag{font-size:10px;color:var(--dsh-persona-muted);align-self:flex-start;border:1px solid var(--dsh-persona-border);border-radius:4px;padding:0 5px}',
      '.dsh-persona-preset-actions{display:flex;align-items:center;gap:10px;justify-content:flex-end;flex:1 0 100%}',
      '.dsh-persona-preset-actions button{font-size:12px;line-height:1.6}',
      '.dsh-persona-preset-avatar{flex:none;display:grid;place-items:center;width:44px;height:44px;border:1px solid var(--dsh-persona-border);border-radius:12px;background:var(--dsh-persona-soft)}',
      '.dsh-persona-avatar-editor{margin-top:14px;padding:16px;border:1px solid var(--dsh-persona-border);border-radius:10px;background:var(--dsh-persona-soft)}.dsh-persona-avatar-workbench{display:grid;grid-template-columns:128px minmax(0,1fr);gap:18px;align-items:start;margin:14px 0}.dsh-persona-avatar-workbench canvas,.dsh-persona-avatar-preview{display:grid;place-items:center;width:128px;height:128px;border:1px solid var(--dsh-persona-border);border-radius:14px;background:var(--dsh-persona-bg);font-size:26px;color:var(--dsh-persona-accent)}.dsh-persona-avatar-workbench input[type=file]{max-width:100%;font-size:12px}.dsh-persona-avatar-crop{display:grid;gap:8px}.dsh-persona-avatar-crop label{display:flex;gap:12px;align-items:center;font-size:12px}.dsh-persona-avatar-crop input{min-width:0;flex:1;accent-color:var(--dsh-persona-accent)}@media(max-width:520px){.dsh-persona-avatar-workbench{grid-template-columns:minmax(0,1fr)}.dsh-persona-avatar-workbench canvas,.dsh-persona-avatar-preview{justify-self:center}}',
      '.dsh-persona-selected-label{font-size:11px;color:var(--dsh-persona-accent)}',
      '.dsh-persona-persona-tools{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-top:14px}',
      '.dsh-persona-persona-tools:has(>.dsh-persona-fold[open]){grid-template-columns:minmax(0,1fr)}',
      '.dsh-persona-fold{border:1px solid var(--dsh-persona-border);border-radius:10px;min-width:0;margin-bottom:14px;background:var(--dsh-persona-bg)}',
      '.dsh-persona-persona-tools>.dsh-persona-fold{margin-bottom:0}',
      '.dsh-persona-fold>summary{position:relative;display:flex;align-items:center;gap:12px;list-style:none;cursor:pointer;padding:15px 39px 15px 17px;min-height:66px;user-select:none}',
      '.dsh-persona-fold>summary::-webkit-details-marker{display:none}',
      '.dsh-persona-fold>summary::after{content:"+";position:absolute;right:17px;top:50%;transform:translateY(-50%);font-size:19px;line-height:1;color:var(--dsh-persona-muted);font-weight:400}',
      '.dsh-persona-fold[open]>summary::after{content:"-"}',
      '.dsh-persona-fold[open]>summary{border-bottom:1px solid var(--dsh-persona-border)}',
      '.dsh-persona-fold-title{display:block;font-size:13px;font-weight:600;line-height:1.6}',
      '.dsh-persona-fold-note{display:block;font-size:11px;line-height:1.6;color:var(--dsh-persona-muted);margin-top:2px}',
      '.dsh-persona-fold-badge{margin-left:auto;white-space:nowrap;font-size:10px;color:var(--dsh-persona-muted);border:1px solid var(--dsh-persona-border);border-radius:20px;padding:1px 7px}',
      '.dsh-persona-fold-body{padding:17px;min-width:0}',
      '.dsh-persona-inline-fold{border:0;margin:0}.dsh-persona-inline-fold>summary{min-height:30px;padding:2px 25px 2px 0}.dsh-persona-inline-fold .dsh-persona-fold-note{display:none}.dsh-persona-inline-fold .dsh-persona-fold-title{font-size:12px;font-weight:400;color:var(--dsh-persona-muted)}.dsh-persona-inline-fold>.dsh-persona-fold-body{padding:12px 0 0}.dsh-persona-inline-fold>summary::after{right:3px;font-size:15px}',
      '.dsh-persona-editor-grid,.dsh-persona-advanced-grid,.dsh-persona-common-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:15px 20px;min-width:0}',
      '.dsh-persona-editor-field:first-child,.dsh-persona-editor-field:last-child,.dsh-persona-wide{grid-column:1/-1}',
      '.dsh-persona-settings textarea,.dsh-persona-settings select,.dsh-persona-settings input:not([type=checkbox]):not([type=range]):not([type=number]){max-width:100%;min-width:0;width:100%}',
      '.dsh-persona-settings textarea{line-height:1.7;resize:vertical}',
      '.dsh-persona-settings input[type=checkbox],.dsh-persona-memory input[type=checkbox]{accent-color:var(--dsh-persona-accent);flex-shrink:0;width:15px;height:15px;margin:1px 0}',
      '.dsh-persona-settings .dsh-persona-setting-field{margin-bottom:0!important;gap:7px!important;min-width:0}',
      '.dsh-persona-settings .dsh-persona-setting-field>label>span{font-size:13px!important;font-weight:550;color:var(--dsh-persona-text)!important}',
      '.dsh-persona-process-options{padding-bottom:17px;margin-bottom:17px;border-bottom:1px solid var(--dsh-persona-border)}',
      '.dsh-persona-common-grid{margin-bottom:17px}',
      '.dsh-persona-settings .dsh-persona-subheading{font:inherit;font-size:13px;font-weight:600;margin:0 0 12px}',
      '.dsh-persona-help-copy{font-size:12px;line-height:1.8;color:var(--dsh-persona-muted)}',
      '.dsh-persona-help-copy p{margin:0 0 10px}.dsh-persona-help-copy p:last-child{margin-bottom:0}',
      '.dsh-persona-footer-note{font-size:11px;line-height:1.7;color:var(--dsh-persona-muted);margin:16px 2px 0}',
      '.dsh-persona-settings :is(button,input,select,textarea,summary):focus-visible,.dsh-persona-memory :is(button,input,select,textarea,summary):focus-visible{outline:2px solid var(--dsh-persona-accent);outline-offset:3px}',
      '.dsh-persona-memory{font:inherit;min-width:0}',
      '.dsh-persona-memory .dsh-persona-fold{margin-top:13px;margin-bottom:0}',
      '.dsh-persona-memory .dsh-persona-fold>summary{min-height:52px;padding:11px 36px 11px 13px}',
      '.dsh-persona-memory .dsh-persona-fold-body{padding:13px}',
      '.dsh-persona-memory-list{position:relative;max-height:min(64vh,680px);overflow:auto;overscroll-behavior:contain;min-width:0;padding-right:4px;scroll-padding:10px}',
      '.dsh-persona-memory-entry{padding:14px 0;border-top:1px solid var(--dsh-persona-border)}',
      '.dsh-persona-memory-entry:first-child{border-top:0}',
      '.dsh-persona-memory-content{font-size:13px;line-height:1.8;margin:5px 0;overflow-wrap:anywhere;white-space:pre-wrap}',
      '.dsh-persona-memory-toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:16px 0 8px}',
      '.dsh-persona-memory-toolbar>select{min-width:0;max-width:100%}',
      '.dsh-persona-settings .dsh-persona-memory-toolbar>select{width:auto;max-width:230px;flex:1}',
      '.dsh-persona-settings .dsh-persona-memory .dsh-persona-fold-body select{width:auto;min-width:0;flex:1}',
      '.dsh-persona-memory-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:9px}',
      '.dsh-persona-memory-tabs{display:flex;flex-wrap:wrap;gap:6px;margin:12px 0}.dsh-persona-memory-tabs button{font:inherit;font-size:12px;cursor:pointer;border:1px solid transparent;border-radius:6px;padding:6px 11px;color:var(--dsh-persona-muted);background:transparent}.dsh-persona-memory-tabs button[aria-pressed=true]{color:var(--dsh-persona-text);border-color:var(--dsh-persona-border);background:var(--dsh-persona-soft);font-weight:600}',
      '.dsh-persona-memory button:disabled{opacity:.5;cursor:default}.dsh-persona-memory-review:focus{outline:2px solid var(--dsh-persona-accent);outline-offset:-2px}',
      '.dsh-persona-memory-review,.dsh-persona-memory-editor{border:1px solid var(--dsh-persona-border);border-radius:9px;padding:14px;margin:10px 0;background:var(--dsh-persona-soft);overflow-wrap:anywhere}',
      '.dsh-persona-memory-review-heading{display:flex;justify-content:space-between;align-items:baseline;gap:8px;flex-wrap:wrap;font-size:13px}.dsh-persona-memory-evidence blockquote{margin:5px 0 10px;padding:8px 12px;border-left:2px solid var(--dsh-persona-accent);white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;line-height:1.8;background:var(--dsh-persona-bg)}',
      '.dsh-persona-usage-stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin:12px 0}.dsh-persona-usage-stat{padding:10px;border:1px solid var(--dsh-persona-border);border-radius:8px;background:var(--dsh-persona-soft);font-size:11px;color:var(--dsh-persona-muted)}.dsh-persona-usage-stat strong{display:block;font-size:20px;line-height:1.4;font-weight:600;color:var(--dsh-persona-text);font-variant-numeric:tabular-nums}',
      '.dsh-persona-usage-list{max-height:420px;overflow:auto;overscroll-behavior:contain;padding:1px}.dsh-persona-usage-record{border:1px solid var(--dsh-persona-border);border-radius:8px;margin:0 0 8px;overflow-wrap:anywhere}.dsh-persona-usage-record>summary{padding:11px;cursor:pointer;font-size:12px;line-height:1.7}.dsh-persona-usage-record>summary>span{margin-right:8px;display:inline-block;max-width:100%}.dsh-persona-usage-record-body{padding:0 12px 12px;font-size:12px}.dsh-persona-usage-record-body ul{list-style:none;padding:0;margin:7px 0 12px}.dsh-persona-usage-record-body li{padding:6px 0;border-bottom:1px solid var(--dsh-persona-border)}.dsh-persona-usage-reason{display:block;color:var(--dsh-persona-muted);font-size:11px;margin-top:2px}',
      '.dsh-persona-usage-bar{height:6px;display:flex;overflow:hidden;border-radius:8px;background:var(--dsh-persona-border);margin:10px 0}.dsh-persona-usage-bar>span{height:100%;background:var(--dsh-persona-accent)}.dsh-persona-usage-bar[data-sent=false]>span{background:var(--dsh-persona-muted)}',
      '.dsh-persona-memory-editor textarea,.dsh-persona-memory textarea{width:100%;min-height:72px;margin:6px 0;resize:vertical}.dsh-persona-memory-delete{margin-top:10px;font-size:11px}.dsh-persona-memory-review p{margin:8px 0}',
      '.dsh-persona-memory-footer{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:12px}',
      '@media(max-width:600px){.dsh-persona-settings-hero{padding:18px;gap:12px;margin-bottom:15px}.dsh-persona-settings-hero h2{font-size:19px}.dsh-persona-section{padding:16px}.dsh-persona-editor-grid,.dsh-persona-advanced-grid,.dsh-persona-common-grid,.dsh-persona-persona-tools{grid-template-columns:minmax(0,1fr)}.dsh-persona-preset-grid[data-many="true"]{max-height:430px}.dsh-persona-common-grid{gap:20px}.dsh-persona-fold>summary{padding-left:15px}.dsh-persona-fold-body{padding:15px}.dsh-persona-inline-fold>summary{padding-left:0}.dsh-persona-inline-fold>.dsh-persona-fold-body{padding-left:0;padding-right:0}}',
      '@media(max-width:400px){.dsh-persona-preset-grid{grid-template-columns:minmax(0,1fr)}.dsh-persona-fold-note{font-size:11px}.dsh-persona-fold-badge{font-size:10px;padding:0 5px}}',
    ].join('\n');

    const SETTINGS_REDESIGN_CSS = `
      .dsh-persona-settings[data-persona-shell=settings]{max-width:800px;font:14px/1.65 system-ui,"Microsoft YaHei",sans-serif;padding:4px 0 20px;--dsh-persona-accent:var(--dsw-alias-brand-primary,#4d63d8);--dsh-persona-wash:color-mix(in srgb,var(--dsh-persona-accent) 6%,var(--dsh-persona-bg))}
      .dsh-persona-settings [hidden]{display:none!important}
      .dsh-persona-settings .dsh-persona-settings-hero{padding:0 0 18px;margin:0;border:0;border-radius:0;background:none;gap:12px;align-items:center}
      .dsh-persona-settings .dsh-persona-settings-hero h2{font-size:20px;font-weight:650;letter-spacing:-.02em;margin:0 0 5px}
      .dsh-persona-settings .dsh-persona-settings-hero p{font-size:13px;color:var(--dsh-persona-muted);margin:0}
      .dsh-persona-settings .dsh-persona-save-state{border:0;padding:0;background:none;font-size:11px;display:inline-flex;align-items:center;gap:6px;white-space:normal}
      .dsh-persona-settings .dsh-persona-save-state::before{content:'';width:6px;height:6px;border-radius:50%;background:#539574;flex:none}
      .dsh-persona-settings .dsh-persona-save-state[data-state=pending]::before{background:#7884bc}
      .dsh-persona-settings .dsh-persona-save-state[data-state=error]::before{background:#c66d55}
      .dsh-persona-settings .dsh-persona-settings-tabs{display:flex;gap:8px;padding:0 0 1px;margin:0 0 24px;border-bottom:1px solid var(--dsh-persona-border);overflow:auto;scrollbar-width:thin}
      .dsh-persona-settings button{font-family:inherit!important;font-size:12px!important;line-height:1.5!important;min-height:28px;padding:4px 10px!important;border-radius:7px!important;border:1px solid var(--dsh-persona-border)!important;transition:background .12s,border-color .12s}
      .dsh-persona-settings button:hover:not(:disabled){filter:brightness(.96)}
      .dsh-persona-settings .dsh-persona-settings-tabs button{position:relative;flex:1;min-width:48px;min-height:38px;padding:8px 10px!important;border:0!important;border-radius:0!important;background:none;color:var(--dsh-persona-muted);font-size:13px!important;font-weight:500;white-space:nowrap}
      .dsh-persona-settings .dsh-persona-settings-tabs button[aria-selected=true]{color:var(--dsh-persona-accent);font-weight:650}
      .dsh-persona-settings .dsh-persona-settings-tabs button[aria-selected=true]::after{content:'';position:absolute;bottom:0;left:16px;right:16px;height:2px;border-radius:2px;background:var(--dsh-persona-accent)}
      .dsh-persona-settings .dsh-persona-section{padding:0;margin:0;border:0;border-radius:0;background:none}
      .dsh-persona-settings .dsh-persona-section-heading{margin-bottom:18px;gap:0}
      .dsh-persona-settings .dsh-persona-step{display:none}
      .dsh-persona-settings .dsh-persona-section-heading h3{font-size:15px;font-weight:650;margin:0 0 4px}
      .dsh-persona-settings .dsh-persona-section-heading p{font-size:12px;line-height:1.6}
      .dsh-persona-settings .dsh-persona-preset-grid{grid-auto-rows:1fr;gap:10px;padding:1px;max-height:none}
      .dsh-persona-settings .dsh-persona-preset-grid[data-many=true]{max-height:400px}
      .dsh-persona-settings .dsh-persona-preset{align-items:center;padding:14px;gap:10px;border-radius:10px;border-color:var(--dsh-persona-border);background:var(--dsh-persona-bg)}
      .dsh-persona-settings .dsh-persona-preset-avatar{width:46px;height:46px;border-radius:11px;border-color:color-mix(in srgb,var(--dsh-persona-border) 60%,transparent)}
      .dsh-persona-settings .dsh-persona-preset-name{flex:1 1 100px;font-size:14px;line-height:1.45}
      .dsh-persona-settings .dsh-persona-preset-description{font-size:12px;line-height:1.55;margin-top:5px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
      .dsh-persona-settings .dsh-persona-preset-tag{font-size:10px;padding:1px 5px;border:0;background:var(--dsh-persona-soft);border-radius:4px;align-self:flex-start}
      .dsh-persona-settings .dsh-persona-preset-actions{gap:7px;margin-top:2px;min-height:28px}
      .dsh-persona-settings .dsh-persona-selected-label{font-size:11px;color:var(--dsh-persona-accent);display:flex;align-items:center;gap:5px}
      .dsh-persona-settings .dsh-persona-selected-label::before{content:'✓';font-weight:650}
      .dsh-persona-settings .dsh-persona-persona-tools{margin-top:18px;gap:10px}
      .dsh-persona-settings .dsh-persona-fold{border-radius:9px;background:none;border-color:var(--dsh-persona-border)}
      .dsh-persona-settings .dsh-persona-fold>summary{padding:12px 34px 12px 13px;min-height:58px;gap:10px}
      .dsh-persona-settings .dsh-persona-fold>summary::after{right:13px;font-size:16px}
      .dsh-persona-settings .dsh-persona-fold-title{font-size:12px;font-weight:600}
      .dsh-persona-settings .dsh-persona-fold-note{font-size:11px}
      .dsh-persona-settings .dsh-persona-fold-body{padding:15px}
      .dsh-persona-settings .dsh-persona-inline-fold>summary{min-height:30px;padding:3px 24px 3px 0}
      .dsh-persona-settings .dsh-persona-inline-fold>.dsh-persona-fold-body{padding:10px 0}
      .dsh-persona-settings .dsh-persona-process-options{padding:18px 0;margin:0;border-bottom:1px solid var(--dsh-persona-border)}
      .dsh-persona-settings .dsh-persona-common-grid{padding:18px 0;margin:0;gap:20px;border-bottom:1px solid var(--dsh-persona-border)}
      .dsh-persona-settings .dsh-persona-common-grid>div{min-width:0}
      .dsh-persona-settings .dsh-persona-advanced-grid{gap:22px}
      .dsh-persona-settings input,.dsh-persona-settings select,.dsh-persona-settings textarea{font-size:13px!important}
      .dsh-persona-settings textarea,.dsh-persona-settings select,.dsh-persona-settings input:not([type=checkbox]):not([type=range]):not([type=file]){border-radius:7px!important;min-height:34px}
      .dsh-persona-settings .dsh-persona-footer-note{padding-top:14px;margin-top:22px;border-top:1px solid var(--dsh-persona-border);font-size:11px}
      .dsh-persona-settings .dsh-persona-avatar-editor{background:var(--dsh-persona-soft)}
      .dsh-persona-settings .dsh-persona-memory-toolbar{margin-top:18px}
      @media(max-width:520px){.dsh-persona-settings .dsh-persona-settings-hero{align-items:flex-start}.dsh-persona-settings .dsh-persona-save-state{padding-top:6px}.dsh-persona-settings .dsh-persona-preset-grid{grid-template-columns:minmax(0,1fr)}.dsh-persona-settings .dsh-persona-preset{padding:12px}.dsh-persona-settings .dsh-persona-persona-tools,.dsh-persona-settings .dsh-persona-common-grid,.dsh-persona-settings .dsh-persona-advanced-grid{grid-template-columns:minmax(0,1fr)}}
      @media(prefers-reduced-motion:reduce){.dsh-persona-settings button{transition:none}}
      @media(max-width:520px){.dsh-persona-settings .dsh-persona-settings-tabs{gap:4px}.dsh-persona-settings .dsh-persona-settings-tabs button{padding:8px 6px!important}}
    `;
    function settingsHeading(number, title, note) {
      return h('div', { className: 'dsh-persona-section-heading' }, h('span', { className: 'dsh-persona-step', 'aria-hidden': true }, number),
        h('div', null, h('h3', null, title), h('p', null, note)));
    }

    const USAGE_SECTIONS = [
      { label: '工作转述', keys: ['rewrite', 'progress'], tone: 'rewrite' },
      { label: '报告阅读', keys: ['report-visualization'], tone: 'visualization' },
      { label: '聊天室', keys: ['chat', 'chat-context-selection', 'chat-participation', 'reply-suggestions', 'chat-draft'], tone: 'chat' },
      { label: '其他功能', keys: ['preset', 'memory'], tone: 'other' },
    ];
    const USAGE_NAMES = { rewrite: '汇报改写', progress: '静默播报', 'report-visualization':'报告阅读', chat: '角色发言',
      'chat-context-selection':'轮次规划', 'chat-participation': '调度判断', 'reply-suggestions': '快捷回复', 'chat-draft':'指令整理', preset: '预设生成', memory: '记忆提取' };
    const usageNumber = (n) => Number.isSafeInteger(n) && n >= 0 ? n.toLocaleString('zh-CN') : '—';
    const usageTokens = (m) => m.calls > 0 && !m.usageCalls ? '未上报' : usageNumber(m.totalTokens);
    const usageDay = (iso) => String(iso ?? '').slice(5).replace('-', '/');
    const MODEL_USAGE_CSS = `
      .dsh-model-usage{--usage-ink:var(--dsh-persona-text);--usage-quiet:var(--dsh-persona-muted);--usage-rule:var(--dsh-persona-border);--usage-first:var(--dsw-alias-brand-primary,#4e6ebb);--usage-second:#398879;--usage-third:#b78544;container-type:inline-size;color:var(--usage-ink);font-variant-numeric:tabular-nums}
      .dsh-model-usage h3,.dsh-model-usage h4,.dsh-model-usage p,.dsh-model-usage figure{margin:0}
      .dsh-model-usage small,.dsh-model-usage p,.dsh-model-usage figcaption{font-size:12px;color:var(--usage-quiet);line-height:1.6}
      .dsh-model-usage .mu-head,.dsh-model-usage .mu-actions,.dsh-model-usage .mu-line{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
      .dsh-model-usage .mu-head{justify-content:space-between;gap:9px 20px;margin-bottom:14px}
      .dsh-model-usage h3{font-size:16px;font-weight:650}.dsh-model-usage h4{font-size:14px;font-weight:650}
      .dsh-model-usage .mu-range{display:inline-flex;border-radius:9px;background:var(--dsh-persona-soft);padding:3px;gap:1px}
      .dsh-model-usage .mu-range button{min-height:27px;padding:3px 9px!important;border:0!important;line-height:1.5;background:transparent;color:var(--usage-quiet)}
      .dsh-model-usage .mu-range button[aria-pressed=true]{background:var(--dsh-persona-bg);color:var(--usage-ink);box-shadow:0 1px 3px #0002;font-weight:650}
      .dsh-model-usage .mu-refresh{background:transparent;color:var(--usage-quiet)}
      .dsh-model-usage .mu-hero{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,1fr);gap:14px 26px;padding:18px;border:1px solid var(--usage-rule);border-radius:14px;background:linear-gradient(115deg,var(--dsh-persona-wash),var(--dsh-persona-bg) 85%)}
      .dsh-model-usage .mu-metric{display:block;font-size:clamp(24px,5cqi,38px);font-weight:650;line-height:1.2;letter-spacing:-.035em;overflow-wrap:anywhere;margin:4px 0}
      .dsh-model-usage .mu-metric[data-unknown=true]{font-size:23px}
      .dsh-model-usage .mu-chart{display:flex;flex-direction:column;min-width:0;align-self:center}
      .dsh-model-usage .mu-bars{display:flex;align-items:end;gap:clamp(2px,.6cqi,5px);height:46px;margin:5px 0 0;border-bottom:1px solid var(--usage-rule)}
      .dsh-model-usage .mu-bars i{flex:1;border-radius:3px 3px 0 0;background:color-mix(in srgb,var(--usage-first) 65%,var(--dsh-persona-bg))}.dsh-model-usage .mu-bars i:only-child{max-width:36px}
      .dsh-model-usage .mu-bars i:last-child{background:var(--usage-first)}.dsh-model-usage .mu-dates{display:flex;justify-content:space-between;font-size:10px;color:var(--usage-quiet)}
      .dsh-model-usage .mu-card{padding-top:20px}.dsh-model-usage .mu-legend{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
      .dsh-model-usage .mu-card .mu-head{margin:0}.dsh-model-usage .mu-head select{width:auto;font:inherit;color:var(--usage-ink);background:var(--dsh-persona-bg);border:1px solid var(--usage-rule);padding:3px 7px}
      .dsh-model-usage .mu-share{display:flex;height:9px;gap:2px;background:var(--dsh-persona-soft);border-radius:6px;overflow:hidden;margin:11px 0}
      .dsh-model-usage [data-tone=rewrite]{--tone:var(--usage-first)}.dsh-model-usage [data-tone=visualization]{--tone:#8a6cbd}.dsh-model-usage [data-tone=chat]{--tone:var(--usage-second)}.dsh-model-usage [data-tone=other]{--tone:var(--usage-third)}
      .dsh-model-usage .mu-share i{background:var(--tone)}.dsh-model-usage .mu-label{display:flex;align-items:center;gap:6px;font-size:13px;font-weight:600}
      .dsh-model-usage .mu-label::before{content:'';width:8px;height:8px;border-radius:2px;background:var(--tone);flex:none}
      .dsh-model-usage .mu-legend small{display:block}.dsh-model-usage .mu-panel{border:1px solid var(--usage-rule);border-radius:10px;margin-top:8px}
      .dsh-model-usage .mu-model+ .mu-model{border-top:1px solid var(--usage-rule)}
      .dsh-model-usage .mu-model>summary{display:grid;grid-template-columns:minmax(0,1fr) auto auto;align-items:center;gap:10px;cursor:pointer;padding:10px 12px;list-style:none}
      .dsh-model-usage .mu-model>summary::-webkit-details-marker{display:none}
      .dsh-model-usage .mu-model>summary::after{content:'›';display:block;transform:rotate(90deg);color:var(--usage-quiet)}
      .dsh-model-usage .mu-model[open]>summary::after{transform:rotate(-90deg)}
      .dsh-model-usage .mu-model strong{font-size:13px;overflow-wrap:anywhere}.dsh-model-usage .mu-model small{display:block}.dsh-model-usage .mu-model-amount{text-align:right;font-size:13px}
      .dsh-model-usage .mu-breakdown{border-top:1px dashed var(--usage-rule);margin:0 12px;padding:6px 0 9px}.dsh-model-usage .mu-breakdown .mu-line{justify-content:space-between;font-size:12px;padding:2px 0}
      .dsh-model-usage .mu-foot{margin-top:16px}.dsh-model-usage .mu-foot>summary{font-size:12px;color:var(--usage-quiet);cursor:pointer}
      .dsh-model-usage .mu-foot p{margin-top:6px}.dsh-model-usage .mu-notice{border:1px dashed var(--usage-rule);border-radius:12px;padding:20px;color:var(--usage-quiet)}
      .dsh-model-usage .mu-notice strong{display:block;font-size:14px;color:var(--usage-ink);margin-bottom:4px}
      @container(max-width:470px){.dsh-model-usage .mu-hero{grid-template-columns:minmax(0,1fr);gap:12px;padding:14px}.dsh-model-usage .mu-bars{height:35px}.dsh-model-usage .mu-legend{gap:6px}.dsh-model-usage .mu-legend small{font-size:11px}.dsh-model-usage .mu-metric{font-size:29px}}
      @media(max-width:520px){.dsh-persona-settings .dsh-persona-settings-tabs{gap:2px}.dsh-persona-settings .dsh-persona-settings-tabs button{min-width:37px;padding:8px 3px!important}}
    `;

    function ModelUsagePanel({ visible }) {
      const [days, setDays] = React.useState(7);
      const [revision, refresh] = React.useState(0);
      const [snapshot, setSnapshot] = React.useState(null);
      const [source, setSource] = React.useState('all');
      React.useEffect(() => {
        if (!visible) return;
        const ctl = new AbortController();
        setSnapshot({ days, state: 'loading' });
        (async () => {
          try {
            const res = await fetch(ROUTE + '/model-usage?days=' + days, { signal: ctl.signal });
            if (!res.ok) throw Error();
            const data = await res.json();
            if (data?.days !== days || !Number.isSafeInteger(data.totals?.calls)
              || !['daily', 'purposes', 'models', 'breakdown'].every((key) => Array.isArray(data[key]))) throw Error();
            if (!ctl.signal.aborted) setSnapshot({ days, state: 'ready', data });
          } catch {
            if (!ctl.signal.aborted) setSnapshot({ days, state: 'error' });
          }
        })();
        return () => ctl.abort();
      }, [days, revision, visible]);
      const state = snapshot?.days === days ? snapshot.state : 'loading';
      const data = state === 'ready' ? snapshot.data : null;
      const line = (name, content, key) => h('div', { className: 'mu-line', key }, h('span', null, name), h('span', null, content));
      const summary = () => {
        const { totals, daily, models, breakdown } = data;
        const inSection = (section, purpose) => section.keys.includes(purpose)
          || (section.tone === 'other' && !USAGE_SECTIONS.some((s) => s.keys.includes(purpose)));
        const addMetrics = (rows) => Object.fromEntries(['calls', 'usageCalls', 'totalTokens', 'inputTokens',
          'cacheReadTokens', 'cacheWriteTokens', 'outputTokens', 'reasoningTokens'].map((key) => [key, rows.reduce((sum, row) => sum + (row[key] ?? 0), 0)]));
        const groups = USAGE_SECTIONS.map((section) => {
          const rows = data.purposes.filter(({ purpose }) => inSection(section, purpose));
          return { ...section, ...addMetrics(rows) };
        });
        const section = USAGE_SECTIONS.find((s) => s.tone === source);
        const selectedRows = section ? breakdown.filter((r) => inSection(section, r.purpose)) : breakdown;
        const groupKey = (m) => JSON.stringify([m.provider, m.model]);
        const byModel = new Map();
        for (const row of selectedRows) {
          const key = groupKey(row);
          if (!byModel.has(key)) byModel.set(key, []);
          byModel.get(key).push(row);
        }
        const modelRows = section ? Array.from(byModel.values(), (rows) =>
          ({ provider: rows[0].provider, model: rows[0].model, ...addMetrics(rows) })) : [...models];
        const shareKey = totals.totalTokens > 0 ? 'totalTokens' : 'calls';
        const peak = Math.max(1, ...daily.map((day) => day.calls));
        const known = totals.usageCalls > 0;
        return h(React.Fragment, null,
          h('div', { className: 'mu-hero' },
            h('div', null, h('small', null, '已上报 token'), h('strong', { className: 'mu-metric', 'data-unknown': !known }, usageTokens(totals)),
              h('p', null, '共 ' + usageNumber(totals.calls) + ' 次调用 · ' + usageNumber(totals.usageCalls) + ' 次有用量回执'),
              totals.failedCalls ? h('p', null, '其中 ' + usageNumber(totals.failedCalls) + ' 次未正常完成') : null),
            h('figure', { className: 'mu-chart', 'aria-label': '每日调用次数' }, h('figcaption', null, days === 1 ? '今天的调用' : '每日调用'),
              h('div', { className: 'mu-bars', role: 'img', 'aria-label': daily.map((d) => usageDay(d.date) + '：' + d.calls + ' 次').join('；') },
                ...daily.map((d) => h('i', { key: d.date, title: d.date + ' · ' + d.calls + ' 次',
                  style: { height: d.calls ? Math.max(5, 100 * d.calls / peak) + '%' : '0%' } }))),
              h('div', { className: 'mu-dates' }, h('span', null, usageDay(daily[0]?.date)), daily.length > 1 ? h('span', null, usageDay(daily.at(-1)?.date)) : null))),
          h('section', { className: 'mu-card', 'aria-label': '按用途' }, h('h4', null, '用在哪里'), h('p', null,
            shareKey === 'totalTokens' ? '色带表示各用途占已上报 token 的比例。' : '暂无可比较的 token 消耗，色带按调用次数展示。'),
            h('div', { className: 'mu-share', 'aria-hidden': true }, ...groups.filter((g) => g[shareKey] > 0).map((g) =>
              h('i', { key: g.tone, 'data-tone': g.tone, style: { flex: g[shareKey] } }))),
            h('div', { className: 'mu-legend' }, ...groups.map((g) => h('div', { key: g.tone, 'data-tone': g.tone },
              h('span', { className: 'mu-label' }, g.label), h('small', null, usageNumber(g.calls) + ' 次'),
              h('small', null, g.calls && !g.usageCalls ? 'token 未上报' : usageNumber(g.totalTokens) + ' token'))))),
          h('section', { className: 'mu-card', 'aria-label': '按模型' },
            h('div', { className: 'mu-head' }, h('div', null, h('h4', null, '模型明细'), h('p', null, '展开模型可查看调用与 token 构成。')),
              h('select', { 'aria-label': '筛选模型用途', value: source, onChange: (e) => setSource(e.target.value) },
                h('option', { value: 'all' }, '全部用途'), ...USAGE_SECTIONS.map((s) => h('option', { key: s.tone, value: s.tone }, s.label)))),
            !modelRows.length ? h('p', { className: 'mu-notice' }, '这个时段内没有此用途的调用。') :
            h('div', { className: 'mu-panel' }, ...modelRows.sort((a, b) => b.calls - a.calls || b.totalTokens - a.totalTokens).map((m) => {
              const rows = byModel.get(groupKey(m)) ?? [];
              const tokens = [['inputTokens', '未缓存输入'], ['cacheReadTokens', '缓存读取'], ['cacheWriteTokens', '缓存写入'],
                ['outputTokens', '输出']].filter(([key]) => m[key] > 0).map(([key, label]) => label + ' ' + usageNumber(m[key]));
              return h('details', { className: 'mu-model', key: groupKey(m) },
                h('summary', null, h('div', null, h('strong', null, m.model === '(other)' ? '其他模型（合并）' :
                  !m.model || m.model === '(unknown)' ? '未标明模型' : m.model),
                  h('small', null, m.provider === '(other)' ? '合并统计' : !m.provider || m.provider === '(unknown)' ? '未标明提供方' : m.provider)),
                  h('div', { className: 'mu-model-amount' }, usageNumber(m.calls) + ' 次', h('small', null, m.usageCalls ? usageTokens(m) + ' token' : 'token 未上报'))),
                h('div', { className: 'mu-breakdown' }, ...rows.map((r) => line(USAGE_NAMES[r.purpose] ?? '其他用途',
                  usageNumber(r.calls) + ' 次 · ' + (r.usageCalls ? usageTokens(r) + ' token' : 'token 未上报'), r.purpose)),
                  h('small', null, usageNumber(m.usageCalls) + ' / ' + usageNumber(m.calls) + ' 次有用量回执'),
                  tokens.length ? h('small', null, '已上报 token：' + tokens.join(' · ')) : null,
                  m.usageCalls && m.reasoningTokens > 0 ? h('small', null, '其中推理 ' + usageNumber(m.reasoningTokens) + '（已含在输出，不重复计入）') : null));
            }))),
          h('details', { className: 'mu-foot' }, h('summary', null, '统计口径与费用'), h('p', null,
            '每次实际发出的模型请求计一次，重试与多人发言分别计数。时间按本地自然日划分。没有回执的请求只计次数；未提供货币账单，不估算金额。')));
      };
      return h('section', { className: 'dsh-model-usage', 'aria-label': '模型用量' },
        h('style', null, MODEL_USAGE_CSS),
        h('div', { className: 'mu-head' }, h('div', null, h('h3', null, '模型用量'), h('p', null, '只统计人格套壳发起的模型调用。')),
          h('div', { className: 'mu-actions' }, h('div', { className: 'mu-range', role: 'group', 'aria-label': '统计时段' },
            ...[[1, '今天'], [7, '近 7 天'], [30, '近 30 天']].map(([n, label]) => h('button', {
              type: 'button', key: n, 'aria-pressed': n === days, onClick: () => setDays(n) }, label))),
            h('button', { type: 'button', className: 'mu-refresh', disabled: state === 'loading', onClick: () => refresh((n) => n + 1) }, '刷新'))),
        data && ['failed', 'memory-only'].includes(data.persistence) ? h('p', { role: 'status', style: { marginBottom: '10px' } },
          data.persistence === 'failed' ? '最近一次保存失败，这部分用量可能无法在重启后保留。' : '本地存储不可用，当前记录仅在这次运行中保留。') : null,
        data?.totals.calls ? summary() : h('div', { className: 'mu-notice', role: 'status' },
          h('strong', null, state === 'error' ? '暂时读不到用量' : data ? '这段时间还没有调用记录' : '正在读取用量…'),
          h('p', null, state === 'error' ? '可以点击刷新重试。' : data ? '从启用统计后的第一次模型调用开始记录，也可以切换时段查看。' : '')));
    }

    function settingsFold(id, title, description, content, options = {}) {
      return h('details', { className: 'dsh-persona-fold' + (options.compact ? ' dsh-persona-inline-fold' : ''), 'data-settings-fold': id, open: options.open, onToggle: options.onToggle },
        h('summary', null, h('span', null, h('span', { className: 'dsh-persona-fold-title' }, title),
          h('span', { className: 'dsh-persona-fold-note' }, description)),
        options.badge ? h('span', { className: 'dsh-persona-fold-badge' }, options.badge) : null),
        h('div', { className: 'dsh-persona-fold-body' }, content));
    }

    const discussionLabels={discussing:'讨论中',proposal:'候选方案',confirmed:'已确定',deferred:'已搁置',rejected:'已否定'};
    const assignmentLabels={respond:'先回应用户',complement:'承接并补充',contribute:'旁听补充', 'answer-peer':'回应同伴'};
    function RoomDiscussionPanel({data,busy,saving,change}){
      const [editor,setEditor]=React.useState(null),[removeId,setRemoveId]=React.useState(null);
      const board=data.discussion??{revision:0,entries:[],canUndo:false},choices=data.discussionChoices??[],locked=busy||saving;
      const key=ref=>ref?JSON.stringify(ref):'';
      const short=(text,max=38)=>Array.from(text.replace(/\s+/g,' ').trim()).slice(0,max).join('');
      const author=quote=>quote?.author?.role==='user'?'我':quote?.author?.name??'原消息';
      const label=quote=>author(quote)+' · '+short(quote.text);
      const allChoices=[...choices],currentEntry=board.entries.find(item=>item.id===editor?.id&&item.inScope&&item.source?.text);
      for(const value of [currentEntry?.source,currentEntry?.evidence])if(value?.text&&!allChoices.some(q=>key(q.ref)===key(value.ref)))allChoices.push(value);
      const source=allChoices.find(q=>key(q.ref)===key(editor?.source)),evidence=allChoices.find(q=>key(q.ref)===key(editor?.evidence));
      const terminal=editor&&['confirmed','deferred','rejected'].includes(editor.status);
      const openAdd=()=>{const quote=choices.find(q=>q.author.role==='user')??choices[0];
        setRemoveId(null);setEditor({action:'add',requestId:chatNonce(),title:quote?short(quote.text,80):'',status:quote?.author.role==='assistant'?'proposal':'discussing',source:quote?.ref??null,evidence:null});};
      const edit=item=>{setRemoveId(null);setEditor({action:'update',id:item.id,version:item.version,title:item.title,status:item.status,
        source:item.source.ref,evidence:item.available?item.evidence?.ref??null:null});};
      const update=value=>setEditor(old=>({...old,...value}));
      const submit=async event=>{event.preventDefault();if(locked||!editor||!source||!editor.title.trim()||(terminal&&!evidence))return;
        const saved=await change(editor);if(saved)setEditor(null);};
      const quote=(value,title)=>h('details',null,h('summary',null,title),value?.text?h(React.Fragment,null,h('p',null,author(value)),h('blockquote',null,value.text))
        :h('p',{style:hintStyle},'原话已更改、超出保留范围或来源已变，不恢复旧内容。'));
      return h('section',{'aria-label':'房间讨论状态',className:'dsh-persona-room-discussion'},
        h('style',null,`.dsh-persona-room-discussion{margin:14px 0;min-width:0}.dsh-persona-room-discussion>details{border:1px solid var(--dsh-persona-border);border-radius:10px;overflow:hidden}.dsh-persona-room-discussion>details>summary{padding:11px 12px;font-weight:600}.dsh-persona-room-discussion-body{padding:0 12px 12px}.dsh-persona-room-discussion-toolbar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:10px 0}.dsh-persona-room-discussion-toolbar button{font-size:12px}.dsh-persona-room-discussion-row{border-top:1px solid var(--dsh-persona-border);padding:11px 0;min-width:0}.dsh-persona-room-discussion-heading{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}.dsh-persona-room-discussion-heading strong{font-size:13px;overflow-wrap:anywhere}.dsh-persona-discussion-badge{font-size:11px;white-space:nowrap;border-radius:5px;padding:2px 6px;background:var(--dsh-persona-soft);color:var(--dsh-persona-muted)}.dsh-persona-discussion-badge[data-state=confirmed]{color:var(--dsh-persona-accent)}.dsh-persona-room-discussion-editor{padding:12px;border:1px solid var(--dsh-persona-border);border-radius:8px;background:var(--dsh-persona-soft);margin:10px 0}.dsh-persona-room-discussion-editor label{display:flex;flex-direction:column;gap:5px;margin-bottom:12px;font-size:12px}.dsh-persona-room-discussion-editor :is(input,select){min-width:0;width:100%;box-sizing:border-box}.dsh-persona-room-discussion-editor p{font-size:12px;margin:7px 0}.dsh-persona-room-discussion-editor button{font-size:12px}.dsh-persona-room-discussion-counts{display:flex;gap:7px;flex-wrap:wrap;font-size:11px;color:var(--dsh-persona-muted);margin:8px 0}.dsh-persona-room-discussion-counts span{padding:2px 6px;background:var(--dsh-persona-soft);border-radius:5px}`),
        h('details',null,h('summary',null,'房间讨论 · '+board.entries.length),h('div',{className:'dsh-persona-room-discussion-body'},
          h('p',{style:hintStyle},'从本房间原话整理话题与决定。只用于这里的讨论，不写入长期记忆，也不代表工作已经完成。'),
          board.entries.length?h('div',{className:'dsh-persona-room-discussion-counts','aria-label':'房间讨论状态概览'},...Object.entries(discussionLabels).map(([state,text])=>{
            const count=board.entries.filter(e=>e.status===state).length;return count?h('span',{key:state},text+' '+count):null;})):h('p',{style:hintStyle},'还没有整理过的话题。可以选一句原话，留作本房间的讨论依据。'),
          h('div',{className:'dsh-persona-room-discussion-toolbar'},h('button',{type:'button',style:toggleStyle,disabled:locked||!!editor||!choices.length||board.entries.length>=16,onClick:openAdd},'新增讨论条目'),
            h('button',{type:'button',style:toggleStyle,disabled:locked||!!editor||!board.canUndo,onClick:()=>void change({action:'undo'})},'撤销最近修改')),
          editor?h('form',{className:'dsh-persona-room-discussion-editor','aria-label':editor.action==='add'?'新增房间讨论':'更正房间讨论',onSubmit:submit},
            editor.action==='add'?h('label',null,'原话来源',h('select',{style:inputStyle,'aria-label':'讨论原话来源',value:key(editor.source),disabled:locked,onChange:event=>{
              const selected=choices.find(q=>key(q.ref)===event.target.value);if(selected)update({source:selected.ref,title:short(selected.text,80),status:selected.author.role==='assistant'?'proposal':'discussing',evidence:null});}},
              ...choices.map(q=>h('option',{key:key(q.ref),value:key(q.ref)},label(q))))):null,
            source?quote(source,'核对条目原话'):h('p',{style:hintStyle},'这句原话已不可用，请取消后重新选择。'),
            h('label',null,'整理标题',h('input',{style:inputStyle,'aria-label':'讨论条目标题',value:editor.title,maxLength:100,autoFocus:true,disabled:locked,onChange:event=>update({title:event.target.value})})),
            h('p',{style:hintStyle},'标题只用于整理，不改写原消息。'),
            h('label',null,'讨论状态',h('select',{style:inputStyle,'aria-label':'讨论条目状态',value:editor.status,disabled:locked,onChange:event=>{
              const status=event.target.value;update({status,evidence:['confirmed','deferred','rejected'].includes(status)?editor.evidence:null});}},
              ...Object.entries(discussionLabels).map(([value,text])=>h('option',{key:value,value},text)))),
            terminal?h(React.Fragment,null,h('label',null,'用户原话依据',h('select',{style:inputStyle,'aria-label':'讨论状态用户依据',value:key(editor.evidence),disabled:locked,onChange:event=>update({evidence:allChoices.find(q=>key(q.ref)===event.target.value)?.ref??null})},
              h('option',{value:''},'选择用户明确表达这项决定的原话…'),...allChoices.filter(q=>q.author.role==='user').map(q=>h('option',{key:key(q.ref),value:key(q.ref)},label(q))))),
              h('p',{style:hintStyle},'角色建议本身不是用户决定。请选同房间的用户原话；确认角色方案时，依据应来自方案之后。'),evidence?quote(evidence,'核对用户依据'):null):null,
            h('div',{className:'dsh-persona-room-discussion-toolbar'},h('button',{type:'submit',style:toggleStyle,disabled:locked||!source||!editor.title.trim()||(terminal&&!evidence)},saving?'正在保存…':'保存讨论条目'),
              h('button',{type:'button',style:toggleStyle,disabled:saving,onClick:()=>setEditor(null)},'取消编辑'))):null,
          ...board.entries.map(item=>h('article',{key:item.id,className:'dsh-persona-room-discussion-row','aria-label':'讨论条目 '+(item.title??'旧参考范围条目')},
            h('div',{className:'dsh-persona-room-discussion-heading'},h('strong',null,item.title??'旧参考范围的讨论条目'),h('span',{className:'dsh-persona-discussion-badge','data-state':item.status},discussionLabels[item.status]??'状态未知')),
            !item.available?h('p',{style:hintStyle},'原话依据已不可用，这项状态不会提供给角色。'):null,
            item.inScope?quote(item.source,'查看条目原话'):null,item.evidence&&item.inScope?quote(item.evidence,'查看状态依据'):null,
            h('div',{className:'dsh-persona-room-discussion-toolbar'},h('button',{type:'button',style:toggleStyle,disabled:locked||!!editor||!item.inScope||!item.source?.text,onClick:()=>edit(item)},'更正'),
              h('button',{type:'button',style:toggleStyle,disabled:locked||!!editor,onClick:()=>setRemoveId(item.id)},'移除')),
            removeId===item.id?h('div',{role:'group','aria-label':'确认移除讨论条目'},h('p',{style:hintStyle},'仅移除整理条目，保留原聊天。可撤销最近修改。'),
              h('div',{className:'dsh-persona-room-discussion-toolbar'},h('button',{type:'button',style:toggleStyle,disabled:locked,onClick:async()=>{if(await change({action:'remove',id:item.id,version:item.version}))setRemoveId(null);}},'确认移除'),
                h('button',{type:'button',style:toggleStyle,disabled:saving,onClick:()=>setRemoveId(null)},'保留条目'))):null)),
          h('p',{style:hintStyle},'保存、更正或撤销会停止本房间尚未完成的旧回复。其他房间不受影响；最多 16 项，最近 10 次修改可撤销。'))));
    }

    function RoomReferencesPanel({visible}){
      const [expanded,setExpanded]=React.useState(false),[data,setData]=React.useState(null),[busy,setBusy]=React.useState(false),[saving,setSaving]=React.useState(false);
      const [info,setInfo]=React.useState(''),[roomId,setRoomId]=React.useState(''),[recordId,setRecordId]=React.useState('');
      const current=React.useRef({token:0,room:'',record:'',abort:null,writing:0});
      const accept=value=>{setData(value);const room=value.room?.id??'';
        if(room!==current.current.room)current.current.record='';current.current.room=room;setRoomId(room);
        if(!value.records?.some(r=>r.id===current.current.record))current.current.record=value.records?.find(r=>r.sentAt!==null)?.id??value.records?.[0]?.id??'';
        setRecordId(current.current.record);};
      const load=async(target=current.current.room)=>{
        const own=current.current;if(own.writing)return;const token=++own.token;own.abort?.abort();const abort=new AbortController();own.abort=abort;
        setBusy(true);setInfo('');
        try{const response=await fetch(ROUTE+'/chat-references'+(target?'?room='+encodeURIComponent(target):''),{signal:abort.signal});
          const value=await response.json();if(!response.ok)throw Object.assign(Error(),{status:response.status});
          if(typeof value.initialized!=='boolean'||!Array.isArray(value.rooms)||!Array.isArray(value.records))throw Error();
          if(token===own.token&&!abort.signal.aborted)accept(value);
        }catch(error){if(token===own.token&&!abort.signal.aborted){if(error.status===404){own.room='';setRoomId('');setData(null);}
          setInfo(error.status===404?'这个房间已删除，请刷新房间列表。':'参考信息暂时无法读取，可以重试。');}}
        finally{if(token===own.token)setBusy(false);}
      };
      React.useEffect(()=>{
        if(visible&&expanded)void load();
        return()=>{current.current.token++;current.current.abort?.abort();current.current.writing=0;setBusy(false);setSaving(false);};
      },[visible,expanded]);
      const change=async(ref,excluded)=>{
        if(busy||saving||current.current.writing||!data?.room)return;const own=current.current,token=++own.token,abort=new AbortController();own.abort?.abort();own.abort=abort;own.writing=token;
        setSaving(true);setInfo('');
        try{const response=await fetch(ROUTE+'/chat-references',{method:'POST',headers:{'content-type':'application/json'},signal:abort.signal,
          body:JSON.stringify({roomId:data.room.id,referenceRevision:data.referenceRevision,epoch:data.epoch,ref,excluded})});
          const value=await response.json();if(!response.ok)throw Object.assign(Error(),{status:response.status});
          if(token===own.token&&!abort.signal.aborted){accept(value);setInfo(excluded?'已暂停自动旧话题引用；聊天原记录保留。':'已恢复自动旧话题引用。');}
        }catch(error){if(token===own.token&&!abort.signal.aborted)setInfo(error.status===409?'参考设置已变化，请刷新后再试。':'暂时无法确认修改结果，请刷新核对后重试。');}
        finally{if(own.writing===token)own.writing=0;if(token===own.token)setSaving(false);}
      };
      const changeDiscussion=async(body)=>{
        if(busy||saving||current.current.writing||!data?.room)return false;const own=current.current,token=++own.token,abort=new AbortController();own.abort?.abort();own.abort=abort;own.writing=token;
        setSaving(true);setInfo('');
        try{const response=await fetch(ROUTE+'/chat-discussion',{method:'POST',headers:{'content-type':'application/json'},signal:abort.signal,
          body:JSON.stringify({...body,roomId:data.room.id,epoch:data.epoch,discussionRevision:data.discussion?.revision??0})});
          const value=await response.json();if(!response.ok)throw Object.assign(Error(value.error),{status:response.status});
          if(token===own.token&&!abort.signal.aborted){accept(value);setInfo(body.action==='undo'?'已撤销最近一次讨论状态修改。':'房间讨论已保存，原聊天与长期记忆保持各自范围。');return true;}
        }catch(error){if(token===own.token&&!abort.signal.aborted)setInfo(error.status===409?'房间讨论已变化，请刷新核对后再保存。编辑草稿仍保留。'
          :error.message==='chat-discussion-evidence-required'?'请选能够支持这项状态的用户原话；角色方案需要之后的用户确认。编辑仍保留。'
          :error.message==='chat-quote-unavailable'?'原话依据已经改变，请刷新核对或取消后重新选择。编辑仍保留。'
          :error.message==='chat-discussion-capacity'?'房间讨论已满，请先整理或移除不再需要的条目。'
          :error.message==='chat-discussion-duplicate'?'这句原话已经整理过，请更正已有条目。'
          :'暂时无法确认保存结果，请刷新核对后重试。编辑草稿仍保留。');}
        finally{if(own.writing===token)own.writing=0;if(token===own.token)setSaving(false);}return false;
      };
      const record=data?.records?.find(r=>r.id===recordId),sent=record?.sentAt!==null&&record?.sentAt!==undefined;
      const selection=record?.coordination&&typeof record.coordination==='object'?record.coordination:null;
      const workChoice={required:'按需参考工作', 'not-needed':'这轮不带工作参考',unclear:'暂不判断为工作请求'};
      const requestChoice={answer:'回应问题',advice:'讨论建议',listen:'以倾听为主',open:'开放交流',unclear:'表达需求尚不明确'};
      const selectionBasis={model:'本轮轻量判断',omitted:'本轮未提供新的资料选择','no-sources':'没有接入工作会话',invalid:'判断返回未通过校验',timeout:'判断超时',unavailable:'判断暂不可用',explicit:'本轮明确指定'};
      const selectedSources=(Array.isArray(selection?.selectedSourceIds)?selection.selectedSourceIds:[]).filter((id,index,all)=>typeof id==='string'&&all.indexOf(id)===index).slice(0,6);
      const sourceLabel=id=>record.work?.find(source=>source.sessionId===id)?.name
        ||data.currentSources?.find(source=>source.sessionId===id)?.name||'来源未提供';
      const time=value=>Number.isFinite(value)?new Date(value).toLocaleString():'未记录';
      const phase=r=>r.request?.responseKind==='normal'?(r.request.replyTo==='user'?'回应用户':'回应同伴'):r.request?.responseKind==='peer'?'回应同伴'
        :r.request?.phase==='reaction'?'旁听接话':r.request?.phase==='followup'?'再次回应':r.request?.available?'主讲 '+r.request.order:'回应';
      const brief=text=>Array.from(text.replace(/\s+/g,' ').trim()).slice(0,38).join('');
      const status={pending:'进行中',generated:'回复已完成',silent:'未发言',failed:'请求失败',rejected:'结果未采用',cancelled:'已停止',interrupted:'结束状态未知'};
      const excerpt=(item,action=false)=>h('div',{className:'dsh-persona-room-reference-item',key:JSON.stringify(item.ref)},
        h('div',null,h('strong',null,item.author?.role==='user'?'我':item.author?.name??'原消息'),
          item.available?h('details',null,h('summary',null,'查看出处'),h('blockquote',null,item.text))
            :h('p',null,'原消息已更改、已清空或不属于当前来源，不显示旧内容。')),
        action?h('button',{type:'button',style:toggleStyle,disabled:busy||saving||(!item.available&&!item.excluded),
          onClick:()=>void change(item.ref,!item.excluded)},item.excluded?'恢复引用':'暂停引用'):null);
      const content=h('section',{'aria-label':'房间参考信息',className:'dsh-persona-room-references'},
        h('style',null,`.dsh-persona-room-references{min-width:0}.dsh-persona-room-reference-toolbar{display:flex;align-items:end;flex-wrap:wrap;gap:10px;margin-bottom:12px}.dsh-persona-room-reference-toolbar label{flex:1;min-width:min(170px,100%)}.dsh-persona-room-reference-toolbar label span{display:block;font-size:12px;margin-bottom:4px}.dsh-persona-room-reference-toolbar select{width:100%}.dsh-persona-room-reference-status{font-size:12px;color:var(--dsw-alias-label-secondary,#65758a);line-height:1.7}.dsh-persona-room-reference-grid{display:grid;gap:10px;margin:12px 0}.dsh-persona-room-reference-card{min-width:0;border:1px solid var(--dsw-alias-border-l1,#d6dfe9);border-radius:10px;padding:12px}.dsh-persona-room-reference-card h4{font-size:13px;margin:0 0 6px}.dsh-persona-room-reference-card p{font-size:12px;line-height:1.65;margin:6px 0;overflow-wrap:anywhere}.dsh-persona-room-reference-item{display:flex;align-items:start;justify-content:space-between;gap:10px;margin-top:10px}.dsh-persona-room-reference-item>div{min-width:0;flex:1}.dsh-persona-room-reference-item strong{font-size:12px}.dsh-persona-room-reference-item button{flex:none;font-size:11px}.dsh-persona-room-references details summary{font-size:12px;cursor:pointer}.dsh-persona-room-references blockquote{font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere;margin:8px 0;padding:8px 10px;border-inline-start:2px solid var(--dsw-alias-border-l1,#d6dfe9);max-height:210px;overflow:auto}.dsh-persona-room-reference-counts{display:flex;gap:6px;flex-wrap:wrap;margin:8px 0}.dsh-persona-room-reference-counts span{font-size:11px;border-radius:6px;padding:3px 7px;background:var(--dsw-alias-bg-layer-2,#f3f5f8)}@media(max-width:420px){.dsh-persona-room-reference-item{flex-wrap:wrap}.dsh-persona-room-reference-item button{margin-inline-start:auto}}`),
        h('p',{style:hintStyle},'只核对已经记录的参考，不启动聊天、刷新工作会话或调用模型。'),
        h('div',{className:'dsh-persona-room-reference-toolbar'},
          data?.rooms?.length?h('label',null,h('span',null,'查看房间'),h('select',{style:inputStyle,'aria-label':'查看房间参考',value:roomId,disabled:saving,
            onChange:e=>{const id=e.target.value;current.current.room=id;current.current.record='';setRoomId(id);setRecordId('');setData(old=>({...old,room:null,records:[],excluded:[]}));void load(id);}},
            ...data.rooms.map(room=>h('option',{key:room.id,value:room.id},room.name)))):null,
          h('button',{type:'button',style:toggleStyle,disabled:busy||saving,onClick:()=>void load()},busy?'正在读取…':'刷新参考信息')),
        h('p',{className:'dsh-persona-room-reference-status',role:'status','aria-live':'polite'},info||(!data&&busy?'正在读取房间参考…':'')),
        data?.initialized===false?h('p',{style:hintStyle},'本次运行尚未打开聊天室。打开后，这里会显示房间和实际使用记录。'):null,
        data?.initialized&&!data.room&&!busy?h('p',{style:hintStyle},'还没有聊天室，可以先从工作页打开一间。'):null,
        data?.room?h(React.Fragment,null,
          h('p',{className:'dsh-persona-room-reference-status'},'当前接入：'+(data.currentSources?.length?data.currentSources.map(s=>s.name+(s.primary?'（主要）':'')).join('、'):'未接入工作会话')+'。这里只显示已保存的选择。'),
          h(RoomDiscussionPanel,{key:data.room.id,data,busy,saving,change:changeDiscussion}),
          data.records?.length?h('label',{style:fieldStyle},h('span',{style:labelStyle},'查看哪次回复'),
            h('select',{style:inputStyle,'aria-label':'选择房间参考记录',value:recordId,disabled:saving,onChange:e=>{current.current.record=e.target.value;setRecordId(e.target.value);}},
              ...data.records.map(r=>h('option',{key:r.id,value:r.id},r.personaName+' · '+phase(r)+' · '+time(r.at)
                +(r.sentAt===null?' · 尚未发出':'')+(r.request?.available?' · '+brief(r.request.text):'')))))
            :h('p',{style:hintStyle},'这个房间还没有参考使用记录。发送聊天后会在这里记录。'),
          record?h(React.Fragment,null,h('p',{className:'dsh-persona-room-reference-status'},
            (sent?'已提供给模型':'准备选入，尚未提供')+' · '+(status[record.outcome]??'状态未知')+' · '+time(record.sentAt??record.at)),
            !record.inScope?h('p',{style:warningStyle},'这次记录属于之前的参考范围。保留用量信息，旧正文与偏好不在这里展开。'):null,
            h('section',{className:'dsh-persona-room-reference-card','aria-label':'本次回复归属'},h('h4',null,'这次回应了什么'),
              record.request?.available?h(React.Fragment,null,
                h('p',null,record.personaName+' · '+phase(record)),
                record.assignment?.kind?h('p',{className:'dsh-persona-room-reference-status'},'本轮职责：'+(assignmentLabels[record.assignment.kind]??'按本次消息回应')):null,
                h('p',{className:'dsh-persona-room-reference-status'},record.request.recipients.length?'当时点名：'+record.request.recipients.map(p=>'@'+p.name).join(' '):'当时发给整个房间'),
                h('p',{className:'dsh-persona-room-reference-question',style:{display:'-webkit-box',WebkitLineClamp:2,WebkitBoxOrient:'vertical',overflow:'hidden',whiteSpace:'pre-wrap'}},record.request.text),
                record.request.text.length>120||record.request.text.includes('\n')?h('details',null,h('summary',null,'展开本轮用户原话'),h('blockquote',null,record.request.text)):null)
                :h('p',null,'原轮次已被替换、超出保留范围或来源已变，不用其他消息代替当时的提问。')),
            h('section',{className:'dsh-persona-room-reference-card','aria-label':'本次参考选择',style:{marginTop:10}},h('h4',null,'本轮参考选择'),
              selection?h(React.Fragment,null,
                h('div',{className:'dsh-persona-room-reference-counts'},h('span',null,workChoice[selection.work]??'工作参考选择未记录'),
                  h('span',null,requestChoice[selection.request]??'表达需求未记录')),
                h('p',null,selectedSources.length?'选择的来源：'+selectedSources.map(sourceLabel).join('、')+'。':'这轮没有选择工作来源。'),
                h('details',null,h('summary',null,'查看选择依据'),h('p',null,selectionBasis[selection.basis]??'依据方式未记录'),
                  h('p',null,'参考选择只作用于这条消息，不修改 @ 对象、房间来源或长期偏好；不是对用户意图的确认。'),
                  ['invalid','timeout','unavailable'].includes(selection.basis)?h('p',null,'判断未完成时不扩大工作参考范围，不把已接入会话的正文全部带入。'):null))
                :h('p',null,'这条记录没有保存本轮参考选择，不从现有来源倒推当时的判断。')),
            h('div',{className:'dsh-persona-room-reference-counts','aria-label':'本次参考概览'},
              ...[['工作来源',record.work.length],['旧话题',record.notes.length],...(record.discussion?.length?[['讨论状态',record.discussion.length]]:[]),...(record.quote?[['主动引用',1]]:[]),['偏好',record.memory.length],['近期对话',record.historyCount]].map(([label,count])=>h('span',{key:label},label+' '+count))),
            record.discussion?.length?h('details',null,h('summary',null,'本次采用的房间状态 · '+record.discussion.length),
              ...record.discussion.map(item=>h('p',{key:item.id,style:hintStyle},item.available?(item.title+' · '+(discussionLabels[item.status]??'已核对状态')):'这项状态版本已更改或原话不再适用，不恢复旧内容。'))):null,
            h('div',{className:'dsh-persona-room-reference-grid'},
              h('section',{className:'dsh-persona-room-reference-card','aria-label':'本次工作来源'},h('h4',null,'工作来源'),
                !record.work.length?h('p',null,'这次没有提供工作会话正文。'):null,
                ...record.work.map(s=>h('div',{key:s.sessionId},h('strong',null,s.name||'工作会话'),
                  h('p',null,'读取于 '+time(s.readAt)+' · '+(s.reportStatus==='final'?'本轮结束的原始汇报':s.reportStatus==='progress'?'过程汇报':'尚无汇报')),
                  h('details',null,h('summary',null,'查看来源依据'),h('p',null,'第 '+(s.turn??'—')+' 轮 · 目标事件 '+(s.goalSeq??'—')+' · 汇报事件 '+(s.reportSeq??'—')),
                    s.goalHasAttachments?h('p',null,'目标包含附件，只提供存在性，不读取附件内容。'):null,
                    s.goalOmitted?h('p',null,'目标正文超过预算，本次未提供完整目标。'):null,
                    s.reportOmitted?h('p',null,s.reportExcerpt?.includedChars>0?'本次只提供报告的完整原文片段，省略部分仍未知，不代表已检查全文。':'报告正文超过预算，本次未提供正文。'):null,
                    s.previousReportOmitted?h('p',null,s.previousReport?.excerpt?.includedChars>0?'上轮参考只提供了部分原文，未提供部分仍未知。':'上轮参考正文超过预算，本次未提供正文。'):null,
                    s.previousReport?h('p',null,'另含上轮参考 · 第 '+(s.previousReport.turn??'—')+' 轮 · 事件 '+(s.previousReport.seq??'—')+'，不代表本轮结果。'):null,
                    s.available?h(React.Fragment,null,s.goal?h('div',null,h('strong',null,'本轮目标'),h('blockquote',null,s.goal)):null,
                      s.report?h('div',null,h('strong',null,s.reportStatus==='final'?'本轮原始汇报':'本轮过程汇报'),h('blockquote',null,s.report)):null,
                      s.previousReport?.text?h('div',null,h('strong',null,'上轮参考 · 不代表本轮结果'),h('blockquote',null,s.previousReport.text)):null)
                      :h('p',null,'原始缓存已更新或尚未载入，仅保留当时的来源与轮次，不用新正文冒充旧参考。')))),
                ...record.omitted.map((s,i)=>h('p',{key:i},(s.name||'工作来源')+' · 本次未提供：'+({budget:'超过内容预算','update-pending':'等待更新','read-failed':'读取未完成',unavailable:'暂不可用'}[s.reason]??'暂不可用')))),
              h('section',{className:'dsh-persona-room-reference-card','aria-label':'本次旧话题原话'},h('h4',null,'旧话题原话'),
                h('p',null,'只说明当时说过什么，不代表问题仍未解决或建议已经采纳。'),
                record.notes.length?h('p',null,'暂停仅影响额外选入的旧话题，并停止本房间未完成的旧请求；不删除最近对话，也不阻止主动引用。'):null,
                ...record.notes.map(n=>excerpt(n,record.inScope)),
                !record.notes.length?h('p',null,'这次没有额外选入较早的聊天片段。'):null,
                record.quote?h('div',null,h('strong',null,'用户本次明确引用'),excerpt(record.quote)):null),
              h('section',{className:'dsh-persona-room-reference-card','aria-label':'本次人格偏好'},h('h4',null,'人格偏好 · '+record.personaName),
                h('p',null,'只用于这位人格的这次回应；其他成员不会因此取得她的私有偏好。'),
                ...record.memory.map(ref=>h('p',{key:ref.id},ref.available?ref.content:'该版本已更改、撤销或不再适用，不显示旧内容。')),
                !record.memory.length?h('p',null,record.memoryEnabled?'这次没有选入表达偏好。':'发起这次请求时，记忆功能未开启。'):null))) :null,
          data.excluded?.length?h('details',null,h('summary',null,'已暂停的旧话题 · '+data.excluded.length),
            h('p',{style:hintStyle},'仅停止自动选入旧话题，不删除聊天，也不阻止你主动引用。修改会停止本房间尚未完成的旧请求。'),
            ...data.excluded.map(n=>excerpt(n,true))):null,
          data.persistence==='failed'?h('p',{style:hintStyle},'使用记录暂未保存成功，重启后可能缺少最近记录。'):null):null);
      return settingsFold('room-references','房间参考','整理房间讨论，核对来源、旧话题和偏好',content,
        {onToggle:event=>{if(event.target===event.currentTarget)setExpanded(event.currentTarget.open);}});
    }

    function MemoryUsagePanel({ data, presets, settings, filter, refresh, busy, scopePending }) {
      const [channel, setChannel] = React.useState('all');
      const [refreshing, setRefreshing] = React.useState(false);
      const [refreshInfo, setRefreshInfo] = React.useState('');
      const refreshState = React.useRef({ busy: false, personaId: undefined });
      refreshState.current.personaId = data?.activePersonaId;
      React.useEffect(() => { setRefreshInfo(''); }, [data?.activePersonaId]);
      const reload = async () => {
        if (refreshState.current.busy || busy || scopePending) return;
        const personaId = data?.activePersonaId;
        refreshState.current.busy = true; setRefreshing(true); setRefreshInfo('');
        try {
          const ok = await refresh();
          if (refreshState.current.personaId === personaId) setRefreshInfo(ok ? '已刷新' : '暂未更新，已有记录仍保留，请稍后重试。');
        } catch { if (refreshState.current.personaId === personaId) setRefreshInfo('暂未更新，已有记录仍保留，请稍后重试。'); }
        finally { refreshState.current.busy = false; setRefreshing(false); }
      };
      const channels = { report: '汇报转述', process: '过程转述与补充', retry: '单次重说', progress: '静默播报', chat: '角色聊天' };
      const outcomes = { pending: '请求进行中', generated: '转述已生成', rejected: '生成内容未采用',
        silent:'未发言',failed: '生成未完成', cancelled: '请求已取消', interrupted: '重启前结束状态未知' };
      const reasons = { candidate: '等待确认', superseded: '已被替代', rejected: '已忽略', retracted: '已撤销',
        expired: '已过期', 'not-expression': '共同经历或会话情况，不用于表达转述', overridden: '已有优先级更高的同类偏好',
        budget: '超出本次内容预算', limit: '超出本次条数上限' };
      const name = (id) => presets.find((p) => p.id === id)?.name ?? '已移除的人格';
      const allRecords = scopePending || data?.usage?.version !== 1 ? [] : (data.usage.records ?? []);
      const records = allRecords.filter((record) =>
        (filter === 'all' || record.personaId === data.activePersonaId) && (channel === 'all' || channel === record.channel)).slice().reverse();
      const sent = (record) => Number.isFinite(record.sentAt);
      const resolve = (ref, record, selected) => {
        const entry = (data.entries ?? []).find((e) => e.id === ref.id && e.version === ref.version);
        const allowed = entry && (entry.scope === 'shared' || (entry.scope === 'persona' && entry.personaId === record.personaId)
          || (entry.scope === 'session' && entry.sessionId === record.sessionId && (!entry.personaId || entry.personaId === record.personaId)));
        if (!allowed || (selected && (entry.status !== 'active' || (entry.expiresAt !== null && entry.expiresAt <= Date.now())))) return undefined;
        return entry.content;
      };
      const list = records.map((record) => {
        const provided = sent(record); const total = record.selected.length + record.omitted.length;
        const selectionLabel = (provided ? '已提供 ' : '准备选入 ') + record.selected.length + ' 条';
        const refList = (refs, selected) => refs.length ? h('ul', null, ...refs.map((ref) => h('li', { key: ref.id },
          resolve(ref, record, selected) ?? '原版本已更改、删除或不再适用，无法展示当时内容。',
          !selected ? h('span', { className: 'dsh-persona-usage-reason' }, reasons[ref.reason] ?? '本次未选中') : null)))
          : h('p', { style: hintStyle }, selected ? '本次没有选入表达偏好。' : '没有其他同范围记忆被排除。');
        return h('details', { key: record.id, className: 'dsh-persona-usage-record', 'data-memory-usage': record.id },
          h('summary', null, h('span', null, channels[record.channel]), h('span', { style: hintStyle }, name(record.personaId)),
            h('span', { style: hintStyle }, new Date(record.at).toLocaleString()), h('span', { style: { whiteSpace: 'nowrap' } }, selectionLabel)),
          h('div', { className: 'dsh-persona-usage-record-body' },
            h('p', { style: hintStyle }, (record.sessionId === data.sessionId ? '当前会话' : '其他会话') + ' · '
              + (provided ? '已提供给模型请求' : '尚未提供给模型请求') + ' · ' + (outcomes[record.outcome] ?? '状态未知')),
            total ? h('div', { className: 'dsh-persona-usage-bar', 'data-sent': String(provided), role: 'img',
              'aria-label': selectionLabel + '，未选中 ' + record.omitted.length + ' 条' },
              h('span', { style: { width: (record.selected.length / total * 100) + '%' } })) : null,
            h('strong', null, provided ? '已提供的偏好' : '准备选入的偏好（尚未提供）'), refList(record.selected, true),
            record.omitted.length ? h('details', null, h('summary', { style: hintStyle }, '为什么其他 ' + record.omitted.length + ' 条没有选中'),
              refList(record.omitted, false)) : null));
      });
      const content = h('section', { 'aria-label': '记忆使用情况', 'data-persona-shell': 'memory-usage' },
        h('p', { style: hintStyle }, '这里只记录偏好是否提供给模型，不代表模型一定遵守。只保留最近 24 次请求，不保存原话或汇报副本。'),
        h('div', { className: 'dsh-persona-memory-actions' },
          h('select', { style: inputStyle, value: channel, 'aria-label': '筛选使用渠道', onChange: (e) => setChannel(e.target.value) },
            h('option', { value: 'all' }, '所有发言渠道'), ...Object.entries(channels).map(([id, label]) => h('option', { key: id, value: id }, label))),
          h('button', { type: 'button', style: toggleStyle, disabled: busy || scopePending || refreshing, onClick: reload }, refreshing ? '正在刷新…' : '刷新使用情况'),
          h('span', { style: hintStyle, role: 'status', 'aria-live': 'polite' }, refreshInfo)),
        h('div', { className: 'dsh-persona-usage-stats' }, ...[
          ['已记录请求', records.length], ['提供了偏好', records.filter((r) => sent(r) && r.selected.length > 0).length],
          ['未发出请求', records.filter((r) => !sent(r)).length],
        ].map(([label, value]) => h('div', { key: label, className: 'dsh-persona-usage-stat' }, h('strong', null, value), label))),
        settings.memory === false ? h('p', { style: hintStyle }, '记忆已关闭，暂停记录新的使用情况；已有记录保留。') : null,
        data?.usage?.persistence === 'failed' ? h('p', { style: hintStyle }, '最近记录暂未保存成功，重启后可能丢失；不影响正常转述。') : null,
        h('div', { className: 'dsh-persona-usage-list' }, ...list),
        records.length === 0 ? h('p', { style: hintStyle }, scopePending ? '正在读取使用情况…'
          : '这个筛选下还没有记录。开启记忆后发起人格转述，即可在这里查看。') : null,
        filter !== 'all' && records.length === 0 && allRecords.some((record) => record.personaId !== data?.activePersonaId
          && (channel === 'all' || record.channel === channel))
          ? h('p', { style: hintStyle }, '其他人格还有记录，可在上方选择「全部人格」查看。') : null,
        h('p', { style: hintStyle }, '跟随上方人格筛选。展开面板时刷新，也可以手动刷新；不会在聊天中显示。'));
      return settingsFold('memory-usage', '最近使用情况', '看看偏好有没有提供，以及未选中的原因', content,
        { badge: records.length ? records.length + ' 次' : undefined,
          onToggle: (event) => { if (event.target === event.currentTarget && event.currentTarget.open) void reload(); } });
    }

    function personaSummary(preset) {
      if (preset.builtin) {
        if (preset.id === '大肥鱼（默认）') return '鲸鲸的轻松口吻';
        if (preset.id === '大肥龙') return 'GPT，直爽又有主见';
        if (preset.id === 'Claude小姐') return '理性、克制，规矩感强';
        if (preset.id === '鲸鲸（实验性）') return '转达原助手「姐姐」的汇报';
        if (preset.id === 'Gemini') return '猫猫，好奇心旺，接梗快';
      }
      return (preset.pack?.identity ?? '你自己的说话风格').replace(/\s+/g, ' ').slice(0, 36);
    }

    const memoryAddDrafts = new Map();
    const memoryEditDrafts = new Map();
    function MemoryPanel({ settings, save, presets }) {
      const [data, setData] = React.useState(undefined);
      const [notice, setNotice] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const busyRef = React.useRef(false);
      const revision = React.useRef(0);
      const currentPreset = React.useRef(settings.presetName);
      currentPreset.current = settings.presetName;
      const expectedPersona = presets.find((p) => p.name === settings.presetName)?.id;
      const draftKey = expectedPersona ?? settings.presetName;
      const [manual, setManual] = React.useState(() => memoryAddDrafts.get(draftKey)
        ?? { content: '', kind: 'preference', scope: 'persona' });
      const editManual = (patch) => {
        const next = { ...manual, ...patch }; setManual(next); keepDraft(memoryAddDrafts, draftKey, next);
      };
      const scopePending = !data || (data.activePresetName !== undefined
        ? data.activePresetName !== settings.presetName : expectedPersona && expectedPersona !== data.activePersonaId);
      const [filter, setFilter] = React.useState('current');
      const [view, setView] = React.useState('active');
      const memoryList = React.useRef(null);
      const focusOperation = React.useRef(undefined);
      const [editing, setEditing] = React.useState(undefined);
      const [editDraft, setEditDraft] = React.useState({ content: '', statement: '' });
      const [clearConfirm, setClearConfirm] = React.useState(false);
      React.useEffect(() => {
        const list = memoryList.current;
        if (!list) return;
        const review = [...list.querySelectorAll('[data-memory-operation]')].find((el) => el.dataset.memoryOperation === focusOperation.current);
        if (review) {
          list.scrollTop = review.offsetTop;
          review.focus({ preventScroll: true });
          review.querySelector('.dsh-persona-memory-review-heading')?.scrollIntoView({ block: 'nearest' });
          focusOperation.current = undefined;
        }
      }, [data, view]);
      const labels = { preference: '表达偏好', agreement: '互动约定', context: '会话情况', episode: '共同经历',
        active: '使用中', candidate: '待核对', superseded: '已替代', rejected: '已忽略', retracted: '已撤销',
        manual: '手动记录', explicit: '用户明确表达', model: '后台整理', legacy: '旧版迁移', correction: '已确认更正' };
      const personaName = (id) => presets.find((p) => p.id === id)?.name ?? '已移除的人格';
      const scopeLabel = (entry) => entry.scope === 'shared' ? '所有人格共享'
        : entry.scope === 'persona' ? '仅 ' + personaName(entry.personaId)
        : (entry.sessionId === data?.sessionId ? '当前会话' : '会话 ' + String(entry.sessionId).slice(0, 16))
          + (entry.personaId ? ' · 仅 ' + personaName(entry.personaId) : ' · 角色共享');
      const errorText = (code) => ({
        'memory-conflict': '记录已变化，尚未应用这次操作。请刷新后重新核对；草稿会保留。',
        'storage-not-ready': '存储尚未就绪，请稍后重试。',
        'memory-save-failed': '保存失败，内容仍保留，请稍后重试。',
        'memory-capacity': '记忆已满，请删除不再需要的历史记录。',
        'memory-operation-capacity': '待确认项目已满，请先处理不再需要的项目。',
        'memory-target-inactive': '这条记录已失效，请刷新后核对当前记录。',
        'memory-statement-required': '请留下你这次更正或撤销的原话。',
        'invalid-memory-replacement': '请填写与旧记录不同的新内容。',
        'private-memory-needs-scope': '互动约定和共同经历请保留在对应人格或会话中。',
        'memory-extraction-disabled': '请先开启记忆与后台整理。',
      }[code] ?? '操作未完成，输入仍保留，请刷新后重试。');
      const refresh = async () => {
        if (busyRef.current) return false;
        const token = ++revision.current;
        try {
          const response = await fetch(ROUTE + '/memory');
          if (!response.ok) throw new Error('load');
          const value = await response.json();
          if (revision.current === token) {
            setData(value);
            setNotice((previous) => previous.startsWith('暂时无法读取记忆') ? '' : previous);
            return true;
          }
          return false;
        } catch {
          if (revision.current === token) setNotice('暂时无法读取记忆，请稍后刷新。');
          return false;
        }
      };
      React.useEffect(() => {
        setManual(memoryAddDrafts.get(draftKey) ?? { content: '', kind: 'preference', scope: 'persona' });
        setEditing(undefined); setClearConfirm(false); setNotice('');
        // A persona change retires the old response, even if it is still saving.
        revision.current += 1;
        void (async () => {
          const token = revision.current;
          try {
            const response = await fetch(ROUTE + '/memory');
            if (!response.ok) throw new Error('load');
            const value = await response.json();
            if (revision.current === token) setData(value);
          } catch { if (revision.current === token) setNotice('暂时无法读取记忆，请稍后刷新。'); }
        })();
        return () => { revision.current += 1; };
      }, [settings.memory, settings.memoryExtraction, settings.presetName]);
      const write = async (body) => {
        if (busyRef.current || scopePending || currentPreset.current !== settings.presetName) return false;
        busyRef.current = true; setBusy(true);
        const token = ++revision.current;
        setNotice('正在保存…');
        try {
          const response = await fetch(ROUTE + '/memory', { method: 'POST',
            headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
          const value = await response.json();
          if (!response.ok) throw new Error(value.error);
          if (revision.current !== token) return false;
          if (['propose', 'propose-add'].includes(body.action)) focusOperation.current = value.result?.id;
          setData(value); setNotice(body.action === 'consolidate' ? '已安排整理，稍后可刷新查看。'
            : ['propose', 'propose-add'].includes(body.action) ? '已生成核对单，确认前不会改变正在使用的记忆。'
            : body.action === 'confirm' ? '已确认，后续转述会使用新状态；历史汇报保持原样。'
            : body.action === 'dismiss' ? '已放弃这次操作，原记录保持原样。' : '已保存');
          return true;
        } catch (error) {
          if (revision.current === token) setNotice(errorText(error.message));
          return false;
        } finally { busyRef.current = false; setBusy(false); }
      };
      const scoped = (entry) => filter === 'all' || entry.scope === 'shared'
        || (entry.scope === 'persona' && entry.personaId === data?.activePersonaId)
        || (entry.scope === 'session' && entry.sessionId === data?.sessionId
          && (!entry.personaId || entry.personaId === data?.activePersonaId));
      const live = (entry) => entry.status === 'active' && (entry.expiresAt === null || entry.expiresAt > Date.now());
      const all = scopePending ? [] : (data?.entries ?? []).filter(scoped);
      const pending = scopePending ? [] : (data?.operations ?? []).filter((op) => op.status === 'pending' && scoped(op.target));
      const adoptionIds = new Set(pending.filter((op) => op.kind === 'accept').map((op) => op.targetId));
      const candidates = all.filter((entry) => entry.status === 'candidate' && !adoptionIds.has(entry.id));
      const entries = all.filter((entry) => view === 'history' ? !live(entry) && entry.status !== 'candidate'
        : view === 'pending' ? entry.status === 'candidate' && !adoptionIds.has(entry.id) : live(entry));
      const evidenceView = (evidence, missing = '没有保存完整原话，请根据实际情况核对。') => evidence?.length
        ? h('div', { className: 'dsh-persona-memory-evidence' }, ...evidence.map((ref, i) => h('div', { key: i },
          h('span', { style: hintStyle }, ref.source === 'settings' ? '你在设置页的说明'
            : ref.complete ? '用户原话 · 当前保存的完整片段' : '历史片段 · 完整原话未保存'),
          ref.quote.length > 320 ? h('details', null,
            h('summary', { style: hintStyle }, (ref.source === 'settings' ? '展开完整说明'
              : ref.complete ? '展开完整原话' : '展开已保存片段') + '（' + ref.quote.length + ' 字符）'),
            h('blockquote', null, ref.quote)) : h('blockquote', null, ref.quote)))) : h('p', { style: hintStyle }, missing);
      const beginEdit = (entry, operation) => {
        const key = entry.id + ':' + operation;
        setEditing({ ...entry, operation });
        setEditDraft(memoryEditDrafts.get(key) ?? { content: operation === 'revise' ? entry.content : '', statement: '' });
      };
      const changeEdit = (patch) => {
        const next = { ...editDraft, ...patch }; setEditDraft(next);
        keepDraft(memoryEditDrafts, editing.id + ':' + editing.operation, next);
      };
      const pendingRows = pending.map((op) => {
        const target = data.entries.find((e) => e.id === op.targetId);
        const currentConflicts = target && op.kind === 'accept' ? data.entries.filter((e) => e.id !== target.id && live(e)
          && e.kind === target.kind && e.key === target.key && e.scope === target.scope
          && e.personaId === target.personaId && e.sessionId === target.sessionId).map((e) => ({ id: e.id, version: e.version })) : [];
        const stale = !target || target.version !== op.targetVersion
          || (target.expiresAt !== null && target.expiresAt <= Date.now())
          || (op.kind === 'accept' && JSON.stringify(currentConflicts) !== JSON.stringify(op.conflicts));
        const name = { revise: '更正', retract: '撤销', accept: '采用' }[op.kind];
        return h('section', { key: op.id, className: 'dsh-persona-memory-review', 'data-memory-operation': op.id, tabIndex: -1,
          'aria-label': '待确认' + name },
        h('div', { className: 'dsh-persona-memory-review-heading' }, h('strong', null, '核对' + name),
          h('span', { style: hintStyle }, scopeLabel(op.target))),
        h('p', { style: hintStyle }, op.origin === 'model' ? '后台整理建议，尚未确认。'
          : op.origin === 'local' ? '从明确表达识别，尚未确认。' : '由你在设置页提出。'),
        target?.expiresAt ? h('p', { style: hintStyle }, '有效至 ' + new Date(target.expiresAt).toLocaleString() + '，本次操作不会延长。') : null,
        h('p', { style: hintStyle }, op.kind === 'accept' ? '准备采用的内容' : '原先的记录'),
        h('div', { className: 'dsh-persona-memory-content' }, op.target.content),
        op.kind === 'revise' ? h('div', null, h('p', { style: hintStyle }, '更正后'),
          h('div', { className: 'dsh-persona-memory-content', 'data-memory-replacement': '' }, op.content)) : null,
        op.kind === 'retract' ? h('p', { style: hintStyle }, '确认后停止使用这条记录。保留撤销记录，不建立相反偏好，也不恢复同范围内已被替代的偏好。') : null,
        evidenceView(op.evidence),
        op.kind === 'accept' && op.conflicts?.length ? h('div', null,
          h('p', { style: hintStyle }, '采用后将替代以下同范围记录：'),
          ...op.conflicts.map((ref) => h('p', { key: ref.id, className: 'dsh-persona-memory-content' },
            data.entries.find((e) => e.id === ref.id)?.content ?? '记录已变化，请重新核对。'))) : null,
        h('p', { style: hintStyle }, '仅影响上述范围的后续表达。原汇报的事实、条件和风险仍以原文为准。'),
        stale ? h('p', { role: 'status', style: hintStyle }, '原记录已经变化，请放弃这张核对单，再对当前记录操作。') : null,
        h('div', { className: 'dsh-persona-memory-actions' },
          h('button', { type: 'button', style: primaryButtonStyle, disabled: busy || stale || scopePending,
            onClick: () => write({ action: 'confirm', id: op.id, version: op.version }) }, '确认' + name),
          h('button', { type: 'button', style: toggleStyle, disabled: busy,
            onClick: () => write({ action: 'dismiss', id: op.id, version: op.version }) }, '放弃这次操作')));
      });
      const memoryRows = entries.map((entry) => h('div', { key: entry.id, 'data-persona-shell': 'memory-entry', 'data-memory-id': entry.id,
        className: 'dsh-persona-memory-entry' },
      h('div', { style: hintStyle }, (labels[entry.kind] ?? entry.kind) + ' · '
        + (entry.expiresAt !== null && entry.expiresAt <= Date.now() ? '已过期' : labels[entry.status] ?? entry.status)),
      h('div', { className: 'dsh-persona-memory-content' }, entry.content),
      h('div', { style: hintStyle }, scopeLabel(entry) + (entry.pinned ? ' · 已置顶' : '')),
      h('details', null, h('summary', { style: hintStyle }, '查看来源'),
        h('p', { style: hintStyle }, labels[entry.origin] ?? '未知来源'), evidenceView(entry.evidence,
          entry.origin === 'legacy' ? '来自旧版迁移，没有逐条原始依据。' : '旧记录没有保存原话依据。'),
        ...(data.operations ?? []).filter((op) => op.status === 'applied' && op.targetId === entry.id).map((op) =>
          h('div', { key: op.id }, h('p', { style: hintStyle }, { revise: '更正时的说明', retract: '撤销时的说明', accept: '采用时的依据' }[op.kind]),
            op.kind === 'revise' ? h('p', { className: 'dsh-persona-memory-content' }, '更正为：' + op.content) : null,
            evidenceView(op.evidence)))),
      editing?.id === entry.id ? h('div', { className: 'dsh-persona-memory-editor', 'aria-label': editing.operation === 'revise' ? '更正记忆' : '撤销记忆' },
        h('p', { style: hintStyle }, scopeLabel(editing) + '。更正与撤销不会改变记录的归属。'),
        editing.operation === 'revise' ? h('label', { style: labelStyle }, '现在应该怎样记',
          h('textarea', { style: inputStyle, maxLength: 240, value: editDraft.content, disabled: busy,
            'aria-label': '更正后的记忆内容', onChange: (e) => changeEdit({ content: e.target.value }) })) : null,
        h('label', { style: labelStyle }, '你的原话',
          h('textarea', { style: inputStyle, maxLength: 1000, value: editDraft.statement, disabled: busy,
            'aria-label': '本次更正或撤销的原话', placeholder: editing.operation === 'revise'
              ? '例如：以前说要简短，现在我希望把必要的解释讲清楚。' : '例如：不用再记着提醒我休息了。',
            onChange: (e) => changeEdit({ statement: e.target.value }) })),
        h('span', { style: hintStyle }, '这段说明按原样保存，仅作为你在设置页提交的依据；不会发送到工作对话。'),
        h('div', { className: 'dsh-persona-memory-actions' },
          h('button', { type: 'button', style: primaryButtonStyle,
            disabled: busy || !editDraft.statement.trim() || (editing.operation === 'revise'
              && (!editDraft.content.trim() || editDraft.content.trim() === editing.content)),
            onClick: async () => {
              const key = editing.id + ':' + editing.operation;
              if (await write({ action: 'propose', operation: editing.operation, id: editing.id,
                version: editing.version, content: editDraft.content, statement: editDraft.statement })) {
                memoryEditDrafts.delete(key); setEditing(undefined); setView('pending');
              }
            } }, editing.operation === 'revise' ? '预览更正' : '预览撤销'),
          h('button', { type: 'button', style: toggleStyle, disabled: busy, onClick: () => setEditing(undefined) }, '收起，保留草稿')))
        : h('div', { className: 'dsh-persona-memory-actions' },
          entry.status === 'candidate' ? h('button', { type: 'button', style: primaryButtonStyle, disabled: busy,
            onClick: async () => { if (await write({ action: 'propose', operation: 'accept', id: entry.id, version: entry.version })) setView('pending'); } }, '核对并采用') : null,
          entry.status === 'candidate' ? h('button', { type: 'button', style: toggleStyle, disabled: busy,
            onClick: () => write({ action: 'reject', id: entry.id, version: entry.version }) }, '忽略') : null,
          ...(['revise', 'retract'].filter(() => live(entry)).map((operation) => h('button', { key: operation,
            type: 'button', style: toggleStyle, disabled: busy, onClick: () => beginEdit(entry, operation) },
          operation === 'revise' ? '更正' : '撤销'))),
          live(entry) ? h('button', { type: 'button', style: toggleStyle, disabled: busy,
            onClick: () => write({ action: 'pin', id: entry.id, version: entry.version, pinned: !entry.pinned }) }, entry.pinned ? '取消置顶' : '置顶') : null),
      h('details', { className: 'dsh-persona-memory-delete' }, h('summary', { style: hintStyle }, '彻底删除'),
        h('p', { style: hintStyle }, '删除这条记录、相关核对单和待整理来源。只想停用时可选择撤销。'),
        h('button', { type: 'button', style: toggleStyle, disabled: busy,
          onClick: () => write({ action: 'delete', id: entry.id, version: entry.version }) }, '确认删除这条记录'))));
      const scopeFields = (value) => ({ scope: value, personaId: value === 'persona' ? data?.activePersonaId : null,
        sessionId: value === 'session' ? data?.sessionId : null });
      const manualEditor = h('div', null,
        h('textarea', { style: inputStyle, value: manual.content, maxLength: 240, disabled: busy,
          'aria-label': '新增记忆内容', placeholder: '例如：称呼我为阿晴；汇报先说结果，再补充条件。',
          onChange: (e) => editManual({ content: e.target.value }) }),
        h('div', { className: 'dsh-persona-memory-actions' },
          h('select', { style: inputStyle, value: manual.kind, disabled: busy, 'aria-label': '记忆类型',
            onChange: (e) => editManual({ kind: e.target.value }) },
          ...['preference', 'agreement', 'context', 'episode'].map((value) => h('option', { key: value, value }, labels[value]))),
          h('select', { style: inputStyle, value: manual.scope, disabled: busy || scopePending, 'aria-label': '记忆适用范围',
            onChange: (e) => editManual({ scope: e.target.value }) },
          h('option', { value: 'persona' }, '当前人格'), h('option', { value: 'shared', disabled: ['agreement', 'episode'].includes(manual.kind) }, '所有人格'),
          h('option', { value: 'session', disabled: !data?.sessionId }, '当前会话（角色共享）')),
          h('button', { type: 'button', style: primaryButtonStyle, disabled: busy || scopePending || !manual.content.trim()
            || (manual.scope === 'session' && !data?.sessionId) || (manual.scope === 'shared' && ['agreement', 'episode'].includes(manual.kind)),
            onClick: async () => {
              if (await write({ action: 'propose-add', entry: { kind: manual.kind, content: manual.content, ...scopeFields(manual.scope) } })) {
                const next = { ...manual, content: '' }; setManual(next); keepDraft(memoryAddDrafts, draftKey, next); setView('pending');
              }
            } }, '预览新记忆')),
        h('p', { style: hintStyle }, manual.scope === 'shared' ? '这条内容会供所有人格使用，请只记录确实通用的偏好。'
          : manual.scope === 'session' ? '供当前会话中的角色共享，默认一天后失效。' : '只交给当前人格，新建或另存人格不会继承。'));
      const clearControl = h('div', null, h('p', { style: hintStyle }, '清空所有人格的记忆、原话依据、待确认项目和交接记录。'),
        clearConfirm ? h('div', { className: 'dsh-persona-memory-actions' },
          h('button', { type: 'button', style: toggleStyle, disabled: busy, onClick: async () => {
            if (busyRef.current) return;
            busyRef.current = true; setBusy(true); const token = ++revision.current;
            try {
              const result = await save({ clearMemory: true });
              if (revision.current !== token) return;
              if (result?.settings) {
                setEditing(undefined); memoryEditDrafts.clear(); setClearConfirm(false);
                setData((previous) => previous ? { ...previous, entries: [], operations: [], usage: { version: 1, records: [] },
                  extraction: { status: 'idle', pending: 0 } } : previous);
                busyRef.current = false; await refresh(); setNotice('已清空记忆、原话依据和待确认项目。');
              } else setNotice('清空未完成，请稍后重试。');
            } catch { if (revision.current === token) setNotice('清空未完成，请稍后重试。');
            } finally { busyRef.current = false; setBusy(false); }
          } }, '确认清空全部记忆'),
          h('button', { type: 'button', style: toggleStyle, disabled: busy, onClick: () => setClearConfirm(false) }, '取消清空'))
          : h('button', { type: 'button', style: toggleStyle, disabled: busy, onClick: () => setClearConfirm(true) }, '清空记忆'));
      return h('div', { className: 'dsh-persona-memory', style: { ...fieldStyle, marginBottom: 0 }, 'data-persona-shell': 'memory-panel' },
        h('style', null, SETTINGS_CSS),
        h('label', { style: toggleRowStyle }, h('input', { type: 'checkbox', checked: settings.memory !== false,
          onChange: (e) => save({ memory: e.target.checked }) }), h('span', { style: labelStyle }, '记住偏好与约定')),
        h('span', { style: hintStyle }, '从已启用的主工作会话识别明确偏好，供适用的人格表达参考。聊天室不会自动提炼长期记忆；可在这里手动管理。关闭后停止采集和使用，已有记录与房间聊天分别保留。'),
        settingsFold('memory-extraction', '后台整理', '可选，额外调用转述模型',
          h('div', null, h('label', { style: toggleRowStyle }, h('input', { type: 'checkbox', checked: settings.memoryExtraction === true,
            disabled: settings.memory === false, onChange: (e) => save({ memoryExtraction: e.target.checked }) }),
          h('span', { style: labelStyle }, '后台整理记忆候选（默认关闭）')),
          h('p', { style: hintStyle }, '开启后把有限的用户短消息片段交给转述模型整理。约每5分钟或积累8条同会话消息处理一次。候选、更正和撤销都在这里核对，不打扰对话。'),
          h('div', { className: 'dsh-persona-memory-footer' }, h('span', { style: hintStyle }, data?.extraction?.status === 'running' ? '正在整理…'
            : data?.extraction?.status === 'failed' ? '上次整理未完成，可稍后重试。' : '待整理 ' + (data?.extraction?.pending ?? 0) + ' 条'),
          h('button', { type: 'button', style: toggleStyle, disabled: busy || !settings.memory || !settings.memoryExtraction,
            onClick: () => write({ action: 'consolidate' }) }, '整理一次'))), { badge: settings.memoryExtraction ? '已开启' : '已关闭' }),
        h('div', { className: 'dsh-persona-memory-toolbar' }, h('span', { style: labelStyle }, '记忆管理'),
          h('select', { style: inputStyle, value: filter, 'aria-label': '筛选记忆', onChange: (e) => { setFilter(e.target.value); setEditing(undefined); } },
          h('option', { value: 'current' }, '当前人格与共享'), h('option', { value: 'all' }, '全部人格')),
          h('button', { type: 'button', style: toggleStyle, disabled: busy, onClick: refresh }, '刷新记忆')),
        h(MemoryUsagePanel, { data, presets, settings, filter, refresh, busy, scopePending }),
        h('div', { className: 'dsh-persona-memory-tabs', role: 'group', 'aria-label': '记忆状态' },
          ...[['active', '使用中', all.filter(live).length], ['pending', '待确认', pending.length + candidates.length],
            ['history', '历史', all.filter((e) => !live(e) && e.status !== 'candidate').length]].map(([id, name, count]) =>
            h('button', { key: id, type: 'button', 'aria-pressed': view === id,
              onClick: () => { setView(id); setEditing(undefined); if (memoryList.current) memoryList.current.scrollTop = 0; } }, name + ' ' + count))),
        h('div', { className: 'dsh-persona-memory-footer' }, h('span', { style: hintStyle, role: 'status', 'aria-live': 'polite' }, notice)),
        h('div', { className: 'dsh-persona-memory-list', ref: memoryList }, ...(view === 'pending' ? pendingRows : []), ...memoryRows),
        scopePending ? h('p', { style: hintStyle }, '正在读取当前人格的记忆…') : entries.length + (view === 'pending' ? pending.length : 0) === 0
          ? h('p', { style: hintStyle }, view === 'pending' ? '暂时没有需要确认的内容。' : view === 'history' ? '还没有历史记录。'
            : '还没有正在使用的记忆，可以手动记一条。') : null,
        settingsFold('memory-add', '手动记一条', '选择内容与适用范围', manualEditor, { badge: manual.content.trim() ? '有草稿' : undefined }),
        settingsFold('memory-clear', '清理记忆', '清空所有人格的记忆与待确认内容', clearControl));
    }

    function PersonaAvatarEditor({ preset, busy, onSave, onClose, user = false }) {
      const [picture, setPicture] = React.useState(undefined), [reading, setReading] = React.useState(false);
      const [crop, setCrop] = React.useState({ x: 50, y: 50, zoom: 1 });
      const [notice, setNotice] = React.useState('');
      const canvas = React.useRef(null), live = React.useRef(true), request = React.useRef(0), operation = React.useRef(chatNonce());
      React.useEffect(() => { live.current = true; return () => { live.current = false; request.current += 1; }; }, []);
      const draw = () => {
        if (!picture || !canvas.current) return;
        const el = canvas.current, context = el.getContext('2d');
        const scale = Math.max(256 / picture.naturalWidth, 256 / picture.naturalHeight) * crop.zoom;
        const width = picture.naturalWidth * scale, height = picture.naturalHeight * scale;
        context.clearRect(0, 0, 256, 256);
        context.drawImage(picture, -(width - 256) * crop.x / 100, -(height - 256) * crop.y / 100, width, height);
      };
      React.useEffect(draw, [picture, crop]);
      const pick = async (file) => {
        if (!file || busy) return;
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 8 * 1024 * 1024) {
          setNotice('请选择 8MB 以内的 PNG、JPG 或 WebP 图片。'); return;
        }
        const token = ++request.current; setReading(true); setNotice('');
        const url = URL.createObjectURL(file);
        try {
          const img = new Image();
          await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; img.src = url; });
          if (!live.current || token !== request.current) return;
          if (!img.naturalWidth || !img.naturalHeight || img.naturalWidth * img.naturalHeight > 40000000) throw Error('size');
          setPicture(img); setCrop({ x: 50, y: 50, zoom: 1 }); operation.current = chatNonce();
        } catch { if (live.current && token === request.current) setNotice('这张图片无法读取，或尺寸过大。请选择另一张。'); }
        finally { URL.revokeObjectURL(url); if (live.current && token === request.current) setReading(false); }
      };
      const save = async (remove = false) => {
        if (busy || reading || (!picture && !remove)) return;
        draw();
        const avatar = remove ? null : canvas.current.toDataURL('image/png');
        const result = await onSave({ action: 'avatar', id: preset.id, avatar, expectedAvatar: preset.avatar ?? null,
          requestId: (remove ? 'remove-' : '') + operation.current });
        if (live.current && result?.ok !== true) setNotice(result?.reason === 'avatar-conflict'
          ? '头像已在别处更新，请取消后重新打开。已选图片仍保留。' : '保存未完成，已选图片与取景仍保留，可以重试。');
      };
      return h('section', { className: 'dsh-persona-avatar-editor', role: 'group', 'aria-label': user ? '编辑我的头像' : '编辑人格头像' },
        h('div', { className: 'dsh-persona-memory-footer' }, h('strong', null, preset.name + ' · 头像'),
          h('button', { type: 'button', style: toggleStyle, disabled: busy, onClick: onClose }, '取消头像修改')),
        h('p', { style: hintStyle }, user ? '这张头像用于所有角色聊天，只改变显示，不影响人格与记忆。' : preset.builtin ? '只覆盖这位内置人格在本机的显示头像，可恢复原图。身份、默认选择、房间成员与私人记忆归属保持不变。' : '只改变这位角色的头像，身份、聊天记录与记忆保持不变。'),
        h('div', { className: 'dsh-persona-avatar-workbench' },
          picture ? h('canvas', { ref: canvas, width: 256, height: 256, 'aria-label': '头像取景预览' })
            : h(PersonaAvatar, { src: preset.avatar, id: preset.id, name: preset.name, className: 'dsh-persona-avatar-preview' }),
          h('div', null, h('label', { style: fieldStyle }, h('span', { style: labelStyle }, '选择头像图片'),
            h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', disabled: busy || reading,
              'aria-label': '选择头像图片', onClick: (event) => { event.target.value = ''; }, onChange: (event) => { void pick(event.target.files?.[0]); } })),
            picture ? h('div', { className: 'dsh-persona-avatar-crop' },
              ...[['x', '左右位置', 0, 100, 1], ['y', '上下位置', 0, 100, 1], ['zoom', '缩放', 1, 3, 0.05]].map(([key, title, min, max, step]) =>
                h('label', { key }, title, h('input', { type: 'range', min, max, step, value: crop[key], 'aria-label': '头像' + title,
                  disabled: busy, onChange: (event) => { setCrop({ ...crop, [key]: Number(event.target.value) }); operation.current = chatNonce(); } }))))
              : h('p', { style: hintStyle }, '支持 PNG、JPG、WebP，选好后可调整取景。图片仅保存在插件内，不发送给模型。'))),
        h('div', { className: 'dsh-persona-memory-actions' },
          h('button', { type: 'button', style: primaryButtonStyle, disabled: busy || reading || !picture, onClick: () => save() },
            busy ? '正在保存…' : user ? '保存我的头像' : '保存头像'),
          (preset.builtin ? preset.avatarOverridden === true : !!preset.avatar) ? h('button', { type: 'button', style: toggleStyle, disabled: busy || reading, onClick: () => save(true) },
            user ? '使用账号头像' : preset.builtin ? '恢复原头像' : '移除头像') : null),
        h('p', { style: hintStyle, role: 'status', 'aria-live': 'polite' }, reading ? '正在读取图片…' : notice));
    }

    function ChatUserSettings({ onClose, visible = true }) {
      const [value, setValue] = React.useState(undefined), [editing, setEditing] = React.useState(undefined);
      const [busy, setBusy] = React.useState(false), [notice, setNotice] = React.useState('');
      const [addressDraft,setAddressDraft]=React.useState(()=>chatUserAddressState.draft),[addressNotice,setAddressNotice]=React.useState(()=>chatUserAddressState.notice),
        [addressSaving,setAddressSaving]=React.useState(()=>chatUserAddressState.saving);
      const live = React.useRef(false), request = React.useRef(0), saving = React.useRef(false), state = React.useRef(undefined), retired = React.useRef(new Set()),profileRead=React.useRef(null);
      const accept = (next) => {
        if (!live.current || retiredInstances.has(next?.instanceId) || retired.current.has(next?.instanceId) || !Number.isSafeInteger(next?.revision)) return;
        if (state.current?.instanceId === next.instanceId && state.current.revision > next.revision) return;
        if (state.current?.instanceId && state.current.instanceId !== next.instanceId) retired.current.add(state.current.instanceId);
        state.current = next; setValue(next);
      };
      const refresh = async () => {
        const token = ++request.current,abort=new AbortController();profileRead.current?.abort();profileRead.current=abort;
        const timeout=setTimeout(()=>abort.abort(),10000);setNotice('正在读取个人资料…');
        try {
          const response = await fetch(ROUTE + '/chat-profile',{signal:abort.signal}); const next = await response.json();
          if(abort.signal.aborted)throw Error('profile-timeout');
          if (live.current && token === request.current) {
            if (!response.ok || !next.instanceId) throw Error('unavailable');
            accept(next); for (const update of chatProfileUpdates) update(next); setNotice('');
          }
        } catch { if (live.current && token === request.current) setNotice('个人资料暂时无法读取，可以刷新重试。'); }
        finally{clearTimeout(timeout);}
      };
      React.useEffect(() => {
        live.current = true; const update = (next) => accept(next); chatProfileUpdates.add(update);
        return () => { live.current = false; request.current += 1; profileRead.current?.abort();chatProfileUpdates.delete(update); };
      }, []);
      React.useEffect(()=>{const update=()=>{setAddressDraft(chatUserAddressState.draft);setAddressNotice(chatUserAddressState.notice);setAddressSaving(chatUserAddressState.saving);};
        chatUserAddressListeners.add(update);update();return()=>chatUserAddressListeners.delete(update);},[]);
      React.useEffect(()=>{if(visible)void refresh();},[visible]);
      const persist = async (patch, revision) => {
        if (saving.current) return { ok: false };
        saving.current = true; setBusy(true); request.current += 1;
        const abort=new AbortController(),timeout=setTimeout(()=>abort.abort(),10000);
        try {
          const response = await fetch(ROUTE + '/chat-profile', { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ...patch, revision }),signal:abort.signal });
          const next = await response.json();
          if(abort.signal.aborted)throw Error('profile-timeout');
          if (next.state) { accept(next.state); for (const update of chatProfileUpdates) update(next.state); }
          if (!response.ok) return { ok: false, reason: next.error === 'profile-conflict' ? 'avatar-conflict' : next.error };
          accept(next); for (const update of chatProfileUpdates) update(next);
          if (live.current&&(Object.hasOwn(patch,'avatar')||Object.hasOwn(patch,'avatarMode'))) { setEditing(undefined); setNotice('头像已保存。'); }
          return { ok: true, state:next };
        } catch { return { ok: false,reason:abort.signal.aborted?'profile-timeout':undefined }; }
        finally { clearTimeout(timeout);saving.current = false; if (live.current) setBusy(false); }
      };
      const save = ({ avatar }) => editing ? persist({ avatar }, editing.revision) : Promise.resolve({ ok: false });
      const mode = userAvatarMode(value);
      const accountUrl = useAccountAvatar(visible && !!value && mode === 'account');
      const changeMode = async (avatarMode) => {
        const result = await persist({ avatarMode }, state.current.revision);
        if (live.current && !result.ok) setNotice(result.reason === 'avatar-conflict'
          ? '外观已在别处更新，请核对当前选择后再试。' : '显示方式未保存，原设置仍保留，请重试。');
      };
      const changeGender = async (userGender) => {
        const result = await persist({ userGender }, state.current.revision);
        if (live.current) setNotice(result.ok ? '性别设置已保存，只影响之后的聊天回复。' : result.reason === 'avatar-conflict'
          ? '个人资料已在别处更新，请核对当前性别选择后重试。' : '未能确认性别设置已保存，请核对后重试。');
      };
      const confirmedAddress=typeof value?.userAddress==='string'?value.userAddress:'',address=addressDraft?.text??confirmedAddress,
        addressError=userAddressProblem(address),addressDirty=address!==confirmedAddress;
      const editAddress=text=>{
        const next={text,version:++chatUserAddressDraftVersion};
        chatUserAddressState.draft=next;chatUserAddressState.notice='';notifyUserAddress();
      };
      const saveAddress=async()=>{
        if(!value||busy||chatUserAddressState.saving||editing||addressError||!addressDirty)return;
        const sent=addressDraft??{text:address,version:++chatUserAddressDraftVersion};chatUserAddressState.saving=true;notifyUserAddress();
        try{const result=await persist({userAddress:address},state.current.revision);
          if(result.ok){
            if(chatUserAddressState.draft?.version===sent.version)chatUserAddressState.draft=null;
            chatUserAddressState.notice=chatUserAddressState.draft?'上次称呼已保存，当前输入尚未保存。':'称呼已保存。';
          }else chatUserAddressState.notice=result.reason==='avatar-conflict'
            ?'个人资料已在别处更新，输入仍保留。请核对后重试保存。':result.reason==='profile-timeout'
              ?'未能确认保存，输入已保留。请核对后重试。':'称呼未能保存，输入仍保留，可以重试。';
        }finally{chatUserAddressState.saving=false;notifyUserAddress();}
      };
      return h('div', { 'data-persona-shell': 'user-profile', style: {
        '--dsh-persona-accent': 'var(--dsw-alias-brand-primary,#3976c3)', '--dsh-persona-border': 'var(--dsw-alias-border-l1,#d8dfe7)',
        '--dsh-persona-bg': 'var(--dsw-alias-bg-layer-1,#fff)', '--dsh-persona-soft': 'var(--dsw-alias-bg-layer-2,#f5f7fa)',
        '--dsh-persona-text': 'var(--dsw-alias-label-primary,#203044)', '--dsh-persona-muted': 'var(--dsw-alias-label-secondary,#607080)',
      } }, h('style', null, SETTINGS_CSS),
        h('div', { className: 'dsh-persona-memory-footer' }, h('strong', null, '我的资料'),
          onClose ? h('button', { type: 'button', style: toggleStyle, disabled: busy, onClick: onClose }, '收起外观') : null),
        h('label',{style:{...fieldStyle,marginTop:'14px'}},h('span',{style:labelStyle},'角色怎么称呼你'),
          h('input',{type:'text',style:inputStyle,'aria-label':'角色怎么称呼你',placeholder:'不指定，按人设自然称呼',value:address,
            'aria-invalid':!!addressError,disabled:!value,onChange:event=>editAddress(event.target.value)})),
        h('div',{style:{display:'flex',alignItems:'center',justifyContent:'space-between',gap:'12px',marginTop:'8px'}},
          h('span',{style:hintStyle},Array.from(address.trim()).length+'/40'),h('button',{type:'button',style:toggleStyle,'aria-label':'保存称呼',
            disabled:!value||busy||addressSaving||!!editing||!!addressError||!addressDirty,onClick:()=>void saveAddress()},addressSaving?'保存中…':'保存称呼')),
        h('p',{style:hintStyle},'所有聊天室共用；只用于角色聊天中的称呼，不改工作汇报，也不会存入长期记忆。留空即可按人设自然称呼。'),
        h('p',{style:hintStyle,role:'status','aria-live':'polite'},addressError||addressNotice),
        h('label',{style:{...fieldStyle,marginTop:'14px'}},h('span',{style:labelStyle},'你的性别（聊天室）'),
          h('select',{style:inputStyle,'aria-label':'你的性别（聊天室）',value:value?.userGender??'unset',disabled:!value||busy||addressSaving||!!editing,
            onChange:event=>void changeGender(event.target.value)},
            h('option',{value:'unset'},'不指定'),h('option',{value:'female'},'女性'),h('option',{value:'male'},'男性'),h('option',{value:'none'},'无性别'))),
        h('p',{style:hintStyle},'可选，默认不指定；不指定表示不提供性别，不等于无性别。所有聊天室共用，不改工作汇报或长期记忆。默认不因性别差异拉开距离；设为男性时，女性人格会更克制，不主动肢体接触，收到你的邀请也保留分寸。女性或不指定时按性格自然相处；性别不代表同意接触。'),
        h('strong',{style:{display:'block',marginTop:'18px',marginBottom:'8px'}},'我的头像'),
        h('p', { style: hintStyle }, '默认跟随 DSH 账号头像。没有头像或加载失败时，只显示你的消息气泡。'),
        h('label', { style: { ...fieldStyle, marginTop: '14px' } }, h('span', { style: labelStyle }, '用户头像显示'),
          h('select', { style: inputStyle, 'aria-label': '用户头像显示', value: mode, disabled: !value || busy || !!editing,
            onChange: (event) => { void changeMode(event.target.value); } },
            h('option', { value: 'account' }, '跟随账号头像'), h('option', { value: 'custom', disabled: !value?.avatar }, '使用自定义头像'),
            h('option', { value: 'hidden' }, '不显示头像'))),
        editing ? h(PersonaAvatarEditor, { user: true, preset: { id: 'user', name: '你', avatar: editing.avatar }, busy, onSave: save,
          onClose: () => { setEditing(undefined); setNotice(''); } })
          : h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' } },
            h(UserChatAvatar, { profile: value, accountUrl, className: 'dsh-persona-preset-avatar' }),
            h('button', { type: 'button', style: toggleStyle, disabled: !value || busy, onClick: () => setEditing(value) }, '修改我的头像'),
            h('button', { type: 'button', style: toggleStyle, disabled: busy, onClick: () => { void refresh(); void accountAvatarSource.refresh(); } }, '刷新头像')),
        !editing ? h('p', { style: hintStyle }, mode === 'hidden' ? '用户侧只显示消息气泡；已上传的图片仍保留。'
          : mode === 'account' ? accountUrl ? '使用当前 DSH 账号头像，不保存账号资料。' : '未获取到账号头像时，用户侧只显示消息气泡。'
            : '使用已上传的自定义图片；只保存取景后的图片，不发送给模型。') : null,
        h('p', { style: hintStyle, role: 'status' }, notice),
        notice==='个人资料暂时无法读取，可以刷新重试。'?h('button',{type:'button',style:toggleStyle,disabled:busy,onClick:()=>void refresh()},'重新读取个人资料'):null);
    }

    /** A visible model selector owns its catalogue request and retires it on hide/change. */
    function useModelCatalogue(provider, visible, retry = 0) {
      const [state, setState] = React.useState({ provider: null, models: [], failed: false });
      React.useEffect(() => {
        if (!visible || !provider) return;
        let live = true;
        const abort = new AbortController();
        const fail = () => { if (live) setState({ provider, models: [], failed: true }); };
        const timeout = setTimeout(() => { abort.abort(); fail(); }, 10000);
        setState({ provider, models: [], failed: false });
        void (async () => {
          try {
            const response = await fetch(ROUTE + '/models?provider=' + encodeURIComponent(provider), { signal: abort.signal });
            if (!response.ok) throw Error('models-unavailable');
            const value = await response.json();
            if (value.error || !Array.isArray(value.models)) throw Error('models-unavailable');
            if (live && !abort.signal.aborted) setState({ provider, models: value.models, failed: false });
          } catch { fail(); }
          finally { clearTimeout(timeout); }
        })();
        return () => { live = false; clearTimeout(timeout); abort.abort(); };
      }, [provider, visible, retry]);
      return provider && state.provider === provider ? state : { models: [], failed: false };
    }

    let nextSettingsId = 0;
    function SettingsSection() {
      const [activeTab, setActiveTab] = React.useState('persona');
      const [appearanceVisited,setAppearanceVisited]=React.useState(false);
      React.useEffect(()=>{if(activeTab==='appearance')setAppearanceVisited(true);},[activeTab]);
      const tabsId = React.useRef(null);
      if (tabsId.current === null) tabsId.current = 'dsh-persona-settings-' + (++nextSettingsId);
      const [settings, setSettings] = React.useState(undefined);
      const settingsRef = React.useRef(undefined);
      const [packDrafts, setPackDrafts] = React.useState({});
      const draftsRef = React.useRef({ values: {}, versions: {}, revision: 0 });
      const writes = React.useRef(Promise.resolve());
      const editorGeneration = React.useRef(0);
      const editorScope = editorGeneration.current;
      const [presetBusy, setPresetBusy] = React.useState(false);
      const presetBusyRef = React.useRef(false);
      const presetLoadRevision = React.useRef(0);
      const statusTimer = React.useRef(undefined);
      const mounted = React.useRef(true);
      const [rendererState, setRendererState] = React.useState(chatRendererState);
      React.useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; clearTimeout(statusTimer.current); };
      }, []);
      React.useEffect(() => {
        const listener = () => setRendererState(chatRendererState);
        rendererListeners.add(listener);
        listener();
        return () => rendererListeners.delete(listener);
      }, []);
      const [providers, setProviders] = React.useState([]);
      const [providersFailed,setProvidersFailed]=React.useState(false),[catalogueRetry,setCatalogueRetry]=React.useState(0);
      const { models, failed: modelsFailed } = useModelCatalogue(settings?.provider, activeTab === 'advanced', catalogueRetry);
      const { models: chatModels, failed: chatModelsFailed } = useModelCatalogue(settings?.chatProvider, activeTab === 'chat', catalogueRetry);
      const { models: visualizationModels, failed: visualizationModelsFailed } = useModelCatalogue(settings?.visualizationProvider, activeTab === 'advanced', catalogueRetry);
      const [status, setStatus] = React.useState('');
      const [failedSettingsSave, setFailedSettingsSave] = React.useState(false);
      const [reviewThresholdDraft, setReviewThresholdDraft] = React.useState(undefined);
      const [progressMinutesDraft, setProgressMinutesDraft] = React.useState(undefined);
      /** What long-term memory currently claims, so it can be inspected. */
      const [memoryLines, setMemoryLines] = React.useState([]);
      const [memoryStats, setMemoryStats] = React.useState(undefined);

      /** Named persona presets, plus the free-form prompt used to generate one. */
      const [presets, setPresets] = React.useState([]);
      const [activePresetId, setActivePresetId] = React.useState('');
      const [activePresetName, setActivePresetName] = React.useState('');
      const [personaPrompt, setPersonaPrompt] = React.useState('');
      const [generating, setGenerating] = React.useState(false);
      const [generated, setGenerated] = React.useState(undefined);
      const [generatedSource, setGeneratedSource] = React.useState('');
      const [generatedReviewOpen, setGeneratedReviewOpen] = React.useState(false);
      const generatedReview = React.useRef(null), generatedReviewReturn = React.useRef(null), generateButton = React.useRef(null);
      React.useEffect(() => {
        if (generatedReviewOpen) {
          generatedReview.current?.focus({ preventScroll: true });
          generatedReview.current?.scrollIntoView?.({ block: 'nearest' });
        }
      }, [generatedReviewOpen]);
      const generatingRef = React.useRef(false);
      const [presetStatus, setPresetStatus] = React.useState('');
      /** Name the user chose for a freshly generated preset. */
      const [generatedName, setGeneratedName] = React.useState('');
      /** Preset id being renamed, if the inline editor is open. */
      const [renaming, setRenaming] = React.useState(undefined);
      const [renameValue, setRenameValue] = React.useState('');
      const [editingAvatar, setEditingAvatar] = React.useState(undefined);

      // Keep writes in user order; card drafts remain separate from server snapshots.
      const queueWrite = (write) => {
        const task = writes.current.then(write, write);
        writes.current = task.catch(() => {});
        return task;
      };
      const acceptSettings = (value) => { settingsRef.current = value; setSettings(value); };
      const showStatus = (value, temporary = false) => {
        if (!mounted.current) return;
        clearTimeout(statusTimer.current);
        setStatus(value);
        if (temporary) statusTimer.current = setTimeout(() => setStatus(''), 1500);
      };
      const setDraft = (field, value) => {
        if (presetBusyRef.current || editorGeneration.current !== editorScope) return false;
        const draft = draftsRef.current;
        const revision = draft.revision + 1;
        draftsRef.current = { values: { ...draft.values, [field]: value },
          versions: { ...draft.versions, [field]: revision }, revision };
        setPackDrafts(draftsRef.current.values);
        return true;
      };

      const catalogueVisible = !!settings && (activeTab === 'chat' || activeTab === 'advanced');
      React.useEffect(() => {
        if (!catalogueVisible) return;
        let cancelled = false;
        const abort=new AbortController(),timeout=setTimeout(()=>{abort.abort();if(!cancelled)setProvidersFailed(true);},10000);setProvidersFailed(false);
        (async () => {
          try {
            const response = await fetch(`${ROUTE}/models`,{signal:abort.signal});
            if (!response.ok) throw Error('models-unavailable');
            const value = await response.json();
            if(value.error||!Array.isArray(value.providers))throw Error('models-unavailable');
            if (!cancelled && !abort.signal.aborted) setProviders(value.providers);
          } catch { if(!cancelled)setProvidersFailed(true); }
          finally{clearTimeout(timeout);}
        })();
        return () => { cancelled = true;clearTimeout(timeout);abort.abort(); };
      }, [catalogueVisible,catalogueRetry]);

      // Presets load once, and again whenever a preset operation returns a new
      // list: the host is the source of truth, the page only mirrors it.
      /**
       * Mirror the host's preset state.
       *
       * Takes the whole payload, not just the array. The active name and id move
       * whenever a preset is applied, renamed, deleted or saved, and updating the
       * list without them left the page showing the previous selection — so
       * 「启用」 looked like it did nothing until a reload.
       * @param {{ presets?: unknown, active?: unknown }} [payload]
       */
      const refreshPresets = async (payload) => {
        let value = payload;
        if (value === undefined) {
          const revision = presetLoadRevision.current;
          try {
            const response = await fetch(`${ROUTE}/presets`);
            if (!response.ok) return;
            value = await response.json();
            if (revision !== presetLoadRevision.current) return;
          } catch {
            return;
          }
        } else presetLoadRevision.current += 1;
        const list = Array.isArray(value?.presets) ? value.presets : [];
        setPresets(list);
        const activeName = typeof value?.active === 'string' ? value.active : '';
        setActivePresetName(activeName);
        const match = list.find((preset) => preset.name === activeName);
        setActivePresetId(match !== undefined ? match.id : '');
      };

      React.useEffect(() => { void refreshPresets(); }, []);

      const presetAction = (body) => {
        if (presetBusyRef.current) return Promise.resolve({ ok: false, reason: 'preset-change-pending' });
        presetBusyRef.current = true;
        setPresetBusy(true);
        editorGeneration.current += 1;
        const builtinAvatarOnly = body.action === 'avatar' && presets.some(preset => preset.id === body.id && preset.builtin);
        const replacesCard = body.action === 'apply' || body.action === 'save' || (body.action === 'avatar' && !builtinAvatarOnly)
          || (body.action === 'delete' && body.id === activePresetId);
        return queueWrite(async () => {
          try {
            // A failed blur save must not disappear when another card is selected.
            const changes = draftChanges();
            let requestBody = body;
            if (replacesCard && changes.length > 0) {
              const saved = await persistPackChanges(changes);
              if (!saved?.settings) {
                setPresetStatus(body.action === 'avatar' ? '保存头像前，人格修改未能保存，请重试。' : '切换前保存人格修改失败，请重试。');
                return { ok: false, reason: 'unsaved-persona-edits' };
              }
              if (body.action === 'avatar' && body.id === activePresetId) {
                const current = saved.presets?.find((p) => p.name === saved.settings.presetName);
                if (current && current.id !== body.id) requestBody = { ...body, id: current.id, expectedAvatar: current.avatar ?? null };
              }
            }
            const result = await postPreset(requestBody);
            if (result?.ok === true) {
              await refreshPresets({ presets: result.presets, active: result.active });
              if (result.settings !== undefined) acceptSettings(result.settings);
              setPresetStatus('');
              if (body.action === 'avatar') for (const update of chatUpdates) update(body.id);
            } else {
              setPresetStatus(body.action === 'avatar'
                ? result?.reason === 'avatar-conflict' ? '头像已在别处更新，请取消后重新打开。已选图片仍保留。' : '头像保存未完成，已选图片与取景仍保留，可以重试。'
                : `失败：${result?.reason ?? '未知原因'}`);
            }
            return result;
          } finally {
            presetBusyRef.current = false;
            setPresetBusy(false);
          }
        });
      };

      const returnFromGeneratedReview = (removed = false) => {
        const target = generatedReviewReturn.current;
        if (!removed && target?.isConnected) target.focus();
        else if (removed) generateButton.current?.closest('[data-settings-fold="create-persona"]')?.querySelector('summary')?.focus();
        else generateButton.current?.focus();
      };
      const closeGeneratedReview = () => {
        if (generatingRef.current || presetBusyRef.current) return;
        setGeneratedReviewOpen(false);
        returnFromGeneratedReview();
      };
      const generatePreset = async (event) => {
        if (generatingRef.current || presetBusyRef.current) return;
        generatedReviewReturn.current = event?.currentTarget ?? generateButton.current;
        generatingRef.current = true;
        const prompt = personaPrompt;
        setGenerating(true);
        setPresetStatus('正在读取人设…');
        const result = await postPreset({ action: 'generate', prompt });
        generatingRef.current = false;
        setGenerating(false);
        if (result?.ok === true) {
          setGenerated(result.preset);
          setGeneratedSource(prompt);
          // Seeded from the generated suggestion, but editable: it is a starting
          // point, not the user's decision.
          setGeneratedName(result.preset?.name ?? '');
          setGeneratedReviewOpen(true);
          setPresetStatus('已生成，确认后保存');
        } else {
          setPresetStatus(typeof result?.reason === 'string' && result.reason.startsWith('generation-')
            ? '模型返回的结构或多轮示例不完整，未采用。输入和已有预览已保留，可调整后重新生成。'
            : `生成失败：${result?.reason ?? '未知原因'}`);
        }
      };

      const startRename = (preset) => {
        setRenaming(preset.id);
        setRenameValue(preset.name);
      };

      const commitRename = async () => {
        const name = renameValue.trim();
        if (renaming === undefined || name === '') return;
        const result = await presetAction({ action: 'rename', id: renaming, name });
        if (result?.ok === true) {
          setRenaming(undefined);
          setRenameValue('');
        }
      };

      const pack = settings?.pack;

      const writeSettings = async (patch) => {
        showStatus('正在保存…');
        const result = await postSettings(patch);
        if (result?.settings !== undefined) {
          setFailedSettingsSave(false);
          acceptSettings(result.settings);
          // Saving can change the learned profile (a clear resets it), so the
          // memory panel refreshes from the same response rather than going stale.
          if (Array.isArray(result.memory)) setMemoryLines(result.memory);
          if (result.memoryStats !== undefined) setMemoryStats(result.memoryStats);
          // Editing the card writes back into a preset — or forks one from the
          // builtin — so the list and the selection both move with it.
          if (Array.isArray(result.presets)) {
            await refreshPresets({ presets: result.presets, active: result.settings.presetName });
          }
          showStatus(result.settingsPersistence === 'pending' ? '当前已生效，存储尚未就绪。'
            : result.settingsPersistence === 'memory-only' ? '仅本次生效，当前没有可用存储。' : '已保存',
            result.settingsPersistence !== 'pending' && result.settingsPersistence !== 'memory-only');
        } else {
          if (result?.error === 'settings-save-failed' && result.appliedSettings) {
            acceptSettings(result.appliedSettings);
            setFailedSettingsSave(true);
            showStatus('当前已生效，但保存失败。');
          } else showStatus('保存失败，请重试');
        }
        return result;
      };
      const save = (patch) => queueWrite(() => writeSettings(patch));
      const draftChanges = () => Object.entries(draftsRef.current.values)
        .map(([field, value]) => ({ field, value, version: draftsRef.current.versions[field] }));
      const persistPackChanges = async (changes) => {
        const ordered = [...changes].sort((a, b) => a.version - b.version);
        for (const change of ordered) if (change.field === 'chatVoice') {
          const lines = change.value.split('\n').filter(line => line.trim() !== '');
          if (lines.length > 8 || lines.some(line => line.length > 400)) {
            showStatus('聊天室语气最多8条，每条400字；请缩短后保存。');
            return { error: 'chat-voice-too-long' };
          }
        }
        const nextPack = { ...settingsRef.current?.pack };
        for (const { field, value } of ordered) {
          if (field === 'subagent') nextPack.address = { ...nextPack.address, subagent: value };
          else if (field === 'narrationMode') nextPack.narration = { ...nextPack.narration, mode: value };
          else if (field === 'narrationAssistant') nextPack.narration = { ...nextPack.narration, assistant: value };
          else if (field === 'chatVoice') nextPack.chat = { ...(nextPack.chat ?? { samples: [] }), voice: value.split('\n').filter(line => line.trim() !== '') };
          else if (field === 'chatGender') nextPack.chat = { ...(nextPack.chat ?? {}), gender: value };
          else if (field === 'chatSource' && nextPack.chat?.source) {
            const effectiveVoice = nextPack.chat.voice ?? (nextPack.voice ?? []).filter(line => line.trim());
            if (value === 'use' && !chatSourceCanBind(nextPack.identity, effectiveVoice)) {
              const draft = draftsRef.current;
              if (draft.versions.chatSource === changes.find(change => change.field === 'chatSource')?.version) {
                const values = { ...draft.values }, versions = { ...draft.versions };
                delete values.chatSource; delete versions.chatSource;
                draftsRef.current = { ...draft, values, versions }; setPackDrafts(values);
              }
              showStatus('当前身份或聊天语气超出原始参考的绑定范围，未启用，原文仍保留。');
              return { error: 'chat-source-binding-limit' };
            }
            nextPack.chat = { ...nextPack.chat, source: { ...nextPack.chat.source, enabled: value === 'use',
              ...(value === 'use' ? { identity: nextPack.identity.trim(), voice: [...effectiveVoice] } : {}) } };
          }
          else if (field === 'chatReset') {
            const gender = nextPack.chat?.gender;
            if (gender !== undefined) nextPack.chat = { gender };
            else delete nextPack.chat;
          }
          else nextPack[field] = field === 'identity' ? value : value.split('\n').filter((line) => line.trim() !== '');
        }
        const result = await writeSettings({ pack: nextPack });
        if (result?.settings !== undefined) {
          const draft = draftsRef.current;
          const values = { ...draft.values };
          const versions = { ...draft.versions };
          for (const { field, version } of changes) if (versions[field] === version) {
            delete values[field]; delete versions[field];
          }
          const resetVersion = Math.max(-1, ...changes.filter(change => change.field === 'chatReset').map(change => change.version));
          if (versions.chatVoice !== undefined && versions.chatVoice <= resetVersion) {
            delete values.chatVoice; delete versions.chatVoice;
          }
          draftsRef.current = { ...draft, values, versions };
          setPackDrafts(values);
        }
        return result;
      };
      const savePackField = (field, value) => {
        if (!setDraft(field, value)) return Promise.resolve();
        const change = { field, value, version: draftsRef.current.versions[field] };
        return queueWrite(() => persistPackChanges([change]));
      };
      const draftValue = (field, value) => Object.hasOwn(packDrafts, field) ? packDrafts[field] : value;

      if (settings === undefined) {
        return h('div', null,
          h('h2', { style: sectionTitleStyle }, '人格套壳'),
          h(LoadSettings, {
            onLoaded: (value) => {
              acceptSettings(value.settings);
              setMemoryLines(Array.isArray(value.memory) ? value.memory : []);
              setMemoryStats(value.memoryStats);
            },
          }),
        );
      }

      const colloquialControls = h('div', { className: 'dsh-persona-setting-field', style: fieldStyle },
          h('label', { style: toggleRowStyle },
            h('input', { type: 'checkbox', checked: settings.colloquialReports !== false,
              'aria-describedby': tabsId.current + '-colloquial-hint',
              onChange: (event) => save({ colloquialReports: event.target.checked }) }),
            h('span', { style: labelStyle }, '口语化转述')),
          h('span', { id: tabsId.current + '-colloquial-hint', style: hintStyle },
            '把书面说明讲得顺口一些，事实、条件和风险完整保留。关闭后更贴近原文句式。'));
      const processControls = h('div', { className: 'dsh-persona-setting-field', style: fieldStyle },
          h('label', { style: toggleRowStyle },
            h('input', {
              type: 'checkbox',
              checked: settings?.includeToolSteps !== false,
              disabled: settings.trigger === 'report',
              'aria-describedby': tabsId.current + '-process-scope-hint',
              onChange: (event) => save({ includeToolSteps: event.target.checked }),
            }),
            h('span', { style: labelStyle }, '同时改写阶段性输出'),
          ),
          h('span', { style: hintStyle, id: tabsId.current + '-process-scope-hint' },
            settings.trigger === 'report' ? '仅最终汇报不使用以下过程选项，原选择已保留；独立设为全部汇报的会话仍沿用这些选择。'
              : '让带工具调用的阶段汇报也使用当前人格。',
          ),
          h('label', { style: { ...toggleRowStyle, marginTop: '10px' } },
            h('input', { type: 'checkbox', checked: settings?.processToolUsage === true,
              disabled: settings.trigger === 'report' || settings?.includeToolSteps === false,
              'aria-describedby': tabsId.current + '-process-scope-hint',
              onChange: (event) => save({ processToolUsage: event.target.checked }) }),
            h('span', { style: labelStyle }, '允许过程转述参考运行信息'),
          ),
          h('span', { style: hintStyle },
            '参考这段工作的轻量统计，单独补充一句。可选，会增加一次模型续接。'),
        );
      const quietControls = h('div', { className: 'dsh-persona-setting-field', style: fieldStyle },
          h('label', { style: toggleRowStyle },
            h('input', { type: 'checkbox', checked: settings.progressNotices === true,
              onChange: (event) => save({ progressNotices: event.target.checked }) }),
            h('span', { style: labelStyle }, '静默状态播报'),
          ),
          h('span', { style: hintStyle },
            '等待较久时听到一句状态播报。可选，会额外调用模型。'),
          h('label', { hidden: settings.progressNotices !== true, style: { ...toggleRowStyle, display: settings.progressNotices === true ? 'flex' : 'none', marginTop: '8px', flexWrap: 'wrap' } },
            h('span', { style: labelStyle }, '静默多久后播报（分钟）'),
            h('input', { type: 'number', min: 1, max: 60, step: 1, style: { ...inputStyle, width: '76px' },
              disabled: settings.progressNotices !== true,
              value: progressMinutesDraft ?? settings.progressMinutes ?? 5,
              onChange: (event) => setProgressMinutesDraft(event.target.value),
              onBlur: async (event) => {
                const value = Number(event.target.value);
                if (Number.isInteger(value) && value >= 1 && value <= 60 && value !== settings.progressMinutes) {
                  await save({ progressMinutes: value });
                }
                setProgressMinutesDraft(undefined);
              },
              onKeyDown: (event) => { if (event.key === 'Enter') event.currentTarget.blur(); },
            }),
          ),
        );
      const reviewControls = h('div', { className: 'dsh-persona-setting-field', style: fieldStyle },
          h('label', { style: toggleRowStyle },
            h('input', {
              type: 'checkbox',
              checked: settings.reviewHints !== false,
              onChange: (event) => save({ reviewHints: event.target.checked }),
            }),
            h('span', { style: labelStyle }, '改写变化提示'),
          ),
          h('span', { style: hintStyle },
            '措辞变化较大，或检测到数字、局部否定变化时显示 ※，方便对照原文。只在本地检查，不增加模型调用。')
        );
      const thresholdControls = h('details', { style: { marginTop: '6px' } },
            h('summary', { style: { ...hintStyle, cursor: 'pointer' } }, '调整变化提示阈值'),
            h('label', { style: { ...toggleRowStyle, marginTop: '6px' } },
              h('span', { style: labelStyle }, `措辞变化阈值：${Math.round((reviewThresholdDraft ?? settings.reviewThreshold ?? 0.55) * 100)}/100`),
              h('input', {
                type: 'range', min: 0, max: 1, step: 0.05,
                'aria-label': '措辞变化提示阈值',
                value: reviewThresholdDraft ?? settings.reviewThreshold ?? 0.55,
                disabled: settings.reviewHints === false,
                onChange: (event) => setReviewThresholdDraft(Number(event.target.value)),
                // Commit once on blur, not one network request per slider tick.
                onBlur: async (event) => {
                  const value = Number(event.target.value);
                  if (value !== settings.reviewThreshold) await save({ reviewThreshold: value });
                  setReviewThresholdDraft(undefined);
                },
                onKeyDown: (event) => { if (event.key === 'Enter') event.currentTarget.blur(); },
              })),
            h('span', { style: hintStyle },
              '默认 55；越低越容易提示，移开焦点后保存。低于阈值不显示；关键表达变化只作解释，不绕过阈值。'
              + '修改只影响已有评估的显示，不重新改写；旧记录不补算。'),
          );
      const subagentControls = h('div', { className: 'dsh-persona-setting-field', style: fieldStyle },
          h('span', { style: { ...labelStyle, marginBottom: '2px' } }, '子代理会话'),
          h('label', { style: toggleRowStyle },
            h('input', {
              type: 'checkbox',
              checked: settings?.subagentSteps === true,
              onChange: (event) => save({ subagentSteps: event.target.checked }),
            }),
            h('span', { style: labelStyle }, '改写子代理的过程输出'),
          ),
          h('span', { style: hintStyle }, '子代理的中间步骤基本没人看，默认不改写。'),
          h('label', { style: { ...toggleRowStyle, marginTop: '6px' } },
            h('input', {
              type: 'checkbox',
              checked: settings?.subagentReports === true,
              onChange: (event) => save({ subagentReports: event.target.checked }),
            }),
            h('span', { style: labelStyle }, '改写子代理的结论输出'),
          ),
          h('span', { style: hintStyle }, '子代理的最终答复；如果会转述给你，可以打开。'),
        );
      const personaControls = h('div', { className: 'dsh-persona-personas' },


          // Say where edits go before they are made: an edit to the builtin
          // forks a new preset, and that is surprising if it is not announced.


          presets && presets.length > 0
            ? h('div', { className: 'dsh-persona-preset-grid', 'data-many': presets.length > 5 },
              ...presets.map((preset) => h('div', {
                key: preset.id,
                className: 'dsh-persona-preset', 'data-preset-id': preset.id, 'data-active': preset.id === activePresetId,
              },
              preset.avatar ? h(PersonaAvatar, { src: preset.avatar, name: preset.name, id: preset.id, fallback: false,
                className: 'dsh-persona-preset-avatar' }) : null,
              h('span', {
                className: 'dsh-persona-preset-name',
                style: presetNameStyle,
              }, preset.name, h('small', { className: 'dsh-persona-preset-description' }, personaSummary(preset))),
              preset.builtin === true
                ? h('span', { className: 'dsh-persona-preset-tag' }, '内置')
                : null,
              h('div', { className: 'dsh-persona-preset-actions' },
                h('button', { type: 'button', style: toggleStyle, disabled: presetBusy,
                  'aria-label': '修改' + preset.name + '头像', onClick: () => setEditingAvatar(preset) }, '头像'),
                preset.id === activePresetId
                  ? h('span', { className: 'dsh-persona-selected-label' }, '已选择')
                  : h('button', {
                    type: 'button',
                    style: toggleStyle,
                    disabled: presetBusy,
                    onClick: () => presetAction({ action: 'apply', id: preset.id }),
                  }, '启用'),
                preset.builtin === true
                  ? null
                  : h('button', {
                    type: 'button',
                    style: toggleStyle,
                    disabled: presetBusy,
                    onClick: () => startRename(preset),
                  }, '改名'),
                preset.builtin === true
                  ? null
                  : h('button', {
                    type: 'button',
                    style: { ...toggleStyle, color: 'var(--dsw-alias-label-tertiary)' },
                    disabled: presetBusy,
                    onClick: () => presetAction({ action: 'delete', id: preset.id }),
                  }, '删除'),
              ))),
            )
            : null,

          editingAvatar ? h(PersonaAvatarEditor, { key: editingAvatar.id, preset: editingAvatar, busy: presetBusy,
            onClose: () => setEditingAvatar(undefined), onSave: async (body) => {
              const result = await presetAction(body); if (result?.ok === true && mounted.current) setEditingAvatar(undefined); return result;
            } }) : null,

          presets.some(p=>p.builtin&&p.character)?h('details',{className:'dsh-persona-character-guide',style:{marginTop:12}},
            h('summary',{style:{cursor:'pointer',fontSize:12,color:'var(--dsw-alias-label-secondary)'}},'内置人物关系'),
            h('p',{style:hintStyle},'大肥鱼和小肥鱼是姐妹。大家叫大肥龙「GPT」，叫 Gemini「猫猫」。这些是本插件的二创设定，自定义人格有自己的关系。'),
            h('div',{style:{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(min(100%,320px),1fr))',gap:10}},
              ...presets.filter(p=>p.builtin&&p.character).map(p=>h('article',{key:p.id,style:{border:'1px solid var(--dsw-alias-border-l1)',borderRadius:9,padding:'10px 12px'}},
                h('strong',{style:{fontSize:12}},p.name+' · '+p.character.genderLabel),
                h('p',{style:{...hintStyle,margin:'5px 0 8px'}},'称呼：'+p.character.preferredAddress.join('、')),
                ...p.character.relations.map(r=>h('p',{key:r.to,style:{...hintStyle,margin:'5px 0'}},
                  h('span',{style:{color:'var(--dsw-alias-label-primary)'}},'对'+r.address+'：'),r.dynamic)))))):null,

          // Inline rename: a dialog would be heavier than the operation, and the
          // page already has the preset in hand.
          renaming !== undefined
            ? h('div', { style: { ...presetPreviewStyle, display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
              h('input', {
                style: { ...inputStyle, flex: 1 },
                value: renameValue,
                disabled: presetBusy,
                onChange: (event) => setRenameValue(event.target.value),
                onKeyDown: (event) => { if (event.key === 'Enter') commitRename(); },
              }),
              h('button', { type: 'button', style: primaryButtonStyle, disabled: presetBusy, onClick: commitRename }, '保存'),
              h('button', {
                type: 'button',
                style: toggleStyle,
                onClick: () => { setRenaming(undefined); setRenameValue(''); },
              }, '取消'),
            )
            : null,
        );
      const chatSourceCanBind = (identity, voice) => typeof identity === 'string' && identity.trim() && identity.trim().length <= 4000
        && Array.isArray(voice) && voice.length <= 8 && voice.every(line => typeof line === 'string' && line.trim() && line.length <= 400);
      const chatSourceActive = (profile, identity, voice) => profile?.source?.enabled === true && profile.source.identity === identity?.trim()
        && Array.isArray(profile.source.voice) && profile.source.voice.length === (profile.voice ?? voice ?? []).length
        && profile.source.voice.every((line, index) => line === (profile.voice ?? voice ?? [])[index]);
      const sourcePreview = (profile, identity, voice) => profile?.source ? h('details', { style: { marginTop: '6px' } },
        h('summary', null, `原始人设参考（${chatSourceActive(profile, identity, voice) ? '用于聊天' : '未启用'}）`),
        h('p', { style: hintStyle }, '仅作虚构角色资料，当前身份、语气和用户本次原话优先；不是实际经历、长期记忆或工具权限，不提供给工作转述。'),
        h('div', { style: { ...memoryLineStyle, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, profile.source.text)) : null;
      const chatExamplesPreview = (profile) => h(React.Fragment, null,
        profile?.samples?.length ? h('details', { style: { marginTop: '6px' } }, h('summary', null, '聊天语气示例'),
          h('div', { style: { ...memoryLineStyle, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, profile.samples.join('\n\n'))) : null,
        ...[['dialogueExamples', '日常虚构示例'], ['workDialogueExamples', '工作讨论虚构示例']].map(([key, label]) =>
          Array.isArray(profile?.[key]) && profile[key].length ? h('details', { key, style: { marginTop: '6px' } },
            h('summary', null, label), ...profile[key].map((group, index) => h('div', { key: index,
              style: { ...memoryLineStyle, marginTop: '6px', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } },
              (group.turns ?? []).map(turn => `${turn.speaker === 'self' ? '本人' : turn.speaker === 'user' ? '用户' : turn.speaker}：${turn.text}`).join('\n')))) : null));
      const editGenerated = (section, key, value) => setGenerated(current => current
        ? section ? { ...current, [section]: { ...current[section], [key]: value } } : { ...current, [key]: value } : current);
      const generatorControls = h('div', { className: 'dsh-persona-setting-field', style: fieldStyle },
          h('span', { style: labelStyle }, '从人设提示词生成预设'),
          h('span', { style: hintStyle },
            '粘贴人设提示词，分别准备聊天和转述表达。先预览、改名，再保存启用；生成不会自动替换当前人格。',
          ),
          h('textarea', {
            style: { ...inputStyle, minHeight: '88px', resize: 'vertical' },
            'aria-label': '人设提示词', placeholder: '粘贴人设提示词…',
            value: personaPrompt,
            onChange: (event) => setPersonaPrompt(event.target.value),
          }),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginTop: '6px' } },
            h('button', {
              type: 'button',
              ref: generateButton,
              style: primaryButtonStyle,
              disabled: generating || presetBusy || personaPrompt.trim().length < 20,
              onClick: (event) => generatePreset(event),
            }, generating ? '生成中…' : '生成预设'),
            presetStatus !== '' ? h('span', { style: hintStyle }, presetStatus) : null,
          ),
          generated !== undefined
            ? h('details', { style: presetPreviewStyle, open: generatedReviewOpen,
              onToggle: event => { if (event.currentTarget.open !== generatedReviewOpen) setGeneratedReviewOpen(event.currentTarget.open); } },
              h('summary', { style: { ...labelStyle, cursor: 'pointer', overflowWrap: 'anywhere' },
                'aria-disabled': generating || presetBusy,
                onClick: event => {
                  if (generating || presetBusy) event.preventDefault();
                  else if (!generatedReviewOpen) generatedReviewReturn.current = event.currentTarget;
                } }, '核对生成结果（未保存）'),
              h('section', { ref: generatedReview, role: generatedReviewOpen ? 'dialog' : undefined,
                'aria-label': '核对生成的人格', 'aria-modal': false, tabIndex: -1,
                style: { maxHeight: 'min(72vh, 760px)', overflowY: 'auto', overscrollBehavior: 'contain', padding: '8px 2px 2px', outlineOffset: '2px' },
                onKeyDown: event => {
                  if (event.key === 'Escape' && !event.nativeEvent?.isComposing) {
                    event.preventDefault(); event.stopPropagation(); closeGeneratedReview();
                  }
                } },
              h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' } },
                h('strong', { style: labelStyle }, '保存前核对一下'),
                h('button', { type: 'button', style: toggleStyle, disabled: presetBusy || generating, onClick: closeGeneratedReview }, '稍后编辑')),
              h('p', { style: hintStyle }, '可以在这里修正身份、性别、称呼和转述关系。关闭后草稿仍保留；只有“保存并启用”才会采用。'),
              // The generated name is a suggestion, not a decision: the user
              // names their own presets.
              h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' } },
                h('span', { style: labelStyle }, '名称'),
                h('input', {
                  style: { ...inputStyle, flex: 1 },
                  value: generatedName,
                  disabled: presetBusy || generating,
                  'aria-label': '新预设名称', placeholder: '给这个预设起个名字',
                  onChange: (event) => setGeneratedName(event.target.value),
                }),
              ),
              h('label', { style: fieldStyle }, h('span', { style: labelStyle }, '身份摘要（可修正）'),
                h('textarea', { style: { ...inputStyle, minHeight: '74px', resize: 'vertical' }, 'aria-label': '生成身份摘要',
                  value: generated.identity ?? '', disabled: presetBusy || generating, onChange: event => editGenerated(null, 'identity', event.target.value) })),
              h('label',{style:fieldStyle},h('span',{style:labelStyle},'人格性别（聊天室）'),
                h('select',{style:inputStyle,'aria-label':'生成人格性别（聊天室）',value:generated.chat?.gender??'unset',disabled:presetBusy||generating,
                  onChange:event=>editGenerated('chat','gender',event.target.value)},
                  h('option',{value:'unset'},'不指定'),h('option',{value:'female'},'女性'),h('option',{value:'male'},'男性'),h('option',{value:'none'},'无性别（如明确无性别的智能助手）'))),
              h('p', { style: hintStyle }, '不指定表示不作判断；无性别是明确设定，并非所有 AI 都无性别。男娘、假小子是表达风格，不能从气质、衣着或外形推定性别；请按原设或自行选择。'),
              h('label', { style: fieldStyle }, h('span', { style: labelStyle }, '发言关系'),
                h('select', { style: inputStyle, 'aria-label': '生成发言关系', value: generated.narration?.mode ?? 'voice', disabled: presetBusy || generating,
                  onChange: event => editGenerated('narration', 'mode', event.target.value) }, h('option', { value: 'voice' }, '用角色口吻重述'), h('option', { value: 'relay' }, '转达另一位助手的工作'))),
              ...[['narration','assistant','原助手称呼'],['address','user','用户称呼'],['address','subagent','子代理称呼']].map(([section,key,label]) =>
                h('label', { key: label, style: fieldStyle }, h('span', { style: labelStyle }, label), h('input', { style: inputStyle, maxLength: 20,
                  'aria-label': '生成'+label, value: generated[section]?.[key] ?? '', disabled: presetBusy || generating,
                  onChange: event => editGenerated(section, key, event.target.value) }))),
              generated.chat ? h('div', { 'aria-label': '生成的聊天表达', style: { marginTop: '8px' } },
                h('div', { style: labelStyle }, '聊天室'),
                h('div', { style: memoryLineStyle }, (generated.chat.voice ?? []).join(' ／ ')),
                h('p', { style: hintStyle }, `日常多轮示例：${generated.chat.dialogueExamples?.length ?? 0}组；工作讨论示例：${generated.chat.workDialogueExamples?.length ?? 0}组。`),
                h('p', { style: hintStyle }, '示例是虚构风格参考，不是实际经历或记忆。'), chatExamplesPreview(generated.chat),
                sourcePreview(generated.chat, generated.identity, generated.voice),
                generated.chat.source ? h('label', { style: toggleRowStyle }, h('input', { type: 'checkbox',
                  'aria-label': '生成预览参考原始人设', checked: chatSourceActive(generated.chat, generated.identity, generated.voice),
                  disabled: generating || presetBusy || !chatSourceCanBind(generated.identity, generated.chat.voice ?? generated.voice ?? []),
                  onChange: event => { const enabled = event.target.checked; setGenerated(current => current?.chat?.source ? ({ ...current, chat: { ...current.chat,
                    source: { ...current.chat.source, enabled, ...(enabled ? { identity: current.identity.trim(), voice: [...(current.chat.voice ?? current.voice ?? [])] } : {}) } } }) : current); } }), '聊天时参考原始人设') : null)
                : h('p', { style: hintStyle }, '本次未生成独立聊天表达，聊天将沿用基础语感；可以补充人设后再生成。'),
              h('div', { style: { ...labelStyle, marginTop: '8px' } }, '工作转述'),
              (generated.voice ?? []).length ? h('div', { style: memoryLineStyle }, `语气：${generated.voice.join(' ／ ')}`) : null,
              (generated.report ?? []).length > 0
                ? h('div', { style: { ...memoryLineStyle, marginTop: '4px' } },
                  `汇报规则：${generated.report.join(' ／ ')}`)
                : null,
              (generated.samples ?? []).length > 0
                ? h('div', { style: { ...memoryLineStyle, marginTop: '4px' } },
                  h('details', null, h('summary', null, '转述示例'), h('div', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, generated.samples.join('\n\n'))))
                : null,
              generated.avoid?.length ? h('details', { style: { marginTop: '6px' } }, h('summary', null, '表达边界'),
                h('div', { style: { ...memoryLineStyle, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, generated.avoid.join('\n'))) : null,
              h('div', { style: { display: 'flex', gap: '10px', flexWrap: 'wrap', marginTop: '8px' } },
                h('button', {
                  type: 'button',
                  style: primaryButtonStyle,
                  disabled: generating || presetBusy || generatedName.trim() === '' || !generated.identity?.trim()
                    || !generated.address?.user?.trim() || !generated.address?.subagent?.trim() || !generated.narration?.assistant?.trim(),
                  onClick: async () => {
                    const result = await presetAction({
                      action: 'save',
                      name: generatedName.trim(),
                      pack: generated,
                      source: generatedSource,
                    });
                    if (result?.ok === true) {
                      setGenerated(undefined);
                      setGeneratedName('');
                      setGeneratedReviewOpen(false);
                      returnFromGeneratedReview(true);
                    }
                  },
                }, '保存并启用'),
                h('button', {
                  type: 'button',
                  style: toggleStyle,
                  disabled: presetBusy || generating,
                  onClick: () => { setGenerated(undefined); setGeneratedReviewOpen(false); setPresetStatus(''); returnFromGeneratedReview(true); },
                }, '丢弃'),
              ),
            ))
            : null,
        );
      const editorControls = h('div', { className: 'dsh-persona-editor-grid' }, h('div', { className: 'dsh-persona-editor-field', style: fieldStyle },
          h('span', { style: labelStyle }, '身份'),
          h('textarea', {
            style: { ...inputStyle, minHeight: '56px', resize: 'vertical' },
            disabled: presetBusy,
            'aria-label': '身份',
            value: draftValue('identity', pack?.identity ?? ''),
            onChange: (event) => setDraft('identity', event.target.value),
            onBlur: (event) => savePackField('identity', event.target.value),
          }),
        ),

        h('div', { className: 'dsh-persona-editor-field', style: fieldStyle },
          h('span',{style:labelStyle},'人格性别（聊天室）'),
          h('select',{style:inputStyle,'aria-label':'人格性别（聊天室）',
            value:presets.some(p=>p.id===activePresetId&&p.builtin)?'female':draftValue('chatGender',pack?.chat?.gender??'unset'),
            disabled:presetBusy||presets.some(p=>p.id===activePresetId&&p.builtin),onChange:event=>savePackField('chatGender',event.target.value)},
            h('option',{value:'unset'},'不指定'),h('option',{value:'female'},'女性'),h('option',{value:'male'},'男性'),h('option',{value:'none'},'无性别')),
          h('p',{style:hintStyle},'内置人格保持女性；自定义人格按原设选择。不指定不等于无性别，智能助手也不默认无性别。男娘、假小子是表达风格，不能从气质、衣着或外形判定性别。这里只调整聊天，明确选择优先于旧示例，不自动改写身份文字或转述。')),
        h('div', { className: 'dsh-persona-editor-field', style: fieldStyle },
          h('span', { style: labelStyle }, '汇报里的说话规则（每行一条）'),
          h('textarea', {
            style: { ...inputStyle, minHeight: '76px', resize: 'vertical' },
            disabled: presetBusy,
            'aria-label': '汇报里的说话规则',
            value: draftValue('report', (pack?.report ?? []).join('\n')),
            onChange: (event) => setDraft('report', event.target.value),
            onBlur: (event) => savePackField('report', event.target.value),
          }),
        ),

        h('div', { className: 'dsh-persona-editor-field', style: fieldStyle },
          h('span', { style: labelStyle }, '通用语感（每行一条）'),
          h('span', { style: hintStyle }, '有独立聊天表达时，这组语感用于工作转述。'),
          h('textarea', {
            style: { ...inputStyle, minHeight: '76px', resize: 'vertical' },
            disabled: presetBusy,
            'aria-label': '通用语感',
            value: draftValue('voice', (pack?.voice ?? []).join('\n')),
            onChange: (event) => setDraft('voice', event.target.value),
            onBlur: (event) => savePackField('voice', event.target.value),
          }),
        ),

        h('div', { className: 'dsh-persona-editor-field', style: fieldStyle },
          h('span', { style: labelStyle }, '语气示例（每行一条）'),
          h('textarea', {
            style: { ...inputStyle, minHeight: '56px', resize: 'vertical' },
            disabled: presetBusy,
            'aria-label': '语气示例',
            value: draftValue('samples', (pack?.samples ?? []).join('\n')),
            onChange: (event) => setDraft('samples', event.target.value),
            onBlur: (event) => savePackField('samples', event.target.value),
          }),
        ),

        h('div', { className: 'dsh-persona-editor-field', style: fieldStyle },
          h('span', { style: labelStyle }, '避免出现（每行一条）'),
          h('textarea', {
            style: { ...inputStyle, minHeight: '56px', resize: 'vertical' },
            disabled: presetBusy,
            'aria-label': '避免出现',
            value: draftValue('avoid', (pack?.avoid ?? []).join('\n')),
            onChange: (event) => setDraft('avoid', event.target.value),
            onBlur: (event) => savePackField('avoid', event.target.value),
          }),
        ),

        h('div', { className: 'dsh-persona-editor-field', style: fieldStyle, 'aria-label': '独立聊天表达' },
          h('span', { style: labelStyle }, '聊天室语气'),
          pack?.chat || Object.hasOwn(packDrafts, 'chatVoice') ? h(React.Fragment, null,
            h('textarea', { style: { ...inputStyle, minHeight: '90px', resize: 'vertical' }, disabled: presetBusy,
              'aria-label': '聊天室语气', value: draftValue('chatVoice', (pack.chat?.voice ?? pack.voice ?? []).join('\n')),
              onChange: event => setDraft('chatVoice', event.target.value), onBlur: event => savePackField('chatVoice', event.target.value) }),
            chatExamplesPreview(pack.chat),
            sourcePreview(pack.chat, pack.identity, pack.voice),
            pack.chat?.source ? h(React.Fragment, null,
              h('label', { style: toggleRowStyle }, h('input', { type: 'checkbox', 'aria-label': '聊天室参考原始人设',
                checked: chatSourceActive(pack.chat, pack.identity, pack.voice), disabled: presetBusy || Object.hasOwn(packDrafts, 'chatReset')
                  || !chatSourceCanBind(pack.identity, pack.chat.voice ?? pack.voice ?? []),
                onChange: event => savePackField('chatSource', event.target.checked ? 'use' : 'skip') }), '聊天时参考原始人设'),
              pack.chat.source.enabled && !chatSourceActive(pack.chat, pack.identity, pack.voice)
                ? h('button', { type: 'button', style: toggleStyle, disabled: presetBusy || Object.hasOwn(packDrafts, 'chatReset'),
                  onClick: () => savePackField('chatSource', 'skip') }, '停用这份原始参考') : null,
              h('p', { style: hintStyle }, '修改身份或聊天室语气会暂停旧参考；重新勾选时，按当前已保存的身份和语气启用。原文保留，可随时查看。')) : null,
            pack.chat?.source && !chatSourceCanBind(pack.identity, pack.chat.voice ?? pack.voice ?? [])
              ? h('p', { style: hintStyle }, '重新启用需要身份摘要在4000字内、有效聊天语气最多8条且每条400字；请调整后再启用，原始材料仍保留。') : null,
            h('p', { style: hintStyle }, '这里单独用于聊天，不改变转述语气。最多8条，每条400字。恢复基础表达会移除独立语气、示例和原始参考。'),
            h('button', { type: 'button', style: toggleStyle, disabled: presetBusy,
              onClick: () => savePackField('chatReset', 'inherit') }, '恢复基础表达并清除聊天示例'))
            : h(React.Fragment, null, h('span', { style: hintStyle }, '尚未单独设置；自定义人格沿用基础语感，内置人格使用自己的聊天材料。'),
              h('button', { type: 'button', style: toggleStyle, disabled: presetBusy,
                onClick: () => savePackField('chatVoice', (pack?.voice ?? []).join('\n')) }, '从基础语感设置聊天表达'))),

        h('div', { className: 'dsh-persona-editor-field', style: fieldStyle },
          h('span', { style: labelStyle }, '子代理称呼'),
          h('input', {
            style: inputStyle,
            disabled: presetBusy,
            'aria-label': '子代理称呼',
            value: draftValue('subagent', pack?.address?.subagent ?? ''),
            onChange: (event) => setDraft('subagent', event.target.value),
            onBlur: (event) => savePackField('subagent', event.target.value),
          }),
        ),
        h('div', { className: 'dsh-persona-editor-field', style: fieldStyle },
          h('span', { style: labelStyle }, '发言关系'),
          h('select', { style: inputStyle, disabled: presetBusy, 'aria-label': '发言关系',
            value: draftValue('narrationMode', pack?.narration?.mode ?? 'voice'),
            onChange: (e) => savePackField('narrationMode', e.target.value) },
            h('option', { value: 'voice' }, '用角色口吻重述'), h('option', { value: 'relay' }, '转达另一位助手的工作')),
          h('span', { style: hintStyle }, '小肥鱼（实验性）使用转达模式；切换角色不会改变实际工作的助手。')),
        (draftValue('narrationMode', pack?.narration?.mode ?? 'voice') === 'relay')
          ? h('div', { className: 'dsh-persona-editor-field', style: fieldStyle },
            h('span', { style: labelStyle }, '称呼原助手为'),
            h('input', { style: inputStyle, disabled: presetBusy, maxLength: 20, 'aria-label': '原助手称呼',
              value: draftValue('narrationAssistant', pack?.narration?.assistant ?? '原助手'),
              onChange: (e) => setDraft('narrationAssistant', e.target.value),
              onBlur: (e) => savePackField('narrationAssistant', e.target.value) })) : null);
      const catalogueFailure=message=>h('div',{style:hintStyle,role:'status'},h('p',null,message),h('button',{type:'button',style:toggleStyle,onClick:()=>setCatalogueRetry(value=>value+1)},'重新读取模型目录'));
      const providerFailure=providersFailed?catalogueFailure('模型提供方列表暂时无法读取，已保存选择仍保留。'):null;
      const modelControls = h('div', { className: 'dsh-persona-model-fields' },providerFailure, h('div', { className: 'dsh-persona-setting-field', style: fieldStyle },
          h('span', { style: labelStyle }, '改写所用模型'),
          h('select', {
            style: inputStyle,
            'aria-label': '改写所用模型', value: settings?.provider ?? '',
            onChange: (event) => save({ provider: event.target.value, model: '' }),
          },
          h('option', { value: '' }, '跟随会话当前模型'),
          settings.provider&&!providers.some(entry=>entry.provider===settings.provider)?h('option',{value:settings.provider},settings.provider+'（暂未读取）'):null,
          providers.map((entry) => h('option', { key: entry.provider, value: entry.provider }, entry.name ?? entry.provider))),
          h('span', { style: hintStyle }, '留空即跟随当前会话；指定后所有会话都用它改写。'),
          h('span', { style: hintStyle }, settings?.reasoningEffort
            ? `推理强度已指定为 ${settings.reasoningEffort}；模型不支持时回到默认兼容策略。`
            : '改写默认优先关闭思考；模型无法关闭时使用其最低档，能力未知时按提供方默认兼容。失败仍保留原文。'),
        ),

        settings?.provider !== undefined && settings.provider !== ''
          ? h('div', { className: 'dsh-persona-setting-field', style: fieldStyle },
            h('span', { style: labelStyle }, '模型'),
            h('select', {
              style: inputStyle,
              'aria-label': '模型', value: settings.model ?? '',
              onChange: (event) => save({ model: event.target.value }),
            },
            h('option', { value: '' }, '该提供方的默认模型'),
            settings.model&&!models.some(entry=>entry.id===settings.model)?h('option',{value:settings.model},settings.model):null,
            models.map((entry) => h('option', { key: entry.id, value: entry.id }, entry.name))),
          )
          : null,modelsFailed&&!providersFailed?catalogueFailure('模型列表暂时无法读取，已保存选择仍保留。'):null);
      const settingsTabs = [['persona', '人格'], ['rewrite', '转述'], ['chat','聊天室'], ['memory', '记忆'], ['appearance', '外观'], ['usage', '用量'], ['advanced', '高级']];
      const visualizationControls=h('div',null,
        h('label',{style:fieldStyle},h('span',{style:labelStyle},'报告阅读模型'),
          h('select',{style:inputStyle,'aria-label':'报告阅读模型',value:settings.visualizationProvider??'',onChange:event=>save({visualizationProvider:event.target.value,visualizationModel:''})},
            h('option',{value:''},'跟随转述模型（默认）'),
            settings.visualizationProvider&&!providers.some(provider=>provider.provider===settings.visualizationProvider)?h('option',{value:settings.visualizationProvider},settings.visualizationProvider+'（暂不可用）'):null,
            ...providers.map(provider=>h('option',{key:provider.provider,value:provider.provider},provider.name??provider.provider)))),
        settings.visualizationProvider?h('label',{style:fieldStyle},h('span',{style:labelStyle},'模型名称'),
          h('select',{style:inputStyle,'aria-label':'报告阅读模型名称',value:settings.visualizationModel??'',onChange:event=>save({visualizationModel:event.target.value})},
            h('option',{value:''},'该提供方的默认模型'),
            settings.visualizationModel&&!visualizationModels.some(model=>model.id===settings.visualizationModel)?h('option',{value:settings.visualizationModel},settings.visualizationModel):null,
            ...visualizationModels.map(model=>h('option',{key:model.id,value:model.id},model.name??model.id)))):null,
        visualizationModelsFailed&&settings.visualizationProvider&&!providersFailed?catalogueFailure('模型列表暂时无法读取，已保存的选择仍保留。'):null,
        h('label',{style:toggleRowStyle},h('input',{type:'checkbox',checked:settings.visualizationThinking===true,onChange:event=>save({visualizationThinking:event.target.checked})}),h('span',null,'重点分析开启思考')),
        h('p',{style:hintStyle},'重点分析默认关闭思考。导览、展开和阅读主题在本地完成，不再次调用模型。'),
        h('label',{style:toggleRowStyle},h('input',{type:'checkbox',checked:settings.readableThinking!==false,onChange:event=>save({readableThinking:event.target.checked})}),h('span',null,'顺畅阅读开启思考')),
        h('p',{style:hintStyle},'顺畅阅读默认开启，强度采用模型默认档位。只在你确认生成后调用，结果计入报告阅读用量；不影响重点分析或聊天室。'));
      const panel = (id, content) => h('div', { key: id, role: 'tabpanel', id: tabsId.current + '-' + id,
        'aria-labelledby': tabsId.current + '-tab-' + id, hidden: activeTab !== id, 'data-settings-panel': id }, content);
      return h('div', { 'data-persona-shell': 'settings', className: 'dsh-persona-settings' },
        h('style', null, SETTINGS_CSS, SETTINGS_REDESIGN_CSS),
        h('header', { className: 'dsh-persona-settings-hero' },
          h('div', null,
            h('h2', null, '人格套壳'),
            h('p', null, '只换表达，原文随时可查。')),
          h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', minWidth: 0 } },
            h('span', { className: 'dsh-persona-save-state', role: 'status', 'aria-live': 'polite',
              'data-state': /失败/.test(status) ? 'error' : /正在|尚未就绪/.test(status) ? 'pending' : 'saved' }, status || '自动保存'),
            failedSettingsSave ? h('button', { type: 'button', style: toggleStyle, disabled: status === '正在保存…', onClick: () => save({}) }, '重试保存当前设置') : null)),
        h('div', { className: 'dsh-persona-settings-tabs', role: 'tablist', 'aria-label': '设置分类',
          onKeyDown: (event) => {
            if (event.nativeEvent?.isComposing || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const current = settingsTabs.findIndex(([id]) => id === activeTab);
            const index = event.key === 'Home' ? 0 : event.key === 'End' ? settingsTabs.length - 1
              : (current + (event.key === 'ArrowRight' ? 1 : -1) + settingsTabs.length) % settingsTabs.length;
            setActiveTab(settingsTabs[index][0]); event.currentTarget.querySelectorAll('[role=tab]')[index]?.focus();
          } }, ...settingsTabs.map(([id, label]) => h('button', { key: id, type: 'button', role: 'tab',
            id: tabsId.current + '-tab-' + id, 'aria-controls': tabsId.current + '-' + id,
            'aria-selected': activeTab === id, tabIndex: activeTab === id ? 0 : -1, onClick: () => setActiveTab(id) }, label))),
        shippedRendererOk ? null : h('div', { style: warningStyle },
          '独立原文预览暂以纯文本显示，聊天正文仍由官方组件渲染。'),
        rendererState.status === 'incompatible' || rendererState.status === 'error'
          ? h('div', { style: warningStyle, role: 'status' }, '人格显示已暂停，当前保留官方原文。',
            h('details', null, h('summary', null, '查看原因'), rendererState.reason)) : null,
        panel('persona', h('section', { className: 'dsh-persona-section', 'aria-label': '选择人格' },
          settingsHeading('', '默认人格', '用于没有单独指定角色的会话。' + (presets.length > 5 ? ' 共 ' + presets.length + ' 个，可滚动选择。' : '')),
          personaControls,
          h('div', { className: 'dsh-persona-persona-tools' },
            settingsFold('create-persona', '创建新人格', '从你的人设提示词开始', generatorControls,
              { open: generated !== undefined ? true : undefined }),
            settingsFold('edit-persona', '调整当前人格', Object.keys(packDrafts).length
              ? '有尚未保存的输入' : '身份、语气、示例与称呼',
              h('div', null, h('p', { className: 'dsh-persona-section-note' },
                '编辑后自动保存；调整内置人格会另存一份，原版始终保留。'), editorControls))))),
        panel('rewrite', h('section', { className: 'dsh-persona-section', 'aria-label': '日常转述' },
          settingsHeading('', '日常转述', '决定哪些汇报换一种口吻。'),
          h('label', { style: fieldStyle }, h('span', { style: labelStyle }, '默认转述范围'),
            h('select', { style: inputStyle, 'aria-label': '默认转述范围', value: settings.trigger ?? 'step',
              onChange: (e) => save({ trigger: e.target.value }) },
              h('option', { value: 'step' }, '全部汇报'), h('option', { value: 'report' }, '仅最终汇报')),
            h('span', { style: hintStyle }, '聊天顶部可以单独选择人格、范围或安排接力；独立选择的会话不随全局切换。')),
          h('div', { className: 'dsh-persona-process-options', style: { display: 'grid', gap: '16px' } }, colloquialControls, processControls),
          h('div', { className: 'dsh-persona-common-grid' }, reviewControls, quietControls),
          settingsFold('rewrite-help', '这些选项如何工作', '调用用量与原文边界',
            h('div', { className: 'dsh-persona-help-copy' },
              h('p', null, '阶段性输出关闭后跳过带工具调用的步骤。要严格只改最终汇报，请将转述范围设为仅最终汇报。'),
              h('p', null, '过程运行信息仅提供分类统计与轻量会话节奏；可选补充最多40字、每轮最多3条，不进入最终汇报。查询会增加一次模型续接。'),
              h('p', null, '静默播报仅为前台正在查看的主会话生成，标记为 ◈；每轮最多3次，无新事实不重复调用，也不代表任务完成。'),
              h('p', null, '※ 提示措辞、数字或局部状态变化，不保证语义一致。重要事实、条件和风险仍应对照原文。')), { compact: true }))),
        panel('chat',h(React.Fragment,null,h('section',{className:'dsh-persona-section','aria-label':'聊天室模型设置'},
          settingsHeading('','聊天室','默认跟随转述模型，可以单独选择。修改只影响之后的请求。'),
          providerFailure,
          h('label',{style:fieldStyle},h('span',{style:labelStyle},'聊天室模型'),
            h('select',{style:inputStyle,'aria-label':'聊天室模型',value:settings.chatProvider??'',onChange:e=>save({chatProvider:e.target.value,chatModel:''})},
              h('option',{value:''},'跟随转述模型（默认）'),
              settings.chatProvider&&!providers.some(p=>p.provider===settings.chatProvider)?h('option',{value:settings.chatProvider},settings.chatProvider+'（暂不可用）'):null,
              ...providers.map(p=>h('option',{key:p.provider,value:p.provider},p.name??p.provider)))),
          settings.chatProvider?h('label',{style:fieldStyle},h('span',{style:labelStyle},'模型名称'),
            h('select',{style:inputStyle,'aria-label':'聊天室模型名称',value:settings.chatModel??'',onChange:e=>save({chatModel:e.target.value})},
              h('option',{value:''},'该提供方的默认模型'),
              settings.chatModel&&!chatModels.some(m=>m.id===settings.chatModel)?h('option',{value:settings.chatModel},settings.chatModel):null,
              ...chatModels.map(m=>h('option',{key:m.id,value:m.id},m.name??m.id)))):null,
          chatModelsFailed&&settings.chatProvider&&!providersFailed?catalogueFailure('模型列表暂时无法读取，已保存的选择仍保留。'):null,
          h('div',{className:'dsh-persona-process-options',style:{borderBottom:0,paddingBottom:0}},
            h(ChatThinkingControls,{visible:activeTab==='chat',settings,save}))),h(RoomReferencesPanel,{visible:activeTab==='chat'}))),
        panel('memory', h('section', { className: 'dsh-persona-section', 'aria-label': '记忆与约定' },
          settingsHeading('', '记忆与约定', '查看原话依据，确认哪些偏好继续使用。'), h(MemoryPanel, { settings, save, presets }))),
        panel('appearance', h('section', { className: 'dsh-persona-section', 'aria-label': '聊天室外观' },
          settingsHeading('', '聊天室外观', '用户头像只用于展示，不会发送给模型。'),
          (activeTab==='appearance'||appearanceVisited)?h(ChatUserSettings,{visible:activeTab==='appearance'}):null)),
        panel('usage', h(ModelUsagePanel, { visible: activeTab === 'usage' })),
        panel('advanced', h('section', { className: 'dsh-persona-section', 'aria-label': '高级设置' },
          settingsHeading('', '高级设置', '模型与较少使用的选项。'),
          h('div', { className: 'dsh-persona-advanced-grid' },
            h('div', null, h('h3', { className: 'dsh-persona-subheading' }, '转述模型'), modelControls),
            h('div', null, subagentControls),
            h('div', { className: 'dsh-persona-wide' }, thresholdControls)),
          settingsFold('report-visualization-model','报告阅读','按需生成 · 默认跟随转述模型',visualizationControls))),
        h('p', { className: 'dsh-persona-footer-note' }, '转述失败时显示原文。聊天室保留独立记录。'));
    }

    /** A manual read retry never repeats a settings write or revives a closed page. */
    function LoadSettings({ onLoaded }) {
      const [attempt,setAttempt]=React.useState(0),[status,setStatus]=React.useState('loading'),owner=React.useRef(0),loaded=React.useRef(onLoaded);
      loaded.current=onLoaded;
      React.useEffect(() => {
        const readAt=chatThinkingReadAt(),token=++owner.current,abort=new AbortController();let alive=true,timedOut=false;
        const timeout=setTimeout(()=>{timedOut=true;abort.abort();},10000);setStatus('loading');
        (async () => {
          try {
            const response = await fetch(`${ROUTE}/settings`,{signal:abort.signal});
            if(!alive||token!==owner.current||abort.signal.aborted)return;
            if(!response.ok){setStatus(response.status===401||response.status===403?'auth':'error');return;}
            const value = await response.json();
            if(!alive||token!==owner.current||abort.signal.aborted)return;
            // The whole payload, not just `settings`: it also carries the learned
            // memory, and the page renders both from one fetch.
            if(!value?.settings||typeof value.settings!=='object'||Array.isArray(value.settings)){setStatus('error');return;}
            chatThinkingSnapshots.set(value.settings,{readAt});loaded.current(value);
          } catch {if(alive&&token===owner.current&&(!abort.signal.aborted||timedOut))setStatus('error');}
          finally{clearTimeout(timeout);}
        })();
        return()=>{alive=false;owner.current++;clearTimeout(timeout);abort.abort();};
      }, [attempt]);
      return h('div',{'aria-label':'读取插件设置',role:'group'},h('p',{style:hintStyle,role:'status','aria-live':'polite'},status==='loading'?'正在读取设置…'
        :status==='auth'?'设置未能读取。请重新连接 DSH 后重试。':'暂时无法读取设置，请重试。'),
        status!=='loading'?h('button',{type:'button',style:toggleStyle,onClick:()=>setAttempt(value=>value+1)},'重新读取设置'):null);
    }

    return {
      inject: ['slots'],
      /**
       * Rendering decisions, exposed for the offline suite.
       *
       * Pure timing/compatibility decisions plus components for the stateful
       * offline harness. renderMarkdown is only an isolated-preview fallback;
       * the main transcript always delegates to the official assistant.
       */
      __testing: {
        chatLocalUi:{bind:useChatUiNamespace,read:readChatUiStorage,saveDraft:saveChatDraft,restore:restoreChatUi,update:updateChatUi,clear:clearChatUi,storageEvent:chatUiStorageEvent,
          inspect:()=>({namespace:chatUiNamespace,records:[...chatUi],drafts:[...chatDrafts],workDrafts:[...chatWorkDrafts]})},
        createAccountAvatarSource,
        accountAvatarSource,
        ConversationPanel,
        ReportFeedback,
        ReportVisualizationWindow,
        reportReadingRuntime,
        SessionPersonaSwitch,
        WorkInputBridge,
        PersonaChatWindow,
        RoomChatWorkspace,
        RoomAvatar,
        RoomRecipient,
        ChatReplyBubbles,
        ChatThinkingControls,
        ChatUserSettings,
        userAddressProblem,
        chatMessageTime,
        chatDateBoundary,
        chatClientTime,
        chatDirectorIssueReason,
        chatPalette,
        sampleAvatarColor,
        useChatBubbleColors,
        PersonaAvatar,
        CHAT_CSS,
        PersonaChatLauncher,
        MemoryPanel,
        SettingsSection,
        useModelCatalogue,
        roomReferenceHint,
        PersonaAvatarEditor,
        reportFallbackReason,
        rowBranch,
        renderMarkdown,
        resolveChatDelegate,
        displayNode,
        renderOfficial,
        PersonaStep,
        refreshState: refresh,
        watchState: watch,
        getHostState: (sessionId) => states.get(sessionId),
        applyControls,
        getChatRendererState: () => chatRendererState,
        unmaskPartial,
        chatTakeoverEnabled,
        HOLD_PLACEHOLDER_MS,
        STATE_WAIT_MS,
        reviewFingerprint,
        reviewNeeded,
        reviewPlacement,
        ReviewHint,
        ComparisonDialog,
        NativeComparisonModal,
        COMPARISON_NARROW_WIDTH,
        ProgressNotice,
        setProgressEnabled,
        PROGRESS_PREFIX,
      },
      apply(ctx) {
        clientStopped = false;
        // Owned by the plugin lifetime; both are cleared on unload below.
        let heartbeatTimer;
        // Announce this build as soon as the plugin is applied, then keep saying
        // so. The desktop client has no hard reload, so the only way to tell a
        // stale bundle from a broken one is a heartbeat that names the build:
        // without it, "my fix did nothing" and "my fix never loaded" look the
        // same, and that ambiguity cost this plugin several rounds.
        reportDiagnostics({ applied: true, at: Date.now() });
        //
        // Wrapped in try/catch on purpose: diagnostics are a convenience, and a
        // missing timer global must never take the whole plugin down with it.
        try {
          heartbeatTimer = setInterval(() => {
            reportDiagnostics({ heartbeat: Date.now() });
          }, 30000);
          if (typeof heartbeatTimer?.unref === 'function') heartbeatTimer.unref();
        } catch {
          // No timers here; the apply-time report is still enough to prove a load.
        }


        // Keep the official entry (and its child declarations) live. Our entry
        // borrows its inject/locale contract, not its exclusive child ownership.
        let releaseChat = undefined;
        let chatComponent;
        let chatDelegate;
        let rendererFailed = false;
        const rendererSubscriptions = [];
        const releaseChatSlot = () => {
          const release = releaseChat;
          releaseChat = undefined;
          chatDelegate = undefined;
          if (release !== undefined) release();
        };
        refreshChatTakeover = () => {
          if (stopped) return;
          if (!chatTakeoverEnabled(globalEnabled, activeSessionId, sessionOff)) {
            releaseChatSlot();
            rendererFailed = false;
            setChatRendererState('disabled');
            return;
          }
          if (rendererFailed) {
            releaseChatSlot();
            setChatRendererState('error', 'delegate-render-failed');
            return;
          }
          try {
            const delegate = resolveChatDelegate(ctx.slots, chatComponent);
            if (!delegate.ok) {
              releaseChatSlot();
              setChatRendererState('incompatible', delegate.reason);
              return;
            }
            if (chatDelegate?.entry === delegate.entry
              && chatDelegate.children.every((entry, index) => entry === delegate.children[index])) return;
            releaseChatSlot();
            chatComponent = function PersonaDelegate(props) { return h(PersonaStep, { ...props, delegate }); };
            releaseChat = ctx.slots.register({
              name: CHAT_SLOT, key: 'assistant-step', priority: -1,
              locale: delegate.entry.locale, inject: delegate.entry.inject,
            }, chatComponent);
            chatDelegate = delegate;
            setChatRendererState('delegated');
          } catch {
            releaseChatSlot();
            rendererFailed = true;
            setChatRendererState('error', 'delegate-setup-failed');
          }
        };

        // Track the switch. The host is the source of truth.
        //
        // Three rules, each from a real failure:
        //
        // 1. Start NOT taken over. Taking over unconditionally meant that if the
        //    settings request kept failing (403, offline), the plugin stayed
        //    shadowing the shipped renderer forever without ever confirming the
        //    server wanted it. The shipped renderer is the safe default.
        // 2. Only an explicit boolean counts. `enabled !== false` reads a missing
        //    field or a malformed payload as "on".
        // 3. One request at a time. `setInterval` allowed overlap, so a stale
        //    `enabled:true` response could land after a newer `enabled:false` and
        //    re-install the takeover — the switch would flip itself back.
        let stopped = false;
        let syncTimer;
        let inFlightController;

        if (typeof ctx.slots.subscribe === 'function') {
          for (const key of [CHAT_SLOT, ...Object.keys(CHILD_FACTORIES)]) {
            rendererSubscriptions.push(ctx.slots.subscribe(key, () => refreshTakeover()));
          }
        }
        if (typeof ctx.slots.onEntryError === 'function') {
          rendererSubscriptions.push(ctx.slots.onEntryError((key, entry) => {
            const ownCrash = key === CHAT_SLOT && entry.component === chatComponent;
            const factoryCrash = releaseChat !== undefined && Object.values(CHILD_FACTORIES)
              .some((name) => key === `factory:${name}`);
            if (!ownCrash && !factoryCrash) return;
            rendererFailed = true;
            // Leave the failing render/commit before releasing its entry. Do
            // not repeatedly reinstall a component the host just abdicated.
            void Promise.resolve().then(() => refreshTakeover());
          }));
        }

        const scheduleSync = (delay) => {
          if (stopped) return;
          clearTimeout(syncTimer);
          syncTimer = setTimeout(() => { void syncEnabled(); }, delay);
        };

        const syncEnabled = async () => {
          if (stopped) return;
          if (['ready', 'blocked'].includes(stateTransport?.status(''))) {
            refreshTakeover(); stateTransport.restart(); scheduleSync(5000); return;
          }
          const request = ++requestSequence;
          // `AbortController` is a host global, not part of the module sandbox.
          // The guard is not paranoia: when it is missing the whole apply() throws
          // and the plugin never registers anything, which looks exactly like "the
          // plugin is off".
          const controller = typeof AbortController === 'function' ? new AbortController() : undefined;
          inFlightController = controller;
          // A hung request must not stop the sync loop for good.
          const timeout = setTimeout(() => controller?.abort(), 10000);
          try {
            const response = await fetch(`${ROUTE}/settings`, controller === undefined ? undefined : { signal: controller.signal });
            if (stopped) return;
            if (response.ok) {
              const value = await response.json();
              if (stopped) return;
              applyControls(value, request);
            }
          } catch {
            // Keep the last confirmed state; a transient failure is not evidence
            // of a switch change.
          } finally {
            clearTimeout(timeout);
            if (inFlightController === controller) inFlightController = undefined;
          }
          // Factory definitions have no public subscription on SlotRegistry;
          // child-slot changes wake us immediately, this also checks quiet churn.
          refreshTakeover();
          stateTransport?.restart();
          scheduleSync(5000);
        };

        // Everything this controller owns is torn down with the plugin. Native
        // timers are not part of Cordis's scope, so without this every reload left
        // one more poller and one more heartbeat behind.
        const removeTimers = () => {
          stopped = true;
          chatRuntime.dispose();
          reportReadingRuntime.dispose();
          clientStopped = true;
          if (progressViewerSession !== undefined) announceProgressView(undefined);
          progressEnabled = false;
          clearTimeout(syncTimer);
          if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
          if (inFlightController !== undefined) inFlightController.abort();
          for (const entry of stateSubscriptions) { entry.poll?.(); entry.remote?.(); }
          stateSubscriptions.clear();
          const closingTransport = stateTransport;
          stateTransport = undefined;
          // The pollers are not part of the chat slot; a disabled plugin would
          // otherwise keep one 15s request per session alive after its UI was
          // unmounted.
          for (const poller of pollers.values()) poller.stop();
          pollers.clear();
          states.clear();
          hostInstance = undefined;
          retiredInstances.clear();
          instanceRequestFloor = 0;
          controlRevision = -1;
          sessionOff.clear();
          sessionSwitchRev = -1;
          switchReady = false;
          globalEnabled = false;
          activeSessionId = undefined;
          for (const unsubscribe of rendererSubscriptions.splice(0)) unsubscribe();
          releaseChatSlot();
          refreshChatTakeover = () => {};
          branchHistory.clear();
          freshDecided.clear();
          liveSeen.clear();
          diagnosticsTrail.clear();
          setChatRendererState('disabled');
          return closingTransport?.dispose();
        };
        try {
          ctx.effect(() => removeTimers, 'persona-shell.client-timers');
        } catch {
          // No effect scope here; the timers still stop on the next stop().
        }

        // Start the loop; the first response decides whether to take over.
        void syncEnabled();

        // Optional compatibility path: older compositions continue using the
        // authenticated long-poll routes. Official Remote owns transport/auth.
        if (typeof ctx.inject === 'function') ctx.inject(['remote'], (owner) => {
          let gateway;
          try { gateway = require('@deepseek-ai/dsh-api-gateway'); } catch { return; }
          const remote = owner.get('remote');
          if (stopped || stateTransport || typeof remote?.$stream !== 'function'
            || typeof gateway.RemoteSnapshotStream !== 'function') return;
          stateTransport = createClientTransport({ remote, SnapshotStream: gateway.RemoteSnapshotStream,
            CarrierError: gateway.RemoteStreamCarrierError, contribution: createRemoteContract(),
            bindRemote(bind) {
              return owner.inject(['remote', 'remote.personaShell'], (consumer) => {
                bind(consumer.get('remote'));
                consumer.effect(() => () => bind(undefined));
              });
            },
            viewer: progressViewerId, nextRequest: () => ++requestSequence,
            onState(sessionId, value, request) {
              if (stopped || !acceptInstance(value, request)) return false;
              if (sessionId === '') {
                applyControls(value, request);
              } else applyState(sessionId, value);
              return true;
            },
            onStatus(sessionId, status, error) {
              for (const entry of stateSubscriptions) if (entry.sessionId === sessionId) syncSubscription(entry);
              reportDiagnostics({ stateTransport: { status, error: error?.code ?? (error ? 'local-error' : undefined),
                message: typeof error?.message === 'string' ? error.message.slice(0, 160) : undefined } });
            },
          });
          stateTransport.subscribe('');
          for (const entry of stateSubscriptions) entry.remote = stateTransport.subscribe(entry.sessionId);
          if (progressViewerSession !== undefined) stateTransport.setView({ sessionId: progressViewerSession,
            revision: progressViewRevision, visible: typeof document === 'undefined' || document.visibilityState !== 'hidden' });
          void stateTransport.start();
          const transport = stateTransport;
          if (typeof owner.on === 'function') owner.on('connection/reset', () => transport.restart());
          owner.effect(() => () => {
            if (stateTransport === transport) {
              stateTransport = undefined;
              for (const entry of stateSubscriptions) { entry.remote = undefined; syncSubscription(entry); }
            }
            return transport.dispose();
          });
        });

        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'persona-shell',
          order: 30,
          label: '人格套壳',
        }, SettingsSection));

        // Optional: hosts without the account API simply show user bubbles.
        if (typeof ctx.inject === 'function') ctx.inject(['remote', 'remote.account'], (owner) => {
          const remote = owner.get('remote');
          if (typeof remote?.account?.getProfile !== 'function' || typeof remote?.account?.getState !== 'function') return;
          const release = accountAvatarSource.bind(remote, () => ({ version: 'dsh-persona-shell/0.5.2',
            locale: typeof navigator !== 'undefined' ? navigator.language : 'zh-CN', timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60 }));
          owner.effect(() => release);
          if (typeof owner.on === 'function') owner.on('connection/reset', () => { void accountAvatarSource.refresh(); });
        });

        // One switch per Session, in the header's right-aligned utilities.
        // It also tells the page-wide takeover which Session is on screen.
        ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
          name: 'conversation.session.header.utilities',
          id: 'persona-shell',
          order: 10,
        }, SessionPersonaSwitch));

        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
          name: 'conversation.input.dock', id: 'persona-shell-progress', order: 30, locale: 'dsh-persona-shell',
        }, ProgressNotice));
      },
    };
  },
});

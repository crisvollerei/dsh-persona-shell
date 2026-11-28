// SECTION usage
    const USAGE_SECTIONS = [
      { label: '工作转述', keys: ['rewrite', 'progress'], tone: 'rewrite' },
      { label: '报告阅读', keys: ['report-visualization'], tone: 'visualization' },
      { label: '聊天室', keys: ['chat', 'chat-context-selection', 'chat-participation', 'chat-support-research', 'chat-support-reason', 'chat-support-summarize', 'reply-suggestions', 'chat-draft'], tone: 'chat' },
      { label: '其他功能', keys: ['preset', 'persona-preview', 'memory'], tone: 'other' },
    ];
    const USAGE_NAMES = { rewrite: '汇报改写', progress: '静默播报', 'report-visualization':'报告阅读', chat: '角色发言',
      'chat-support-research':'调查资料', 'chat-support-reason':'深入推演', 'chat-support-summarize':'整理工作参考', 'chat-context-selection':'轮次规划', 'chat-participation': '调度判断', 'reply-suggestions': '快捷回复', 'chat-draft':'指令整理', preset: '预设生成','persona-preview':'人格试说', memory: '记忆提取' };
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
        data?.chatTiming&&Object.values(data.chatTiming.paths).some(r=>r.count>0)?h('section',{style:{overflowX:'auto'}},h('h4',null,'聊天室响应（最近 200 轮）'),
          h('table',null,h('thead',null,h('tr',null,...['路径','轮数','首字 P50','首字 P90','完成 P50','平均调用'].map(n=>h('th',{key:n},n)))),
            h('tbody',null,...Object.entries(data.chatTiming.paths).map(([path,r])=>h('tr',{key:path},...[{direct:'单人直答',directed:'定向首答',director:'经判断',context:'筛选工作参考',support:'带辅助任务'}[path],r.count,
              ...[r.firstText.p50,r.firstText.p90,r.done.p50].map(n=>n==null?'—':(n/1000).toFixed(1)+' s'),r.avgCalls?.toFixed(1)??'—'].map((v,i)=>h('td',{key:i},v)))))),
          h('p',{style:hintStyle},'有效样本不足 5 轮时隐藏分位数。失败与取消 '+data.chatTiming.failed+' 轮计入轮数，延迟与平均调用仅统计成功轮次。')):null,
        data?.totals.calls ? summary() : h('div', { className: 'mu-notice', role: 'status' },
          h('strong', null, state === 'error' ? '暂时读不到用量' : data ? '这段时间还没有调用记录' : '正在读取用量…'),
          h('p', null, state === 'error' ? '可以点击刷新重试。' : data ? '从启用统计后的第一次模型调用开始记录，也可以切换时段查看。' : '')));
    }

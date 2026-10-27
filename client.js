window.__ModuleLoader__.load({
  id: '@local/dsh-persona-shell',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const ROUTE = '/persona-shell';

    /**
     * Bumped whenever the client changes shape.
     *
     * Sent on load and on the first render, so "is the page running the code I
     * just installed?" is answerable instead of assumed. A stale bundle and a
     * broken one look identical otherwise.
     */
    const CLIENT_BUILD = 20241027;

    // --- host data -----------------------------------------------------------

    /** sessionId → newest state payload from the host half. */
    const states = new Map();
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
    /** `${sessionId}:${seq}` → the branch sequence, capped. */
    const diagnosticsTrail = new Map();
    const listeners = new Set();
    /** `${sessionId}` → poll handle, so several steps share one timer. */
    const pollers = new Map();

    function emit() {
      for (const listener of listeners) listener();
    }

    async function refresh(sessionId) {
      try {
        const response = await fetch(`${ROUTE}/state?session=${encodeURIComponent(sessionId)}`);
        if (!response.ok) {
          // Only failures are reported. A rejected fetch is the difference
          // between "no data yet" and "the route refuses this request", and it
          // is the one case with no other symptom — the transcript just stays
          // plain. Successes would be a write per poll for no extra insight.
          reportDiagnostics({ lastFetchError: { status: response.status, at: Date.now() } });
          return;
        }
        const value = await response.json();
        const previous = states.get(sessionId);
        states.set(sessionId, value);
        if (previous === undefined || previous.rev !== value.rev) emit();
      } catch (error) {
        reportDiagnostics({
          lastFetchError: { error: error instanceof Error ? error.message : String(error), at: Date.now() },
        });
      }
    }

    /**
     * Keep one session's rewrites fresh.
     *
     * One poller per session, tracking **every** seq that asked for it. The first
     * version captured a single seq at creation and kept it forever: once that
     * row settled the cadence fell to the slow tail interval, so every later
     * rewrite in the same session completed between two polls and appeared as one
     * jump — indistinguishable from having no streaming at all.
     *
     * The poller stops itself once nothing is watching it, so a long session does
     * not leave a timer running forever.
     */
    function watch(sessionId, seq) {
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
        const startedAt = Date.now();

        /** Schedule the next poll, never creating a second timer. */
        const schedule = (delay) => {
          if (stopped) return;
          if (inFlight) {
            // A request is running; remember the request to poll again as soon as
            // it returns rather than starting a second one.
            wakePending = true;
            return;
          }
          if (timer !== undefined) clearTimeout(timer);
          timer = setTimeout(tick, delay);
        };

        const tick = async () => {
          timer = undefined;
          if (stopped) return;
          if (watched.size === 0) {
            // Nothing needs this session any more; release the poller.
            stopped = true;
            pollers.delete(key);
            return;
          }
          inFlight = true;
          try {
            await refresh(sessionId);
          } finally {
            inFlight = false;
          }
          if (stopped) return;
          const rows = states.get(sessionId)?.rows ?? [];
          // Anything still owing keeps the eager cadence: a new step starts
          // owing, and the slow interval must not resume just because an older
          // row already settled.
          const owe = [...watched.keys()].some((candidate) => {
            const row = rows.find((entry) => entry.seq === candidate);
            return row === undefined || row.status === 'pending';
          });
          const waited = Date.now() - startedAt;
          const interval = owe ? (waited < 8000 ? 100 : 300) : 6000;
          if (wakePending) {
            wakePending = false;
            schedule(0);
            return;
          }
          schedule(interval);
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
            // A newly watched row must not wait behind an existing slow timer:
            // its rewrite may finish entirely before the next 6s poll.
            schedule(0);
            let released = false;
            return () => {
              if (released) return;
              released = true;
              const remaining = (watched.get(candidate) ?? 1) - 1;
              if (remaining <= 0) watched.delete(candidate);
              else watched.set(candidate, remaining);
            };
          },
        };
        pollers.set(key, poller);
      }
      const release = poller.add(seq);
      return release;
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
        const stop = usableSessionId(sessionId) ? watch(sessionId, seq) : () => {};
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
     * Empty-string injection below keeps the arrival order honest; the lookup
     * itself is tried lazily so a missing module degrades to the local renderer
     * rather than a blank row.
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
     * If the module table ever stops carrying `MarkdownText`, the row degrades
     * to plain preformatted text — visibly wrong, cheap to maintain — and the
     * settings page shows a warning. Fidelity is the shipped component's job.
     * @param {string} text
     * @returns {any}
     */
    function renderMarkdown(text) {
      const MarkdownText = shippedMarkdownText();
      if (MarkdownText !== undefined) {
        return h(MarkdownText, { text, labels: MARKDOWN_LABELS });
      }
      return h('div', { style: PLAIN_FALLBACK_STYLE }, text);
    }

    // --- components ----------------------------------------------------------

    const personaBodyStyle = {
      color: 'var(--dsw-alias-label-primary)',
      fontSize: 'inherit',
      lineHeight: 'inherit',
    };
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
    /**
     * Side-by-side comparison.
     *
     * When the original is revealed it sits to the LEFT of the rewrite, both in
     * equal columns. A stacked layout below the text forces the eye to travel
     * away from what it is comparing; two columns let the same line be read
     * twice without moving.
     *
     * `auto-fit` with a 320px floor is what makes this collapse: below roughly
     * 660px of chat width the second column no longer fits and the grid falls
     * back to one column, because two half-width columns of technical prose are
     * unreadable. No media query, so it follows the chat column rather than the
     * window.
     */
    const compareRowStyle = {
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
      gap: '14px',
      alignItems: 'start',
    };
    const originalPaneStyle = {
      minWidth: 0,
      paddingInlineEnd: '14px',
      borderInlineEnd: '0.5px solid var(--dsw-alias-border-l1)',
      color: 'var(--dsw-alias-label-secondary)',
    };
    const personaPaneStyle = { minWidth: 0 };
    const paneLabelStyle = {
      marginBottom: '4px',
      fontSize: '11px',
      lineHeight: '16px',
      letterSpacing: '0.04em',
      textTransform: 'uppercase',
      color: 'var(--dsw-alias-label-tertiary)',
    };

    /**
     * Placeholder while the rewrite is in flight.
     *
     * Deliberately quiet and the same height as one line of body text, so the
     * layout does not jump when the real text lands. It is a waiting state, not
     * a message: nothing the reader might start parsing.
     */
    const placeholderStyle = {
      color: 'var(--dsw-alias-label-tertiary)',
      fontSize: 'inherit',
      lineHeight: 'inherit',
      minHeight: 'calc(24px + var(--dsh-content-font-delta, 0px))',
      letterSpacing: '0.12em',
    };

    /** Text of one assistant step, in the order the blocks carry it. */
    function textOf(data) {
      const blocks = data?.blocks ?? [];
      return blocks
        .filter((block) => block !== undefined && block.kind === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n')
        .trim();
    }

    /** Whether this step carries anything the persona view cannot reproduce. */
    function hasNonText(data) {
      const blocks = data?.blocks ?? [];
      return blocks.some((block) => block !== undefined
        && block.kind !== 'text' && block.kind !== 'reasoning' && block.kind !== 'tool-call');
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
    function rowBranch(row, conceded, fresh = false) {
      if (row !== undefined && row.status === 'ready' && typeof row.text === 'string' && row.text !== '') {
        return 'persona';
      }
      // Streaming text arrived before the row settled: show it growing rather
      // than a placeholder that says nothing.
      if (row !== undefined && typeof row.partial === 'string' && row.partial !== '') {
        return 'streaming';
      }
      // A rewrite that already failed will never arrive, so the report is the
      // honest answer immediately.
      if (row !== undefined && row.status !== 'pending') return 'plain';
      // A pending row is the only case where text is genuinely on its way.
      if (row !== undefined) return conceded ? 'plain' : 'placeholder';
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

    /**
     * Persona body for one settled step.
     *
     * The rewrite is asynchronous, so a freshly settled step has no persona text
     * for a moment. Rendering the plain report in that window is what produced
     * the visible "text appears, then swaps" flicker: the reader starts reading
     * one version and finishes another.
     *
     * Rows that stream or carry non-text blocks return `null` so the shipped
     * renderer keeps them; everything else goes through {@link rowBranch}.
     * @returns the persona block, or `null` to let the shipped renderer render.
     */
    function PersonaStep(props) {
      const { node, sessionId, t, groupPart } = props;
      const data = node?.data;
      const finalNode = data?.finalNode;
      const seq = finalNode?.seq;
      const status = data?.status;
      const original = textOf(data);
      const { state } = useHostState(sessionId, seq);
      const [openOriginal, setOpenOriginal] = React.useState(false);
      const [conceded, setConceded] = React.useState(false);

      // The shipped chat renders the same assistant node twice, and `groupPart`
      // selects which blocks belong to which pass:
      //
      //   groupPart === 'reasoning' → only `reasoning` blocks
      //   groupPart === 'response'  → everything except `reasoning`
      //
      // This entry replaces `AssistantNodeView` wholesale, so the reasoning pass
      // is *not* handed back to the shipped component — returning `null` simply
      // renders nothing for it. That is a deliberate, documented loss: showing the
      // reasoning correctly would mean reimplementing `ProcessReasoning` and
      // `ReasoningRow`, which is the "copy the shipped renderer" work this project
      // decided against. Without this guard the answer appeared inside the
      // thinking pane as well, which was strictly worse than showing nothing.
      if (groupPart === 'reasoning') return null;

      // The hold window must measure the wait for a rewrite, not the lifetime of
      // this component. The shipped chat keeps one instance across
      // running → settled, so a timer started at mount had already expired by the
      // time the step settled — the row conceded immediately and showed the plain
      // report, then swapped to the persona when the rewrite landed. That is the
      // flash this whole mechanism exists to prevent.
      const settled = status === 'settled';
      React.useEffect(() => {
        if (!settled || conceded) return undefined;
        const timer = setTimeout(() => setConceded(true), HOLD_PLACEHOLDER_MS);
        return () => clearTimeout(timer);
      }, [settled, conceded]);

      if (status === 'running' || status === 'interrupted') return null;
      if (seq === undefined || original === '') return null;
      // Images or unknown blocks: the shipped renderer owns this row.
      if (hasNonText(data)) return null;

      const row = state?.rows?.find((candidate) => candidate.seq === seq);
      // Whether this step is new, decided ONCE and remembered.
      //
      // Every derived answer flips as `state` arrives — `seq > newestKnown` was
      // false while state was undefined and true a moment later, so the row
      // re-rendered `plain → placeholder → plain → placeholder` within 9ms. That
      // oscillation is the flash this whole mechanism exists to prevent, so the
      // answer is latched the first time the step is seen.
      //
      // "New" means: the page already had this session's state, and this row was
      // not in it. That is precisely a step that just arrived and whose rewrite is
      // being computed now. A row present in the first state the page ever got is
      // history — nothing is coming for it, so it renders at once.
      const key = rowKey(sessionId, seq);
      if (!freshDecided.has(key) && state !== undefined) {
        freshDecided.set(key, row === undefined);
      }
      const fresh = freshDecided.get(key) === true;
      const branch = rowBranch(row, conceded, fresh);
      // Record the first branch a row takes, and any change after it. "Plain
      // first, persona later" is a visible flash, and this is the only way to see
      // whether it came from a placeholder timeout, a transient skipped row, or a
      // second render with different data.
      const previousBranch = branchHistory.get(key);
      if (previousBranch !== branch) {
        branchHistory.set(key, branch);
        const trace = diagnosticsTrail.get(key) ?? [];
        trace.push({ branch, at: Date.now() });
        diagnosticsTrail.set(key, trace.slice(-4));
        if (trace.length <= 4) {
          reportDiagnostics({ branchTrail: { [key]: trace } });
        }
      }

      if (branch === 'placeholder') {
        return h('div', null, h('div', { style: placeholderStyle }, placeholderText(t)));
      }
      if (branch === 'plain') {
        return h('div', { style: personaBodyStyle }, renderMarkdown(original));
      }
      if (branch === 'streaming') {
        // No badge and no toggle yet: what is on screen is a rewrite still being
        // written, and offering "原文" against half a sentence would be noise.
        // No caret either — the shipped renderer never draws one, and the text
        // already grows visibly as chunks land.
        return h('div', { style: personaBodyStyle },
          renderMarkdown(unmaskPartial(row.partial, row.partialLiterals)),
        );
      }

      const showOriginal = openOriginal ? (t?.('shell.hideOriginal') ?? 'Hide original') : (t?.('shell.showOriginal') ?? 'Original');

      // Mid-turn narration is short and frequent; a badge and a toggle on every
      // one turns the transcript into a wall of chrome. The control appears only
      // on the step that ends the turn, which is the one worth comparing — the
      // others still get the persona text, just without being labelled.
      const showHeader = row.final === true;

      return h('div', { style: personaBodyStyle },
        showHeader
          ? h('div', { style: headerStyle },
            h('span', { style: badgeStyle }, 'persona'),
            h('button', {
              type: 'button',
              style: toggleStyle,
              onClick: () => setOpenOriginal((value) => !value),
            }, showOriginal),
          )
          : null,
        h('div', { style: openOriginal ? compareRowStyle : undefined },
          // The original sits to the LEFT of the rewrite when revealed: the two
          // are read against each other line by line, so a stacked layout below
          // the text forces the eye to scroll away from what it is comparing.
          openOriginal
            ? h('div', { style: originalPaneStyle },
              h('div', { style: paneLabelStyle }, t?.('shell.originalLabel') ?? '原文'),
              renderMarkdown(original))
            : null,
          h('div', { style: openOriginal ? personaPaneStyle : undefined },
            openOriginal ? h('div', { style: paneLabelStyle }, t?.('shell.personaLabel') ?? '人格版') : null,
            renderMarkdown(row.text)),
        ),
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
    /** Box listing what long-term memory currently claims. */
    const memoryBoxStyle = {
      margin: '8px 0 0',
      padding: '8px 10px',
      borderRadius: '6px',
      border: '0.5px solid var(--dsw-alias-border-l1)',
      background: 'var(--dsw-alias-bg-layer-2)',
      fontSize: '12px',
      lineHeight: '1.6',
      color: 'var(--dsw-alias-label-secondary)',
    };
    const memoryLineStyle = { color: 'var(--dsw-alias-label-primary)' };
    /** Preset list rows: one line each, actions pushed to the right. */
    const presetListStyle = {
      margin: '8px 0 0',
      border: '0.5px solid var(--dsw-alias-border-l1)',
      borderRadius: '6px',
      overflow: 'hidden',
    };
    const presetRowStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      padding: '7px 10px',
      fontSize: '12px',
      borderBottom: '0.5px solid var(--dsw-alias-border-l1)',
    };
    const presetNameStyle = { color: 'var(--dsw-alias-label-primary)' };
    const presetTagStyle = {
      fontSize: '10px',
      padding: '0 5px',
      borderRadius: '4px',
      background: 'var(--dsw-alias-bg-layer-2)',
      color: 'var(--dsw-alias-label-tertiary)',
    };
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
    const hintStyle = { fontSize: '11.5px', color: 'var(--dsw-alias-label-secondary)', lineHeight: '1.5' };
    const sectionTitleStyle = { margin: '0 0 12px', fontSize: '15px', fontWeight: '600' };

    async function postSettings(patch) {
      try {
        const response = await fetch(`${ROUTE}/settings`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(patch),
        });
        if (!response.ok) return undefined;
        return await response.json();
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
    function SettingsSection() {
      const [settings, setSettings] = React.useState(undefined);
      const [providers, setProviders] = React.useState([]);
      const [models, setModels] = React.useState([]);
      const [status, setStatus] = React.useState('');
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
      const [presetStatus, setPresetStatus] = React.useState('');
      /** Name the user chose for a freshly generated preset. */
      const [generatedName, setGeneratedName] = React.useState('');
      /** Preset id being renamed, if the inline editor is open. */
      const [renaming, setRenaming] = React.useState(undefined);
      const [renameValue, setRenameValue] = React.useState('');

      React.useEffect(() => {
        let cancelled = false;
        (async () => {
          try {
            const response = await fetch(`${ROUTE}/models`);
            if (!response.ok) return;
            const value = await response.json();
            if (!cancelled) setProviders(value.providers ?? []);
          } catch { /* ignore */ }
        })();
        return () => { cancelled = true; };
      }, []);

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
          try {
            const response = await fetch(`${ROUTE}/presets`);
            if (!response.ok) return;
            value = await response.json();
          } catch {
            return;
          }
        }
        const list = Array.isArray(value?.presets) ? value.presets : [];
        setPresets(list);
        const activeName = typeof value?.active === 'string' ? value.active : '';
        setActivePresetName(activeName);
        const match = list.find((preset) => preset.name === activeName);
        setActivePresetId(match !== undefined ? match.id : '');
      };

      React.useEffect(() => { void refreshPresets(); }, []);

      const presetAction = async (body) => {
        const result = await postPreset(body);
        if (result?.ok === true) {
          // The whole reply: it carries both the list and which preset is now
          // active, and the selection must move with it or the button looks dead.
          await refreshPresets({ presets: result.presets, active: result.active });
          if (result.settings !== undefined) setSettings(result.settings);
          setPresetStatus('');
        } else {
          setPresetStatus(`失败：${result?.reason ?? '未知原因'}`);
        }
        return result;
      };

      const generatePreset = async () => {
        setGenerating(true);
        setPresetStatus('正在读取人设…');
        setGenerated(undefined);
        setGeneratedName('');
        const result = await postPreset({ action: 'generate', prompt: personaPrompt });
        setGenerating(false);
        if (result?.ok === true) {
          setGenerated(result.preset);
          // Seeded from the generated suggestion, but editable: it is a starting
          // point, not the user's decision.
          setGeneratedName(result.preset?.name ?? '');
          setPresetStatus('已生成，确认后保存');
        } else {
          setPresetStatus(`生成失败：${result?.reason ?? '未知原因'}`);
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

      React.useEffect(() => {
        if (settings?.provider === undefined || settings.provider === '') { setModels([]); return; }
        let cancelled = false;
        (async () => {
          try {
            const response = await fetch(`${ROUTE}/models?provider=${encodeURIComponent(settings.provider)}`);
            if (!response.ok) return;
            const value = await response.json();
            if (!cancelled) setModels(value.models ?? []);
          } catch { /* ignore */ }
        })();
        return () => { cancelled = true; };
      }, [settings?.provider]);

      const pack = settings?.pack;

      const save = async (patch) => {
        const result = await postSettings(patch);
        if (result?.settings !== undefined) {
          setSettings(result.settings);
          // Saving can change the learned profile (a clear resets it), so the
          // memory panel refreshes from the same response rather than going stale.
          if (Array.isArray(result.memory)) setMemoryLines(result.memory);
          if (result.memoryStats !== undefined) setMemoryStats(result.memoryStats);
          // Editing the card writes back into a preset — or forks one from the
          // builtin — so the list and the selection both move with it.
          if (Array.isArray(result.presets)) {
            await refreshPresets({ presets: result.presets, active: result.settings.presetName });
          }
          setStatus('已保存');
          setTimeout(() => setStatus(''), 1500);
        } else {
          setStatus('保存失败');
        }
      };

      if (settings === undefined) {
        return h('div', null,
          h('h2', { style: sectionTitleStyle }, '人格套壳'),
          h('div', { style: hintStyle }, '正在读取设置…'),
          h(LoadSettings, {
            onLoaded: (value) => {
              setSettings(value.settings);
              setMemoryLines(Array.isArray(value.memory) ? value.memory : []);
              setMemoryStats(value.memoryStats);
            },
          }),
        );
      }

      return h('div', null,
        h('h2', { style: sectionTitleStyle }, '人格套壳'),
        h('div', { style: hintStyle },
          '在系统提示词之外，为每条助手汇报套一层人格化转述。原汇报始终可查，套壳失败时自动保留原文。',
        ),
        // The transcript already shows the degradation; this explains it where
        // the reader can act on it. Silence here would send them hunting.
        shippedRendererOk
          ? null
          : h('div', { style: warningStyle },
            '官方 Markdown 渲染器不可用，汇报目前显示为纯文本（没有高亮、公式和脚注）。',
          ),
        h('div', { style: { height: '14px' } }),

        h('div', { style: fieldStyle },
          h('label', { style: toggleRowStyle },
            h('input', {
              type: 'checkbox',
              checked: settings?.includeToolSteps !== false,
              onChange: (event) => save({ includeToolSteps: event.target.checked }),
            }),
            h('span', { style: labelStyle }, '同时改写阶段性输出'),
          ),
          h('span', { style: hintStyle },
            '开启后，带工具调用的中间步骤（"现在改常量…"这类叙述）也会套壳；'
            + '关掉则只改写每轮最终的汇报，中间步骤保持原样。',
          ),
        ),

        h('div', { style: { height: '6px' } }),

        // --- subagent conversations -------------------------------------------
        // Two switches, not one: a helper's progress chatter and its conclusion
        // are read by different people at different times.
        h('div', { style: fieldStyle },
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
        ),

        h('div', { style: { height: '6px' } }),

        // --- long-term memory ------------------------------------------------
        h('div', { style: fieldStyle },
          h('label', { style: toggleRowStyle },
            h('input', {
              type: 'checkbox',
              checked: settings?.memory !== false,
              onChange: (event) => save({ memory: event.target.checked }),
            }),
            h('span', { style: labelStyle }, '记住我的习惯'),
          ),
          h('span', { style: hintStyle },
            '跨会话统计你的提问语言、称呼方式和句子长短，用来微调套壳语气。'
            + '只保存计数，不保存你说过的话。',
          ),
          memoryLines && memoryLines.length > 0
            ? h('div', { style: memoryBoxStyle },
              h('div', { style: { ...labelStyle, marginBottom: '4px' } }, '目前学到的'),
              ...memoryLines.map((line, index) => h('div', { key: index, style: memoryLineStyle }, `· ${line}`)),
              memoryStats !== undefined
                ? h('div', { style: { ...hintStyle, marginTop: '6px' } },
                  `基于 ${memoryStats.messages} 条消息`
                  + (memoryStats.meanSentence > 0 ? `，平均每句 ${memoryStats.meanSentence} 字` : ''),
                )
                : null,
            )
            : h('div', { style: hintStyle }, '还没有足够的样本，继续聊天就会开始学习。'),
          h('div', { style: { marginTop: '6px' } },
            h('button', {
              type: 'button',
              style: toggleStyle,
              onClick: () => save({ clearMemory: true }),
            }, '清空记忆'),
          ),
        ),

        h('div', { style: { height: '6px' } }),

        // --- persona presets --------------------------------------------------
        h('div', { style: fieldStyle },
          h('span', { style: labelStyle }, '人设预设'),
          h('span', { style: hintStyle }, '当前：' + (activePresetName ?? '大肥鱼（默认）')),
          // Say where edits go before they are made: an edit to the builtin
          // forks a new preset, and that is surprising if it is not announced.
          h('span', { style: hintStyle },
            '下面编辑的人格卡会保存到当前预设；编辑内置预设时会自动另存为一个新预设。',
          ),

          presets && presets.length > 0
            ? h('div', { style: presetListStyle },
              ...presets.map((preset) => h('div', {
                key: preset.id,
                style: presetRowStyle,
              },
              h('span', {
                style: {
                  ...presetNameStyle,
                  fontWeight: preset.id === activePresetId ? '600' : '400',
                },
              }, preset.name),
              preset.builtin === true
                ? h('span', { style: presetTagStyle }, '内置')
                : null,
              h('div', { style: { display: 'flex', gap: '10px', marginLeft: 'auto' } },
                preset.id === activePresetId
                  ? null
                  : h('button', {
                    type: 'button',
                    style: toggleStyle,
                    onClick: () => presetAction({ action: 'apply', id: preset.id }),
                  }, '启用'),
                preset.builtin === true
                  ? null
                  : h('button', {
                    type: 'button',
                    style: toggleStyle,
                    onClick: () => startRename(preset),
                  }, '改名'),
                preset.builtin === true
                  ? null
                  : h('button', {
                    type: 'button',
                    style: { ...toggleStyle, color: 'var(--dsw-alias-label-tertiary)' },
                    onClick: () => presetAction({ action: 'delete', id: preset.id }),
                  }, '删除'),
              ))),
            )
            : null,

          // Inline rename: a dialog would be heavier than the operation, and the
          // page already has the preset in hand.
          renaming !== undefined
            ? h('div', { style: { ...presetPreviewStyle, display: 'flex', gap: '8px', alignItems: 'center' } },
              h('input', {
                style: { ...inputStyle, flex: 1 },
                value: renameValue,
                onChange: (event) => setRenameValue(event.target.value),
                onKeyDown: (event) => { if (event.key === 'Enter') commitRename(); },
              }),
              h('button', { type: 'button', style: primaryButtonStyle, onClick: commitRename }, '保存'),
              h('button', {
                type: 'button',
                style: toggleStyle,
                onClick: () => { setRenaming(undefined); setRenameValue(''); },
              }, '取消'),
            )
            : null,
        ),

        h('div', { style: fieldStyle },
          h('span', { style: labelStyle }, '从人设提示词生成预设'),
          h('span', { style: hintStyle },
            '把你写的人设提示词整段粘进来，会提取出「说话风格」，丢掉外貌和背景故事——'
            + '因为这里只需要知道怎么把汇报换种口气讲。生成后可以先预览再保存。',
          ),
          h('textarea', {
            style: { ...inputStyle, minHeight: '88px', resize: 'vertical' },
            placeholder: '粘贴人设提示词…',
            value: personaPrompt,
            onChange: (event) => setPersonaPrompt(event.target.value),
          }),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', marginTop: '6px' } },
            h('button', {
              type: 'button',
              style: primaryButtonStyle,
              disabled: generating || personaPrompt.trim().length < 20,
              onClick: () => generatePreset(),
            }, generating ? '生成中…' : '生成预设'),
            presetStatus !== '' ? h('span', { style: hintStyle }, presetStatus) : null,
          ),
          generated !== undefined
            ? h('div', { style: presetPreviewStyle },
              h('div', { style: { ...labelStyle, marginBottom: '4px' } }, '预览'),
              // The generated name is a suggestion, not a decision: the user
              // names their own presets.
              h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' } },
                h('span', { style: labelStyle }, '名称'),
                h('input', {
                  style: { ...inputStyle, flex: 1 },
                  value: generatedName,
                  placeholder: '给这个预设起个名字',
                  onChange: (event) => setGeneratedName(event.target.value),
                }),
              ),
              h('div', { style: { ...memoryLineStyle, marginTop: '4px' } }, `身份：${generated.identity ?? ''}`),
              (generated.report ?? []).length > 0
                ? h('div', { style: { ...memoryLineStyle, marginTop: '4px' } },
                  `汇报规则：${generated.report.join(' ／ ')}`)
                : null,
              (generated.samples ?? []).length > 0
                ? h('div', { style: { ...memoryLineStyle, marginTop: '4px' } },
                  `示例：${generated.samples.join(' ／ ')}`)
                : null,
              h('div', { style: { display: 'flex', gap: '10px', marginTop: '8px' } },
                h('button', {
                  type: 'button',
                  style: primaryButtonStyle,
                  disabled: generatedName.trim() === '',
                  onClick: () => {
                    presetAction({
                      action: 'save',
                      name: generatedName.trim(),
                      pack: generated,
                      source: personaPrompt,
                    });
                    setGenerated(undefined);
                    setGeneratedName('');
                  },
                }, '保存并启用'),
                h('button', {
                  type: 'button',
                  style: toggleStyle,
                  onClick: () => { setGenerated(undefined); setPresetStatus(''); },
                }, '丢弃'),
              ),
            )
            : null,
        ),

        h('div', { style: { height: '6px' } }),

        h('div', { style: fieldStyle },
          h('span', { style: labelStyle }, '身份'),
          h('textarea', {
            style: { ...inputStyle, minHeight: '56px', resize: 'vertical' },
            value: pack?.identity ?? '',
            onChange: (event) => setSettings({
              ...settings, pack: { ...pack, identity: event.target.value },
            }),
            onBlur: (event) => save({ pack: { ...pack, identity: event.target.value } }),
          }),
        ),

        h('div', { style: fieldStyle },
          h('span', { style: labelStyle }, '汇报里的说话规则（每行一条）'),
          h('textarea', {
            style: { ...inputStyle, minHeight: '76px', resize: 'vertical' },
            value: (pack?.report ?? []).join('\n'),
            onChange: (event) => setSettings({
              ...settings, pack: { ...pack, report: event.target.value.split('\n') },
            }),
            onBlur: (event) => save({ pack: { ...pack, report: event.target.value.split('\n').filter((line) => line.trim() !== '') } }),
          }),
        ),

        h('div', { style: fieldStyle },
          h('span', { style: labelStyle }, '通用语感（每行一条）'),
          h('textarea', {
            style: { ...inputStyle, minHeight: '76px', resize: 'vertical' },
            value: (pack?.voice ?? []).join('\n'),
            onChange: (event) => setSettings({
              ...settings, pack: { ...pack, voice: event.target.value.split('\n') },
            }),
            onBlur: (event) => save({ pack: { ...pack, voice: event.target.value.split('\n').filter((line) => line.trim() !== '') } }),
          }),
        ),

        h('div', { style: fieldStyle },
          h('span', { style: labelStyle }, '语气示例（每行一条）'),
          h('textarea', {
            style: { ...inputStyle, minHeight: '56px', resize: 'vertical' },
            value: (pack?.samples ?? []).join('\n'),
            onChange: (event) => setSettings({
              ...settings, pack: { ...pack, samples: event.target.value.split('\n') },
            }),
            onBlur: (event) => save({ pack: { ...pack, samples: event.target.value.split('\n').filter((line) => line.trim() !== '') } }),
          }),
        ),

        h('div', { style: fieldStyle },
          h('span', { style: labelStyle }, '避免出现（每行一条）'),
          h('textarea', {
            style: { ...inputStyle, minHeight: '56px', resize: 'vertical' },
            value: (pack?.avoid ?? []).join('\n'),
            onChange: (event) => setSettings({
              ...settings, pack: { ...pack, avoid: event.target.value.split('\n') },
            }),
            onBlur: (event) => save({ pack: { ...pack, avoid: event.target.value.split('\n').filter((line) => line.trim() !== '') } }),
          }),
        ),

        h('div', { style: fieldStyle },
          h('span', { style: labelStyle }, '子代理称呼'),
          h('input', {
            style: inputStyle,
            value: pack?.address?.subagent ?? '',
            onChange: (event) => setSettings({
              ...settings,
              pack: { ...pack, address: { ...(pack?.address ?? {}), subagent: event.target.value } },
            }),
            onBlur: (event) => save({
              pack: { ...pack, address: { ...(pack?.address ?? {}), subagent: event.target.value } },
            }),
          }),
        ),

        h('div', { style: fieldStyle },
          h('span', { style: labelStyle }, '改写所用模型'),
          h('select', {
            style: inputStyle,
            value: settings?.provider ?? '',
            onChange: (event) => save({ provider: event.target.value, model: '' }),
          },
          h('option', { value: '' }, '跟随会话当前模型'),
          providers.map((entry) => h('option', { key: entry.provider, value: entry.provider }, entry.name ?? entry.provider))),
          h('span', { style: hintStyle }, '留空即跟随当前会话；指定后所有会话都用它改写。'),
        ),

        settings?.provider !== undefined && settings.provider !== ''
          ? h('div', { style: fieldStyle },
            h('span', { style: labelStyle }, '模型'),
            h('select', {
              style: inputStyle,
              value: settings.model ?? '',
              onChange: (event) => save({ model: event.target.value }),
            },
            h('option', { value: '' }, '该提供方的默认模型'),
            models.map((entry) => h('option', { key: entry.id, value: entry.id }, entry.name))),
          )
          : null,

        status === '' ? null : h('div', { style: { ...hintStyle, color: 'var(--dsw-alias-brand-primary)' } }, status),
      );
    }

    /** Loads settings once, from any session the host knows. */
    function LoadSettings({ onLoaded }) {
      React.useEffect(() => {
        (async () => {
          try {
            const response = await fetch(`${ROUTE}/settings`);
            if (!response.ok) return;
            const value = await response.json();
            // The whole payload, not just `settings`: it also carries the learned
            // memory, and the page renders both from one fetch.
            if (value?.settings !== undefined) onLoaded(value);
          } catch { /* ignore */ }
        })();
      }, []);
      return null;
    }

    return {
      inject: ['slots'],
      /**
       * Rendering decisions, exposed for the offline suite.
       *
       * `rowBranch` is the whole flicker policy: which body a settled row shows
       * while its rewrite is still in flight. `renderMarkdown` is the body
       * renderer itself. A mocked React cannot replay a fetch-then-rerender
       * cycle, so the decisions are tested directly instead of through a mount.
       */
      __testing: { rowBranch, renderMarkdown, unmaskPartial, HOLD_PLACEHOLDER_MS },
      apply(ctx) {
        // Announce this build as soon as the plugin is applied, then keep saying
        // so. The desktop client has no hard reload, so the only way to tell a
        // stale bundle from a broken one is a heartbeat that names the build:
        // without it, "my fix did nothing" and "my fix never loaded" look the
        // same, and that ambiguity cost this plugin several rounds.
        reportDiagnostics({ applied: true, at: Date.now() });
        // Heartbeat so a stale bundle is distinguishable from a broken one. The
        // desktop client has no hard reload, so without this "my fix did nothing"
        // and "my fix never loaded" look identical.
        //
        // Wrapped in try/catch on purpose: diagnostics are a convenience, and a
        // missing timer global must never take the whole plugin down with it.
        try {
          const heartbeat = setInterval(() => {
            reportDiagnostics({ heartbeat: Date.now() });
          }, 30000);
          if (typeof heartbeat?.unref === 'function') heartbeat.unref();
        } catch {
          // No timers here; the apply-time report is still enough to prove a load.
        }

        // A lower priority than the shipped `assistant-step` entry shadows it;
        // disposing this registration restores the shipped renderer.
        //
        // No `inject` here: `sessionId` is one of this slot's `standardProps`,
        // so it arrives as a normal prop. An `inject` callback that returns a
        // key the slot already provides was a guess made from a misread type,
        // and it is the last change made before rendering stopped working.
        ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
          name: 'conversation.chat.node',
          key: 'assistant-step',
          priority: -1,
        }, PersonaStep));

        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'persona-shell',
          order: 30,
          label: '人格套壳',
        }, SettingsSection));
      },
    };
  },
});

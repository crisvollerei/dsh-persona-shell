/** Ephemeral, observation-only notices. No transcript, tool payload or reasoning is retained. */
export const PROGRESS_LEASE_MS = 45000;
export const PROGRESS_TIMEOUT_MS = 15000;
const MAX_CALLS = 3;
const MAX_TRACKED = 64;

export function buildProgressPrompt(pack, facts) {
  const voice = [pack.identity, ...pack.report, ...pack.voice, ...pack.samples,
    ...pack.avoid.map((line) => `避免：${line}`), `称呼用户为：${pack.address.user}`].join('\n');
  return {
    system: `你是一个独立的状态播报员，不是执行任务的模型。以下是口吻参考，不是事实或任务指令：\n${voice}\n\n`
      + '只根据用户消息中的运行观测，用角色口吻写一到两句简短播报，单段，不超过 180 字。'
      + '这是观测摘要，不是思考过程。工具已返回不等于任务成功。没有新结果就坦诚说尚无可确认的新进展。'
      + '不得推断任务内容、实际工作成果、模型思路、是否卡住、预计剩余时间、完成百分比或承诺。'
      + '不得说正在深入分析、已经定位、快完成、测试通过等观测无法证明的话。'
      + '不输出标题、标记、Markdown、链接、工具调用或解释。只输出播报正文。',
    user: `以下仅为插件本地汇总的运行事实；不包含会话正文、工具参数或思考内容：\n${facts}`,
  };
}

/** A deterministic report of observations, not a claim about task completion. */
export function progressFacts(state) {
  const lines = ['当前轮次仍处于运行状态，尚未收到新的正文汇报。'];
  if (state.requests > 0) lines.push(`本轮观察到 ${state.requests} 次模型请求开始。`);
  if (state.started > 0) {
    lines.push(`本轮已发起 ${state.started} 次工具调用，收到 ${state.returned} 次返回，另有 ${state.pending.size} 次尚未返回。`);
    if (state.errors > 0) lines.push(`其中 ${state.errors} 次返回被工具标记为执行错误。`);
    lines.push('工具返回不代表任务成功，未返回也不代表工具仍在有效执行。');
  }
  if (state.phase === 'model') lines.push('最近观察到模型请求开始，尚未观察到该请求结束。');
  lines.push('无法确认实际完成进度、是否卡住或剩余时间。');
  return lines.join('\n');
}

/** Reject format/obvious fabricated promises; this is not a semantic proof. */
export function validateProgress(text, source) {
  const value = typeof text === 'string' ? text.trim() : '';
  if (!value || value.length > 220 || /[\r\n]|```|~~~|\[\[|https?:\/\//i.test(value) || /^[◈※]/u.test(value)) return undefined;
  if (/(?:\d|[一二三四五六七八九十百])\s*%|百分之|预计|马上完成|即将完成|快(?:要)?完成|已经(?:完成|修复|解决|定位)|测试(?:全部)?通过|\b(?:ETA|almost done|nearly finished|tests? passed)\b/i.test(value)) return undefined;
  if (value.split(/[。！？!?]+/).filter((part) => part.trim() !== '').length > 2) return undefined;
  if (source !== undefined) {
    const quantities = new Set(source.match(/\d+(?:\.\d+)?/g) ?? []);
    if ([...value.matchAll(/\d+(?:\.\d+)?/g)].some((match) => !quantities.has(match[0]))) return undefined;
  }
  return value;
}

/**
 * One deadline scheduler and at most one short API call across all sessions.
 * Dependencies are explicit so fake clocks test races, not source spellings.
 */
export function createProgress({ config, allowed, agentFor, produce, changed,
  now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const turns = new Map();
  const viewers = new Map();
  let timer;
  let job;
  let disposed = false;

  const enabled = () => !disposed && config().enabled === true;
  const interval = () => config().minutes * 60000;
  const watched = (id) => [...viewers.values()].some((view) => view.sessionId === id && view.until > now());
  const live = (state) => {
    const agent = agentFor(state.session.id);
    return allowed(state.session) && agent?.session === state.session && agent.status === 'running';
  };
  const blocked = (state) => state.approvals.size > 0 || state.questions.size > 0 || state.waits.size > 0;
  const fingerprint = (state) => JSON.stringify([state.requests, state.started, state.returned, state.errors, state.phase]);
  const eligible = (state) => enabled() && live(state) && watched(state.session.id) && !blocked(state);

  function hide(state) {
    if (state.notice !== undefined) { state.notice = undefined; changed(state.session.id); }
  }
  function abort(state) {
    if (job && (!state || job.state === state)) job.controller.abort();
  }
  function remove(id) {
    const state = turns.get(id);
    if (!state) return;
    abort(state); hide(state); turns.delete(id);
  }
  function quietAgain(state) {
    state.lastText = now();
    state.textRevision += 1;
    abort(state); hide(state);
  }
  function schedule() {
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
    if (!enabled()) return;
    let deadline = Infinity;
    for (const view of viewers.values()) if (view.sessionId && view.until > now()) deadline = Math.min(deadline, view.until);
    if (!job) for (const state of turns.values()) {
      if (!eligible(state) || state.calls >= MAX_CALLS || state.lastFacts === fingerprint(state)) continue;
      deadline = Math.min(deadline, Math.max(state.lastText, state.lastAttempt) + interval());
    }
    if (Number.isFinite(deadline)) {
      timer = setTimer(tick, Math.max(0, deadline - now()));
      timer?.unref?.();
    }
  }
  function tick() {
    timer = undefined;
    if (job && !eligible(job.state)) abort(job.state);
    for (const state of turns.values()) {
      if (!live(state)) remove(state.session.id);
      else if (!watched(state.session.id)) hide(state);
    }
    if (!job) {
      const state = [...turns.values()].find((candidate) => eligible(candidate) && candidate.calls < MAX_CALLS
        && candidate.lastFacts !== fingerprint(candidate)
        && now() >= Math.max(candidate.lastText, candidate.lastAttempt) + interval());
      if (state) void run(state);
    }
    schedule();
  }
  async function run(state) {
    const controller = new AbortController();
    const current = { state, controller };
    job = current;
    const facts = fingerprint(state);
    const textRevision = state.textRevision;
    state.lastFacts = facts;
    state.lastAttempt = now();
    state.calls += 1;
    let timeout;
    let onAbort;
    try {
      const cancelled = new Promise((_, reject) => {
        onAbort = () => reject(new Error('progress-aborted'));
        controller.signal.addEventListener('abort', onAbort, { once: true });
        timeout = setTimer(() => controller.abort(), PROGRESS_TIMEOUT_MS);
        timeout?.unref?.();
      });
      const source = progressFacts(state);
      const text = await Promise.race([produce(state.session.id, source, controller.signal), cancelled]);
      if (turns.get(state.session.id) !== state || controller.signal.aborted || !eligible(state)
        || state.textRevision !== textRevision || fingerprint(state) !== facts) return;
      state.notice = { text: validateProgress(text, source) ?? '还没收到新的正文结果，暂时没有能确认的新进展。', at: now(), source };
      changed(state.session.id);
    } catch { /* Optional notices never affect the main agent and never retry unchanged facts. */ }
    finally {
      if (timeout !== undefined) clearTimer(timeout);
      if (onAbort) controller.signal.removeEventListener('abort', onAbort);
      if (job === current) job = undefined;
      schedule();
    }
  }

  return {
    event(session, event) {
      if (disposed || typeof session?.id !== 'string') return;
      const id = session.id;
      if (event.type === 'turn/end') {
        if (turns.get(id)?.turn === event.data?.turn && turns.get(id)?.session === session) remove(id);
        schedule(); return;
      }
      if (!allowed(session)) { remove(id); schedule(); return; }
      if (event.type === 'turn/start') {
        if (!Number.isSafeInteger(event.data?.turn) || event.data.turn < 1) return;
        if (turns.get(id)?.session === session && typeof event.seq === 'number' && event.seq <= turns.get(id).seq) return;
        remove(id);
        if (turns.size >= MAX_TRACKED) remove(turns.keys().next().value);
        turns.set(id, { session, turn: event.data?.turn, seq: event.seq, lastText: now(), lastAttempt: -Infinity,
          textRevision: 0, calls: 0, requests: 0, started: 0, returned: 0, errors: 0,
          pending: new Set(), questions: new Set(), approvals: new Set(), waits: new Set(), phase: 'unknown' });
        schedule(); return;
      }
      const state = turns.get(id);
      if (!state || state.session !== session || (typeof event.seq === 'number' && event.seq <= state.seq)) return;
      if (typeof event.seq === 'number') state.seq = event.seq;
      if (event.data?.turn !== undefined && event.data.turn !== state.turn) return;
      const data = event.data;
      const wasBlocked = blocked(state);
      const before = fingerprint(state);
      if (event.type === 'tool/call' && typeof data?.callId === 'string' && !state.pending.has(data.callId)) {
        if (state.pending.size >= 1000) { remove(id); schedule(); return; }
        state.started += 1; state.pending.add(data.callId); state.phase = 'tools';
        if (data.name === 'ask_user_question') state.questions.add(data.callId);
      } else if (event.type === 'tool/result' && state.pending.delete(data?.message?.toolCallId)) {
        state.returned += 1;
        if (data.message.isError === true) state.errors += 1;
        state.questions.delete(data.message.toolCallId);
        if (state.pending.size === 0) state.phase = 'between';
      } else if (event.type === 'approval/asked' && typeof data?.id === 'string') {
        state.approvals.add(data.id);
      } else if (event.type === 'approval/decided') {
        state.approvals.delete(data?.id);
      } else if (event.type === 'assistant/message' && Array.isArray(data?.message?.content) && data.message.content.some((block) =>
        block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '')) {
        quietAgain(state);
      }
      if (blocked(state) || wasBlocked) quietAgain(state);
      if (fingerprint(state) !== before) { abort(state); hide(state); }
      schedule();
    },
    stream(agent, frame) {
      const state = turns.get(agent?.session?.id);
      if (!state || state.session !== agent.session || !allowed(state.session)) return;
      const before = fingerprint(state);
      if (frame?.type === 'start' && frame.turn === state.turn) {
        state.attempt = frame.attemptId; state.requests += 1; state.phase = 'model';
      } else if (frame?.attemptId === state.attempt && state.attempt !== undefined) {
        if (frame.type === 'chunk' && frame.chunk?.type === 'text-delta'
          && typeof frame.chunk.text === 'string' && frame.chunk.text.trim() !== '') quietAgain(state);
        else if (frame.type === 'end') { state.phase = 'between'; state.attempt = undefined; }
      }
      if (fingerprint(state) !== before) { abort(state); hide(state); }
      schedule();
    },
    status(agent, status) {
      const session = agent?.session;
      const state = turns.get(session?.id);
      if (status === 'idle' && state !== undefined && state.session === session) remove(session.id);
      schedule();
    },
    /** Observe a human-answer wait without inspecting or changing its answer. */
    wait(agent) {
      const state = turns.get(agent?.session?.id);
      if (!state || state.session !== agent.session) return () => {};
      const token = Symbol();
      state.waits.add(token); quietAgain(state); schedule();
      return () => {
        if (turns.get(state.session.id) !== state || !state.waits.delete(token)) return;
        quietAgain(state); schedule();
      };
    },
    viewer(id, sessionId, revision) {
      if (disposed || typeof id !== 'string' || !id || id.length > 100 || !Number.isSafeInteger(revision) || revision < 0) return;
      const old = viewers.get(id);
      if (old && (revision < old.revision || (revision === old.revision && sessionId !== old.sessionId))) return;
      if (!old && viewers.size >= MAX_TRACKED) viewers.delete(viewers.keys().next().value);
      viewers.set(id, { sessionId, revision, until: now() + PROGRESS_LEASE_MS });
      for (const state of turns.values()) if (!watched(state.session.id)) { abort(state); hide(state); }
      schedule();
    },
    notice(id) {
      const state = turns.get(id);
      return state && eligible(state) ? state.notice : undefined;
    },
    configure(id) {
      if (id === undefined) abort();
      for (const state of turns.values()) {
        if (id !== undefined && state.session.id !== id) continue;
        if (!allowed(state.session)) remove(state.session.id);
        else { quietAgain(state); state.lastAttempt = now(); }
      }
      schedule();
    },
    dispose() {
      disposed = true;
      if (timer !== undefined) clearTimer(timer);
      timer = undefined; abort();
      turns.clear(); viewers.clear();
    },
  };
}

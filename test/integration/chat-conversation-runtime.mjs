import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  fixture,
  newRoom,
  roomSend,
  roomState,
  whale,
  dragon,
  readChatInput,
  reply
} from '../helpers/persona-chat-host.mjs';

const { values } = parseArgs({
  options: { live: { type: 'boolean' }, deps: { type: 'string' }, transcript: { type: 'boolean' } }
});
const little = '鲸鲸（实验性）';
const scenarios = [
  {
    name: 'duo',
    members: [whale, dragon],
    targets: [],
    support: false,
    lines: ['今天路过烘焙店，闻起来像有人把整条街烤成了面包。', '那我先去买一块，等我回来再聊。']
  },
  {
    name: 'trio',
    members: [whale, little, dragon],
    targets: [whale],
    support: true,
    lines: ['给那家街角烘焙店起个外号吧，随口说一个。', '你觉得小肥鱼怎么样？']
  }
];

async function liveProvider() {
  assert.ok(values.deps, '--live requires --deps <DSH SDK package.json>');
  const require = createRequire(resolve(values.deps));
  const load = (name) => import(pathToFileURL(require.resolve('@deepseek-ai/' + name)));
  const [{ Context }, { LlmRuntime }, { LocalCredentialProvider }, provider] = await Promise.all(
    ['cordis', 'dsh-llm', 'dsh-credentials-local', 'dsh-llm-deepseek-api-key'].map(load)
  );
  const ctx = new Context();
  try {
    await ctx.plugin(LocalCredentialProvider, { watch: false });
    assert.ok(
      (await ctx.get('credentials').describe('DEEPSEEK_API_KEY')).configured,
      'DSH DeepSeek API key is not configured'
    );
    await ctx.plugin(LlmRuntime);
    await ctx.plugin(provider, { thinking: 'disabled' });
    return { llm: ctx.get('llm'), close: () => ctx.fiber.dispose() };
  } catch (error) {
    await ctx.fiber.dispose();
    throw error;
  }
}

function controlledDirector(input, scenario) {
  const spoken = input.events.filter((e) => e.author.role === 'assistant');
  const allowSecond =
    scenario.name === 'duo' ? input.message === scenario.lines[0] : input.message === scenario.lines[1];
  const speakers = allowSecond ? [whale, scenario.name === 'trio' ? little : dragon] : [whale];
  const id = speakers[spoken.length];
  const to = spoken.length && scenario.name === 'duo' ? whale : 'user';
  const choice = input.choices.find((c) => c.id === id && c.to === to && c.kind === 'normal');
  if (id) assert.ok(choice, 'controlled speaker must have a real offered opportunity');
  const wire = !choice
    ? 'WAIT'
    : input.phase === 'followup'
      ? choice.choiceId
      : `${choice.choiceId} N ${input.sceneCatalog?.options.find((s) => s.key === 'K')?.key ?? input.sceneCatalog?.options[0]?.key ?? '-'} react | 接住当前这句话。`;
  return (async function* () {
    yield { type: 'text-delta', text: wire };
    yield { type: 'finish', reason: { kind: 'stop' } };
  })();
}

async function runScenario(scenario, live) {
  const inspected = [];
  const route = live
    ? { provider: 'deepseek-official', model: process.env.DSH_TEST_MODEL ?? 'deepseek-flash' }
    : {};
  function stream(options) {
    const input = readChatInput(options);
    const trace = { options, input, wire: '' };
    inspected.push(trace);
    if (live)
      return (async function* () {
        for await (const chunk of await live.llm.stream(options)) {
          if (input.task === 'chat-room-director' && chunk.type === 'text-delta') trace.wire += chunk.text;
          yield chunk;
        }
      })();
    if (input.task === 'chat-room-director') return controlledDirector(input, scenario);
    assert.equal(input.task, 'chat-control');
    return reply([`${input.speaker.name}的第${inspected.length}句合成原话。`]);
  }
  const f = fixture(
    { after() {} },
    {
      config: { ...route, timeoutMs: 60000, chatThinking: false, chatDeepReasoningEnabled: scenario.support },
      runtime: { chatIntervalMs: live ? 1200 : 0 },
      script: stream,
      directorScript: stream,
      ...(live
        ? {
            listModels: (...args) => live.llm.listModels(...args),
            modelInfo: (...args) => live.llm.resolveModelInfo(...args)
          }
        : {})
    }
  );
  try {
    await f.ready();
    const room = await newRoom(f, scenario.members);
    const detached = await f.request('chat-context', {
      action: 'detach',
      ...room,
      sessionId: 'work',
      revision: Number(room.contextKey.split(':').at(-1))
    });
    assert.equal(detached.status, 200);
    room.contextKey = detached.value.id + ':' + detached.value.revision;
    const state = await roomState(f, room);
    assert.equal(
      (
        await f.request('chat-rooms', {
          action: 'update',
          roomId: room.roomId,
          configRevision: state.room.configRevision,
          epoch: state.epoch,
          targetPersonaIds: scenario.targets
        })
      ).status,
      200
    );
    for (const [index, line] of scenario.lines.entries()) {
      const start = inspected.length,
        id = 'sample-' + index;
      assert.equal((await roomSend(f, room, whale, line, id)).status, 200);
      const until = Date.now() + 180000;
      let done;
      do {
        await sleep(25);
        done = await roomState(f, room);
      } while ((done.running || done.queuedInputs?.length) && Date.now() < until);
      assert.ok(!done.running && !done.queuedInputs?.length, 'round exceeded the deadline');
      const current = inspected.slice(start),
        actors = current.filter((v) => v.input.task === 'chat-control'),
        directors = current.filter((v) => v.input.task === 'chat-room-director').map((v) => v.input);
      const turns = done.room.turns.filter((t) => t.messageId === id && t.phase !== 'anchor'),
        ready = turns.filter((t) => t.status === 'ready');
      const own = [];
      for (const { input, options } of actors) {
        const original = done.room.turns
          .filter((t) => t.recipientId === input.speaker.id && t.status === 'ready')
          .flatMap((t) => t.assistant);
        for (const history of options.messages.filter((m) => m.role === 'assistant'))
          for (const block of history.content) {
            assert.ok(
              original.includes(block.text),
              'own model history must contain the exact saved original'
            );
            own.push(block.text);
          }
      }
      const labels = ready
        .flatMap((t) => t.assistant)
        .filter((v) => /【(?:本人|同伴|用户)[^】]* e\d+\.\d+】/u.test(v));
      const row = {
        scenario: scenario.name,
        round: index + 1,
        supportEnabled: scenario.support,
        actor: actors.length,
        director: directors.length,
        support: current.filter((v) => v.input.task === 'chat-support').length,
        openingWithHelpers: directors.filter((d) => d.phase === 'opening' && d.supportChoices?.length).length,
        compact: directors.filter((d) => d.phase === 'followup' && d.sourceKeys === undefined).length,
        ownHistoryBubbles: own.length,
        labelLeaks: labels.length,
        speakers: ready.map((t) => t.recipientId),
        targets: ready.map((t) => t.responsePlan?.to),
        directorFailure: done.directorFailure?.reason ?? null,
        failed: turns.filter((t) => t.status === 'failed').map((t) => t.failure)
      };
      console.log(JSON.stringify(row));
      if (values.transcript) {
        for (const { input, wire } of current) {
          if (input.task === 'chat-room-director' && live) {
            const choice = input.choices.find((c) => c.choiceId === wire.trim().split(/\s/u)[0]);
            console.log(JSON.stringify({ decision: wire, ...(choice ? { choice } : {}) }));
          } else if (input.task === 'chat-control') {
            console.log(
              JSON.stringify({
                actor: input.speaker.id,
                replyTarget: input.replyTarget,
                scene: input.conversationScene?.relation
              })
            );
          }
        }
        for (const t of ready) console.log(JSON.stringify({ speaker: t.speakerName, bubbles: t.assistant }));
      }
      if (row.directorFailure && values.transcript) {
        const last = current.findLast((trace) => trace.input.task === 'chat-room-director');
        console.log(
          JSON.stringify({
            failedWire: last?.wire,
            choices: last?.input.choices.map((c) => c.choiceId),
            scenes: last?.input.sceneCatalog?.options.map((s) => s.key)
          })
        );
      }
      if (row.directorFailure || row.failed.length || row.labelLeaks) process.exitCode = 1;
      if (!live) {
        assert.deepEqual(
          row.speakers,
          scenario.name === 'duo' && !index
            ? [whale, dragon]
            : scenario.name === 'trio' && index
              ? [whale, little]
              : [whale]
        );
        assert.ok(row.compact > 0, 'the delivered round uses the compact handback');
        assert.equal(row.support, 0);
        if (scenario.support) assert.ok(row.openingWithHelpers > 0);
        if (index) assert.ok(row.ownHistoryBubbles > 0);
      }
    }
  } finally {
    await f.dispose();
  }
}

const live = values.live ? await liveProvider() : null;
try {
  for (const scenario of scenarios) await runScenario(scenario, live);
} finally {
  await live?.close();
}

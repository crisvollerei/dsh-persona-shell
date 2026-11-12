import { createHash } from 'node:crypto';
import { buildDirectorPrompt, parseDirector } from './chat-director.js';
import { contextSelectionFallback } from './chat-coordinator.js';
import { normalizeChatContribution } from './chat-contribution.js';
import { normalizeSceneDirection } from './chat-fiction.js';

const requests = new Set(['answer', 'advice', 'listen', 'open', 'unclear']);
const invalid = reason => ({ context: contextSelectionFallback(), next: null,
  basis: 'invalid', reason, waitForUser: false });

/** Finite references only. No generated quotation, routing object, or JSON on the control path. */
function projection(options) {
  const original = buildDirectorPrompt(options), body = JSON.parse(original.user);
  const sources = body.sources ?? [];
  const evidence = [];
  const message = typeof options.message === 'string' ? options.message : '';
  if (message.trim()) {
    evidence.push({ id: 'q0', start: 0, end: message.length });
    for (const match of message.matchAll(/[^。！？!?\r\n]+[。！？!?]*/gu)) {
      if (evidence.length >= 25) break;
      if (match[0].trim() && match[0].length <= 1600)
        evidence.push({ id: 'q' + evidence.length, start: match.index, end: match.index + match[0].length });
    }
  }
  const ticket = createHash('sha256').update(JSON.stringify([body, evidence])).digest('hex').slice(0, 16);
  return { original, body, sources, evidence, message, ticket };
}

export function buildDirectorRequest(options) {
  const { original, body, sources, evidence, ticket } = projection(options);
  // Keep one semantic brief and replace only the legacy output instructions.
  // The wire protocol does not add another copy of the conversation policy.
  const system = original.system.split('\n').filter(line => !line.startsWith('只输出JSON对象 ')).map(line=>{
    if(line.startsWith('当前这一拍没有合适'))return '当前这一拍没有合适的具体回应时返回 WAIT，choices 为空也可停止。简短回应可以有价值，不用替整场聊天收尾；剩余额度不是任务，不为延长聊天安排互相点名或预编台词。';
    if(line.startsWith('先核对话头留给了谁'))return '先核对话头留给了谁：此刻轮到用户答话、行动或自己决定要不要继续，就返回 WAIT。不需要场上已经有人提问，也不需要等到人人表过态。若有直接邀请留给另一个人，她仍可接。沉默、改题或角色自称已解决不代表用户回答；用户可回应、拒绝、改题或暂停，不需要被催问。只有等某位冷却后还需要核对才用 IDLE。';
    if(line.startsWith('选项kind=normal'))return 'kind=normal 使用普通机会，kind=peer 使用独立同伴机会。peer 选项仍需结合完整语境确认对方真的在叫她、提问或邀请，第三人称提及或引文不选。工作来源与原话位置只从本次给出的选项中选择，不自行生成事实或复制长原话。';
    return line;
  }).join('\n');
  const sceneOptions=body.sceneCatalog?.options??[];
  return { system: system + '\n' + [
    ...(sceneOptions.length?[
      '## 房间话题与转场',
      '同时从 sceneCatalog.options 中原样选择一个 key。fresh 开始当前的新话题；continue 接着对应旧话题或共同活动；pause 按用户明确原话把旧话题暂放，当前请求成为焦点；resume 回到对应旧话题；只提供 K 时复用本用户轮已经确认的现场。目录没有的关系不能自造。',
      '“其他人的看法”通常延续原话题；“算了先不管，和我贴贴”可暂放它；“再说刚才那个风险”可恢复。例子不是本轮事实，不确定时选 fresh。N 只表示不取工作正文，不等于转场；话题关联也不授予来源访问权。',
    ]:[]),
    '## 唯一输出格式（替代上面的 JSON 输出说明）',
    '首行沿用下面的选择协议，不加标签、解释或代码围栏；除可选 SCENE 行外不加其他行。没有必要继续时输出 WAIT；只是在等某位成员冷却、稍后还需核对时输出 IDLE。',
    '需要有人回应时，只输出 choiceId work sceneKey move | point：竖线前四段各用一个空格分隔，竖线后是本次具体小任务。choiceId 原样复制 choices 的完整编号；work 从下面的有限来源选项中选择。',
    sceneOptions.length?'sceneKey 原样复制 sceneCatalog.options 的 key。需要更新现场并停下时仍可输出 WAIT N sceneKey 或 IDLE N sceneKey；无需更新现场时单独 WAIT/IDLE 也有效。'
      :'没有 sceneCatalog.options 时，sceneKey 必须为 -，不能自造话题关系。',
    'move 只选 answer、ask、opine、react、develop、branch、correct；point 为1至180字符，不换行、不含控制字符。',
    'work 选 N 表示明确不取工作正文，U 表示当前无法确定；需要资料就选 sourceKeys 的 key，多个用 + 连接，例如 s1+s2。选择资料只代表参考当前用户原话，不等于求建议、执行许可或任务已完成。',
    'sources 非空时必须判断 work；referenceSelection 只可复用本用户轮已确认的资料选择，不跨新用户轮继承。无 sources 时选 N。',
    '不另输出 request、evidence、goal、contribution 或 action 等JSON字段。选择会绑定当前快照的原话与资格；WAIT/IDLE 不附 move/point。',
    '仅当公开原话明确在共同想象或角色扮演、work=N且选出有效下一位时，可附唯一第二行 SCENE | 短程参考方向；方向1至240字符，不换行、不含控制字符。普通闲聊、问候或工作不必给；WAIT/IDLE或取工作资料时不附。',
    'SCENE只是本次下一位的可选提议，不是场景已成立的事实，不改变sceneKey或来源资格；不预写角色台词、用户动作或结局。用户改题时按新现场重想，不维护永久世界状态。',
  ].join('\n'), user: JSON.stringify({ ...body, protocol: { version: 'D1', ticket },
    sourceKeys: sources.map((source, index) => ({ key: 's' + (index + 1), id: source.id })), userEvidence: evidence }) };
}

export function parseDirectorResponse(wire, options) {
  if (typeof wire !== 'string') return invalid('wire-type');
  if (wire.length > 20000) return invalid('wire-size');
  const trimmed = wire.trim(), fence = /^```(?:json|text|d1)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/iu.exec(trimmed);
  const content = fence ? fence[1].trim() : trimmed;
  // Already-valid old adapters/recorded fixtures retain all original validation.
  // No repair, substring extraction, or partial JSON acceptance is attempted.
  if (content.startsWith('{')) return parseDirector(content, options);
  if(content.includes('|')&&/[\r\n]/u.test(content)){
    // Match the entire extension, not a valid-looking fragment. Retain the raw
    // second line so outer trim cannot hide an invalid trailing tab or control.
    const scene=/^[ \t\r\n]*([^\r\n]+)\r?\nSCENE \| ([^\r\n]*)(?:\r?\n[ \t]*)*$/u.exec(fence?fence[1]:wire);
    if(!scene)return invalid('scene-direction');
    // The unmodified first-line parser owns actor, source, event, eligibility
    // and snapshot checks. Never alter options while recursing: that would
    // create a different choice projection/ticket for this same selection.
    const result=parseDirectorResponse(scene[1],options);
    if(result.basis!=='model')return result;
    if(!result.next||result.context.work!=='not-needed')return invalid('scene-direction-context');
    const sceneDirection=normalizeSceneDirection(scene[2]);
    return sceneDirection?{...result,next:{...result.next,sceneDirection}}:invalid('scene-direction');
  }
  if(content.includes('|')){
    // Outer presentation whitespace/fences remain harmless. The task payload
    // itself is one line; malformed tasks never fall back to an old protocol.
    if(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(content))return invalid('contribution');
    const divider=content.indexOf('|'),header=content.slice(0,divider).trim().split(/ +/u);
    if(header.length!==4)return invalid('control');
    const [choiceId,work,sceneKey,move]=header;
    const contribution=normalizeChatContribution({move,point:content.slice(divider+1).trim()});
    if(!contribution)return invalid('contribution');
    const snapshot=projection(options),hasScene=!!snapshot.body.sceneCatalog?.options?.length;
    if(hasScene?!snapshot.body.sceneCatalog.options.some(option=>option.key===sceneKey):sceneKey!=='-')return invalid('scene');
    if(!snapshot.body.choices.some(choice=>choice.choiceId===choiceId))return invalid('choice');
    // The complete legacy selection still performs every authority, source,
    // author, scope, pending-event and cooldown check. Only then attach a task.
    const result=parseDirectorResponse(`${choiceId} ${work}${hasScene?' '+sceneKey:''}`,options);
    return result.basis==='model'&&result.next
      ?{...result,next:{...result.next,goal:contribution.point,contribution}}:result;
  }
  // K merely refers to the frame already in force. A stop naming that
  // sole frame is the same as a bare stop: no source or scene is selected.
  if(content==='WAIT K'||content==='IDLE K'){
    const catalog=projection(options).body.sceneCatalog,only=catalog?.options;
    if(only?.length!==1||only[0].key!=='K'||only[0].relation!==catalog.current?.relation)return invalid('scene');
    return parseDirectorResponse(content.split(' ')[0],options);
  }
  const words = content.split(/\s+/u);
  if(words.length===2||words.length===3&&words[0]!=='D1'){
    const snapshot=projection(options),choice=snapshot.body.choices.find(value=>value.choiceId===words[0]);
    const stop=words.length===3&&['WAIT','IDLE'].includes(words[0]);
    if(!choice&&!stop)return invalid('choice');
    const sceneKey=words.length===3?words[2]:undefined;
    if(sceneKey!==undefined&&!snapshot.body.sceneCatalog?.options?.some(option=>option.key===sceneKey))return invalid('scene');
    const work=words[1];let kind,sourceIds=[];
    if(work==='N'||work==='U')kind=work==='N'?'not-needed':'unclear';
    else{
      const keys=work.split('+');
      if(!keys.length||keys.length>6||new Set(keys).size!==keys.length
        ||keys.some(key=>!/^s[1-6]$/u.test(key)||!snapshot.sources[Number(key.slice(1))-1]))return invalid('control');
      sourceIds=keys.map(key=>snapshot.sources[Number(key.slice(1))-1].id);kind='required';
    }
    if(kind==='required'&&!snapshot.message.trim())return invalid('evidence');
    const result=parseDirector(JSON.stringify({choiceId:stop?null:choice.choiceId,...(stop?{waitForUser:words[0]==='WAIT'}:{}),
      context:{work:kind,sourceIds,request:'unclear',evidence:kind==='required'?snapshot.message:''}}),options);
    return sceneKey!==undefined&&result.basis==='model'?{...result,sceneKey}:result;
  }
  if(words.length===1){
    const stop=words[0].toUpperCase();
    if(stop==='WAIT'||stop==='IDLE')return parseDirector(JSON.stringify({choiceId:null,waitForUser:stop==='WAIT'}),options);
    // The action ID already binds the actor, source and full public snapshot.
    // Missing auxiliary metadata withholds work rather than inventing intent.
    const snapshot=projection(options),choice=snapshot.body.choices.find(value=>value.choiceId===words[0]);
    return choice?parseDirector(JSON.stringify({choiceId:choice.choiceId}),options):invalid('control');
  }
  // A complete stop with its valid request ticket is also unambiguous. No work
  // permission is accepted from an omitted or partially supplied context.
  if(words.length===3&&words[0]==='D1'&&['WAIT','IDLE'].includes(words[2])){
    if(words[1]!==projection(options).ticket)return invalid('choice');
    return parseDirector(JSON.stringify({choiceId:null,waitForUser:words[2]==='WAIT'}),options);
  }
  if (words.length !== 6 || words[0] !== 'D1') return invalid('control');
  const [, ticket, action, work, request, evidenceId] = words;
  const snapshot = projection(options);
  if (ticket !== snapshot.ticket) return invalid('choice');
  if (!requests.has(request)) return invalid('control');
  const stop = action === 'WAIT' || action === 'IDLE';
  if (!stop && !snapshot.body.choices.some(choice => choice.choiceId === action)) return invalid('choice');
  let sourceIds = [], workKind;
  if (work === 'N' || work === 'U') workKind = work === 'N' ? 'not-needed' : 'unclear';
  else {
    const keys = work.split('+');
    if (!keys.length || keys.length > 6 || new Set(keys).size !== keys.length
      || keys.some(key => !/^s[1-6]$/u.test(key) || !snapshot.sources[Number(key.slice(1)) - 1])) return invalid('control');
    sourceIds = keys.map(key => snapshot.sources[Number(key.slice(1)) - 1].id);
    workKind = 'required';
  }
  const ref = snapshot.evidence.find(item => item.id === evidenceId);
  if (!ref && evidenceId !== '-') return invalid('evidence');
  if (!ref && (workKind === 'required' || ['answer', 'advice', 'listen'].includes(request))) return invalid('evidence');
  const context = { work: workKind, sourceIds, request,
    evidence: ref ? snapshot.message.slice(ref.start, ref.end) : '' };
  return parseDirector(JSON.stringify({ context, choiceId: stop ? null : action,
    ...(action === 'WAIT' ? { waitForUser: true } : {}) }), options);
}

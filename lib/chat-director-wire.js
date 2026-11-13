import { createHash } from 'node:crypto';
import { buildDirectorPrompt, parseDirector } from './chat-director.js';
import { contextSelectionFallback } from './chat-coordinator.js';
import { normalizeChatContribution } from './chat-contribution.js';
import { CHAT_SUPPORT_TEMPLATES,supportGoal } from './chat-support-templates.js';
import { normalizeSceneDirection } from './chat-fiction.js';

const requests = new Set(['answer', 'advice', 'listen', 'open', 'unclear']);
const invalid = reason => ({ context: contextSelectionFallback(), next: null,
  basis: 'invalid', reason, waitForUser: false });

/** Finite references only. No generated quotation, routing object, or JSON on the control path. */
function projection(options) {
  const original = buildDirectorPrompt(options), body = JSON.parse(original.user);
  if(Number.isSafeInteger(options.imageCount)&&options.imageCount>0&&options.imageCount<=3)
    body.userImages={count:options.imageCount,note:'本条用户消息附有图片。这里只选择发言者，图片交给实际回答者查看；不猜图中内容，也不重复追问已在图中的信息。'};
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

/** Compile each allowed helper into a finite, snapshot-bound choice. The model supplies only its question. */
function supportChoices(options,body,ticket){
  const templates=[...new Set(options.supportTemplates??[])].filter(id=>Object.hasOwn(CHAT_SUPPORT_TEMPLATES,id));
  return body.choices.filter(c=>c.kind==='normal'&&c.to==='user').flatMap(choice=>templates.map(template=>({
    choiceId:'h'+createHash('sha256').update(JSON.stringify([ticket,choice.choiceId,template])).digest('hex').slice(0,16),
    id:choice.id,template,replyChoiceId:choice.choiceId,
  })));
}

export function buildDirectorRequest(options) {
  const { original, body, sources, evidence, ticket } = projection(options);
  // Keep one semantic brief and replace only the legacy output instructions.
  // The wire protocol does not add another copy of the conversation policy.
  const system = original.system.split('\n').filter(line => !line.startsWith('只输出JSON对象 ')&&!line.startsWith('request 只分当前请求：')).map(line=>{
    if(line.startsWith('本次需要工作原文才选'))return '本次需要工作原文才从 sourceKeys 选择相关来源，正文可用性由程序核对。闲聊、个人邀请或希望倾听不因接入工作就取正文，work选N；依据不足选U，不确定不等于必须追问。';
    if(line.startsWith('当前这一拍没有合适'))return '当前这一拍没有合适的具体回应时返回 WAIT，choices 为空也可停止。简短回应可以有价值，不用替整场聊天收尾；剩余额度不是任务，不为延长聊天安排互相点名或预编台词。';
    if(line.startsWith('先核对话头留给了谁'))return '先核对话头留给了谁：此刻轮到用户答话、行动或自己决定要不要继续，就返回 WAIT。不需要场上已经有人提问，也不需要等到人人表过态。若有直接邀请留给另一个人，她仍可接。沉默、改题或角色自称已解决不代表用户回答；用户可回应、拒绝、改题或暂停，不需要被催问。只有等某位冷却后还需要核对才用 IDLE。';
    if(line.startsWith('选项kind=normal'))return 'kind=normal 使用普通机会，kind=peer 使用独立同伴机会。peer 选项仍需结合完整语境确认对方真的在叫她、提问或邀请，第三人称提及或引文不选。工作来源与原话位置只从本次给出的选项中选择，不自行生成事实或复制长原话。';
    return line;
  }).join('\n');
  const sceneOptions=body.sceneCatalog?.options??[];
  const helpers=supportChoices(options,body,ticket);
  return { system: system + '\n' + [
    ...(sceneOptions.length?[
      '## 房间话题与转场',
      '同时从 sceneCatalog.options 中原样选择一个 key。fresh 开始当前的新话题；continue 接着对应旧话题或共同活动；pause 按用户明确原话把旧话题暂放，当前请求成为焦点；resume 回到对应旧话题；只提供 K 时复用本用户轮已经确认的现场。目录没有的关系不能自造。',
      '“其他人的看法”通常延续原话题；“算了先不管，和我贴贴”可暂放它；“再说刚才那个风险”可恢复。例子不是本轮事实，不确定时选 fresh。N 只表示不取工作正文，不等于转场；话题关联也不授予来源访问权。',
    ]:[]),
    '## 唯一输出格式（替代上面的 JSON 输出说明）',
    '首行沿用下面的选择协议，不加标签、解释或代码围栏；除本次允许的可选附加行外不加其他行。没有必要继续时输出 WAIT；只是在等某位成员冷却、稍后还需核对时输出 IDLE。',
    '普通接话只输出 choiceId work sceneKey move | point：竖线前四段各用一个空格分隔，竖线后是本次具体小任务。choiceId 原样复制 choices 的完整编号；work 从下面的有限来源选项中选择。辅助任务使用下方的独立选项格式。',
    sceneOptions.length?'sceneKey 原样复制 sceneCatalog.options 的 key。需要更新现场并停下时仍可输出 WAIT N sceneKey 或 IDLE N sceneKey；无需更新现场时单独 WAIT/IDLE 也有效。'
      :'没有 sceneCatalog.options 时，sceneKey 必须为 -，不能自造话题关系。',
    'move 只选 answer、ask、opine、react、develop、branch、correct；point 为1至180字符，不换行、不含控制字符。',
    'work 选 N 表示明确不取工作正文，U 表示当前无法确定；需要资料就选 sourceKeys 的 key，多个用 + 连接，例如 s1+s2。选择资料只代表参考当前用户原话，不等于求建议、执行许可或任务已完成。',
    ...(body.choices.length?[`完整首行示例：${body.choices[0].choiceId} N ${sceneOptions[0]?.key??'-'} react | 接住这句。闲聊也保留 work=N 这一段；实际选项与任务按当前原话决定。`]:[]),
    'sources 非空时必须判断 work；referenceSelection 只可复用本用户轮已确认的资料选择，不跨新用户轮继承。无 sources 时选 N。',
    '不另输出 request、evidence、goal、contribution 或 action 等JSON字段。选择会绑定当前快照的原话与资格；WAIT/IDLE 不附 move/point。',
    '仅当公开原话明确在共同想象或角色扮演、work=N且选出有效下一位时，可附唯一第二行 SCENE | 短程参考方向；方向1至240字符，不换行、不含控制字符。普通闲聊、问候或工作不必给；WAIT/IDLE或取工作资料时不附。',
    ...((options.supportTemplates??[]).length?[
      '本次还提供 supportTemplates。只有确实缺少可公开查询的事实才选 research；资料足够但需要较复杂推理时选 reason。用户自己的感受、偏好、行动和未知图片内容应向用户或实际看图者了解，不外查，不为闲聊/扮演调用。',
      '需要辅助时，从 supportChoices 原样复制一个 choiceId，仅输出 choiceId work sceneKey | 具体资料缺口或推演问题（1至400字符）。模板和回应者已经绑定在选项里，不再填写 move 或另一套任务标签，不附第二行。work 与 sceneKey 仍按原规则选择。没有需要就使用普通 choices，自然接话或等待。',
      ...(helpers.length?[`辅助任务完整示例：${helpers[0].choiceId} N ${sceneOptions[0]?.key??'-'} | 核对当前问题所缺的公开资料。示例格式不代表本轮必须调用辅助任务。`]:[]),
    ]:[]),
    'SCENE只是本次下一位的可选提议，不是场景已成立的事实，不改变sceneKey或来源资格；不预写角色台词、用户动作或结局。用户改题时按新现场重想，不维护永久世界状态。',
  ].join('\n'), user: JSON.stringify({ ...body, protocol: { version: 'D1', ticket },
    ...((options.supportTemplates??[]).length?{supportTemplates:options.supportTemplates.map(id=>CHAT_SUPPORT_TEMPLATES[id]).filter(Boolean)}:{}),
    ...(helpers.length?{supportChoices:helpers.map(({replyChoiceId,...choice})=>choice)}:{}),
    sourceKeys: sources.map((source, index) => ({ key: 's' + (index + 1), id: source.id })), userEvidence: evidence }) };
}

export function parseDirectorResponse(wire, options) {
  if (typeof wire !== 'string') return invalid('wire-type');
  if (wire.length > 20000) return invalid('wire-size');
  const trimmed = wire.trim(), fence = /^```(?:json|text|d1)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/iu.exec(trimmed);
  const content = fence ? fence[1].trim() : trimmed;
  if(/^h[0-9a-f]{16}(?:\s|$)/u.test(content)){
    const match=/^(h[0-9a-f]{16}) ([^ \r\n]+) ([^ \r\n]+) \| ([^\r\n]+)(?:\r?\n[ ]*)*$/u.exec(fence?fence[1]:wire.trimStart());
    if(!match||!supportGoal(match[4]))return invalid('support');
    const snapshot=projection(options),helper=supportChoices(options,snapshot.body,snapshot.ticket).find(c=>c.choiceId===match[1]);
    if(!helper)return invalid('support');
    const hasScene=!!snapshot.body.sceneCatalog?.options?.length;
    if(!hasScene&&match[3]!=='-')return invalid('support');
    const base=parseDirectorResponse(`${helper.replyChoiceId} ${match[2]}${hasScene?' '+match[3]:''}`,options);
    return base.basis==='model'&&base.next?.kind==='normal'&&base.next.to==='user'
      ?{...base,next:{...base.next,support:{template:helper.template,goal:supportGoal(match[4])}}}:invalid('support');
  }
  // Already-valid old adapters/recorded fixtures retain all original validation.
  // No repair, substring extraction, or partial JSON acceptance is attempted.
  if (content.startsWith('{')) return parseDirector(content, options);
  if(/\r?\nHELP /u.test(content)){
    const match=/^([^\r\n]+)\r?\nHELP (research|reason) \| ([^\r\n]+)(?:\r?\n[ ]*)*$/u.exec(fence?fence[1]:wire.trimStart());
    if(!match||!(options.supportTemplates??[]).includes(match[2])||!supportGoal(match[3]))return invalid('support');
    const base=parseDirectorResponse(match[1],options);
    return base.basis==='model'&&base.next?.kind==='normal'&&base.next.to==='user'
      ?{...base,next:{...base.next,support:{template:match[2],goal:supportGoal(match[3])}}}:invalid('support');
  }
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

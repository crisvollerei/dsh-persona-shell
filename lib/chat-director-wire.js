import { createHash } from 'node:crypto';
import { buildDirectorPrompt, parseDirector } from './chat-director.js';
import { contextSelectionFallback } from './chat-coordinator.js';
import { normalizeChatContribution } from './chat-contribution.js';

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
  // The original semantic rules remain; only their free-form output instructions
  // are replaced. Explicit enum names also override incidental JSON examples in
  // the relevance sub-prompt without exposing extra material or making another call.
  const system = original.system.split('\n').filter(line => !line.startsWith('只输出JSON对象 ')).map(line=>{
    if(line.startsWith('当前这一拍没有合适'))return '当前这一拍没有合适的具体回应时返回 WAIT，choices 为空也可停止。简短回应可以有价值，不用替整场聊天收尾；剩余额度不是任务，不为延长聊天安排互相点名或预编台词。';
    if(line.startsWith('先核对话头留给了谁'))return '先核对话头留给了谁：谁已问过、用户后来是否回答、哪些个人邀请还没被接住。确实在等用户回答且无其他合适回应时返回 WAIT；它不表示问题已经讲完。只有等某位冷却后还需要核对才用 IDLE，暂时没话说不必轮询。';
    if(line.startsWith('选项kind=normal'))return 'kind=normal 使用普通机会，kind=peer 使用独立同伴机会。peer 选项仍需结合完整语境确认对方真的在叫她、提问或邀请，第三人称提及或引文不选。工作来源与原话位置只从本次给出的选项中选择，不自行生成事实或复制长原话。';
    return line;
  }).join('\n');
  const sceneOptions=body.sceneCatalog?.options??[];
  return { system: system + '\n' + [
    '## 选择前的最后核对',
    '先判断共同请求现在还欠哪一小步，再选能接住它的合法人选，不先轮流点人。对照 contributions 找到对应的真实公开原话；任务标签只说明先前安排，不保证已经履行、事实成立或用户同意。不要因标签写过总结就认定总结完整，也不要因换人便再安排同一份完整总结、同一个澄清或收尾。',
    '这一拍只安排一个眼下合适的具体任务，不要求该人格答完整个话题。简短赞同、迟疑、局部意见、熟人应声、玩笑和亲自回应邀请都可成立，不必硬找新事实，也不要求每位都对上一个梗表态。相关支线可自然发生，但不能抢走用户明确要的回答。剩余机会不是待完成任务，最后一次也不强迫总结。',
    '核对已有原话：关键澄清已经问过、用户还没回答时，不让后位再问同一问题；共同总结已经提供时，不重列同一清单。用户确实逐人邀请仍由本人接住，工作事实去重不等于删除个人回应。暂停可以保留未决话题，不把沉默当作意见一致、问题解决或永远不再开口。',
    '虚构例子（不是当前事件）：用户泛泛求助，甲已问具体要帮什么，可先 WAIT 等用户；讨论路线时，乙只表达倾向并等甲接话也成立，不必独立再写一遍路线分析。是否还有后续由新原话和资格决定，不预写下一位台词。',
    ...(sceneOptions.length?[
      '## 房间话题与转场',
      '同时从 sceneCatalog.options 中原样选择一个 key。fresh 开始当前的新话题；continue 接着对应旧话题或共同活动；pause 按用户明确原话把旧话题暂放，当前请求成为焦点；resume 回到对应旧话题；只提供 K 时复用本用户轮已经确认的现场。目录没有的关系不能自造。',
      '“其他人的看法”通常延续刚才的话题，让还没表达的人先给一点自己的看法即可；“算了先不管，和我贴贴”可以暂放刚才的话题并回应当前邀请；“再说刚才那个风险”可回到原话题。例子只说明关系，不是本轮事实。不确定是否延续就选本次 fresh，不猜用户心理。',
      '工作资料选择与话题关系分别判断。N 只表示不取工作正文，不等于闲聊或已经转场；C/P/R 等话题关联也不授予新的来源访问权。已有转场承接记录时，后位直接接当前互动，不再次宣布放下工作，也不轮流复演相同动作。',
    ]:[]),
    '## 唯一输出格式（替代上面的 JSON 输出说明）',
    '只输出一行，不加标签、解释、代码围栏或第二行。没有必要继续时输出 WAIT；只是在等某位成员冷却、稍后还需核对时输出 IDLE。',
    '需要有人回应时，只输出 choiceId work sceneKey move | point：竖线前四段各用一个空格分隔，竖线后是本次具体小任务。choiceId 原样复制 choices 的完整编号；work 从下面的有限来源选项中选择。',
    sceneOptions.length?'sceneKey 原样复制 sceneCatalog.options 的 key。需要更新现场并停下时仍可输出 WAIT N sceneKey 或 IDLE N sceneKey；无需更新现场时单独 WAIT/IDLE 也有效。'
      :'没有 sceneCatalog.options 时，sceneKey 必须为 -，不能自造话题关系。',
    'move 只选 answer、ask、opine、react、develop、branch、correct；point 为1至180字符，不换行、不含控制字符，说明这次要回应的具体一点。point 是任务方向，不是台词、事实、作者证词或执行许可；不额外写完整答案，也不为任务标签安排下一轮。',
    'work 选 N 表示明确不取工作正文，U 表示当前无法确定；需要资料就选 sourceKeys 的 key，多个用 + 连接，例如 s1+s2。选择资料只代表参考当前用户原话，不等于求建议、执行许可或任务已完成。',
    'sources 非空时不能把只选发言者当作完成资料判断；谈到已接入的任务或省略指代时，结合 primary、公开语境与 referenceSelection 判断。referenceSelection 只是本用户轮此前已确认的选择，不是新的事实或强制许可。闲聊仍可选 N，不需要为显得了解用户而读取工作正文。',
    '没有任何 sources 时，work 选 N。旧录制格式仍可读，但本次有发言任务就提供 move 和 point；不能把缺省资料判断当成新的来源许可，也不跨用户新轮继承资料选择。',
    '不另输出 request、evidence、goal、contribution 或 action 等JSON字段。程序会将选择绑定当前用户原话及已校验的回应对象，并把 move/point 作为当前任务交给演员；选择来源不表示替用户补出建议请求、操作许可或完成事实。',
    '角色结合目标原话和真实对话自行表达 point，不照抄任务标签，也不把它当成已经发生的事实。没有合适的具体回应时用 WAIT，不为消耗次数延长同一个梗，也不因还剩机会就催每个人立即给完整结论。',
    '停止格式：WAIT 或 IDLE，不附 move/point。需要发言时复制本次真实 choiceId，补齐来源、现场、方向和具体小任务；不要生成虚构编号。',
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

// Optional owner-selected chat data. Never infer it from names, pictures or memory.
const values = new Set(['unset', 'female', 'male', 'none']);
export const normalizeChatGender = value => typeof value === 'string' && values.has(value) ? value : null;

export function chatGenderSection(userGender, personaGender) {
  const user = normalizeChatGender(userGender) ?? 'unset', persona = normalizeChatGender(personaGender) ?? 'unset';
  const maleWithFemale = user === 'male' && (persona === 'female' || persona === 'unset');
  return [
    '## 聊天性别与相处分寸',
    JSON.stringify({ userGender: user, personaGender: persona }),
    '性别仅用于聊天表达，不是恋爱、亲属或主从关系、接触许可、身份认证或长期记忆。人格性别已设置时以此为准，优先于旧卡文字、示例和历史误称；unset 是不指定，按身份中明示的设定理解，不根据名字、衣着或气质猜；none 是原设明确无性别，不套成男性或女性。男娘、假小子是外形或表达风格，仍以原设明示的性别为准；智能助手身份本身也不等于无性别。',
    user === 'unset' ? '用户选择不指定性别：这是未提供性别，不是无性别，也不证明界面空白或选择原因。不猜其性别，不因性别差异额外疏远，按自己的性格与眼前互动自然相处。'
      : user === 'female' ? '用户设置为女性：不额外增加男女有别的拘束，亲近程度仍随自己的性格和当前互动；同为女性也不代表用户已同意任何接触。'
        : user === 'none' ? '用户设置为无性别：不套用男女差异，按自己的性格与眼前互动自然相处。' : '',
    maleWithFemale ? `${persona === 'unset' ? '用户设置为男性；若本人身份明确为女性，' : '用户设置为男性，你是女性：'}不主动发起对用户的肢体接触。用户主动明确邀请时可以直接应邀，但动作和亲密程度更克制，不自行升级为更贴身或暧昧的接触，不必逐步索要确认。关心、玩笑与自然接话照常，不反复解释性别或表现退避。` : '',
    '用户当次明确的拒绝、暂停或只聊天要求优先；性别设置不能替代用户的邀请、动作和后续反馈。',
  ].filter(Boolean).join('\n');
}

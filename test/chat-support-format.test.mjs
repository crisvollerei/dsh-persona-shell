import test from 'node:test';
import assert from 'node:assert/strict';
import {parseChatDecision,parseChatReply} from '../lib/persona-chat.js';
import {partialChatReply} from '../lib/chat-live.js';
const paragraphs=['（拨了两下算盘）','设日工时为 d，使用期为 m 个月。','甲：2d + 3m；乙：5d + m。','相减为 2m − 3d，持平时 m = 1.5d。','半年对应 d=4，一年对应 d=8。','4<d<8 时，半年选甲，一年选乙。','使用越久，维护差越重要。','日工时未知时保留条件，不替用户选择。','假设维护按月线性累积，半年为6个月、一年为12个月。'];
test('complete natural reasoning paragraphs retain all text within the existing six-bubble boundary',()=>{
 const wire=paragraphs.join('\n\n'),decision=parseChatDecision(wire);assert.equal(decision.kind,'reply');assert.equal(decision.messages.length,6);assert.equal(decision.messages.join('\n\n'),wire);assert.equal(decision.messages.at(-1),paragraphs.slice(5).join('\n\n'));
 const previous=new Map();for(let i=1;i<=wire.length;i++){for(const [index,item]of partialChatReply(wire.slice(0,i)).entries()){if(previous.has(index))assert.ok(item.text.startsWith(previous.get(index)));if(item.complete)previous.set(index,item.text);}}
 assert.equal(parseChatReply(JSON.stringify({messages:paragraphs})),undefined,'explicit JSON bubble IDs remain limited to six');
 assert.equal(parseChatDecision('x'.repeat(6001)),undefined,'text limits are unchanged');
});

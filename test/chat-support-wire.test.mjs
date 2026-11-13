import test from 'node:test';
import assert from 'node:assert/strict';
import {buildDirectorRequest,parseDirectorResponse} from '../lib/chat-director-wire.js';
import {chatSchedulerEventKey} from '../lib/chat-scheduler.js';
const event=chatSchedulerEventKey({roomId:'room',generation:0,sourceScope:null,turnId:'user',attemptId:'user'});
const options={message:'帮我核对公开条件。',members:[{id:'fish',name:'鲸鲸'}],events:[{id:event,author:{role:'user',name:'我'},messages:['帮我核对公开条件。']}],states:[{id:'fish',level:0,normalRemaining:3,normalReady:true,pendingEventIds:[event],normalPendingEventIds:[event]}],sources:[],sourceIds:[],supportTemplates:['research','reason']};
const line=o=>`${JSON.parse(buildDirectorRequest(o).user).choices[0].choiceId} N - answer | 回应当前问题`;
test('HELP is optional and bound to an authorized direct user response',()=>{
 const base=line(options),result=parseDirectorResponse(base+'\nHELP research | 核对公开条件',options);
 assert.equal(result.basis,'model');assert.deepEqual(result.next.support,{template:'research',goal:'核对公开条件'});
 assert.equal(parseDirectorResponse(base,options).next.support,undefined);
 assert.equal(JSON.parse(buildDirectorRequest({...options,supportTemplates:[]}).user).supportTemplates,undefined);
 for(const wire of ['WAIT\nHELP research | 核对','IDLE\nHELP reason | 推演',base+'\nHELP shell | 执行',base+'\nHELP reason | 推演\nSCENE | 灯亮了',base+'\nHELP research | 核对\t',base+'\nHELP reason | 推\u0000演'])assert.equal(parseDirectorResponse(wire,options).basis,'invalid',JSON.stringify(wire));
 assert.equal(parseDirectorResponse(base+'\nHELP research | 核对',{...options,supportTemplates:[]}).basis,'invalid');
 assert.equal(parseDirectorResponse('```text\n'+base+'\nHELP research | 核对\n```',options).basis,'model');
 assert.equal(parseDirectorResponse(base+'\nHELP research | 核对\n',options).basis,'model');
 const changed={...options,states:[]};assert.equal(parseDirectorResponse(base+'\nHELP research | 核对',changed).basis,'invalid');
 assert.doesNotMatch(buildDirectorRequest(options).system,/request 只分当前请求/);
});

test('finite helper choices separate capability selection from the conversational move vocabulary',()=>{
 const body=JSON.parse(buildDirectorRequest(options).user);assert.equal(body.supportChoices.length,2);
 for(const choice of body.supportChoices){const raw=`${choice.choiceId} N - | 核对当前问题`,result=parseDirectorResponse(raw,options);
  assert.equal(result.basis,'model');assert.equal(result.next.id,'fish');assert.equal(result.next.kind,'normal');assert.equal(result.next.support.template,choice.template);
  assert.equal(result.next.contribution,undefined);
  for(const changed of [{...options,supportTemplates:[]},{...options,states:[]},{...options,events:[]},{...options,sources:[{id:'new',name:'新增来源'}]}])assert.equal(parseDirectorResponse(raw,changed).basis,'invalid');
  for(const bad of [raw+'\t',raw+'\nSCENE | 编故事',raw.replace(' N - ',' N invented '),raw.replace(' N - ',' s1 - '),raw.replace(' | ',' reason | '),raw.replace(' | ','\nHELP reason | ')])assert.equal(parseDirectorResponse(bad,options).basis,'invalid',bad);
 }
 const base=line(options).replace(' answer | ',' reason | ');assert.equal(parseDirectorResponse(base+'\nHELP reason | 推演',options).basis,'invalid','historical invalid label is not repaired or converted into permission');
 assert.equal(JSON.parse(buildDirectorRequest({...options,supportTemplates:[]}).user).supportChoices,undefined);
});

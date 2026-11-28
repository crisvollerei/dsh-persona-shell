import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,reply,newRoom,roomSend,roomState,settledRoom,whale,dragon,claude,readChatInput} from './helpers/persona-chat-host.mjs';

const wire=value=>(async function*(){yield{type:'text-delta',text:value};yield{type:'finish',reason:{kind:'stop'}};})();
const taskWire=(body,choice,move,point)=>wire(`${choice.choiceId} N ${body.sceneCatalog?.options[0]?.key??'-'} ${move} | ${point}`);
async function broadcast(f,binding){const state=await roomState(f,binding);assert.equal((await f.request('chat-rooms',{
  ...binding,action:'update',targetPersonaIds:[],configRevision:state.room.configRevision,epoch:state.epoch})).status,200);}

test('a directed opinion can admit the person being discussed and hand back before another parallel opinion',async t=>{
  const userText='那你怎么看待小克的？';
  const f=fixture(t,{directorScript:options=>{
    const body=readChatInput(options),said=body.events.filter(event=>event.author.role==='assistant');
    if(said.length===2){
      assert.equal(body.addressedExchange.addressee,whale);
      assert.deepEqual(body.addressedExchange.parts[0].addressedReplies,[said[0].id]);
      assert.deepEqual(body.addressedExchange.parts[0].otherReplies,[said[1].id]);
      const choice=body.choices.find(item=>item.id===dragon&&item.to==='user');
      assert.ok(choice);
      return taskWire(body,choice,'opine','再说一份自己对小克的看法。');
    }
    const choice=body.choices.find(item=>item.id===(said.length?claude:whale)&&item.to==='user');
    assert.ok(choice);
    return taskWire(body,choice,said.length?'react':'opine',said.length?'本人回应一下先不说话的说法。':'说你的个人印象。');
  },script:options=>{
    const input=readChatInput(options);
    assert.equal(input.message,userText);assert.deepEqual(input.recipients.map(person=>person.id),[whale]);
    if(input.speaker.id===whale){
      assert.match(options.system,/第一人称时用「鲸鲸」/);
      assert.doesNotMatch(options.system,/你是听到公开聊天后顺口插话/);
      return reply(['鲸鲸觉得挺好相处，就是她有时先不说话。']);
    }
    assert.equal(input.speaker.id,claude);
    assert.match(options.system,/公开聊天后顺口插话/);
    assert.match(options.system,/公开发言可以当场听见/);
    assert.match(options.system,/第一人称时用「我」/);
    return reply(['那是我在等你把笑话讲完。']);
  }});
  await f.ready();const room=await newRoom(f,[whale,claude,dragon]);
  await roomSend(f,room,whale,userText,'focused-side');
  const done=await settledRoom(f,room);
  assert.equal(done.directorFailure,null);
  assert.equal(f.directors.length,3);
  assert.equal(f.calls.length,2);
  assert.deepEqual(done.room.turns.filter(turn=>turn.phase!=='anchor').map(turn=>turn.recipientId),[whale,claude]);
});

test('one shared clarification is followed by waiting; later user details get a new bounded task without replaying old progress',async t=>{
  const points=['只问这次签到表要记什么。','只给昵称和到场两列，沿用刚才的范围。','顺口应声，不复演放下工作的过程。'];
  const f=fixture(t,{directorScript:options=>{
    const body=readChatInput(options),said=body.events.filter(event=>event.author.role==='assistant');
    if(said.length){assert.equal(body.contributions.length,1);assert.ok(body.events.some(event=>event.id===body.contributions[0].eventId));return wire('WAIT');}
    assert.deepEqual(body.contributions,[]);
    const number=body.message==='帮我弄签到表。'?0:body.message==='只要昵称和是否到场。'?1:2;
    const choice=body.choices.find(item=>item.id===(number===1?dragon:whale)&&item.to==='user');
    return taskWire(body,choice,number===0?'ask':number===1?'answer':'react',points[number]);
  },script:options=>{
    const body=readChatInput(options),task=body.directorAssignment;
    assert.equal(task.point,undefined);
    return reply([task.move==='ask'?'这次表上要记什么？':task.move==='answer'?'那就两列：昵称、是否到场。':'嗯，你先去。']);
  }});
  await f.ready();const room=await newRoom(f,[whale,dragon],'共同问题只问一次','contribution-multiturn');await broadcast(f,room);
  for(const [index,text]of ['帮我弄签到表。','只要昵称和是否到场。','先等我倒点水。'].entries()){
    await roomSend(f,room,whale,text,'contribution-user-'+index);const done=await settledRoom(f,room);
    assert.equal(done.directorFailure,null);assert.equal(done.running,false);
    assert.equal(f.calls.length,index+1,'waiting does not require another actor to acknowledge the same shared question');
  }
  assert.equal(f.directors.length,6);
  const done=await roomState(f,room);assert.deepEqual(done.room.turns.filter(turn=>turn.phase!=='anchor').map(turn=>turn.responsePlan.contribution.point),points);
  assert.deepEqual(done.room.turns.filter(turn=>turn.phase==='anchor').map(turn=>turn.user),['帮我弄签到表。','只要昵称和是否到场。','先等我倒点水。']);
});

test('a specific public side thread can still take two peer turns and then stop without using every opportunity',async t=>{
  const moves=['react','branch','develop'],points=['接住布置桌面的邀请。','顺着空位聊灯，不重新回答桌面怎么布置。','接她的小台灯想法。'];
  const f=fixture(t,{directorScript:options=>{
    const body=readChatInput(options),said=body.events.filter(event=>event.author.role==='assistant'),index=said.length;
    if(index===3){assert.deepEqual(body.contributions.map(item=>item.contribution.move),moves);return wire('WAIT');}
    const id=index===1?dragon:whale,choice=body.choices.find(item=>item.id===id&&item.kind===(index?'peer':'normal'));
    assert.ok(choice,'an actual peer invitation remains eligible');return taskWire(body,choice,moves[index],points[index]);
  },script:options=>{
    const body=readChatInput(options),index=moves.indexOf(body.directorAssignment.move);
    if(index)assert.equal(body.replyTarget.author.id,index===1?whale:dragon);
    return reply([['GPT，左边空着，你想放点什么？','鲸鲸，要不放个小台灯？','暖一点的那个就挺好。'][index]]);
  }});
  await f.ready();const room=await newRoom(f,[whale,dragon],'顺口长出支线','contribution-branch');await broadcast(f,room);
  await roomSend(f,room,whale,'随便聊聊桌面，别急着列整套方案。','branch-user');const done=await settledRoom(f,room);
  assert.equal(done.directorFailure,null);assert.deepEqual(f.calls.map(options=>readChatInput(options).speaker.id),[whale,dragon,whale]);
  assert.equal(f.directors.length,4);assert.deepEqual(done.room.turns.filter(turn=>turn.phase!=='anchor').map(turn=>turn.responsePlan.contribution.point),points);
});

test('a failed actor task is not recorded as completed and its explicit retry retains the task and target',async t=>{
  let fail=true;
  const contribution={move:'opine',point:'只说本人对先画草图的取舍，不复述其他人的话。'};
  const f=fixture(t,{directorScript:options=>{
    const body=readChatInput(options),choice=body.choices.find(item=>item.id===whale&&item.to==='user');
    if(fail||!body.events.some(event=>event.author.role==='assistant'))assert.deepEqual(body.contributions,[]);
    if(body.events.some(event=>event.author.role==='assistant')||!choice)return wire('WAIT');
    return taskWire(body,choice,contribution.move,contribution.point);
  },script:options=>{
    assert.deepEqual(readChatInput(options).directorAssignment,{kind:'normal',to:'user',move:contribution.move});
    return reply(['我倾向先画草图。'],fail?'max-tokens':'stop');
  }});
  await f.ready();const room=await newRoom(f,[whale,dragon],'重试继续原小步','contribution-retry');
  await roomSend(f,room,whale,'先画草图还是直接写？','retry-user');let done=await settledRoom(f,room);
  const failed=done.room.turns.find(turn=>turn.phase!=='anchor');assert.equal(failed.status,'failed');
  assert.deepEqual(failed.responsePlan.contribution,contribution);fail=false;
  assert.equal((await f.request('chat',{...room,action:'retry',personaId:whale,id:failed.id,attemptId:'retry-task',revision:done.room.revision,epoch:done.epoch})).status,200);
  done=await settledRoom(f,room);assert.equal(done.room.turns.filter(turn=>turn.phase!=='anchor').length,1);
  assert.equal(done.room.turns.find(turn=>turn.id===failed.id).status,'ready');assert.equal(done.directorFailure,null);
  assert.deepEqual(readChatInput(f.calls[1]).replyTarget.text,'先画草图还是直接写？');
  assert.deepEqual(readChatInput(f.directors.at(-1)).contributions.map(item=>item.contribution),[contribution]);
});

test('a newly invited member still receives old unread room words while her new task belongs to the current user turn',async t=>{
  const f=fixture(t,{directorScript:options=>{
    const body=readChatInput(options);
    if(body.events.some(event=>event.author.role==='assistant'))return wire('WAIT');
    const current=body.message==='先保留纸质签到。',person=current?whale:dragon;
    const choice=body.choices.find(item=>item.id===person&&item.to==='user');
    return taskWire(body,choice,current?'react':'opine',current?'接住先保留纸质的决定。':'只说你对两列的取舍，沿用纸质条件。');
  },script:options=>reply([readChatInput(options).speaker.id===whale?'先留纸质表，两列够用。':'我也倾向两列，不额外收联系方式。'])});
  await f.ready();const room=await newRoom(f,[whale,dragon],'旧原话和新任务分别传递','contribution-unread');
  await roomSend(f,room,whale,'先保留纸质签到。','unread-first');await settledRoom(f,room);
  let state=await roomState(f,room);await f.request('chat-rooms',{...room,action:'update',targetPersonaIds:[dragon],configRevision:state.room.configRevision,epoch:state.epoch});
  await roomSend(f,room,dragon,'GPT，你对两列怎么看？','unread-second');state=await settledRoom(f,room);
  assert.equal(state.directorFailure,null);assert.equal(f.calls.length,2);
  const request=readChatInput(f.calls[1]);assert.equal(request.message,'GPT，你对两列怎么看？');
  assert.equal(request.directorAssignment.move,'opine');assert.equal(request.directorAssignment.point,undefined);
  assert.ok(request.inbox.some(item=>item.author.role==='user'&&item.messages.includes('先保留纸质签到。')));
  assert.ok(request.inbox.some(item=>item.author.id===whale&&item.messages.includes('先留纸质表，两列够用。')));
  assert.ok(!f.calls[1].messages.some(message=>message.role==='assistant'),'a peer\'s old words do not become the new actor\'s own history');
});

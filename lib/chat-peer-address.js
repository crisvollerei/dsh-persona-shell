// This only admits an extra, model-reviewed peer opportunity. Other room
// conversation does not have to use a vocative or one of these forms.
const pairs=new Map(Object.entries({'“':'”','‘':'’','「':'」','『':'』','"':'"','`':'`','（':'）','(':')'}));
function spokenText(line){
  const chars=line.split(''),stack=[];
  for(let i=0;i<chars.length;i++){
    const ch=chars[i];
    if(stack.length&&stack.at(-1)===ch){stack.pop();chars[i]='\0';}
    else if(pairs.has(ch)){stack.push(pairs.get(ch));chars[i]='\0';}
    else if(stack.length)chars[i]='\0';
  }
  return chars.join('').replace(/^[ \t]*>[^\n]*/gmu,part=>'\0'.repeat(part.length));
}

/** Locate a public direct address, rather than matching a name in reported speech or a description. */
export function directPeerAddress(line,names,roster,evidence){
  if(typeof line!=='string'||!names.length||!names.some(name=>line.includes(name)))return null;
  const spoken=spokenText(line),all=[...new Set(roster)].sort((a,b)=>b.length-a.length);
  // Starting at a clause boundary distinguishes "小克，借我一盏灯" from
  // "我去问小克，你先等着". A mention marker is itself an explicit address.
  for(const lead of spoken.matchAll(/(?:^|[\r\n，,。.!！?？;；：:…—\0])[ \t]*[@＠]?|[@＠]/gu)){
    const start=lead.index+lead[0].length,tag=/[@＠]$/u.test(lead[0]);
    if(spoken[start]==='\0'||tag&&/[\w.]/u.test(line[start-2]??''))continue;
    let at=start,found=false;
    while(at<line.length){
      const name=all.find(value=>line.startsWith(value,at));
      if(!name)break;
      found ||= names.includes(name);at+=name.length;
      const join=/^[ \t]*(?:、|和|跟|与|&)[ \t]*[@＠]?/u.exec(spoken.slice(at));
      if(!join||!all.some(value=>line.startsWith(value,at+join[0].length)))break;
      at+=join[0].length;
    }
    if(!found)continue;
    const following=spoken.slice(at);
    if(tag&&/[\w]/u.test(line[at-1])&&/^[\w]/u.test(following))continue;
    const cue=/^[ \t]*(?:[呀啊呢呐嘛哦啦]?(?:$|[，,。.!！?？；;：:…—\r\n])|你|您|(?:能不能|可以|能)?(?:借我|帮我|陪我)|要不要一起)/u.exec(following);
    if(!tag&&!cue)continue;
    const span={start:tag?start-1:start,end:at+(tag?0:cue[0].trimEnd().length)};
    if(span.end-span.start>1600)continue;
    if(evidence!==undefined){
      // A legacy response may supply a substring instead of the generated
      // locator. It must actually cover this address in this bubble.
      const offset=line.indexOf(evidence,Math.max(0,span.end-evidence.length));
      if(offset<0||offset>span.start||offset+evidence.length<span.end)continue;
    }
    return span;
  }
  return null;
}

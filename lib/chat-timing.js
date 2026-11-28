const paths = ['direct', 'directed', 'director', 'context', 'support'];
const stages = ['contextDone', 'directorDone', 'firstText', 'done'];
const callKinds = ['director', 'context', 'actor', 'support'];
const duration = n => Number.isSafeInteger(n) && n >= 0 && n <= 600000;

export function createChatTiming({limit = 200, changed = () => {}} = {}) {
  let samples = [];
  let restored = false;
  const normalize = s => {
    if (!s || !paths.includes(s.path) || !Number.isSafeInteger(s.at) || s.at < 0
      || !stages.every(k => s[k] === null || duration(s[k]))
      || !callKinds.every(k => Number.isSafeInteger(s.calls?.[k]) && s.calls[k] >= 0 && s.calls[k] <= 1000)) return null;
    return {at:s.at, path:s.path, ...Object.fromEntries(stages.map(k=>[k,s[k]])),
      calls:Object.fromEntries(callKinds.map(k=>[k,s.calls[k]]))};
  };
  function percentiles(values) {
    values.sort((a,b)=>a-b);
    const at=p=>values.length<5?null:values[Math.ceil(values.length*p)-1];
    return {p50:at(.5),p90:at(.9)};
  }
  return {
    record(input) {const sample=normalize(input); if(sample){samples.push(sample);samples=samples.slice(-limit);changed();}},
    snapshot:()=>structuredClone(samples),
    restore(input) {
      if (restored) return;
      restored = true;
      const saved = (Array.isArray(input) ? input : []).slice(-limit).map(normalize).filter(Boolean);
      samples = [...saved, ...samples].slice(-limit);
    },
    summary() {
      return {failed:samples.filter(s=>s.done===null).length, paths:Object.fromEntries(paths.map(path=>{
        const all=samples.filter(s=>s.path===path),ok=all.filter(s=>s.done!==null);
        return [path,{count:all.length,firstText:percentiles(ok.map(s=>s.firstText).filter(duration)),done:percentiles(ok.map(s=>s.done)),
          avgCalls:ok.length?ok.reduce((n,s)=>n+Object.values(s.calls).reduce((a,b)=>a+b,0),0)/ok.length:null}];
      }))};
    },
  };
}

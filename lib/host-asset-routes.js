import { readRequestBody } from './http-body.js';
import {exportAssets,planAssetImport} from './asset-backup.js';
import manifest from '../package.json' with {type:'json'};

export function createAssetRoute({state,commit,ready,sendJson}) {
  return async (req,res,url)=>{
    if(!ready()){sendJson(res,503,{error:'storage-not-ready'});return;}
    try {
      if(req.method==='GET'){
        sendJson(res,200,exportAssets(state(),{type:url.searchParams.get('type')??'both',id:url.searchParams.get('persona'),
          history:url.searchParams.get('history')==='1',plugin:manifest.version}));return;
      }
      if(req.method!=='POST'){sendJson(res,405,{error:'method-not-allowed'});return;}
      const raw = await readRequestBody(req, 24 * 1024 * 1024);
      if (raw === undefined) { sendJson(res,413,{error:'backup-too-large'}); return; }
      if (!ready()) { sendJson(res,503,{error:'storage-not-ready'}); return; }
      const body=JSON.parse(raw);
      if(body?.action==='preview'){
        const {summary,token}=planAssetImport(body.file,state(),body.fallbackPersona);
        sendJson(res,200,{summary,token});return;
      }
      if(body?.action!=='import' || typeof body.token!=='string')throw Error('invalid-backup');
      sendJson(res,200,{summary:await commit(body)});
    } catch(error){const conflict=error.message==='backup-conflict', malformed=error instanceof SyntaxError || error instanceof TypeError || ['invalid-backup','invalid-avatar','persona-not-found'].includes(error.message);
      sendJson(res,conflict?409:malformed?400:503,{error:conflict?'backup-conflict':malformed?'invalid-backup':'backup-storage-failed'});}
  };
}

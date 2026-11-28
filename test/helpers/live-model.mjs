import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

export async function openLiveModel(deps){
  if(!deps || !process.env.DEEPSEEK_API_KEY)throw Error('Live mode requires --deps and DEEPSEEK_API_KEY');
  const require=createRequire(resolve(deps)),load=name=>import(pathToFileURL(require.resolve('@deepseek-ai/'+name)));
  const [{Context},{LlmRuntime},{DeepSeekAdapter,resolveAdapterOptions}]=await Promise.all([load('cordis'),load('dsh-llm'),load('dsh-llm-deepseek')]);
  const ctx=new Context();await ctx.plugin(LlmRuntime);const llm=ctx.get('llm');
  const options=resolveAdapterOptions({thinking:'disabled'}),userId=randomUUID();
  llm.registerAdapter(['deepseek'],new DeepSeekAdapter({options:()=>options,resolveUserId:()=>userId,
    resolveAuth:async()=>({headers:{'x-api-key':process.env.DEEPSEEK_API_KEY}}),prepareExtensions:async()=>({fields:{}})}));
  return {llm,route:{provider:'deepseek',model:process.env.DSH_TEST_MODEL??'deepseek-flash'},close:()=>ctx.fiber.dispose()};
}

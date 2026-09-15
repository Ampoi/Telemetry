// Test-only Worker entrypoint. Never used by wrangler.jsonc or production build.
import { cloudApi } from '../src/cloud/api';
import worker from '../src/index';
import { claim, context, saveMessage, tombstone } from '../src/cloud/store';
import { consume, dispatch, scheduled } from '../src/cloud/jobs';
import { cleanup } from '../src/cloud/media';
import type { Task, RemoteMessage } from '../src/cloud/model';
export default {
  ...worker,
  async fetch(request:Request,env:Env,ctx:ExecutionContext):Promise<Response>{
    const path=new URL(request.url).pathname;
    if(path==='/test/config') { try { return await cloudApi(new Request(request.url.replace('/test/config','/api/telemetry/config'), request),env); } catch(error) { return Response.json({error:String(error),stack:error instanceof Error?error.stack:null},{status:500}); } }
    if(!path.startsWith('/test/'))return worker.fetch(request,env,ctx);
    try{
      const data=await request.json() as {id:string;task:Task;message:RemoteMessage;observed:number;messageId:string;created:string;key:string};
      if(path==='/test/objects')return Response.json(await env.MEDIA.list());
      if(path==='/test/head')return Response.json(await env.MEDIA.head(data.key));
      if(path==='/test/claim')return Response.json(await claim(env,data.id));
      if(path==='/test/save'){const {channel}=await context(env,data.task);await saveMessage(env,data.task,channel,data.message,data.observed);}
      if(path==='/test/delete'){const {channel}=await context(env,data.task);await tombstone(env,data.task,channel,data.messageId,data.created);}
      if(path==='/test/run'){
        // Synchronously await one real consumer invocation, without Queue delivery timing.
        const message={body:{kind:'collection' as const,id:data.id},id:'test',timestamp:new Date(),attempts:1,ack(){},retry(){}};
        await consume({queue:'telemetry-collection',metadata:{metrics:{backlogCount:0,backlogBytes:0}},messages:[message],ackAll(){},retryAll(){}},env);
      }
      if(path==='/test/dispatch')await dispatch(env);
      if(path==='/test/cleanup')await cleanup(env);
      if(path==='/test/cron')await scheduled({cron:'*/5 * * * *',scheduledTime:Date.now(),noRetry(){}},env);
      return Response.json({ok:true});
    }catch(error){return Response.json({error:error instanceof Error?error.message:'error'},{status:500});}
  },
};

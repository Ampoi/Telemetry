// Test-only Worker entrypoint. Never used by wrangler.jsonc or production build.
import { cloudApi } from '../src/cloud/api';
import worker from '../src/index';
import { claim, context, saveMessage, tombstone } from '../src/cloud/store';
import { consume, dispatch } from '../src/cloud/jobs';
import { cleanup } from '../src/cloud/media';
import type { Task, RemoteMessage } from '../src/cloud/model';
export { MeetingScheduler } from '../src/meeting-scheduler';
export { CollectionRecovery } from '../src/cloud/recovery';
import { MeetingScheduler } from '../src/meeting-scheduler';
import { CollectionRecovery } from '../src/cloud/recovery';
import type { MeetingInput, MeetingState } from '../src/meeting-model';

// Test controls are only exported by this test entrypoint, never src/index.ts.
export class TestMeetingScheduler extends MeetingScheduler {
  async due(runAt: number) {
    const row = this.ctx.storage.sql.exec<{data:string}>('SELECT data FROM meeting WHERE id=1').one();
    const state: MeetingState = JSON.parse(row.data); state.runAt = runAt;
    this.ctx.storage.sql.exec('UPDATE meeting SET data=? WHERE id=1', JSON.stringify(state));
    await this.ctx.storage.deleteAlarm();
  }
  async step() { await super.alarm(); await this.ctx.storage.deleteAlarm(); return this.summary(); }
  async alarmTime() { return this.ctx.storage.getAlarm(); }
}
export class TestCollectionRecovery extends CollectionRecovery {
  async step() { await super.alarm(); return this.ctx.storage.getAlarm(); }
  async expireHold() { await this.ctx.storage.put('holdUntil', 0); }
}
export default {
  ...worker,
  async fetch(request:Request,env:Env,ctx:ExecutionContext):Promise<Response>{
    const path=new URL(request.url).pathname;
    if(path==='/test/config') { try { return await cloudApi(new Request(request.url.replace('/test/config','/api/telemetry/config'), request),env); } catch(error) { return Response.json({error:String(error),stack:error instanceof Error?error.stack:null},{status:500}); } }
    if(!path.startsWith('/test/'))return worker.fetch(request,env,ctx);
    try{
      if(path==='/test/recovery') {
        const data=await request.json() as {guild:string;expire?:boolean};
        const stub=(env.COLLECTION_RECOVERY as unknown as DurableObjectNamespace<TestCollectionRecovery>).getByName(data.guild);
        await stub.arm(data.guild);
        if(data.expire)await stub.expireHold();
        return Response.json({alarm:await stub.step()});
      }
      if(path.startsWith('/test/meeting/')) {
        const data = await request.json() as {guild:string;id:string;runAt:number;input:MeetingInput};
        const meetings = env.MEETINGS as unknown as DurableObjectNamespace<TestMeetingScheduler>;
        const stub = meetings.getByName(`${data.guild}:${data.id}`);
        if(path.endsWith('/book'))return Response.json(await stub.book(data.input));
        if(path.endsWith('/due')){await stub.due(data.runAt);return Response.json({ok:true});}
        if(path.endsWith('/step'))return Response.json(await stub.step());
        if(path.endsWith('/summary'))return Response.json(await stub.summary());
        if(path.endsWith('/cancel'))return Response.json(await stub.cancel());
        if(path.endsWith('/alarm'))return Response.json(await stub.alarmTime());
      }
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
      return Response.json({ok:true});
    }catch(error){return Response.json({error:error instanceof Error?error.message:'error'},{status:500});}
  },
};

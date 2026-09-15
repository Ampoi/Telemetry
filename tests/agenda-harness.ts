// Test-only entrypoint; production Worker configuration remains unchanged.
import { exportRecord } from '../src/cloud/store';
import { generateAgenda, type Input, type Message } from '../src/agenda/index';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const input = await request.json() as Input;
      const row = await env.DB.prepare('SELECT guild,id,data,deleted FROM cloud_messages WHERE guild=? AND id=?')
        .bind(input.guildId, input.messages[0].message_id).first<{guild:string;id:string;data:string;deleted:number}>();
      if (!row) return new Response('missing fixture', {status:404});
      input.messages = [await exportRecord(env, row) as Message];
      return Response.json(await generateAgenda(input, {apiKey:'fake-openai',model:'gpt-5.6-luna'}));
    } catch (error) {
      return Response.json({error:error instanceof Error ? error.message : 'error'}, {status:500});
    }
  },
};
// Match the production bindings when Wrangler builds this test-only entrypoint.
export { MeetingScheduler } from '../src/meeting-scheduler';
export { CollectionRecovery } from '../src/cloud/recovery';

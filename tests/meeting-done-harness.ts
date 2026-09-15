import worker from '../src/index';
import { MeetingScheduler } from '../src/meeting-scheduler';
import { MeetingDone } from '../src/meeting-done';
import type { MeetingState } from '../src/meeting-model';
export { MeetingPoll } from '../src/meeting-poll';
export { MeetingDone } from '../src/meeting-done';
export { MeetingScheduler } from '../src/meeting-scheduler';
export { MeetingStart } from '../src/meeting-start';
export { CollectionRecovery } from '../src/cloud/recovery';

export class DoneSource extends MeetingScheduler {
  async seed(s: MeetingState) {
    this.ctx.storage.sql.exec('INSERT INTO meeting(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data', JSON.stringify(s));
    await this.ctx.storage.deleteAlarm();
  }
}
export class TestMeetingDone extends MeetingDone {
  async start(input: Parameters<MeetingDone['start']>[0]) {
    const result = await super.start(input); await this.ctx.storage.deleteAlarm(); return result;
  }
  async step() { await super.alarm(); await this.ctx.storage.deleteAlarm(); return this.summary(); }
  restart() { this.ctx.abort('Test restart'); }
  async markUncertain(kind: 'sending' | 'generating') {
    const row = this.ctx.storage.sql.exec<{ data: string }>('SELECT data FROM completion WHERE id=1').one();
    const s = JSON.parse(row.data); s[kind] = true;
    this.ctx.storage.sql.exec('UPDATE completion SET data=? WHERE id=1', JSON.stringify(s));
  }
}
export default {
  ...worker,
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const path = new URL(request.url).pathname;
    if (!path.startsWith('/test/')) return worker.fetch(request, env, ctx);
    const body = await request.json() as { id: string; guild: string; state: MeetingState; kind: 'sending' | 'generating' };
    if (path === '/test/seed') {
      await (env.MEETINGS as unknown as DurableObjectNamespace<DoneSource>).getByName(`${body.guild}:${body.id}`).seed(body.state);
      return Response.json({ ok: true });
    }
    const stub = (env.MEETING_DONE as unknown as DurableObjectNamespace<TestMeetingDone>).getByName(`${body.guild}:${body.id}`);
    if (path === '/test/step') return Response.json(await stub.step());
    if (path === '/test/restart') { try { await stub.restart(); } catch { /* Expected RPC interruption. */ } return Response.json({ ok: true }); }
    if (path === '/test/uncertain') { await stub.markUncertain(body.kind); return Response.json({ ok: true }); }
    return Response.json(await stub.summary());
  },
};

import { DurableObject } from 'cloudflare:workers';
import { dispatch } from './jobs';
import { cleanup } from './media';

// Replaces Cron's outbox/attachment/cleanup recovery, without starting new scans.
// It sleeps permanently when all explicitly requested work is finished.
export class CollectionRecovery extends DurableObject<Env> {
  async arm(guild: string): Promise<void> {
    await this.ctx.storage.transaction(async tx => {
      const bound = await tx.get<string>('guild');
      if (bound && bound !== guild) throw new Error('GuildMismatch');
      await tx.put({ guild, holdUntil: Date.now() + 90_000 });
      const alarm = await tx.getAlarm();
      if (alarm === null || alarm > Date.now() + 30_000) await tx.setAlarm(Date.now() + 30_000);
    });
  }
  async alarm(): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now() + 60_000);
    const guild = await this.ctx.storage.get<string>('guild');
    if (!guild) { await this.ctx.storage.deleteAlarm(); return; }
    try {
      await dispatch(this.env, guild);
      await cleanup(this.env, guild);
      const active = await this.env.DB.prepare("SELECT id FROM cloud_tasks WHERE guild=? AND status IN ('pending','running') LIMIT 1").bind(guild).first();
      const media = await this.env.DB.prepare("SELECT id FROM cloud_attachments WHERE guild=? AND status='pending' LIMIT 1").bind(guild).first();
      const cleaning = await this.env.DB.prepare('SELECT MIN(due) AS due FROM cloud_cleanup WHERE storage_key LIKE ?').bind(`guild/${guild}/%`).first<{ due: number | null }>();
      await this.ctx.storage.transaction(async tx => {
        // Observe a concurrent request's keepalive before deciding to stop.
        const hold = await tx.get<number>('holdUntil') ?? 0;
        if (active || media || hold > Date.now()) await tx.setAlarm(Date.now() + 30_000);
        else if (cleaning?.due !== null && cleaning?.due !== undefined) await tx.setAlarm(Math.max(Date.now() + 1000, cleaning.due));
        else await tx.deleteAlarm();
      });
    } catch { await this.ctx.storage.setAlarm(Date.now() + 60_000); }
  }
}

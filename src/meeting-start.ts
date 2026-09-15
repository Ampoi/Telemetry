import { DurableObject } from 'cloudflare:workers';
import { discord, DiscordError } from './cloud/discord-rest';
import { type MeetingInput } from './meeting-model';

import { meetingSettings } from './guild-settings';

const HOUR = 3600_000;
type Notice = Pick<MeetingInput, 'id' | 'guild' | 'user' | 'channel' | 'meetingAt' | 'document'> & {
  status: 'scheduled' | 'sending' | 'sent' | 'failed' | 'needs_review' | 'cancelled';
  url?: string; messageId?: string; error?: string;
};

// A separate alarm waits for the agenda URL and sends the pre-meeting reminder. The sending marker prevents retries after an uncertain POST.
export class MeetingStart extends DurableObject<Env> {
  private async state() { return this.ctx.storage.get<Notice>('notice'); }
  async book(input: MeetingInput) {
    await this.ctx.blockConcurrencyWhile(async () => {
      const old = await this.state();
      if (old) {
        if (old.guild !== input.guild || old.channel !== input.channel || old.meetingAt !== input.meetingAt || old.document !== input.document) throw new Error('StartNoticeConflict');
        if (old.status === 'scheduled') await this.ctx.storage.setAlarm(old.meetingAt! - HOUR);
        return;
      }
      if (!input.channel || !input.meetingAt) throw new Error('MissingStartNotice');
      await this.ctx.storage.put('notice', { id: input.id, guild: input.guild, user: input.user, channel: input.channel,
        meetingAt: input.meetingAt, document: input.document, status: 'scheduled' } satisfies Notice);
      await this.ctx.storage.setAlarm(input.meetingAt - HOUR);
    });
  }
  async documentReady(url: string) {
    await this.ctx.blockConcurrencyWhile(async () => {
      const state = await this.state();
      if (!state || state.status !== 'scheduled') return;
      if (!url.startsWith(`https://docs.google.com/document/d/${state.document}/edit?tab=`)) throw new Error('DocumentMismatch');
      state.url = url; await this.ctx.storage.put('notice', state);
      await this.ctx.storage.setAlarm(Math.max(Date.now(), state.meetingAt! - HOUR));
    });
  }
  async cancel() {
    await this.ctx.blockConcurrencyWhile(async () => {
      const state = await this.state();
      if (!state || state.status !== 'scheduled') return;
      state.status = 'cancelled'; await this.ctx.storage.put('notice', state); await this.ctx.storage.deleteAlarm();
    });
  }
  async summary() { return this.state(); }
  async alarm() {
    await this.ctx.blockConcurrencyWhile(async () => {
      const state = await this.state();
      if (!state || ['sent', 'failed', 'needs_review', 'cancelled'].includes(state.status)) return;
      if (state.status === 'sending') {
        state.status = 'needs_review'; state.error = '開始通知が届いているかチャンネルを確認してください。';
        await this.ctx.storage.put('notice', state); return;
      }
      if (state.meetingAt! - HOUR > Date.now()) { await this.ctx.storage.setAlarm(state.meetingAt! - HOUR); return; }
      if (state.meetingAt! <= Date.now()) {
        state.status = 'failed'; state.error = '開始時刻までに事前通知を送れませんでした。アジェンダと通知設定を確認してください。';
        await this.ctx.storage.put('notice', state); return;
      }
      if (!state.url) { await this.ctx.storage.setAlarm(Date.now() + 15_000); return; }
      try {
        const guild = await discord<{ owner_id: string }>(this.env, `/guilds/${state.guild}`);
        if (guild.owner_id !== state.user) {
          const member = await discord<{ roles: string[] }>(this.env, `/guilds/${state.guild}/members/${state.user}`);
          const roles = await discord<{ id: string; permissions: string }[]>(this.env, `/guilds/${state.guild}/roles`);
          if (!roles.some(r => (r.id === state.guild || member.roles.includes(r.id)) && (BigInt(r.permissions) & 40n))) throw new Error('ManagerRevoked');
        }
        const channel = await discord<{ guild_id: string }>(this.env, `/channels/${state.channel}`);
        if (channel.guild_id !== state.guild) throw new Error('ChannelMismatch');
        const voice = (await meetingSettings(this.env, state.guild)).voice_channel_id;
        if (!voice) throw new Error('VoiceChannelMissing');
        const voiceChannel = await discord<{ guild_id: string; type: number }>(this.env, `/channels/${voice}`);
        if (voiceChannel.guild_id !== state.guild || voiceChannel.type !== 2) throw new Error('VoiceChannelMismatch');
        const minutes = Math.ceil((state.meetingAt! - Date.now()) / 60_000);
        const timing = minutes >= 60 ? '1時間後' : `${minutes}分後`;
        state.status = 'sending'; await this.ctx.storage.put('notice', state); await this.ctx.storage.sync();
        const response = await fetch(`https://discord.com/api/v10/channels/${state.channel}/messages`, {
          method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(15_000),
          headers: { Authorization: `Bot ${this.env.DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: `@everyone\n${timing}に定例mtgを開始します\n通話チャンネル：<#${voice}>\nアジェンダ：${state.url}`,
            allowed_mentions: { parse: ['everyone'] }, nonce: `s${state.id}`, enforce_nonce: true }),
        });
        if (response.status === 429) {
          const result = await response.json() as { retry_after?: number };
          state.status = 'scheduled'; await this.ctx.storage.put('notice', state);
          await this.ctx.storage.setAlarm(Date.now() + Math.max(1, result.retry_after ?? 5) * 1000); return;
        }
        if (!response.ok) {
          state.status = response.status < 500 ? 'failed' : 'needs_review'; await response.body?.cancel();
          throw new Error('SendFailed');
        }
        const result = await response.json() as { id?: string; mention_everyone?: boolean };
        if (!result.id) throw new Error('SendUncertain');
        if (!result.mention_everyone) {
          state.status = 'failed'; state.messageId = result.id; state.error = '通知は投稿されましたが、全員メンションが無効です。Botのメンション権限を確認してください。';
          await this.ctx.storage.put('notice', state); return;
        }
        state.status = 'sent'; state.messageId = result.id;
        await this.ctx.storage.put('notice', state);
      } catch (error) {
        if (state.status === 'scheduled' && error instanceof DiscordError && error.httpStatus === 429) {
          await this.ctx.storage.setAlarm(Date.now() + error.retryAfter * 1000); return;
        }
        state.status = ['sending', 'needs_review'].includes(state.status) ? 'needs_review' : 'failed';
        state.error = state.status === 'needs_review' ? '開始通知が届いているかチャンネルを確認してください。' : '開始通知を送信できませんでした。/settings の通話チャンネル、Botの閲覧・投稿権限と予約者の管理権限を確認してください。';
        await this.ctx.storage.put('notice', state);
      }
    });
  }
}

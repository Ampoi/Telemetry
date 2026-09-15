import type { MeetingInput, MeetingPost } from './meeting-model';

export interface AgendaSource { archive: string; sourceGuild: string; project: string; rangeFrom: number; rangeTo: number }
export async function meetingSource(env: Env, guild: string): Promise<AgendaSource | undefined> {
  return await env.DB.prepare(`SELECT a.id AS archive,a.source_guild AS sourceGuild,a.project,
    a.range_from AS rangeFrom,a.range_to AS rangeTo FROM meeting_agenda_sources s
    JOIN meeting_agenda_archives a ON a.id=s.archive WHERE s.guild=?`).bind(guild).first<AgendaSource>() ?? undefined;
}

// The source guild is deliberately preserved for citations; it is not the guild
// where the test meeting is booked. Only the trusted import CLI sets this mapping.
// Archive coverage describes storage, never the period requested by a meeting.
export function sourceInput(source: AgendaSource | undefined): Partial<MeetingInput> {
  return source ? { sourceArchive: source.archive, sourceGuild: source.sourceGuild,
    projectName: source.project } : {};
}

export function storedPost(data: string): MeetingPost {
  const m = JSON.parse(data);
  return { id: m.message_id, channel_id: m.channel_id, channel_name: m.thread_name ?? m.channel_name ?? m.department ?? '',
    parent_id: m.parent_channel_id ?? null, timestamp: m.created_at, edited_timestamp: m.edited_at ?? null,
    content: m.content ?? '', author: { id: m.author_id, username: m.author_display_name ?? '' },
    attachments: (m.attachments ?? []).map((a: any) => ({ id: a.attachment_id, filename: a.filename,
      content_type: a.content_type, size: a.size ?? 0, url: a.url ?? '' })),
    ...(m.reply_to_message_id ? { message_reference: { message_id: m.reply_to_message_id, channel_id: m.reply_to_channel_id ?? m.channel_id } } : {}),
  };
}

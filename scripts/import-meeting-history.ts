import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { iso } from '../src/cloud/model';
import type { MeetingPost } from '../src/meeting-model';

// Read ZIP members by central-directory offsets, without extracting paths. This
// also avoids macOS unzip's lossy conversion of Japanese member names.
export function zipJson(bytes: Buffer): unknown[] {
  let end = bytes.length - 22;
  while (end >= Math.max(0, bytes.length - 65557) && bytes.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0 || bytes.readUInt32LE(end) !== 0x06054b50) throw new Error('InvalidZip');
  let offset = bytes.readUInt32LE(end + 16), total = 0;
  const records: unknown[] = [];
  for (let n = 0; n < bytes.readUInt16LE(end + 10); n++) {
    if (bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error('InvalidZipDirectory');
    const flags = bytes.readUInt16LE(offset + 8), method = bytes.readUInt16LE(offset + 10);
    const size = bytes.readUInt32LE(offset + 20), plain = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28), extra = bytes.readUInt16LE(offset + 30), comment = bytes.readUInt16LE(offset + 32);
    const local = bytes.readUInt32LE(offset + 42), name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    offset += 46 + nameLength + extra + comment;
    if (!name.endsWith('.json')) continue;
    total += plain;
    if (flags & 1 || ![0, 8].includes(method) || total > 30_000_000 || bytes.readUInt32LE(local) !== 0x04034b50) throw new Error('UnsupportedZip');
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const compressed = bytes.subarray(start, start + size);
    const content = method === 8 ? inflateRawSync(compressed, { maxOutputLength: 30_000_000 }) : compressed;
    if (content.length !== plain) throw new Error('InvalidZipSize');
    records.push(JSON.parse(content.toString('utf8')));
  }
  return records;
}

export function mergeHistory(records: unknown[]) {
  const posts = new Map<string, MeetingPost>();
  let guild: string | undefined;
  for (const record of records as any[]) {
    if (record.schema_version !== 1 || !Array.isArray(record.channels)) throw new Error('UnsupportedBackup');
    for (const c of record.channels) {
      if (c.channel.guild_id) {
        if (guild && guild !== c.channel.guild_id) throw new Error('MultipleSourceGuilds');
        guild = c.channel.guild_id;
      }
      for (const m of c.messages) {
        if (!/^\d{17,20}$/.test(m.id) || m.channel_id !== c.channel.id || !m.author?.id || !Number.isFinite(Date.parse(m.timestamp))) throw new Error('InvalidBackupMessage');
        const post: MeetingPost = { id: m.id, channel_id: m.channel_id, channel_name: c.channel.name,
          parent_id: [10, 11, 12].includes(c.channel.type) ? c.channel.parent_id : null,
          timestamp: iso(m.timestamp), edited_timestamp: m.edited_timestamp ? iso(m.edited_timestamp) : null,
          content: m.content ?? '', author: { id: m.author.id, username: m.author.username, global_name: m.author.global_name },
          attachments: (m.attachments ?? []).map((a: any) => ({ id: a.id, filename: a.filename, content_type: a.content_type, size: a.size, url: a.url })),
          ...(m.message_reference ? { message_reference: m.message_reference } : {}),
          ...(m.member?.nick ? { member: { nick: m.member.nick } } : {}),
        };
        const previous = posts.get(post.id);
        if (previous && previous.channel_id !== post.channel_id) throw new Error('ConflictingChannel');
        if (!previous || (post.edited_timestamp ?? post.timestamp) >= (previous.edited_timestamp ?? previous.timestamp)) posts.set(post.id, post);
      }
    }
  }
  if (!guild || !/^\d{17,20}$/.test(guild) || !posts.size) throw new Error('EmptyBackup');
  return { guild, posts: [...posts.values()].sort((a,b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id)) };
}

async function main() {
  const { values } = parseArgs({ options: { zip: { type: 'string', multiple: true }, guild: { type: 'string' }, project: { type: 'string', default: 'R-1' }, out: { type: 'string' } } });
  if (!values.zip?.length || !values.guild || !/^\d{17,20}$/.test(values.guild) || !values.out) throw new Error('--zip ZIP（複数可） --guild 利用先サーバーID --project R-1 --out exports/history.sql を指定してください。');
  const records = (await Promise.all(values.zip.map(async path => zipJson(await readFile(path))))).flat();
  const { guild, posts } = mergeHistory(records);
  const digest = createHash('sha256').update(JSON.stringify({ guild, posts })).digest('hex');
  const archive = `history-${digest}`;
  const from = Date.parse(posts[0].timestamp), to = Date.parse(posts.at(-1)!.timestamp) + 1;
  const sql = (value: string) => "'" + value.replaceAll("'", "''") + "'";
  const lines = [`INSERT OR IGNORE INTO meeting_agenda_archives(id,source_guild,project,range_from,range_to,imported) VALUES(${sql(archive)},${sql(guild)},${sql(values.project!)},${from},${to},${Date.now()});`];
  for (const p of posts) lines.push(`INSERT OR IGNORE INTO meeting_agenda_posts(archive,id,created,data) VALUES(${sql(archive)},${sql(p.id)},${sql(p.timestamp)},${sql(JSON.stringify(p))});`);
  // Activate only after all immutable source rows have been uploaded.
  lines.push(`INSERT INTO meeting_agenda_sources(guild,archive) VALUES(${sql(values.guild)},${sql(archive)}) ON CONFLICT(guild) DO UPDATE SET archive=excluded.archive;`);
  const out = resolve(values.out); await mkdir(dirname(out), { recursive: true });
  await writeFile(out, lines.join('\n') + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ archive, sourceGuild: guild, targetGuild: values.guild, posts: posts.length,
    from: new Date(from).toISOString(), to: new Date(to).toISOString(), characters: JSON.stringify(posts).length, sqlFile: out }, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => {
  console.error(error instanceof Error ? error.message : 'ImportFailed'); process.exitCode = 1;
});

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parseArgs, parseEnv } from 'node:util';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { zipJson, mergeHistory } from './import-meeting-history';
import { agendaMessages, DEBUG_MODEL, DEBUG_EFFORT } from '../src/debug-agenda';
import { generateAgenda, renderMarkdown, type Input } from '../src/agenda/index';
import { minutesText } from '../src/meeting-minutes';
import { compileMarkdown } from '../src/template';

export async function replayAgenda() {
  const { values } = parseArgs({ options: {
    zip: { type: 'string' }, from: { type: 'string', default: '2026-06-14' },
    split: { type: 'string', default: '2026-06-21' }, to: { type: 'string', default: '2026-06-28' },
    notes: { type: 'string' }, out: { type: 'string' }, 'env-file': { type: 'string' },
    resume: { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log('pnpm run mtg:replay --zip backup.zip --notes meeting-notes.md --out exports/replay [--from 2026-06-14 --split 2026-06-21 --to 2026-06-28] [--env-file .dev.vars] [--resume]');
    console.log('実際のAIで2回生成し、ローカルのDocs形式で会議内容の追記・読み出しを再現します。OPENAI_API_KEYが必要です。');
    return;
  }
  if (!values.zip || !values.notes || !values.out) throw new Error('--zip、--notes、--outを指定してください。');
  const secrets = values['env-file'] ? parseEnv(await readFile(values['env-file'], 'utf8')) : {};
  const apiKey = process.env.OPENAI_API_KEY ?? secrets.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEYを設定してください。');
  const history = mergeHistory(zipJson(await readFile(values.zip)));
  const notes = await readFile(values.notes, 'utf8');
  if (!notes.trim() || notes.length > 30000) throw new Error('会議内容は1〜30000文字で指定してください。');
  const days = [values.from!, values.split!, values.to!];
  const dates = days.map(day => {
    const n = Date.parse(`${day}T00:00:00+09:00`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(n) || new Date(n + 9 * 3600_000).toISOString().slice(0, 10) !== day) throw new Error('存在する日付を指定してください。');
    return n;
  });
  if (!(dates[0] < dates[1] && dates[1] < dates[2])) throw new Error('from < split < toを指定してください。');
  const windows = [0, 1].map(i => history.posts.filter(p => Date.parse(p.timestamp) >= dates[i] && Date.parse(p.timestamp) < dates[i + 1]));
  if (windows.some(w => !w.length)) throw new Error('両方の期間に投稿が必要です。');
  const fingerprint = createHash('sha256').update(JSON.stringify({ days, windows, notes, model: DEBUG_MODEL, effort: DEBUG_EFFORT })).digest('hex');
  const out = resolve(values.out);
  await mkdir(out, { recursive: true });
  const manifest = { fingerprint, model: DEBUG_MODEL, reasoningEffort: DEBUG_EFFORT, sourceGuild: history.guild, dates: days, posts: windows.map(w => w.length), mode: 'local-docs-replay' };
  if (values.resume) {
    if (JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8')).fingerprint !== fingerprint) throw new Error('前回と入力が違います。新しい出力先を指定してください。');
  } else await writeFile(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx', mode: 0o600 });
  const save = async (name: string, value: unknown) => writeFile(join(out, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2), { mode: 0o600 });
  let previous: string | undefined;
  for (let i = 0; i < 2; i++) {
    const name = `round-${i + 1}`;
    const input: Input = { project: 'R-1', meetingAt: `${days[i + 1]} 00:00 JST（デバッグ）`,
      guildId: history.guild, from: days[i], to: days[i + 1], messages: agendaMessages(windows[i], history.guild), previousMinutes: previous,
      coverageNotes: ['履歴アーカイブを使ったデバッグです。画像・動画の実データは未確認。会議追記は仮の検証データです。'] };
    await save(`${name}-input.json`, input);
    let result: Awaited<ReturnType<typeof generateAgenda>>;
    try { result = JSON.parse(await readFile(join(out, `${name}.json`), 'utf8')); }
    catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
      // An interrupted or uncertain paid call is never repeated by --resume.
      await writeFile(join(out, `${name}.started`), new Date().toISOString(), { flag: 'wx', mode: 0o600 });
      console.log(`${name}: ${windows[i].length}投稿から生成中`);
      let responseNumber = 0;
      result = await generateAgenda(input, { apiKey, model: DEBUG_MODEL, reasoningEffort: DEBUG_EFFORT, chunkCharacters: 100000, maxRequests: 8,
        onResponse: async response => { await save(`${name}-response-${++responseNumber}.json`, response); },
      });
      await save(`${name}.json`, result);
    }
    result.markdown = renderMarkdown(result);
    await save(`${name}.json`, result);
    await save(`${name}.md`, result.markdown);
    console.log(`${name}: 完了（${result.metadata.requestCount} API requests）`);
    if (!i) {
      const text = compileMarkdown(result.markdown).text + '\n\n会議中の追記（デバッグ用の仮議事録）\n' + notes;
      const document = { tabs: [{ tabProperties: { tabId: 'debug.round1' }, documentTab: { body: { content: [{ paragraph: { elements: [{ textRun: { content: text } }] } }] } } }] };
      await save('round-1-minutes.docs.json', document);
      // Same saved-tab reader as the production scheduler, including nested tabs.
      previous = minutesText(document, 'debug.round1');
      await save('round-1-minutes.txt', previous);
    } else {
      const points = [...result.agenda.summary, ...result.agenda.topics.flatMap(t => [...t.previous, ...t.results, ...t.insights, ...t.blockers, ...t.next]),
        ...result.agenda.discussions.flatMap(d => [...d.question, ...d.background, ...d.options, ...d.people, ...d.deadline, ...d.materials])];
      const inherited = points.filter(p => p.sourceIds.some(id => id.startsWith('previous-minutes')));
      await save('carryover.json', { count: inherited.length, points: inherited });
      if (!inherited.length) throw new Error('前回議事録を引用した項目がありません。出力を確認してください。');
      console.log(`前回議事録の引用: ${inherited.length}項目。確認先: ${out}`);
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) replayAgenda().catch(error => {
  console.error(error instanceof Error ? error.message : 'ReplayFailed'); process.exitCode = 1;
});

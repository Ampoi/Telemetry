import type { Agenda, Point } from './index';

export type AgendaBlock = { heading: string; level: 2 | 3 } | {
  entries: { label?: string; point: Point }[]; bullet: boolean;
};
function merged(points: Point[]): Point {
  return { text: points.map(p => p.text).join(' '),
    sourceIds: [...new Set(points.flatMap(p => p.sourceIds))], mediaIds: [...new Set(points.flatMap(p => p.mediaIds))] };
}

/** One presentation layout shared by Markdown and native Google Docs. */
export function agendaLayout(agenda: Agenda): AgendaBlock[] {
  const blocks: AgendaBlock[] = [];
  const heading = (text: string, level: 2 | 3 = 2) => blocks.push({ heading: text, level });
  const item = (points: Point[], label?: string) => {
    if (points.length) blocks.push({ entries: [{ label, point: merged(points) }], bullet: true });
  };
  heading('1. 今週の要点');
  const labels = ['成果', '注意点', '会議の焦点'];
  for (const label of labels) {
    const points = agenda.summary.filter(p => p.text.startsWith(label + '：') || p.text.startsWith(label + ':'));
    item(points.map(p => ({ ...p, text: p.text.slice(label.length + 1).trim() })), label);
  }
  // Legacy saved results have unlabelled summaries. Preserve their meaning rather
  // than assigning a guessed category during an in-flight deployment.
  for (const p of agenda.summary.filter(p => !labels.some(l => p.text.startsWith(l + '：') || p.text.startsWith(l + ':')))) item([p]);
  heading('2. 部門・テーマ別の進捗');
  for (const t of agenda.topics) {
    heading(`${t.department}・${t.title}`, 3);
    item(t.previous, '予定 → 現状'); item(t.results, 'やったこと・結果'); item(t.insights, '分かったこと・考察');
    item(t.blockers, '課題'); item(t.next, '次の予定');
  }
  heading('3. 今日話し合うこと');
  agenda.discussions.forEach((d, i) => {
    const number = i < 20 ? String.fromCodePoint(0x2460 + i) : String(i + 1);
    heading(`議題${number} ${d.title}`, 3);
    item(d.question, '今回決めたいこと'); item([...d.background, ...d.options], '判断材料'); item(d.materials, '不足情報');
    const entries = [];
    if (d.people.length) entries.push({ label: '関係者', point: merged(d.people) });
    if (d.deadline.length) entries.push({ label: '判断期限', point: merged(d.deadline) });
    if (entries.length) blocks.push({ entries, bullet: false });
  });
  return blocks;
}

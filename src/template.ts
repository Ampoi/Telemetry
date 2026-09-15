import { AppError } from './errors';

export function documentId(input: string): string {
  const value = input.trim();
  if (/^[a-zA-Z0-9_-]{10,200}$/.test(value)) return value;
  try {
    const url = new URL(value);
    const match = url.pathname.match(/^\/document\/(?:u\/\d+\/)?d\/([a-zA-Z0-9_-]{10,200})(?:\/|$)/);
    if (url.protocol === 'https:' && url.hostname === 'docs.google.com' && match) return match[1];
  } catch { /* Report the same validation error for invalid URLs. */ }
  throw new AppError(400, 'GoogleドキュメントのURLまたはドキュメントIDを指定してください。');
}

export function renderTemplate(template: string, data: Record<string, unknown>): string {
  const missing = new Set<string>();
  const rendered = template.replace(/{{\s*([\w.-]+)\s*}}/g, (_, name: string) => {
    if (!Object.hasOwn(data, name)) { missing.add(name); return ''; }
    const value = data[name];
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      throw new AppError(400, `テンプレート変数 ${name} は文字列・数値・真偽値にしてください。`);
    }
    return String(value);
  });
  if (missing.size) throw new AppError(400, `テンプレート変数が不足しています: ${[...missing].join(', ')}`);
  if (!rendered.trim() || rendered.length > 50_000) throw new AppError(400, '本文は1〜50,000文字にしてください。');
  // Google strips these controls; rejecting them preserves UTF-16 style offsets.
  if (/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\ue000-\uf8ff]/u.test(rendered.replaceAll('\r\n', '\n'))) {
    throw new AppError(400, '本文にGoogle Docsが削除する制御文字・私用文字が含まれています。');
  }
  return rendered.replaceAll('\r\n', '\n');
}

export interface Paragraph { start: number; end: number; style?: string; bullet?: boolean }
export function compileMarkdown(markdown: string): { text: string; paragraphs: Paragraph[] } {
  let text = '';
  const paragraphs: Paragraph[] = [];
  for (const line of markdown.replace(/\n$/, '').split('\n')) {
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    const bullet = line.match(/^[-*]\s+(.+)$/);
    const content = heading?.[2] ?? bullet?.[1] ?? line;
    const start = text.length + 1;
    text += `${content}\n`;
    paragraphs.push({ start, end: text.length + 1, ...(heading ? { style: `HEADING_${heading[1].length}` } : {}), ...(bullet ? { bullet: true } : {}) });
  }
  return { text, paragraphs };
}

export function contentRequests(markdown: string, tabId: string): Record<string, unknown>[] {
  const { text, paragraphs } = compileMarkdown(markdown);
  return [
    { insertText: { endOfSegmentLocation: { tabId }, text } },
    ...paragraphs.filter(p => p.style || p.bullet).map(p => {
      const range = { tabId, startIndex: p.start, endIndex: p.end };
      return p.style
        ? { updateParagraphStyle: { range, paragraphStyle: { namedStyleType: p.style }, fields: 'namedStyleType' } }
        : { createParagraphBullets: { range, bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE' } };
    }),
  ];
}

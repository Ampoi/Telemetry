import { AppError } from '../errors';
import { documentId, renderTemplate } from '../template';

/** Build the existing createTab/API input without making a Google request. */
export function agendaDocsInput(
  agenda: { title: string; markdown: string },
  target: { document: string; requestId: string; title?: string },
) {
  const title = target.title ?? agenda.title;
  if (!title.trim() || title.length > 100 || /[\u0000-\u001f]/.test(title)) throw new AppError(400, 'タブ名は改行なしの1〜100文字にしてください。');
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(target.requestId)) throw new AppError(400, 'requestIdは英数字・_・-の8〜100文字にしてください。');
  const data = { agenda: agenda.markdown };
  // Pass generated text as data. Never interpret source-derived {{...}} as a template.
  renderTemplate('{{agenda}}', data);
  return { document: documentId(target.document), title, template: '{{agenda}}', data, requestId: target.requestId };
}

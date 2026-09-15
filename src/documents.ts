import { hash } from './crypto';
import { AppError } from './errors';
import { accessToken, googleDocs } from './google';
import { contentRequests, documentId, renderTemplate } from './template';

interface CreateInput { document: string; title: string; template: string; data: Record<string, unknown>; requestId: string }

async function readInput(request: Request): Promise<CreateInput> {
  if (!request.headers.get('Content-Type')?.startsWith('application/json')) throw new AppError(415, 'application/jsonで送信してください。');
  const reader = request.body?.getReader();
  if (!reader) throw new AppError(400, 'JSON本文が必要です。');
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 200_000) { await reader.cancel(); throw new AppError(413, 'リクエストが大きすぎます（最大200KB）。'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new AppError(400, 'JSONが不正です。'); }
  if (!value || typeof value !== 'object') throw new AppError(400, 'JSONオブジェクトが必要です。');
  const input = value as Record<string, unknown>;
  for (const field of ['document', 'title', 'template', 'requestId']) {
    if (typeof input[field] !== 'string' || !input[field]) throw new AppError(400, `${field}は空でない文字列で指定してください。`);
  }
  if ((input.title as string).length > 100 || !String(input.title).trim() || /[\r\n\u0000-\u001f]/.test(String(input.title))) throw new AppError(400, 'タブ名は改行なしの1〜100文字にしてください。');
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(input.requestId as string)) throw new AppError(400, 'requestIdは英数字・_・-の8〜100文字にしてください。');
  if (!input.data || typeof input.data !== 'object' || Array.isArray(input.data)) throw new AppError(400, 'dataはJSONオブジェクトで指定してください。');
  return {
    document: input.document as string, title: input.title as string,
    template: input.template as string, requestId: input.requestId as string,
    data: input.data as Record<string, unknown>,
  };
}

export async function createTab(request: Request, env: Env, owner = 'default'): Promise<Response> {
  const input = await readInput(request);
  const id = documentId(input.document);
  const markdown = renderTemplate(input.template, input.data);
  const payloadHash = await hash(JSON.stringify({ document: id, title: input.title, markdown }));
  // Authentication/refresh failures happen before reserving the operation, so login can be retried.
  const token = await accessToken(env, owner);
  const operationId = `${owner}:${input.requestId}`;
  const reservation = await env.DB.prepare("INSERT OR IGNORE INTO operations (id, payload_hash, status, created_at) VALUES (?, ?, 'running', ?)")
    .bind(operationId, payloadHash, Date.now()).run();
  if (!reservation.meta.changes) {
    const existing = await env.DB.prepare('SELECT payload_hash, status, result FROM operations WHERE id = ?').bind(operationId).first<{ payload_hash: string; status: string; result: string | null }>();
    if (existing?.payload_hash !== payloadHash) throw new AppError(409, '同じrequestIdが別の入力に使われています。');
    if (existing.status === 'complete') return Response.json({ ...JSON.parse(existing.result!), replayed: true });
    throw new AppError(409, 'このrequestIdは実行中または結果確認が必要です。ドキュメントを確認し、新しく作成する場合だけ別のrequestIdを使用してください。', { requestId: input.requestId, previousResult: existing.result ? JSON.parse(existing.result) : null });
  }
  let tabId: string | undefined;
  try {
    const result = await googleDocs<{ replies: { addDocumentTab?: { tabProperties: { tabId: string } } }[] }>(token, `${id}:batchUpdate`, {
      requests: [{ addDocumentTab: { tabProperties: { title: input.title } } }],
    });
    tabId = result.replies?.[0]?.addDocumentTab?.tabProperties.tabId;
    if (!tabId) throw new AppError(502, 'Googleから作成したタブIDが返されませんでした。ドキュメントを確認してください。');
    // Persist the created tab before the second API call, including if execution is interrupted.
    const url = `https://docs.google.com/document/d/${id}/edit?tab=${encodeURIComponent(tabId)}`;
    await env.DB.prepare('UPDATE operations SET result = ? WHERE id = ?').bind(JSON.stringify({ tabId, url }), operationId).run();
    await googleDocs(token, `${id}:batchUpdate`, { requests: contentRequests(markdown, tabId) });
    const output = { documentId: id, tabId, title: input.title, url, requestId: input.requestId };
    await env.DB.prepare("UPDATE operations SET status = 'complete', result = ? WHERE id = ?").bind(JSON.stringify(output), operationId).run();
    return Response.json(output, { status: 201 });
  } catch (error) {
    const details = {
      requestId: input.requestId,
      ...(tabId ? { tabId, url: `https://docs.google.com/document/d/${id}/edit?tab=${encodeURIComponent(tabId)}` } : {}),
      message: error instanceof AppError ? error.message : '実行が中断しました。Googleドキュメントの状態を確認してください。',
    };
    await env.DB.prepare("UPDATE operations SET status = 'needs_review', result = ? WHERE id = ?").bind(JSON.stringify(details), operationId).run();
    throw new AppError(502, tabId ? 'タブは作成済みですが、本文入力の完了を確認できませんでした。表示されたURLで確認してください。' : details.message, details);
  }
}

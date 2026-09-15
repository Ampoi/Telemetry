import { mkdirSync, openSync, writeSync, fsyncSync, closeSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { iso } from './model.ts';
import type { Store } from './store.ts';
export function dateBounds(from: string, to: string): [string, string] {
  const date = (s: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error('日付はYYYY-MM-DDです');
    const utc = new Date(s + 'T00:00:00Z');
    if (!Number.isFinite(utc.getTime()) || utc.toISOString().slice(0, 10) !== s) throw new Error('存在しない日付です');
    return iso(utc.getTime() - 9 * 3600_000);
  };
  const start = date(from), end = date(to);
  if (start >= end) throw new Error('--toは--fromより後（終了日は含まない）です');
  return [start, end];
}
export function exportJsonl(store: Store, from: string, to: string, directory: string) {
  const [start, end] = dateBounds(from, to); mkdirSync(directory, { recursive: true });
  const path = join(directory, `telemetry_${from}_${to}_${randomUUID()}.jsonl`), temporary = path + '.part';
  let count = 0, fd: number | undefined;
  try { fd = openSync(temporary, 'wx', 0o600); store.exportRecords(start, end, record => { writeSync(fd!, JSON.stringify(record) + '\n'); count++; }); fsyncSync(fd); closeSync(fd); fd = undefined; renameSync(temporary, path); }
  catch (e) { if (fd !== undefined) closeSync(fd); rmSync(temporary, { force: true }); throw e; }
  return { path, count };
}

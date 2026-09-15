import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { generateAgenda, AgendaError } from '../src/agenda/index';

const args = process.argv.slice(2);
if (args.length < 2 || args.includes('--help')) {
  console.log('pnpm exec tsx scripts/agenda.ts <request.json> <output-directory>');
  console.log('環境変数: OPENAI_API_KEY, OPENAI_MODEL, OPENAI_REASONING_EFFORT（任意）');
  process.exit(args.includes('--help') ? 0 : 1);
}
try {
  const input = JSON.parse(await readFile(args[0], 'utf8'));
  if (input.jsonlFile) {
    if (input.messages) throw new AgendaError('DUPLICATE_INPUT');
    const { dirname } = await import('node:path');
    const raw = await readFile(resolve(dirname(args[0]), input.jsonlFile), 'utf8');
    input.messages = raw.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line));
    delete input.jsonlFile;
  }
  const effort = process.env.OPENAI_REASONING_EFFORT;
  if (effort && !['low', 'medium', 'high'].includes(effort)) throw new AgendaError('INVALID_REASONING_EFFORT');
  const result = await generateAgenda(input, {
    apiKey: process.env.OPENAI_API_KEY ?? '', model: process.env.OPENAI_MODEL ?? '',
    reasoningEffort: effort as 'low' | 'medium' | 'high' | undefined,
  });
  const out = resolve(args[1]); await mkdir(out, { recursive: true });
  const name = `agenda-${crypto.randomUUID()}`;
  await writeFile(resolve(out, name + '.json'), JSON.stringify(result, null, 2), { flag: 'wx' });
  await writeFile(resolve(out, name + '.md'), result.markdown, { flag: 'wx' });
  console.log(`生成完了: ${name}.json / ${name}.md (${result.metadata.requestCount} API requests)`);
} catch (e) {
  console.error(e instanceof AgendaError ? e.message : 'INPUT_OR_OUTPUT_ERROR'); process.exitCode = 1;
}

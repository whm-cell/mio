import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkDocuments } from './check-documents.ts';
import { checkSource } from './check-source.ts';
import { inventory, loadConfig } from './inventory.ts';

async function evaluateGuardrails(targetRoot: string) {
  const root = resolve(targetRoot);
  const config = await loadConfig(root);
  const scan = await inventory(root, config);
  const [source, docs] = await Promise.all([
    checkSource(root, scan.files, config),
    checkDocuments(root, scan.files, config),
  ]);
  const errors = [...scan.errors, ...source.errors, ...docs.errors];
  const stdout = [
    'Code shape (report only; review responsibilities, not a score or automatic split):',
    source.metrics.join('\n'),
    `Inventory: ${scan.files.length} files; Git index: ${docs.indexChecked ? 'checked' : 'unavailable (not verified)'}`,
    ...(errors.length
      ? []
      : ['Guardrails passed for the declared scope. Business behavior is verified separately.']),
  ];
  return { status: errors.length ? 1 : 0, stdout, stderr: errors };
}

export async function runGuardrails(
  targetRoot: string,
): Promise<{ status: number; output: string }> {
  try {
    const result = await evaluateGuardrails(targetRoot);
    return {
      status: result.status,
      output: [...result.stdout, ...result.stderr].join('\n'),
    };
  } catch (error) {
    return {
      status: 1,
      output: error instanceof Error ? (error.stack ?? error.message) : String(error),
    };
  }
}

const entry = process.argv[1];
if (entry && realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))) {
  const result = await evaluateGuardrails(process.argv[2] ?? '.');
  for (const line of result.stdout) console.log(line);
  if (result.stderr.length) {
    console.error(result.stderr.join('\n'));
    process.exitCode = 1;
  }
}

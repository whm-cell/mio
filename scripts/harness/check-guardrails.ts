import { resolve } from 'node:path';
import { checkDocuments } from './check-documents.ts';
import { checkSource } from './check-source.ts';
import { inventory, loadConfig } from './inventory.ts';

const root = resolve(process.argv[2] ?? '.');
const config = await loadConfig(root);
const scan = await inventory(root, config);
const [source, docs] = await Promise.all([
  checkSource(root, scan.files, config),
  checkDocuments(root, scan.files, config),
]);
const errors = [...scan.errors, ...source.errors, ...docs.errors];
console.log('Code shape (report only; review responsibilities, not a score or automatic split):');
console.log(source.metrics.join('\n'));
console.log(
  `Inventory: ${scan.files.length} files; Git index: ${docs.indexChecked ? 'checked' : 'unavailable (not verified)'}`,
);
if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else
  console.log(
    'Guardrails passed for the declared scope. Business behavior is verified separately.',
  );

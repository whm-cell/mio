import { documentCatalog, resolvePrd } from '../task-documents.ts';
import { readPage } from './output.ts';
import { readOptions } from './read-options.ts';
import { readBook } from './reports.ts';

/** Public snapshots stay readable without an author's member, state or original log directory. */
export async function readPublicResult(root: string, args: string[]) {
  const { positionals, options } = readOptions(args);
  if (positionals.length < 1 || positionals.length > 2)
    throw new Error('WORK_READ_RESULT: use read-result <prd> [key] with optional --select');
  const prd = resolvePrd(positionals[0]!, await documentCatalog(root));
  const { book } = await readBook(root, prd);
  const key = positionals[1];
  const command = ['read-result', positionals[0]!];
  if (key === undefined) {
    const results = book.results.map((result) => ({
      key: result.key,
      title: result.title,
      candidate: result.acceptance.candidate,
      read: ['read-result', positionals[0]!, result.key],
    }));
    return readPage(
      { prd, results },
      { ...options, select: options.select || '/results' },
      command,
    );
  }
  const result = book.results.find((entry) => entry.key === key);
  if (!result) throw new Error('WORK_READ_RESULT: result key not found');
  const summary = {
    key: result.key,
    title: result.title,
    candidate: result.acceptance.candidate,
    acceptance: result.acceptance,
    outcomes: result.outcomes,
    limitations: result.limitations,
    locations: result.locations,
    verification: result.verification,
  };
  return readPage({ summary, result }, { ...options, select: options.select || '/summary' }, [
    ...command,
    key,
  ]);
}

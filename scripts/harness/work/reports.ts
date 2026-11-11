import { stat } from 'node:fs/promises';
import { dirname, relative } from 'node:path';
import { format } from 'prettier';
import { beneath } from '../inventory.ts';
import { documentCatalog, resolvePrd, resolveDocument, resultDocument } from '../task-documents.ts';
import { checkedPath, digest, json } from './records.ts';
import type { Evidence, Task } from './records.ts';
import { fields, hashField, metadata, optionalText, record, textField } from './report-format.ts';
import {
  hasResultSelector,
  parseDetails,
  parseRecords,
  parseSelector,
  recordsPath,
  reportPath,
  resultSelector,
} from './compact-store.ts';
import type { ResultBook, ResultDetails } from './compact-store.ts';
import { automatedEvidence } from './evidence.ts';

export { hashField, metadata, optionalText, record, textField } from './report-format.ts';
export type { PublicResult, ResultBook } from './compact-store.ts';
export { reportPath } from './compact-store.ts';
type Catalog = Awaited<ReturnType<typeof documentCatalog>>;
export interface ResultDraft {
  version: 5;
  prd: string;
  candidate: string;
  result: ResultDetails;
  evidence: Evidence[];
}

export function bookPaths(prd: string, catalog: Catalog) {
  const identity = resolvePrd(prd, catalog);
  const { currentPath } = resolveDocument(identity, catalog);
  return {
    identity,
    currentPath,
    report: reportPath(currentPath),
    records: recordsPath(currentPath),
  };
}

/** Only the current result is an output; other results remain ordinary candidate inputs. */
export function deliveryOutput(task: Task, path: string, catalog: Catalog) {
  const target = task.plan.result;
  if (!target) return false;
  const paths = bookPaths(target.prd, catalog);
  if (hasResultSelector(path)) {
    const selector = parseSelector(path);
    return selector.path === paths.records && selector.key === target.key;
  }
  return path === paths.report;
}

async function sameMarkdown(actual: string, expected: string) {
  const options = { parser: 'markdown', printWidth: 100 };
  const [left, right] = await Promise.all([format(actual, options), format(expected, options)]);
  return left === right;
}

export async function validateLocations(root: string, result: ResultDetails, catalog: Catalog) {
  const allowed = [...Object.keys(catalog.config.sourceRoots), ...catalog.config.documentRoots];
  for (const { path } of result.locations) {
    if (
      !allowed.some((base) => beneath(path, base)) ||
      [...catalog.config.privateRoots, ...catalog.config.generatedRoots].some((base) =>
        beneath(path, base),
      ) ||
      !(await stat(await checkedPath(root, path))).isFile()
    )
      throw new Error(`WORK_REPORT_LOCATION: expected a public source or document file: ${path}`);
  }
}

export async function readBook(root: string, prd: string, catalog?: Catalog) {
  catalog ??= await documentCatalog(root);
  const paths = bookPaths(prd, catalog);
  const source = await optionalText(root, paths.report);
  const recordsSource = await optionalText(root, paths.records);
  if (source === null && recordsSource === null)
    return {
      book: { version: 5 as const, prd: paths.identity, results: [] },
      source,
      recordsSource,
    };
  if (source === null || recordsSource === null)
    throw new Error('WORK_REPORT_INTEGRITY: report/records pair missing');
  const navigation = record(metadata(source, 'mio-prd-results'));
  fields(navigation, ['version', 'prd', 'records']);
  if (navigation.version !== 5)
    throw new Error('WORK_REPORT_FORMAT: only public v5 report is supported');
  const records = record(navigation.records);
  fields(records, ['path', 'sha256']);
  if (
    navigation.prd !== paths.identity ||
    records.path !== paths.records ||
    recordsSource === null ||
    digest(recordsSource) !== hashField(records.sha256)
  )
    throw new Error('WORK_REPORT_INTEGRITY: report/records mismatch');
  const book = parseRecords(recordsSource);
  if (book.prd !== paths.identity) throw new Error('WORK_REPORT_BINDING: records PRD mismatch');
  if (!(await sameMarkdown(source, renderBook(book, paths.currentPath, recordsSource))))
    throw new Error('WORK_REPORT_INTEGRITY: report content differs from records');
  return { book, source, recordsSource };
}

// Input reading deliberately does not require the generated report: a journal may be
// between their writes. The records themselves must still have valid ownership and accepted entries.
async function checkedRecords(root: string, path: string, catalog?: Catalog) {
  const source = await optionalText(root, path);
  if (source === null) throw new Error(`WORK_INPUT_MISSING: ${path}`);
  const book = parseRecords(source);
  const paths = bookPaths(book.prd, catalog ?? (await documentCatalog(root)));
  if (paths.identity !== book.prd || paths.records !== path)
    throw new Error('WORK_REPORT_BINDING: records/PRD mismatch');
  return { book, paths };
}

export async function readResultInput(root: string, path: string, catalog?: Catalog) {
  if (!hasResultSelector(path)) return optionalText(root, path);
  const selector = parseSelector(path);
  const { book } = await checkedRecords(root, selector.path, catalog);
  const result = book.results.find((entry) => entry.key === selector.key);
  if (!result) throw new Error(`WORK_INPUT_MISSING: ${path}`);
  return json(result);
}

export async function compactInputs(root: string, path: string, task: Task, catalog?: Catalog) {
  const { book, paths } = await checkedRecords(root, path, catalog);
  return Object.fromEntries(
    book.results
      .filter(
        (entry) => !(book.prd === task.plan.result?.prd && entry.key === task.plan.result.key),
      )
      .map((entry) => [resultSelector(paths.currentPath, entry.key), digest(json(entry))]),
  );
}

export async function matchingEvidence(root: string, task: Task, candidate: string) {
  const selected: Evidence[] = [];
  for (const criterion of task.plan.acceptance) {
    const entries = task.evidence.filter(
      (item) =>
        item.criterion === criterion.id &&
        item.method === criterion.method &&
        item.candidate === candidate,
    );
    if (criterion.method === 'automated') {
      const observation = await automatedEvidence(root, task.plan.id, entries, criterion.command);
      if (observation.result !== 'pass') throw new Error(`WORK_DELIVERY_EVIDENCE: ${criterion.id}`);
      selected.push(...observation.evidence);
      continue;
    }
    const entry = entries.at(-1);
    if (!entry || entry.result !== 'pass')
      throw new Error(`WORK_DELIVERY_EVIDENCE: ${criterion.id}`);
    selected.push(entry);
  }
  return selected;
}

export function parseDraft(source: string): ResultDraft {
  const value = record(metadata(source, 'mio-result-draft'));
  if (value.version !== 5 || !Array.isArray(value.evidence))
    throw new Error('WORK_DELIVERY_OBSOLETE: prepare a new v5 draft');
  fields(value, ['version', 'prd', 'candidate', 'result', 'evidence']);
  return {
    version: 5,
    prd: textField(value.prd),
    candidate: hashField(value.candidate),
    result: parseDetails(value.result),
    evidence: value.evidence as Evidence[],
  };
}

export async function readDraft(root: string, task: Task, candidate: string) {
  const ref = task.delivery?.draft;
  if (task.delivery?.version !== 2 || !ref || ref.candidate !== candidate)
    throw new Error('WORK_DELIVERY_STALE: prepare the current result draft');
  const source = await optionalText(root, ref.path);
  if (source === null || digest(source) !== ref.sha256)
    throw new Error('WORK_DELIVERY_STALE: draft bytes changed');
  const draft = parseDraft(source);
  if (
    draft.prd !== task.plan.result?.prd ||
    draft.result.key !== task.plan.result.key ||
    draft.candidate !== candidate ||
    json(draft.evidence) !== json(await matchingEvidence(root, task, candidate)) ||
    !(await sameMarkdown(source, renderDraft(draft)))
  )
    throw new Error('WORK_DELIVERY_STALE: draft result/candidate/evidence mismatch');
  return draft;
}

const link = (from: string, to: string) =>
  relative(dirname(from), to)
    .replaceAll('\\', '/')
    .split('/')
    .map((part) =>
      encodeURIComponent(part).replace(
        /[!'()*]/g,
        (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join('/');
const label = (value: string) => value.replace(/[\\[\]`*_<>|]/g, '\\$&').replace(/\s+/g, ' ');

export function renderBook(book: ResultBook, currentPath: string, bytes = json(book)) {
  const path = reportPath(currentPath);
  const entries = book.results
    .map((result) => {
      const locations = result.locations
        .map((location) => `[${label(location.path)}](${link(path, location.path)})`)
        .join(' · ');
      return `## ${result.key}\n\n**${label(result.title)}**\n\n${locations}\n`;
    })
    .join('\n');
  return `# 已接受开发成果\n\nPRD：[当前需求](${link(path, currentPath)})。完成范围、接受结论、验证摘要与限制见[成果记录](records.json)，也可用 work read-result 按成果键读取。这里只导航已接受结果，不表示整份 PRD、当前源码或生产验收完成；不保存可恢复代码或详细证据。\n\n${entries}\n\`\`\`mio-prd-results\n${json({ version: 5, prd: book.prd, records: { path: recordsPath(currentPath), sha256: digest(bytes) } })}\`\`\`\n`;
}

export function renderDraft(draft: ResultDraft) {
  const result = draft.result;
  const locations = result.locations.map((entry) => `- ${entry.path}：${entry.purpose}`).join('\n');
  return `# 开发成果待接受草稿\n\n**${result.title}**\n\n${result.outcomes}\n\n${locations}\n\n验证：${result.verification}\n\n限制：${result.limitations}\n\n候选：${draft.candidate}。待针对本候选的真实结果接受。\n\n\`\`\`mio-result-draft\n${json(draft)}\`\`\`\n`;
}

export async function checkReports(root: string, files: readonly string[]) {
  if (!files.some(resultDocument)) return [];
  try {
    const catalog = await documentCatalog(root);
    const linked = new Set<string>();
    for (const entry of catalog.documents.filter((document) => document.kind === 'prd')) {
      const { book } = await readBook(root, entry.identity, catalog);
      const paths = bookPaths(entry.identity, catalog);
      linked.add(paths.report);
      linked.add(paths.records);
      for (const result of book.results) await validateLocations(root, result, catalog);
    }
    for (const path of files.filter((file) => resultDocument(file)))
      if (!linked.has(path)) throw new Error(`WORK_REPORT_ORPHAN: ${path}`);
    return [];
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
}

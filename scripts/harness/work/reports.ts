import { stat } from 'node:fs/promises';
import { dirname, relative } from 'node:path';
import { format } from 'prettier';
import { beneath } from '../inventory.ts';
import { documentCatalog, resolvePrd, resolveDocument, resultDocument } from '../task-documents.ts';
import { checkedPath, contractPlan, digest, json, sameCandidate } from './records.ts';
import type { Candidate, Evidence, ResultDetails, Task } from './records.ts';
import { optionalText } from './report-format.ts';
import {
  hasResultSelector,
  parseDetails,
  parseRecords,
  parseSelector,
  recordsPath,
  reportPath,
} from './compact-store.ts';
import type { ResultBook } from './compact-store.ts';
import { automatedEvidence } from './evidence.ts';
import { manualEvidenceResult } from './manual-evidence.ts';
import { artifact } from './original.ts';

type Catalog = Awaited<ReturnType<typeof documentCatalog>>;

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

/** A task cannot depend on its own result or its derived navigation. */
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

/** records.json is the accepted fact; a missing or stale report must not hide it. */
export async function readBook(root: string, prd: string, catalog?: Catalog) {
  catalog ??= await documentCatalog(root);
  const paths = bookPaths(prd, catalog);
  const recordsSource = await optionalText(root, paths.records);
  let source: string | null = null;
  let reportError: string | null = null;
  try {
    source = await optionalText(root, paths.report);
  } catch (error) {
    reportError = error instanceof Error ? error.message : String(error);
  }
  if (recordsSource === null && (source !== null || reportError !== null))
    throw new Error(`WORK_REPORT_INTEGRITY: records missing for ${paths.report}`);
  if (recordsSource === null)
    return {
      book: { version: 5 as const, prd: paths.identity, results: [] },
      source,
      recordsSource,
      reportError,
    };
  const book = parseRecords(recordsSource);
  if (book.prd !== paths.identity) throw new Error('WORK_REPORT_BINDING: records PRD mismatch');
  return { book, source, recordsSource, reportError };
}

export async function readResultInput(root: string, path: string, catalog?: Catalog) {
  if (!hasResultSelector(path)) return optionalText(root, path);
  const selector = parseSelector(path);
  const source = await optionalText(root, selector.path);
  if (source === null) throw new Error(`WORK_INPUT_MISSING: ${selector.path}`);
  const book = parseRecords(source);
  const paths = bookPaths(book.prd, catalog ?? (await documentCatalog(root)));
  if (paths.identity !== book.prd || paths.records !== selector.path)
    throw new Error('WORK_REPORT_BINDING: records/PRD mismatch');
  const result = book.results.find((entry) => entry.key === selector.key);
  if (!result) throw new Error(`WORK_INPUT_MISSING: ${path}`);
  return json(result);
}

/** Bind a draft to the originals selected by each current criterion. */
export async function matchingEvidence(root: string, task: Task, candidate: Candidate) {
  const selected: Evidence[] = [];
  for (const criterion of task.plan.acceptance) {
    const entries = task.evidence.filter(
      (item) =>
        item.criterion === criterion.id &&
        item.method === criterion.method &&
        sameCandidate(item.candidate, candidate),
    );
    if (criterion.method === 'automated') {
      const observation = await automatedEvidence(
        root,
        task.plan.id,
        entries,
        criterion.command,
        contractPlan(task),
      );
      if (observation.result !== 'pass') throw new Error(`WORK_DELIVERY_EVIDENCE: ${criterion.id}`);
      selected.push(...observation.evidence);
      continue;
    }
    const entry = entries.at(-1);
    if (!entry || entry.result !== 'pass')
      throw new Error(`WORK_DELIVERY_EVIDENCE: ${criterion.id}`);
    const bytes = await artifact(root, task.plan.id, entry.artifact);
    if (
      digest(bytes) !== entry.sha256 ||
      (await manualEvidenceResult(
        root,
        bytes.toString('utf8'),
        task,
        { candidate },
        criterion.id,
      )) !== 'pass'
    )
      throw new Error(`WORK_DELIVERY_EVIDENCE: ${criterion.id}`);
    selected.push(entry);
  }
  return selected;
}

export async function readDraft(root: string, task: Task, candidate: Candidate) {
  const draft = task.delivery?.draft;
  if (
    !draft ||
    !('id' in draft) ||
    !sameCandidate(draft.candidate, candidate) ||
    draft.prd !== task.plan.result?.prd ||
    draft.result.key !== task.plan.result.key
  )
    throw new Error('WORK_DELIVERY_STALE: prepare the current result draft');
  parseDetails(draft.result);
  if (json(draft.evidence) !== json(await matchingEvidence(root, task, candidate)))
    throw new Error('WORK_DELIVERY_STALE: draft evidence changed');
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

export function renderBook(book: ResultBook, currentPath: string) {
  const path = reportPath(currentPath);
  const entries = book.results
    .map((result) => {
      const locations = result.locations
        .map((location) => `[${label(location.path)}](${link(path, location.path)})`)
        .join(' · ');
      return `## ${result.key}\n\n**${label(result.title)}**\n\n${locations}\n`;
    })
    .join('\n');
  return `# 已接受开发成果\n\nPRD：[当前需求](${link(path, currentPath)})。完成范围、接受结论、验证摘要与限制见[成果记录](records.json)，也可用 work read-result 按成果键读取。这里只导航已接受结果，不表示整份 PRD、当前源码或生产验收完成；不保存可恢复代码或详细证据。\n\n${entries}\n\`\`\`mio-prd-results\n${json({ version: 5, prd: book.prd, records: { path: recordsPath(currentPath) } })}\`\`\`\n`;
}

export async function checkReports(root: string, files: readonly string[]) {
  if (!files.some(resultDocument)) return [];
  let catalog;
  try {
    catalog = await documentCatalog(root);
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
  const linked = new Set<string>();
  const errors: string[] = [];
  for (const entry of catalog.documents.filter((document) => document.kind === 'prd')) {
    try {
      const paths = bookPaths(entry.identity, catalog);
      linked.add(paths.report);
      linked.add(paths.records);
      const { book, source, recordsSource, reportError } = await readBook(
        root,
        entry.identity,
        catalog,
      );
      if (
        reportError !== null ||
        (recordsSource === null) !== (source === null) ||
        (recordsSource !== null &&
          (source === null || !(await sameMarkdown(source, renderBook(book, paths.currentPath)))))
      )
        errors.push(`WORK_REPORT_DRIFT: derive ${paths.report} from records`);
      for (const result of book.results) await validateLocations(root, result, catalog);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  for (const path of files.filter((file) => resultDocument(file)))
    if (!linked.has(path)) errors.push(`WORK_REPORT_ORPHAN: ${path}`);
  return [...new Set(errors)];
}

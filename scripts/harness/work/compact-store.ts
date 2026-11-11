import { dirname } from 'node:path';
import { identifier, json } from './records.ts';
import { fields, hashField, publicText, record, textField } from './report-format.ts';

/** Paths take the registered current PRD path, never its possibly historical identity. */
export function prdDirectory(currentPath: string) {
  if (!/^docs\/tasks\/[a-z0-9][a-z0-9_-]*\/prd\.md$/.test(currentPath))
    throw new Error('TASK_DOCUMENT_LOCATION: use docs/tasks/<stable-name>/prd.md');
  return dirname(currentPath);
}
export const reportPath = (currentPath: string) =>
  `${prdDirectory(currentPath)}/complete/report.md`;
export const recordsPath = (currentPath: string) =>
  `${prdDirectory(currentPath)}/complete/records.json`;
export const resultSelector = (currentPath: string, key: string) =>
  `${recordsPath(currentPath)}#result=${identifier(key)}`;
export const hasResultSelector = (value: string) =>
  value.includes('/records.json#') || value.includes('#result');
export const recordsFile = (path: string) =>
  /^docs\/tasks\/[a-z0-9][a-z0-9_-]*\/complete\/records\.json$/.test(path);

export function parseSelector(value: string) {
  const match =
    /^(docs\/tasks\/[a-z0-9][a-z0-9_-]*\/complete\/records\.json)#result=([a-z0-9][a-z0-9_-]{0,79})$/.exec(
      value,
    );
  if (!match) throw new Error(`WORK_REPORT_SELECTOR: ${value}`);
  return { path: match[1]!, key: match[2]! };
}

export interface ResultDetails {
  key: string;
  title: string;
  outcomes: string;
  locations: { path: string; purpose: string }[];
  verification: string;
  limitations: string;
}
export interface PublicResult extends ResultDetails {
  acceptance: { candidate: string; statement: string; reference: string };
}
export interface ResultBook {
  version: 5;
  prd: string;
  results: PublicResult[];
}

export function parseDetails(value: unknown): ResultDetails {
  const result = record(value);
  fields(result, ['key', 'title', 'outcomes', 'locations', 'verification', 'limitations']);
  identifier(textField(result.key));
  for (const key of ['title', 'outcomes', 'verification', 'limitations']) textField(result[key]);
  if (!Array.isArray(result.locations) || !result.locations.length)
    throw new Error('WORK_REPORT_FORMAT: locations required');
  const seen = new Set<string>();
  for (const item of result.locations) {
    const location = record(item);
    fields(location, ['path', 'purpose']);
    const path = textField(location.path);
    textField(location.purpose);
    if (
      seen.has(path) ||
      !/^(?:src|scripts|tests|docs)\//.test(path) ||
      path.includes('\\') ||
      path.split('/').some((part) => !part || part === '.' || part === '..') ||
      path.split('/').some((part) => part.startsWith('.'))
    )
      throw new Error(`WORK_REPORT_LOCATION: ${path}`);
    seen.add(path);
  }
  publicText(json(result));
  return result as unknown as ResultDetails;
}

export function parseAcceptance(value: unknown): PublicResult['acceptance'] {
  const acceptance = record(value);
  fields(acceptance, ['candidate', 'statement', 'reference']);
  hashField(acceptance.candidate);
  textField(acceptance.statement);
  textField(acceptance.reference);
  publicText(json(acceptance));
  return acceptance as PublicResult['acceptance'];
}

export function parseRecords(source: string): ResultBook {
  const value = record(JSON.parse(source));
  fields(value, ['version', 'prd', 'results']);
  if (value.version !== 5 || !Array.isArray(value.results))
    throw new Error('WORK_REPORT_FORMAT: only public v5 records are supported');
  const prd = textField(value.prd);
  const seen = new Set<string>();
  const results = value.results.map((item) => {
    const { acceptance, ...details } = record(item);
    const result = { ...parseDetails(details), acceptance: parseAcceptance(acceptance) };
    if (seen.has(result.key)) throw new Error('WORK_REPORT_FORMAT: duplicate result key');
    seen.add(result.key);
    return result;
  });
  return { version: 5, prd, results };
}

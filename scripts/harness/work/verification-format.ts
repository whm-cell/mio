import { digest, identifier, json } from './records.ts';
import type { Checkpoint } from './records.ts';

export interface Conditions {
  dependencies: string;
  configuration: string;
  external: string;
}
export interface EnvironmentSnapshot {
  runtime: string;
  files: Record<string, string | null>;
  variables: string;
  conditions: Conditions | null;
}

export interface EvidenceRef {
  task: string;
  criterion: string;
  sha256: string;
}
export interface Coverage {
  path: string;
  disposition: 'retain' | 'retest';
  reason: string;
  runs: EvidenceRef[];
}
export interface Resolution {
  issue: EvidenceRef;
  reason: string;
  runs: EvidenceRef[];
}
export interface Verification {
  kind: 'mio-verification';
  version: 1;
  mode: 'reuse' | 'incremental';
  target: { task: string; criterion: string; command: string[] };
  checkpoint: Checkpoint;
  baseline: EvidenceRef;
  legacyCheckpoint?: Checkpoint;
  environment: {
    identity: string;
    reason: string;
    conditions: Conditions;
    snapshot: EnvironmentSnapshot;
  };
  legacyEnvironment?: { snapshot: EnvironmentSnapshot; reason: string };
  coverage: string;
  impact: Coverage[];
  runs: EvidenceRef[];
  resolves: Resolution[];
  priorIssues: EvidenceRef[];
  priorBoundary?: { ref: EvidenceRef; checkpoint: Checkpoint };
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('WORK_VERIFY_FORMAT: object required');
  return value as Record<string, unknown>;
}
export function nonempty(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim())
    throw new Error('WORK_VERIFY_FORMAT: nonempty text required');
}
export function stringArray(value: unknown): asserts value is string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))
    throw new Error('WORK_VERIFY_FORMAT: string array required');
}
export function reference(value: unknown): EvidenceRef {
  const ref = object(value);
  nonempty(ref.task);
  identifier(ref.task);
  nonempty(ref.criterion);
  if (typeof ref.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(ref.sha256))
    throw new Error('WORK_VERIFY_REF: SHA256 required');
  return { task: ref.task, criterion: ref.criterion, sha256: ref.sha256 };
}
export function checkpoint(value: unknown): Checkpoint {
  const item = object(value);
  const files = object(item.files);
  if (
    Object.entries(files).some(
      ([path, hash]) => !path || typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash),
    )
  )
    throw new Error('WORK_VERIFY_SNAPSHOT: invalid file hashes');
  if (
    typeof item.contract !== 'string' ||
    !/^[a-f0-9]{64}$/.test(item.contract) ||
    item.candidate !== digest(json({ files, contract: item.contract }))
  )
    throw new Error('WORK_VERIFY_SNAPSHOT: candidate does not match snapshot');
  return item as unknown as Checkpoint;
}
export const refKey = (ref: EvidenceRef) => `${ref.task}:${ref.criterion}:${ref.sha256}`;
export function changedFiles(before: Checkpoint, after: Checkpoint): string[] {
  return [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])]
    .filter((path) => before.files[path] !== after.files[path])
    .sort();
}
export function verification(value: unknown): Verification {
  const doc = object(value);
  if (
    doc.kind !== 'mio-verification' ||
    doc.version !== 1 ||
    !['reuse', 'incremental'].includes(String(doc.mode))
  )
    throw new Error('WORK_VERIFY_FORMAT: unsupported receipt');
  const target = object(doc.target);
  nonempty(target.task);
  identifier(target.task);
  nonempty(target.criterion);
  stringArray(target.command);
  if (!target.command.length) throw new Error('WORK_VERIFY_FORMAT: declared command required');
  checkpoint(doc.checkpoint);
  reference(doc.baseline);
  if (doc.legacyCheckpoint !== undefined) checkpoint(doc.legacyCheckpoint);
  if (doc.priorBoundary !== undefined) {
    const boundary = object(doc.priorBoundary);
    reference(boundary.ref);
    checkpoint(boundary.checkpoint);
  }
  const environment = object(doc.environment);
  nonempty(environment.identity);
  nonempty(environment.reason);
  nonempty(doc.coverage);
  for (const key of ['impact', 'runs', 'resolves', 'priorIssues'])
    if (!Array.isArray(doc[key])) throw new Error(`WORK_VERIFY_FORMAT: ${key} array required`);
  for (const ref of [...(doc.runs as unknown[]), ...(doc.priorIssues as unknown[])]) reference(ref);
  for (const raw of doc.impact as unknown[]) {
    const item = object(raw);
    nonempty(item.path);
    nonempty(item.reason);
    if (!['retain', 'retest'].includes(String(item.disposition)) || !Array.isArray(item.runs))
      throw new Error('WORK_VERIFY_FORMAT: invalid impact');
    item.runs.forEach(reference);
  }
  for (const raw of doc.resolves as unknown[]) {
    const item = object(raw);
    reference(item.issue);
    nonempty(item.reason);
    if (!Array.isArray(item.runs) || !item.runs.length)
      throw new Error('WORK_VERIFY_FORMAT: resolution requires reruns');
    item.runs.forEach(reference);
  }
  return doc as unknown as Verification;
}

import { digest, json } from './records.ts';
import type { Evidence } from './records.ts';
import { artifact } from './original.ts';
import { evidenceRef, observe } from './verification-proof.ts';
import { captureEnvironment, environmentSnapshot } from './verification-environment.ts';
export { artifact } from './original.ts';

/** Select the complete check and later probes together, for assessment and delivery binding. */
export async function automatedEvidence(
  root: string,
  id: string,
  entries: Evidence[],
  command?: string[],
) {
  if (!command) return { result: 'pending', evidence: [] };
  let newerIssue: string | undefined;
  const selected: Evidence[] = [];
  for (const entry of entries.toReversed()) {
    selected.push(entry);
    let bytes: Buffer;
    try {
      bytes = await artifact(root, id, entry.artifact);
    } catch {
      newerIssue ??= 'missing';
      continue;
    }
    if (digest(bytes) !== entry.sha256) {
      newerIssue ??= 'corrupt';
      continue;
    }
    try {
      if (entry.artifact.endsWith('.verification.json')) {
        const observation = await observe(root, evidenceRef(id, entry));
        if (json(observation.command) !== json(command))
          throw new Error('Receipt command mismatch');
        if (
          !observation.environmentSnapshot ||
          json(await captureEnvironment(root, observation.environmentSnapshot.conditions)) !==
            json(observation.environmentSnapshot)
        )
          throw new Error('Current environment differs from the verified receipt');
        return {
          result: observation.issues.length ? 'pending' : (newerIssue ?? 'pass'),
          evidence: selected.toReversed(),
          basis: observation.kind,
        };
      }
      // work run writes one pretty-printed JSON header before stdout/stderr.
      const source = bytes.toString('utf8');
      const header = JSON.parse(source.slice(0, source.indexOf('\n}\n') + 2));
      if (
        header.candidate !== entry.candidate ||
        !Array.isArray(header.argv) ||
        !header.argv.length ||
        header.argv.some((arg: unknown) => typeof arg !== 'string')
      )
        throw new Error('Invalid automated observation header');
      if (json(header.argv) === json(command)) {
        if (header.environmentSnapshot) {
          const environment = environmentSnapshot(header.environmentSnapshot);
          if (json(await captureEnvironment(root, environment.conditions)) !== json(environment))
            throw new Error('Current environment differs from the execution');
        }
        return {
          result: entry.result === 'pass' ? (newerIssue ?? 'pass') : entry.result,
          evidence: selected.toReversed(),
          basis: 'execution',
        };
      }
      if (entry.result !== 'pass') newerIssue ??= entry.result;
    } catch {
      newerIssue ??= 'invalid';
    }
  }
  return { result: newerIssue ?? 'pending', evidence: selected.toReversed() };
}

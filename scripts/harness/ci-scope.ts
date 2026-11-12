import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';

type Event = {
  before?: string;
  after?: string;
  ref?: string;
  forced?: boolean;
  repository?: { default_branch?: string };
  pull_request?: { base: { sha: string }; head: { sha: string } };
};

function selectScope() {
  const full = (reason: string) => ({ mode: 'full', reason });
  const { GITHUB_EVENT_NAME: name, GITHUB_REF: ref, GITHUB_SHA: sha } = process.env;
  if (name !== 'push' && name !== 'pull_request') return full('event requires full checks');
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH!, 'utf8')) as Event;
  if (ref === 'refs/heads/main' || ref === `refs/heads/${event.repository?.default_branch}`)
    return full('integration branch');
  if (!sha || !/^[a-f0-9]{40}$/.test(sha)) return full('missing or invalid candidate');
  const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' });
  if (git('rev-parse', 'HEAD').trim() !== sha) return full('checkout differs from event');

  let base: string | undefined;
  if (name === 'push') {
    if (!ref?.startsWith('refs/heads/') || event.ref !== ref || event.after !== sha || event.forced)
      return full('not a matching branch push');
    base = event.before;
  } else {
    if (!/^refs\/pull\/\d+\/merge$/.test(ref ?? '')) return full('not a PR merge candidate');
    const parents = git('rev-list', '--parents', '-n', '1', sha).trim().split(' ');
    if (
      parents.length !== 3 ||
      parents[1] !== event.pull_request?.base.sha ||
      parents[2] !== event.pull_request?.head.sha
    )
      return full('PR merge parents differ from event');
    base = parents[1];
  }
  if (!base || !/^[a-f0-9]{40}$/.test(base) || /^0+$/.test(base))
    return full('missing comparison commit');
  // Disabling rename detection retains both sides of moves across the allowed boundary.
  const files = git('diff', '--no-renames', '--name-only', '-z', base, sha, '--')
    .split('\0')
    .filter(Boolean);
  const documents = new Set([
    'docs/coordination.md',
    'docs/work-records.md',
    'docs/engineering/testing.md',
  ]);
  const harnessOnly =
    files.length > 0 &&
    files.every(
      (path) =>
        path !== 'scripts/harness/ci-scope.ts' &&
        path !== 'scripts/harness/validation-entry.ts' &&
        !path.endsWith('.config.ts') &&
        (/^(scripts|tests)\/harness\/.+\.ts$/.test(path) || documents.has(path)),
    );
  return {
    mode: harnessOnly ? 'harness' : 'full',
    reason: harnessOnly ? 'only reviewed harness paths' : 'empty, shared or unclassified changes',
    base,
    head: sha,
    files: files.length,
  };
}

let selection;
try {
  selection = selectScope();
} catch (error) {
  selection = { mode: 'full', reason: `comparison unavailable: ${String(error)}` };
}
console.log(JSON.stringify(selection));
if (process.env.GITHUB_OUTPUT)
  appendFileSync(process.env.GITHUB_OUTPUT, `mode=${selection.mode}\n`);

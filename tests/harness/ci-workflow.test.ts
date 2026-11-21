import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

interface WorkflowStep {
  name?: string;
  id?: string;
  if?: string;
  uses?: string;
  run?: string;
  with: Record<string, string>;
}

interface WorkflowJob {
  name: string;
  raw: string;
  runsOn?: string;
  needs: string[];
  if?: string;
  timeoutMinutes?: number;
  env: Record<string, string>;
  services: Record<string, { image?: string }>;
  steps: WorkflowStep[];
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  )
    return trimmed.slice(1, -1);
  return trimmed;
}

function parseNeeds(value: string): string[] {
  const trimmed = value.trim();
  if (trimmed.startsWith('[') && trimmed.endsWith(']'))
    return trimmed
      .slice(1, -1)
      .split(',')
      .map((item) => unquote(item))
      .filter(Boolean);
  return trimmed ? [unquote(trimmed)] : [];
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/**
 * Structurally parse GitHub Actions `jobs:` blocks and their steps without external YAML packages.
 * Fails loudly if indentation or step structure diverges from expected GitHub Actions syntax.
 */
function parseWorkflowJobs(yaml: string): Map<string, WorkflowJob> {
  const lines = yaml.replace(/\r\n/g, '\n').split('\n');
  const jobsLine = lines.findIndex((line) => line.trim() === 'jobs:' && indentOf(line) === 0);
  expect(jobsLine, 'workflow must contain a top-level jobs: section').toBeGreaterThanOrEqual(0);

  const jobStarts: { name: string; start: number }[] = [];
  for (let i = jobsLine + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const indent = indentOf(line);
    if (indent === 0) break;
    if (indent === 2 && /^[A-Za-z0-9_-]+:\s*$/.test(line.trim())) {
      jobStarts.push({ name: line.trim().slice(0, -1), start: i });
    }
  }

  const jobs = new Map<string, WorkflowJob>();
  for (let index = 0; index < jobStarts.length; index++) {
    const { name, start } = jobStarts[index]!;
    const end = index + 1 < jobStarts.length ? jobStarts[index + 1]!.start : lines.length;
    const slice = lines.slice(start + 1, end);
    const job: WorkflowJob = {
      name,
      raw: lines.slice(start, end).join('\n'),
      needs: [],
      env: {},
      services: {},
      steps: [],
    };

    let section: 'root' | 'env' | 'services' | 'steps' | 'other' = 'root';
    let currentService: string | null = null;
    let currentStep: WorkflowStep | null = null;
    let inStepWith = false;

    for (let i = 0; i < slice.length; i++) {
      const line = slice[i]!;
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const indent = indentOf(line);

      if (indent === 4) {
        currentService = null;
        currentStep = null;
        inStepWith = false;
        const match = /^([A-Za-z0-9_-]+):(?:\s*(.*))?$/.exec(trimmed);
        if (!match) continue;
        const [, key, rest = ''] = match;
        if (key === 'runs-on') {
          job.runsOn = unquote(rest);
          section = 'root';
        } else if (key === 'needs') {
          job.needs = parseNeeds(rest);
          section = rest ? 'root' : 'other';
        } else if (key === 'if') {
          job.if = rest.trim();
          section = 'root';
        } else if (key === 'timeout-minutes') {
          job.timeoutMinutes = Number(rest.trim());
          section = 'root';
        } else if (key === 'env') {
          section = 'env';
        } else if (key === 'services') {
          section = 'services';
        } else if (key === 'steps') {
          section = 'steps';
        } else {
          section = 'other';
        }
        continue;
      }

      if (section === 'env' && indent === 6) {
        const match = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(trimmed);
        if (match) job.env[match[1]!] = unquote(match[2]!);
        continue;
      }

      if (section === 'services') {
        if (indent === 6 && /^[A-Za-z0-9_-]+:\s*$/.test(trimmed)) {
          currentService = trimmed.slice(0, -1);
          job.services[currentService] = {};
        } else if (indent === 8 && currentService && trimmed.startsWith('image:')) {
          job.services[currentService]!.image = unquote(trimmed.slice('image:'.length));
        }
        continue;
      }

      if (section === 'steps') {
        if (indent === 6 && trimmed.startsWith('- ')) {
          currentStep = { with: {} };
          job.steps.push(currentStep);
          inStepWith = false;
          const rest = trimmed.slice(2).trim();
          const field = /^([A-Za-z0-9_-]+):(?:\s*(.*))?$/.exec(rest);
          if (field) {
            const [, key, value = ''] = field;
            if (key === 'run' && value === '|') {
              const block: string[] = [];
              while (i + 1 < slice.length) {
                const next = slice[i + 1]!;
                if (next.trim() && indentOf(next) <= 8) break;
                block.push(next.length >= 10 ? next.slice(10) : next.trimStart());
                i++;
              }
              currentStep.run = block.join('\n').trimEnd();
            } else if (
              key === 'name' ||
              key === 'id' ||
              key === 'if' ||
              key === 'uses' ||
              key === 'run'
            ) {
              currentStep[key] = unquote(value);
            }
          }
          continue;
        }

        if (currentStep && indent === 8) {
          inStepWith = false;
          const field = /^([A-Za-z0-9_-]+):(?:\s*(.*))?$/.exec(trimmed);
          if (!field) continue;
          const [, key, value = ''] = field;
          if (key === 'with') {
            inStepWith = true;
          } else if (key === 'run' && value === '|') {
            const block: string[] = [];
            while (i + 1 < slice.length) {
              const next = slice[i + 1]!;
              if (next.trim() && indentOf(next) <= 8) break;
              block.push(next.length >= 10 ? next.slice(10) : next.trimStart());
              i++;
            }
            currentStep.run = block.join('\n').trimEnd();
          } else if (
            key === 'name' ||
            key === 'id' ||
            key === 'if' ||
            key === 'uses' ||
            key === 'run'
          ) {
            currentStep[key] = unquote(value);
          }
          continue;
        }

        if (currentStep && inStepWith && indent === 10) {
          const field = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(trimmed);
          if (field) currentStep.with[field[1]!] = unquote(field[2]!);
        }
      }
    }

    jobs.set(name, job);
  }
  return jobs;
}

const workflowPath = resolve('.github/workflows/check.yml');
const workflowYaml = readFileSync(workflowPath, 'utf8');
const jobs = parseWorkflowJobs(workflowYaml);

describe('Foundation checks CI workflow contract', () => {
  it('defines the exact parallel scope/harness/service/check topology with version-pinned runners and zero apt-get', () => {
    expect([...jobs.keys()]).toEqual(['scope', 'harness', 'service', 'check']);
    expect(workflowYaml).not.toContain('ubuntu-latest');
    expect(workflowYaml).not.toMatch(/\bapt-get\b/);

    for (const [name, job] of jobs) {
      expect(job.runsOn, `job ${name} must pin a specific Ubuntu LTS runner`).toBe('ubuntu-24.04');
      expect(job.timeoutMinutes, `job ${name} must declare timeout-minutes`).toBeGreaterThan(0);
    }
  });

  it('digest-pins every Docker image reference and caches FFmpeg 8.0.1 and Redis 8.2.11 with integrity checks', () => {
    const digestPattern = /@sha256:[a-f0-9]{64}$/;

    // Every service container image must be digest-pinned.
    for (const [name, job] of jobs) {
      for (const [serviceName, service] of Object.entries(job.services)) {
        expect(service.image, `${name}.services.${serviceName}`).toMatch(digestPattern);
      }
    }

    // Every docker create/run/pull image reference in run steps must be digest-pinned.
    const dockerImageRefs: string[] = [];
    for (const job of jobs.values()) {
      for (const step of job.steps) {
        if (!step.run) continue;
        for (const match of step.run.matchAll(/\bdocker\s+(?:create|run|pull)\b[^\n]*/g)) {
          const tokens = match[0].trim().split(/\s+/);
          const image = tokens.at(-1)!;
          dockerImageRefs.push(image);
          expect(image, `docker image in ${job.name}`).toMatch(digestPattern);
        }
      }
    }
    expect(dockerImageRefs).toContain(
      'mwader/static-ffmpeg:8.0.1@sha256:252705ff88532fa338e7065c21792756552f8fe7c212f84bc503d3c340689594',
    );

    const service = jobs.get('service')!;
    const cacheSteps = service.steps.filter((step) => step.uses === 'actions/cache@v4');
    expect(cacheSteps.map((step) => step.id)).toEqual(['ffmpeg-cache', 'redis-cache']);
    expect(cacheSteps[0]!.with.path).toBe('~/.cache/mio-ci/ffmpeg-8.0.1');
    expect(cacheSteps[0]!.with.key).toContain('mio-ffmpeg-8.0.1-');
    expect(cacheSteps[1]!.with.path).toBe('~/.cache/mio-ci/redis-8.2.11');
    expect(cacheSteps[1]!.with.key).toContain('mio-redis-8.2.11-');

    const ffmpegExtract = service.steps.find((step) =>
      step.run?.includes('mwader/static-ffmpeg:8.0.1@sha256:'),
    );
    expect(ffmpegExtract?.if).toBe("steps.ffmpeg-cache.outputs.cache-hit != 'true'");
    expect(ffmpegExtract?.run).toContain('docker cp');
    expect(ffmpegExtract?.run).toContain('trap');

    const ffmpegVerify = service.steps.find((step) => step.run?.includes('$GITHUB_PATH'));
    expect(ffmpegVerify?.run).toContain('ffmpeg -version');
    expect(ffmpegVerify?.run).toContain('ffprobe -version');
    expect(ffmpegVerify?.run).toContain('libx264');
    expect(ffmpegVerify?.run).toContain('aac');

    const redisBuild = service.steps.find((step) =>
      step.run?.includes('https://download.redis.io/releases/redis-8.2.11.tar.gz'),
    );
    expect(redisBuild?.if).toBe("steps.redis-cache.outputs.cache-hit != 'true'");
    expect(redisBuild?.run).toContain(
      'fba14b77c4bdcb2d5418b6741fc0cdaac4b78bc73eab9b2e5f3c255d597f16fa',
    );
    expect(redisBuild?.run).toContain('sha256sum -c -');

    const redisVerify = service.steps.find((step) => step.run?.includes('MIO_TEST_REDIS_SERVER='));
    expect(redisVerify?.run).toContain('v=8.2.11');
    expect(redisVerify?.run).toContain('$GITHUB_ENV');
  });

  it('splits harness static/test checks and service pre-pack/test/smoke cleanly across parallel jobs', () => {
    const scope = jobs.get('scope')!;
    const checkoutStep = scope.steps.find((step) => step.uses === 'actions/checkout@v4');
    expect(checkoutStep?.with['fetch-depth']).toBe('0');
    expect(scope.steps.some((step) => step.run?.includes('node scripts/harness/ci-scope.ts'))).toBe(
      true,
    );

    const harness = jobs.get('harness')!;
    expect(harness.needs).toEqual(['scope']);
    expect(harness.if).toBe('${{ !cancelled() }}');
    expect(harness.env.VITEST_MAX_WORKERS).toBe('4');
    expect(Object.keys(harness.services)).toEqual(['postgres']);
    expect(harness.raw).not.toContain('ffmpeg');
    expect(harness.raw).not.toContain('redis');
    const harnessRuns = harness.steps.map((step) => step.run ?? '');
    expect(harnessRuns.some((cmd) => cmd.includes('pnpm check:static:base'))).toBe(true);
    expect(
      harnessRuns.some((cmd) =>
        cmd.includes('node scripts/harness/validation-entry.ts ci-group harness'),
      ),
    ).toBe(true);

    const service = jobs.get('service')!;
    expect(service.needs).toEqual(['scope']);
    expect(service.if).toBe(
      "${{ !cancelled() && (needs.scope.result != 'success' || needs.scope.outputs.mode != 'harness') }}",
    );
    expect(service.env.VITEST_MAX_WORKERS).toBe('4');
    expect(Object.keys(service.services)).toEqual(['postgres', 'rabbitmq']);
    expect(service.services.postgres?.image).toBe(harness.services.postgres?.image);
    expect(service.services.rabbitmq?.image).toMatch(/^rabbitmq:4\.4\.0-management@sha256:/);
    expect(workflowYaml).toContain(
      'MIO_TEST_RABBITMQ_CONTAINER_ID: ${{ job.services.rabbitmq.id }}',
    );

    const prepackIndex = service.steps.findIndex((step) =>
      step.run?.includes('MIO_TEST_PACKED_ARCHIVE='),
    );
    const testIndex = service.steps.findIndex((step) =>
      step.run?.includes('node scripts/harness/validation-entry.ts ci-group service'),
    );
    const smokeIndex = service.steps.findIndex(
      (step) => step.run?.includes('pnpm build') && step.run?.includes('pnpm test:smoke'),
    );
    expect(prepackIndex).toBeGreaterThan(-1);
    expect(testIndex).toBeGreaterThan(prepackIndex);
    expect(smokeIndex).toBeGreaterThan(testIndex);
    expect(service.steps[prepackIndex]!.run).toContain('pnpm build');
    expect(service.steps[prepackIndex]!.run).toContain('npm pack --ignore-scripts');
  });

  it('executes the check aggregator gate and enforces strict upstream success or expected harness-only skip', () => {
    const check = jobs.get('check')!;
    expect(check.needs).toEqual(['scope', 'harness', 'service']);
    expect(check.if).toBe('${{ always() }}');
    expect(check.env).toEqual({
      SCOPE_RESULT: '${{ needs.scope.result }}',
      SCOPE_MODE: '${{ needs.scope.outputs.mode }}',
      HARNESS_RESULT: '${{ needs.harness.result }}',
      SERVICE_RESULT: '${{ needs.service.result }}',
    });
    const gateScript = check.steps[0]?.run;
    expect(gateScript).toBeTruthy();

    const runGate = (env: {
      SCOPE_RESULT: string;
      SCOPE_MODE: string;
      HARNESS_RESULT: string;
      SERVICE_RESULT: string;
    }) =>
      spawnSync('bash', ['-c', gateScript!], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '', ...env },
      });

    // Only these two exact combinations may pass the canonical `check` gate.
    for (const passing of [
      {
        SCOPE_RESULT: 'success',
        SCOPE_MODE: 'full',
        HARNESS_RESULT: 'success',
        SERVICE_RESULT: 'success',
      },
      {
        SCOPE_RESULT: 'success',
        SCOPE_MODE: 'harness',
        HARNESS_RESULT: 'success',
        SERVICE_RESULT: 'skipped',
      },
    ]) {
      const outcome = runGate(passing);
      expect(outcome.status, JSON.stringify({ passing, stderr: outcome.stderr })).toBe(0);
    }

    // Any failure, cancellation, unexpected skip, or ambiguous mode must fail closed.
    for (const failing of [
      {
        SCOPE_RESULT: 'failure',
        SCOPE_MODE: 'full',
        HARNESS_RESULT: 'success',
        SERVICE_RESULT: 'success',
      },
      {
        SCOPE_RESULT: 'cancelled',
        SCOPE_MODE: 'full',
        HARNESS_RESULT: 'success',
        SERVICE_RESULT: 'success',
      },
      {
        SCOPE_RESULT: 'success',
        SCOPE_MODE: 'full',
        HARNESS_RESULT: 'failure',
        SERVICE_RESULT: 'success',
      },
      {
        SCOPE_RESULT: 'success',
        SCOPE_MODE: 'full',
        HARNESS_RESULT: 'cancelled',
        SERVICE_RESULT: 'success',
      },
      {
        SCOPE_RESULT: 'success',
        SCOPE_MODE: 'full',
        HARNESS_RESULT: 'skipped',
        SERVICE_RESULT: 'success',
      },
      {
        SCOPE_RESULT: 'success',
        SCOPE_MODE: 'full',
        HARNESS_RESULT: 'success',
        SERVICE_RESULT: 'failure',
      },
      {
        SCOPE_RESULT: 'success',
        SCOPE_MODE: 'full',
        HARNESS_RESULT: 'success',
        SERVICE_RESULT: 'cancelled',
      },
      {
        SCOPE_RESULT: 'success',
        SCOPE_MODE: 'full',
        HARNESS_RESULT: 'success',
        SERVICE_RESULT: 'skipped',
      },
      {
        SCOPE_RESULT: 'success',
        SCOPE_MODE: '',
        HARNESS_RESULT: 'success',
        SERVICE_RESULT: 'skipped',
      },
      {
        SCOPE_RESULT: 'success',
        SCOPE_MODE: 'unknown',
        HARNESS_RESULT: 'success',
        SERVICE_RESULT: 'skipped',
      },
      {
        SCOPE_RESULT: 'success',
        SCOPE_MODE: 'harness',
        HARNESS_RESULT: 'failure',
        SERVICE_RESULT: 'skipped',
      },
      {
        SCOPE_RESULT: 'success',
        SCOPE_MODE: 'harness',
        HARNESS_RESULT: 'success',
        SERVICE_RESULT: 'failure',
      },
      {
        SCOPE_RESULT: 'success',
        SCOPE_MODE: 'harness',
        HARNESS_RESULT: 'success',
        SERVICE_RESULT: 'cancelled',
      },
      {
        SCOPE_RESULT: 'success',
        SCOPE_MODE: 'harness',
        HARNESS_RESULT: 'success',
        SERVICE_RESULT: 'success',
      },
    ]) {
      const outcome = runGate(failing);
      expect(outcome.status, JSON.stringify({ failing, stdout: outcome.stdout })).not.toBe(0);
    }
  });
});

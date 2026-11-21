import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

interface WorkflowStep {
  id?: string;
  if?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string | number>;
  with?: Record<string, string | number>;
}

interface WorkflowJob {
  'runs-on': string;
  'timeout-minutes': number;
  needs?: string | string[];
  if?: string;
  env?: Record<string, string | number>;
  services?: Record<string, { image: string }>;
  steps: WorkflowStep[];
}

function workflowJobs(source: string): Record<string, WorkflowJob> {
  return (parse(source) as { jobs: Record<string, WorkflowJob> }).jobs;
}

function needs(job: WorkflowJob) {
  return [job.needs ?? []].flat();
}

const workflowPath = resolve('.github/workflows/check.yml');
const workflowYaml = readFileSync(workflowPath, 'utf8');
const jobs = workflowJobs(workflowYaml);

describe('Foundation checks CI workflow contract', () => {
  it('defines the exact parallel scope/harness/service/check topology with version-pinned runners and zero apt-get', () => {
    expect(Object.keys(jobs)).toEqual(['scope', 'harness', 'service', 'check']);
    expect(workflowYaml).not.toContain('ubuntu-latest');
    expect(workflowYaml).not.toMatch(/\bapt-get\b/);

    for (const [name, job] of Object.entries(jobs)) {
      expect(job['runs-on'], `job ${name} must pin a specific Ubuntu LTS runner`).toBe(
        'ubuntu-24.04',
      );
      expect(job['timeout-minutes'], `job ${name} must declare timeout-minutes`).toBeGreaterThan(0);
    }
  });

  it('digest-pins every Docker image reference and caches FFmpeg 8.0.1 and Redis 8.2.11 with integrity checks', () => {
    const digestPattern = /@sha256:[a-f0-9]{64}$/;

    // Every service container image must be digest-pinned.
    for (const [name, job] of Object.entries(jobs)) {
      for (const [serviceName, service] of Object.entries(job.services ?? {})) {
        expect(service.image, `${name}.services.${serviceName}`).toMatch(digestPattern);
      }
    }

    // Every docker create/run/pull image reference in run steps must be digest-pinned.
    const dockerImageRefs: string[] = [];
    for (const [name, job] of Object.entries(jobs)) {
      for (const step of job.steps) {
        if (!step.run) continue;
        for (const match of step.run.matchAll(/\bdocker\s+(?:create|run|pull)\b[^\n]*/g)) {
          const tokens = match[0].trim().split(/\s+/);
          const image = tokens.at(-1)!;
          dockerImageRefs.push(image);
          expect(image, `docker image in ${name}`).toMatch(digestPattern);
        }
      }
    }
    expect(dockerImageRefs).toContain(
      'mwader/static-ffmpeg:8.0.1@sha256:252705ff88532fa338e7065c21792756552f8fe7c212f84bc503d3c340689594',
    );

    const service = jobs.service!;
    const cacheSteps = service.steps.filter((step) => step.uses === 'actions/cache@v4');
    expect(cacheSteps.map((step) => step.id)).toEqual(['ffmpeg-cache', 'redis-cache']);
    expect(cacheSteps[0]!.with?.path).toBe('~/.cache/mio-ci/ffmpeg-8.0.1');
    expect(cacheSteps[0]!.with?.key).toContain('mio-ffmpeg-8.0.1-');
    expect(cacheSteps[1]!.with?.path).toBe('~/.cache/mio-ci/redis-8.2.11');
    expect(cacheSteps[1]!.with?.key).toContain('mio-redis-8.2.11-');

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
    const scope = jobs.scope!;
    const checkoutStep = scope.steps.find((step) => step.uses === 'actions/checkout@v4');
    expect(String(checkoutStep?.with?.['fetch-depth'])).toBe('0');
    expect(scope.steps.some((step) => step.run?.includes('node scripts/harness/ci-scope.ts'))).toBe(
      true,
    );

    const harness = jobs.harness!;
    expect(needs(harness)).toEqual(['scope']);
    expect(harness.if).toBe('${{ !cancelled() }}');
    expect(String(harness.env?.VITEST_MAX_WORKERS)).toBe('4');
    expect(Object.keys(harness.services ?? {})).toEqual(['postgres']);
    expect(JSON.stringify(harness)).not.toMatch(/ffmpeg|redis/);
    const harnessRuns = harness.steps.map((step) => step.run ?? '');
    expect(harnessRuns.some((cmd) => cmd.includes('pnpm check:static:base'))).toBe(true);
    expect(
      harnessRuns.some((cmd) =>
        cmd.includes('node scripts/harness/validation-entry.ts ci-group harness'),
      ),
    ).toBe(true);

    const service = jobs.service!;
    expect(needs(service)).toEqual(['scope']);
    expect(service.if).toBe(
      "${{ !cancelled() && (needs.scope.result != 'success' || needs.scope.outputs.mode != 'harness') }}",
    );
    expect(String(service.env?.VITEST_MAX_WORKERS)).toBe('4');
    expect(Object.keys(service.services ?? {})).toEqual(['postgres', 'rabbitmq']);
    expect(service.services?.rabbitmq?.image).toMatch(/^rabbitmq:4\.4\.0-management@sha256:/);
    expect(service.services?.postgres?.image).toBe(harness.services?.postgres?.image);

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
    expect(service.steps[testIndex]?.env?.MIO_TEST_RABBITMQ_CONTAINER_ID).toBe(
      '${{ job.services.rabbitmq.id }}',
    );
    expect(smokeIndex).toBeGreaterThan(testIndex);
    expect(service.steps[prepackIndex]!.run).toContain('pnpm build');
    expect(service.steps[prepackIndex]!.run).toContain('npm pack --ignore-scripts');
  });

  it('reads block-sequence dependencies equivalently to flow-sequence dependencies', () => {
    const flow = 'jobs:\n  check:\n    needs: [scope, harness, service]';
    const block = 'jobs:\n  check:\n    needs:\n      - scope\n      - harness\n      - service';
    expect(needs(workflowJobs(flow).check!)).toEqual(['scope', 'harness', 'service']);
    expect(needs(workflowJobs(block).check!)).toEqual(needs(workflowJobs(flow).check!));
  });

  it('executes the check aggregator gate and enforces strict upstream success or expected harness-only skip', () => {
    const check = jobs.check!;
    expect(needs(check)).toEqual(['scope', 'harness', 'service']);
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
      expect(outcome.status, JSON.stringify({ failing, stdout: outcome.stdout })).toBe(1);
      expect(outcome.stderr).toContain('Gate failed:');
    }
  });
});

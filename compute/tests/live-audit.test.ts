import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

it('records the first real-provider attempt and blocks a second without forwarding credentials', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mio-live-audit-'));
  const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response('ok'));
  vi.stubEnv('MIO_LIVE_IMAGE_AUDIT_DIRECTORY', directory);
  vi.stubGlobal('fetch', transport);
  try {
    await import('../../tests/compute/live-image-audit.ts');
    const url = 'https://api.onelinkai.cloud/volc/api/v3/images/generations';
    const options = { method: 'POST', headers: { authorization: 'synthetic-secret' } };
    await fetch(url, options);
    expect(() => fetch(url, options)).toThrow('LIVE_IMAGE_REPEAT_POST_BLOCKED');
    expect(transport).toHaveBeenCalledOnce();
    const first = readFileSync(join(directory, 'paid-post-started.json'), 'utf8');
    const allowed = readFileSync(join(directory, 'paid-post-allowed.json'), 'utf8');
    const blocked = readFileSync(join(directory, 'paid-post-repeat-blocked.json'), 'utf8');
    expect(first + allowed + blocked).not.toContain('synthetic-secret');
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true });
  }
});

it('records and blocks an unexpected provider endpoint without allowing an outbound request', async () => {
  vi.resetModules();
  const directory = mkdtempSync(join(tmpdir(), 'mio-live-audit-'));
  const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response('ok'));
  vi.stubEnv('MIO_LIVE_IMAGE_AUDIT_DIRECTORY', directory);
  vi.stubGlobal('fetch', transport);
  try {
    await import('../../tests/compute/live-image-audit.ts');
    expect(() => fetch('https://api.onelinkai.cloud/unexpected', { method: 'POST' })).toThrow(
      'LIVE_IMAGE_UNEXPECTED_PROVIDER_POST',
    );
    expect(transport).not.toHaveBeenCalled();
    expect(readFileSync(join(directory, 'paid-post-started.json'), 'utf8')).toContain('at');
    expect(readFileSync(join(directory, 'paid-post-unexpected-blocked.json'), 'utf8')).toContain(
      'at',
    );
    expect(() => readFileSync(join(directory, 'paid-post-allowed.json'), 'utf8')).toThrow();
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true });
  }
});

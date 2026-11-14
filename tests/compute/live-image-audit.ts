import { closeSync, fsyncSync, lstatSync, openSync, writeSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Acceptance-only safety interlock: no headers, request body, URL token or credential is logged.
const directory = process.env.MIO_LIVE_IMAGE_AUDIT_DIRECTORY;
if (!directory) throw new Error('LIVE_IMAGE_AUDIT_DIRECTORY_REQUIRED');
const root = resolve(directory);
const stat = lstatSync(root);
if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
  throw new Error('LIVE_IMAGE_AUDIT_DIRECTORY_INVALID');
const marker = join(root, 'paid-post-started.json');
const allowed = join(root, 'paid-post-allowed.json');
const blocked = join(root, 'paid-post-repeat-blocked.json');
const unexpected = join(root, 'paid-post-unexpected-blocked.json');
function mark(path: string) {
  try {
    const fd = openSync(path, 'wx', 0o600);
    try {
      writeSync(fd, JSON.stringify({ at: new Date().toISOString() }));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  if (method === 'POST' && new URL(url).hostname === 'api.onelinkai.cloud') {
    const expected = url === 'https://api.onelinkai.cloud/volc/api/v3/images/generations';
    if (!expected) mark(unexpected);
    let fd: number;
    try {
      fd = openSync(marker, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        mark(blocked);
        throw new Error('LIVE_IMAGE_REPEAT_POST_BLOCKED');
      }
      throw error;
    }
    try {
      writeSync(fd, JSON.stringify({ at: new Date().toISOString() }));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (!expected) throw new Error('LIVE_IMAGE_UNEXPECTED_PROVIDER_POST');
    mark(allowed);
  }
  return originalFetch(input, init);
};

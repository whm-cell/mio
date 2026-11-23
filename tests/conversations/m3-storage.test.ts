import { Context } from '@deepseek-ai/cordis';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session';
import type { SessionHeader } from '@deepseek-ai/dsh-session';
import {
  SessionAlreadyExistsError,
  SessionAlreadyOwnedError,
  SessionPersistenceCorruptionError,
  SessionPersistenceNotFoundError,
} from '@deepseek-ai/dsh-session-persistence';
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import * as mixedPersistence from '../../src/dsh/mixed-session-persistence.ts';
import {
  kernelRuntime,
  modelOptions,
  ScriptedModel,
  textResponse,
} from '../support/kernel-runtime.ts';
import { readSessionArtifact } from '../support/session-artifact.ts';

const contexts: Context[] = [];
let root: string;
let legacyRoot: string;
let compressedRoot: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mio-m3-storage-'));
  legacyRoot = join(root, 'sessions');
  compressedRoot = join(root, 'sessions-zstd');
});

afterEach(async () => {
  try {
    await Promise.all(contexts.splice(0).map((ctx) => ctx.fiber.dispose()));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function runtime(model: ScriptedModel, mixed = true) {
  const ctx = await kernelRuntime(
    legacyRoot,
    model,
    mixed ? (ctx) => ctx.plugin(mixedPersistence, { legacyRoot, compressedRoot }) : undefined,
  );
  contexts.push(ctx);
  return ctx;
}

const input = (text: string) =>
  createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } });

async function artifact(ctx: Context, id: string) {
  const stored = await ctx.sessionPersistence.stat(SessionId(id));
  if (stored?.location?.kind !== 'jsonl') throw new Error('Missing JSONL artifact for ' + id);
  return stored.location.path;
}

it('continues existing raw logs and restarts with checksummed Zstandard logs for new sessions', async () => {
  const legacy = await runtime(new ScriptedModel([textResponse('original legacy reply')]), false);
  const first = await legacy.mioKernel.create('legacy', modelOptions);
  first.agent.followup(input('original legacy input'));
  await first.agent.whenIdle();
  await legacy.mioKernel.flush(first.agent.session);
  const originalEvents = first.agent.session.snapshotEvents();
  const legacyPath = await artifact(legacy, 'legacy');
  const original = await readFile(legacyPath);
  await legacy.mioKernel.close();
  await legacy.fiber.dispose();

  const model = new ScriptedModel([
    textResponse('legacy continuation'),
    textResponse('new compressed reply'),
  ]);
  const mixed = await runtime(model);
  expect((await mixed.mioKernel.history('legacy')).events).toEqual(originalEvents);
  expect((await readFile(legacyPath)).equals(original)).toBe(true);
  expect(model.requests).toHaveLength(0);
  const legacyView = await mixed.mioKernel.readView('legacy');
  expect(legacyView.snapshotEvents().slice(0, originalEvents.length)).toEqual(originalEvents);
  const resumed = await mixed.mioKernel.resume('legacy', modelOptions);
  await expect(mixed.sessionPersistence.open(SessionId('legacy'), 'write')).rejects.toBeInstanceOf(
    SessionAlreadyOwnedError,
  );
  resumed.agent.followup(input('continue uncompressed'));
  await resumed.agent.whenIdle();
  await mixed.mioKernel.flush(resumed.agent.session);
  expect(JSON.stringify(model.requests[0]!.messages)).toContain('original legacy reply');
  expect(await artifact(mixed, 'legacy')).toBe(legacyPath);
  expect((await readFile(legacyPath)).subarray(0, original.length).equals(original)).toBe(true);

  const modern = await mixed.mioKernel.create('modern', modelOptions);
  modern.agent.followup(input('new compressed input'));
  await modern.agent.whenIdle();
  await mixed.sessionPersistence.flush();
  const liveView = await mixed.mioKernel.readView('modern');
  expect(liveView).not.toBe(modern.agent.session);
  const modernEvents = (await mixed.mioKernel.history('modern')).events;
  expect(liveView.snapshotEvents().slice(0, modernEvents.length)).toEqual(modernEvents);
  const modernPath = await artifact(mixed, 'modern');
  expect(modernPath.startsWith(compressedRoot + '/')).toBe(true);
  expect(modernPath.endsWith('.jsonl.zstd')).toBe(true);
  const compressed = await readFile(modernPath);
  expect(compressed.subarray(0, 4).toString('hex')).toBe('28b52ffd');
  expect(compressed[4]! & 0x04).toBe(0x04);
  expect(await readSessionArtifact(modernPath)).toContain('new compressed reply');
  expect((await mixed.sessionPersistence.list()).map(({ header }) => header.id).sort()).toEqual([
    'legacy',
    'modern',
  ]);

  // Exercise root unload with both writer handles live.
  await mixed.fiber.dispose();
  const coldModel = new ScriptedModel([]);
  const fresh = await runtime(coldModel);
  const oldHistory = (await fresh.mioKernel.history('legacy')).events;
  expect(oldHistory.slice(0, originalEvents.length)).toEqual(originalEvents);
  expect(JSON.stringify(oldHistory)).toContain('legacy continuation');
  expect((await fresh.mioKernel.history('modern')).events).toEqual(modernEvents);
  expect(fresh.agents.list()).toEqual([]);
  expect(coldModel.requests).toHaveLength(0);

  const checksum = compressed.length - 1;
  compressed[checksum] = compressed[checksum]! ^ 1;
  await writeFile(modernPath, compressed);
  await expect(fresh.mioKernel.history('modern')).rejects.toBeInstanceOf(
    SessionPersistenceCorruptionError,
  );
});

it('distinguishes missing, an existing ID, a collision and an unreadable competing artifact', async () => {
  const legacy = new Context();
  contexts.push(legacy);
  await legacy.plugin(Jsonl, { root: legacyRoot, compression: 'none' });
  const mixed = await runtime(new ScriptedModel([]));
  const id = SessionId('same-id');
  const createHeader: SessionHeader = {
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: 1,
    isSeeded: false,
    delegationDepth: 0,
  };
  await expect(mixed.sessionPersistence.stat(id)).resolves.toBeUndefined();
  await expect(mixed.sessionPersistence.open(id, 'read')).rejects.toBeInstanceOf(
    SessionPersistenceNotFoundError,
  );

  const suppliedHeader = { ...createHeader };
  const creating = mixed.sessionPersistence.create(suppliedHeader);
  suppliedHeader.id = SessionId('mutated-after-create');
  const write = await creating;
  expect(write.header.id).toBe(id);
  await expect(mixed.sessionPersistence.create(createHeader)).rejects.toBeInstanceOf(
    SessionAlreadyExistsError,
  );
  await write.flush();
  await write.close();
  const modernPath = await artifact(mixed, id);
  const modern = await readFile(modernPath);

  const same = await legacy.sessionPersistence.create(createHeader);
  await same.flush();
  await same.close();
  const legacyPath = await artifact(legacy, id);

  await expect(mixed.mioKernel.history(id)).rejects.toThrow('appears in both Mio storage roots');
  await expect(mixed.mioKernel.resume(id, modelOptions)).rejects.toBeInstanceOf(
    SessionPersistenceCorruptionError,
  );
  await expect(mixed.sessionPersistence.create(createHeader)).rejects.toBeInstanceOf(
    SessionPersistenceCorruptionError,
  );
  await expect(mixed.sessionPersistence.stat(id)).rejects.toBeInstanceOf(
    SessionPersistenceCorruptionError,
  );
  await expect(mixed.sessionPersistence.list()).rejects.toBeInstanceOf(
    SessionPersistenceCorruptionError,
  );

  const broken = '{"malformed":"header"}\n';
  await writeFile(legacyPath, broken);
  await expect(legacy.sessionPersistence.stat(id)).resolves.toBeUndefined();
  await expect(mixed.sessionPersistence.stat(id)).rejects.toBeInstanceOf(
    SessionPersistenceCorruptionError,
  );
  await expect(mixed.mioKernel.history(id)).rejects.toBeInstanceOf(
    SessionPersistenceCorruptionError,
  );
  await expect(mixed.mioKernel.resume(id, modelOptions)).rejects.toBeInstanceOf(
    SessionPersistenceCorruptionError,
  );
  await expect(mixed.sessionPersistence.create(createHeader)).rejects.toBeInstanceOf(
    SessionPersistenceCorruptionError,
  );
  expect(await readFile(legacyPath, 'utf8')).toBe(broken);
  expect((await readFile(modernPath)).equals(modern)).toBe(true);

  await rm(legacyRoot, { recursive: true });
  await writeFile(legacyRoot, 'invalid root');
  await expect(mixed.sessionPersistence.stat(id)).rejects.toMatchObject({ code: 'ENOTDIR' });
});

import type { Context } from '@deepseek-ai/cordis';
import type { Fiber } from '@deepseek-ai/cordis';
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session';
import {
  materializeCreateHeader,
  SessionAlreadyExistsError,
  SessionPersistence,
  SessionPersistenceCorruptionError,
  SessionPersistenceNotFoundError,
} from '@deepseek-ai/dsh-session-persistence';
import type {
  SessionAccess,
  SessionPersistenceCreateOptions,
  SessionPersistenceListOptions,
  SessionPersistenceOpenOptions,
  SessionPersistenceSnapshot,
  SessionPersistenceStatOptions,
} from '@deepseek-ai/dsh-session-persistence';
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl';
import z from '@deepseek-ai/schemastery';
import { resolve } from 'node:path';

interface Config {
  legacyRoot: string;
  compressedRoot: string;
}

export const name = 'mio-session-persistence';
export const Config = z.object({
  legacyRoot: z.string().required(),
  compressedRoot: z.string().required(),
});

class MixedSessionPersistence extends SessionPersistence {
  private readonly legacy: SessionPersistence;
  private readonly compressed: SessionPersistence;

  constructor(ctx: Context, legacy: SessionPersistence, compressed: SessionPersistence) {
    super(ctx);
    this.legacy = legacy;
    this.compressed = compressed;
  }

  async create(header: SessionHeader, options?: SessionPersistenceCreateOptions) {
    options?.signal?.throwIfAborted();
    const snapshot = materializeCreateHeader(header);
    if (await this.find(snapshot.id, options)) throw new SessionAlreadyExistsError(snapshot.id);
    return this.compressed.create(snapshot, options);
  }

  async open(id: SessionId, access: SessionAccess, options?: SessionPersistenceOpenOptions) {
    const stored = await this.find(id, options);
    if (!stored) throw new SessionPersistenceNotFoundError(id);
    return stored.backend.open(id, access, options);
  }

  async stat(id: SessionId, options?: SessionPersistenceStatOptions) {
    const stored = await this.find(id, options);
    return stored?.snapshot ?? stored?.backend.stat(id, options);
  }

  async list(options?: SessionPersistenceListOptions) {
    const [legacy, compressed] = await Promise.all([
      this.legacy.list(options),
      this.compressed.list(options),
    ]);
    const legacyIds = new Set(legacy.map(({ header }) => header.id));
    for (const { header } of compressed) {
      if (legacyIds.has(header.id)) this.rejectCollision(header.id);
    }
    return [...legacy, ...compressed];
  }

  async flush() {
    const results = await Promise.allSettled([this.legacy.flush(), this.compressed.flush()]);
    const failures = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    if (failures.length) throw new AggregateError(failures, 'Mio session persistence flush failed');
  }

  private async find(id: SessionId, options?: SessionPersistenceStatOptions) {
    const [legacy, compressed] = await Promise.allSettled([
      this.inspect(this.legacy, id, options),
      this.inspect(this.compressed, id, options),
    ]);
    options?.signal?.throwIfAborted();
    if (legacy.status === 'rejected') throw legacy.reason;
    if (compressed.status === 'rejected') throw compressed.reason;
    if (legacy.value && compressed.value) this.rejectCollision(id);
    return legacy.value ?? compressed.value;
  }

  private async inspect(
    backend: SessionPersistence,
    id: SessionId,
    options?: SessionPersistenceStatOptions,
  ): Promise<{ backend: SessionPersistence; snapshot?: SessionPersistenceSnapshot } | undefined> {
    const snapshot = await backend.stat(id, options);
    if (snapshot) return { backend, snapshot };

    // The JSONL backend's stat can also omit a malformed header. Only a direct
    // open's typed not-found result permits an absent-root decision.
    let reader;
    try {
      reader = await backend.open(id, 'read', options);
    } catch (error) {
      if (error instanceof SessionPersistenceNotFoundError) return undefined;
      throw error;
    }
    await reader.close();
    return { backend };
  }

  private rejectCollision(id: SessionId): never {
    throw new SessionPersistenceCorruptionError(
      `session "${id}" appears in both Mio storage roots`,
      {},
    );
  }
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  if (resolve(config.legacyRoot) === resolve(config.compressedRoot))
    throw new Error('Mio session persistence requires separate roots');
  let service!: Fiber;
  // Remove the shared binding first so its consumers drain before the isolated
  // providers remove their listeners and close remaining handles.
  ctx.effect(function* () {
    const legacy = ctx.isolate('sessionPersistence').plugin(Jsonl, {
      root: config.legacyRoot,
      compression: 'none',
    });
    yield legacy.dispose;
    const compressed = ctx.isolate('sessionPersistence').plugin(Jsonl, {
      root: config.compressedRoot,
      compression: 'zstd',
    });
    yield compressed.dispose;
    service = ctx.plugin({
      name: 'mio-session-persistence-service',
      async apply(serviceCtx: Context) {
        await Promise.all([legacy, compressed]);
        const legacyBackend = legacy.ctx.get('sessionPersistence');
        const compressedBackend = compressed.ctx.get('sessionPersistence');
        if (!legacyBackend || !compressedBackend)
          throw new Error('Mio session persistence providers are unavailable');
        new MixedSessionPersistence(serviceCtx, legacyBackend, compressedBackend);
      },
    });
    yield service.dispose;
  }, 'Mio JSONL backends and routing');
  await service;
}

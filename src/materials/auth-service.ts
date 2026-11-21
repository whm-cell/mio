import { timingSafeEqual } from 'node:crypto';
import { sha256Utf8 } from '@mio/foundation/hash';
import { MaterialError } from './contracts.ts';
import type { MaterialPrincipal } from './contracts.ts';
import { materialAuthView, materialAuthEnvelope } from './auth-contracts.ts';
import type {
  MaterialAuthUpstream,
  MaterialAuthRow,
  MaterialAuthStatusRow,
} from './auth-contracts.ts';
import type { MaterialAuthStore } from './auth-store.ts';
import type { ProviderService } from '../providers/service.ts';
import { ProviderError } from '../providers/contracts.ts';
import { MaterialUpstreamError } from '../integrations/onelink/materials.ts';

type Credentials = Pick<
  ProviderService,
  'snapshotAccount' | 'openAccountSnapshot' | 'sealMaterialAuth' | 'openMaterialAuth'
>;
const digest = sha256Utf8;
const code = (error: unknown) =>
  error instanceof MaterialError || error instanceof ProviderError
    ? error.code
    : 'UPSTREAM_RESULT_UNKNOWN';
function auditRequestId(id: string | null, token?: string): string | null {
  return id && /^[A-Za-z0-9._-]{1,256}$/.test(id) && (token === undefined || !id.includes(token))
    ? id
    : null;
}
/** Persistent sessions are the sole auth authority. No operations row, automatic create retry or token logging. */
export function createMaterialAuthService(
  store: MaterialAuthStore,
  credentials: Credentials,
  upstream: MaterialAuthUpstream,
  origin: string,
) {
  let stopping = false,
    closing: Promise<void> | undefined;
  const stop = new AbortController(),
    active = new Set<Promise<unknown>>();
  const admit = <T>(work: () => Promise<T>): Promise<T> => {
    if (stopping) throw new MaterialError(503, 'MATERIAL_UNAVAILABLE');
    const action = work();
    active.add(action);
    void action.then(
      () => active.delete(action),
      () => active.delete(action),
    );
    return action;
  };
  const view = (row: MaterialAuthStatusRow | MaterialAuthRow) => materialAuthView(row, origin);
  const verify = async (row: MaterialAuthRow) => {
    if (row.state === 'completed') return view(row);
    if (row.state === 'expired') throw new MaterialError(410, 'AUTH_EXPIRED');
    if (!row.ciphertext) throw new MaterialError(409, 'AUTH_RECOVERY_UNAVAILABLE');
    const claimed = await store.claim(row);
    if (!claimed) {
      const current = await store.get(row.id);
      if (current.state === 'completed') return view(current);
      if (current.state === 'expired') throw new MaterialError(410, 'AUTH_EXPIRED');
      throw new MaterialError(429, 'AUTH_QUERY_LIMITED');
    }
    let token: string | undefined;
    let resultRequestId: string | null = null;
    let groupRequestId: string | null = null;
    try {
      const remote = credentials.openMaterialAuth(
        claimed.owner_id,
        claimed.id,
        materialAuthEnvelope(claimed),
      );
      if (digest(remote.token) !== claimed.token_digest)
        throw new MaterialError(503, 'MATERIAL_AUTH_SECRET_UNAVAILABLE');
      token = remote.token;
      const snapshot = await credentials.snapshotAccount(claimed.owner_id);
      stop.signal.throwIfAborted();
      const key = credentials.openAccountSnapshot(claimed.owner_id, snapshot);
      const result = await upstream.result(key, token, stop.signal);
      resultRequestId = auditRequestId(result.requestId, token);
      const groupAuditId = await upstream.verifiedGroup(key, result.groupId, stop.signal);
      groupRequestId = auditRequestId(groupAuditId, token);
      stop.signal.throwIfAborted();
      return view(await store.complete(claimed, result.groupId, resultRequestId, groupRequestId));
    } catch (error) {
      if (error instanceof MaterialUpstreamError && error.request) {
        const id = auditRequestId(error.request.id, token);
        if (error.request.action === 'GetVisualValidateResult') resultRequestId = id;
        if (error.request.action === 'GetAssetGroup') groupRequestId = id;
      }
      await store
        .verificationFailed(claimed, code(error), resultRequestId, groupRequestId)
        .catch(() => {});
      throw error;
    }
  };
  return {
    create(
      actor: MaterialPrincipal,
      requestId: string,
      source: 'materials',
      returnTarget: 'materials',
    ) {
      return admit(async () => {
        const inputHash = sha256Utf8(JSON.stringify({ source, returnTarget }));
        const old = await store.previous(actor.userId, requestId, inputHash);
        if (old) return view(old);
        const snapshot = await credentials.snapshotAccount(actor.userId);
        const { session, fresh } = await store.begin(actor.userId, requestId, inputHash, snapshot);
        if (!fresh) return view(await store.status(actor.userId, session.id));
        let attempted = false,
          returned = false;
        let createAuditId: string | null = null;
        let known: Parameters<MaterialAuthStore['createFailed']>[4];
        try {
          stop.signal.throwIfAborted();
          const key = credentials.openAccountSnapshot(actor.userId, snapshot);
          const callback = `${origin}/api/v1/materials/auth-sessions/${session.id}/complete`;
          attempted = true;
          const {
            launchUrl,
            token,
            requestId: upstreamRequestId,
          } = await upstream.create(key, callback, stop.signal);
          returned = true;
          createAuditId = auditRequestId(upstreamRequestId, token);
          known = {
            envelope: credentials.sealMaterialAuth(actor.userId, session.id, {
              launchUrl,
              token,
            }),
            digest: digest(token),
          };
          stop.signal.throwIfAborted();
          await store.created(session, known.envelope, known.digest, createAuditId);
        } catch (error) {
          if (
            error instanceof MaterialUpstreamError &&
            error.request?.action === 'CreateVisualValidateSession'
          )
            createAuditId = auditRequestId(error.request.id);
          await store
            .createFailed(
              session,
              returned ||
                (attempted && (!(error instanceof MaterialUpstreamError) || error.uncertain)),
              code(error),
              createAuditId,
              known,
            )
            .catch(() => {});
        }
        return view(await store.status(actor.userId, session.id));
      });
    },
    get(actor: MaterialPrincipal, id: string) {
      return admit(async () => view(await store.status(actor.userId, id)));
    },
    launch(id: string) {
      return admit(async () => {
        const row = await store.get(id);
        if (row.state === 'expired') throw new MaterialError(410, 'AUTH_EXPIRED');
        if (!['pending', 'unknown'].includes(row.state) || !row.ciphertext)
          throw new MaterialError(409, 'AUTH_NOT_READY');
        const remote = credentials.openMaterialAuth(
          row.owner_id,
          row.id,
          materialAuthEnvelope(row),
        );
        const url = new URL(remote.launchUrl);
        if (
          url.origin !== 'https://ark.volcengine.com' ||
          url.pathname !== '/region:cn-beijing/mobile/livenees-face-manage/authorization' ||
          url.username ||
          url.password ||
          url.hash
        )
          throw new MaterialError(503, 'MATERIAL_AUTH_SECRET_UNAVAILABLE');
        stop.signal.throwIfAborted();
        return remote.launchUrl;
      });
    },
    complete(id: string, token: string, resultCode?: string) {
      return admit(async () => {
        const row = await store.get(id);
        const supplied = digest(token),
          expected = row.token_digest;
        if (
          !expected ||
          !timingSafeEqual(Buffer.from(supplied, 'hex'), Buffer.from(expected, 'hex'))
        )
          throw new MaterialError(400, 'AUTH_PROOF_INVALID');
        if (resultCode !== undefined && resultCode !== '10000' && row.state !== 'completed')
          throw new MaterialError(400, 'AUTH_RESULT_UNCONFIRMED');
        return verify(row);
      });
    },
    refresh(actor: MaterialPrincipal, id: string) {
      return admit(async () => verify(await store.get(id, actor.userId)));
    },
    close(): Promise<void> {
      if (closing) return closing;
      stopping = true;
      closing = (async () => {
        const deadline = setTimeout(() => stop.abort(), 5000);
        try {
          await Promise.allSettled([...active]);
        } finally {
          clearTimeout(deadline);
        }
      })();
      return closing;
    },
  };
}
export type MaterialAuthService = ReturnType<typeof createMaterialAuthService>;

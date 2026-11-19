import { HTTP_STATUS } from '@mio/foundation/http-status';
import { ConversationError } from './contracts.ts';
import type { Principal } from './contracts.ts';

type Identity = (headers: Headers) => Promise<Principal | null>;
type AuthFailure = 'UNAUTHORIZED' | 'AUTH_UNAVAILABLE';
interface Member {
  headers: Headers;
  fail: (code: AuthFailure) => void;
  release: () => void;
}
interface Group {
  actor: Principal;
  members: Set<Member>;
  interval: ReturnType<typeof setInterval>;
  checking?: AbortController;
  closed: boolean;
}

function freshIdentity(identity: Identity, headers: Headers, signal: AbortSignal) {
  return new Promise<Principal | null>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const cleanup = () => {
      clearTimeout(deadline);
      signal.removeEventListener('abort', abort);
    };
    const unavailable = () => {
      cleanup();
      reject(new ConversationError(HTTP_STATUS.SERVICE_UNAVAILABLE, 'AUTH_UNAVAILABLE'));
    };
    const abort = () => {
      cleanup();
      reject(signal.reason);
    };
    const deadline = setTimeout(unavailable, 5000);
    deadline.unref();
    signal.addEventListener('abort', abort, { once: true });
    void Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return identity(headers);
      })
      .then((current) => {
        cleanup();
        resolve(current);
      }, unavailable);
  });
}

/** One handler owns pending/open capacity and fresh checks for verified user/session groups. */
export function createSseRegistry(identity: Identity) {
  let total = 0;
  let unauthenticated = 0;
  const users = new Map<string, number>();
  const groups = new Map<string, Group>();
  const removeGroup = (key: string, group: Group) => {
    if (group.closed) return;
    group.closed = true;
    clearInterval(group.interval);
    group.checking?.abort();
    if (groups.get(key) === group) groups.delete(key);
  };
  const recheck = (key: string, group: Group) => {
    if (group.closed || group.checking) return;
    const member = group.members.values().next().value;
    if (!member) return;
    const check = new AbortController();
    group.checking = check;
    const fail = (code: AuthFailure) => {
      if (group.closed) return;
      removeGroup(key, group);
      for (const member of [...group.members]) {
        try {
          member.fail(code);
        } catch {
          /* A broken transport must not retain other members or capacity. */
        } finally {
          member.release();
        }
      }
    };
    void freshIdentity(identity, member.headers, check.signal)
      .then(
        (current) => {
          if (group.closed) return;
          if (current?.userId !== group.actor.userId || current.sessionId !== group.actor.sessionId)
            fail('UNAUTHORIZED');
        },
        () => fail('AUTH_UNAVAILABLE'),
      )
      .finally(() => {
        if (group.checking === check) delete group.checking;
      });
  };
  return {
    reserve(headers: Headers, fail: Member['fail']) {
      // No awaits before either reservation or verified-user promotion.
      if (total >= 256 || unauthenticated >= 64)
        throw new ConversationError(HTTP_STATUS.TOO_MANY_REQUESTS, 'SSE_LIMITED');
      total++;
      unauthenticated++;
      let released = false;
      let actor: Principal | undefined;
      let group: Group | undefined;
      let key: string | undefined;
      const member: Member = {
        headers,
        fail,
        release() {
          if (released) return;
          released = true;
          total--;
          if (!actor) unauthenticated--;
          else {
            const count = users.get(actor.userId)! - 1;
            if (count) users.set(actor.userId, count);
            else users.delete(actor.userId);
          }
          if (group && key) {
            group.members.delete(member);
            if (!group.members.size) removeGroup(key, group);
          }
        },
      };
      return {
        identify: (signal: AbortSignal) => freshIdentity(identity, headers, signal),
        bind(verified: Principal) {
          if (released) return;
          const count = users.get(verified.userId) ?? 0;
          if (count >= 8) throw new ConversationError(HTTP_STATUS.TOO_MANY_REQUESTS, 'SSE_LIMITED');
          actor = verified;
          unauthenticated--;
          users.set(actor.userId, count + 1);
          key = JSON.stringify([actor.userId, actor.sessionId]);
          group = groups.get(key);
          if (!group) {
            const groupKey = key;
            const created: Group = {
              actor,
              members: new Set(),
              interval: setInterval(() => recheck(groupKey, created), 1000),
              closed: false,
            };
            created.interval.unref();
            groups.set(key, (group = created));
          }
          group.members.add(member);
        },
        release: member.release,
      };
    },
  };
}

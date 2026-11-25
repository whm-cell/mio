import { sha256Utf8 } from '@mio/foundation/hash';
import { epochMs } from '@mio/foundation/time';
import type { BetterAuthPlugin, GenericEndpointContext } from 'better-auth';
import { APIError, createAuthEndpoint, getSession } from 'better-auth/api';
import { deleteSessionCookie, setSessionCookie } from 'better-auth/cookies';
import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import {
  buildOneLinkAuthorizeUrl,
  maskOneLinkSub,
  parseOneLinkAccessToken,
} from '../integrations/onelink/sso.ts';
import type { OneLinkSsoConfig } from '../integrations/onelink/sso.ts';
import { isUserDisabled } from './account.ts';
import {
  cancelActiveOneLinkPending,
  completeStartedPendingLogin,
  createOneLinkPending,
  findBoundOneLinkUser,
  oneLinkPendingSchema,
  readOneLinkPendingByDigest,
  rejectStartedPending,
  transitionStartedPendingToCandidate,
  userHasOneLinkAccount,
} from './onelink-store.ts';
import type { OneLinkPendingIntent, OneLinkPendingRecord } from './onelink-store.ts';

export interface OneLinkSsoRuntimePolicy {
  readonly enabled: boolean;
  readonly clientName: string;
  readonly allowedClientIds: readonly string[];
}

export type OneLinkSsoPolicyReader = () => OneLinkSsoRuntimePolicy;

type OneLinkCallbackResult =
  | 'logged_in'
  | 'choose_account'
  | 'confirm_bind'
  | 'unauthorized'
  | 'invalid_state'
  | 'invalid_token'
  | 'account_disabled'
  | 'session_required';

const PENDING_COOKIE_NAME = 'onelink_pending';
const PENDING_COOKIE_MAX_AGE_SECONDS = 900;
const MAX_BINDING_SESSION_AGE_MS = 600_000;
const MAX_RETURN_PATH_LENGTH = 256;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const CALLBACK_HEADERS = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
} as const;

function pendingCookiePath(ctx: GenericEndpointContext): string {
  return new URL(ctx.context.baseURL).pathname;
}

function readPendingCookie(ctx: GenericEndpointContext): string | null {
  const cookie = ctx.context.createAuthCookie(PENDING_COOKIE_NAME, {
    path: pendingCookiePath(ctx),
  });
  return ctx.getCookie(cookie.name);
}

function setPendingCookie(ctx: GenericEndpointContext, value: string): void {
  const cookie = ctx.context.createAuthCookie(PENDING_COOKIE_NAME, {
    maxAge: PENDING_COOKIE_MAX_AGE_SECONDS,
    path: pendingCookiePath(ctx),
  });
  ctx.setCookie(cookie.name, value, cookie.attributes);
}

function clearPendingCookie(ctx: GenericEndpointContext): void {
  const cookie = ctx.context.createAuthCookie(PENDING_COOKIE_NAME, {
    maxAge: 0,
    path: pendingCookiePath(ctx),
  });
  ctx.setCookie(cookie.name, '', cookie.attributes);
}

function parseReturnPath(value: unknown, baseURL: string): string | null {
  if (value === undefined) return '/';
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_RETURN_PATH_LENGTH ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('\\') ||
    CONTROL_CHARS.test(value)
  ) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(value, baseURL);
  } catch {
    return null;
  }
  if (parsed.origin !== baseURL || parsed.pathname.startsWith('//')) return null;
  return `${parsed.pathname}${parsed.search}`;
}

function parseStartBody(
  body: unknown,
  baseURL: string,
): { readonly intent: OneLinkPendingIntent; readonly returnPath: string } | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const input = body as Record<string, unknown>;
  if (Object.keys(input).some((key) => key !== 'intent' && key !== 'returnPath')) return null;
  if (input.intent !== 'login' && input.intent !== 'bind') return null;
  const returnPath = parseReturnPath(input.returnPath, baseURL);
  if (!returnPath) return null;
  return { intent: input.intent, returnPath };
}

function buildCleanRedirectLocation(
  returnPath: string,
  baseURL: string,
  result: OneLinkCallbackResult,
): string {
  const safePath = parseReturnPath(returnPath, baseURL) ?? '/';
  const target = new URL(safePath, baseURL);
  target.searchParams.set('onelink_result', result);
  return `${target.pathname}${target.search}`;
}

function redirect303(ctx: GenericEndpointContext, location: string): Response {
  ctx.setHeader('cache-control', 'no-store');
  ctx.setHeader('referrer-policy', 'no-referrer');
  ctx.setHeader('location', location);
  return new Response(null, { status: 303 });
}

function requireOneLinkReady(
  oneLinkConfig: OneLinkSsoConfig | undefined,
  getPolicy: OneLinkSsoPolicyReader,
  headers?: HeadersInit,
): { readonly config: OneLinkSsoConfig; readonly policy: OneLinkSsoRuntimePolicy } {
  const policy = getPolicy();
  if (!oneLinkConfig || !policy.enabled) {
    throw new APIError(
      'SERVICE_UNAVAILABLE',
      { code: 'ONELINK_UNAVAILABLE', message: 'OneLink authentication is unavailable' },
      headers,
    );
  }
  return { config: oneLinkConfig, policy };
}

function authUnavailable(headers?: HeadersInit): never {
  throw new APIError(
    'SERVICE_UNAVAILABLE',
    { code: 'AUTH_UNAVAILABLE', message: 'Authentication unavailable' },
    headers,
  );
}

function isClientApiError(error: unknown): error is APIError {
  return error instanceof APIError && error.statusCode >= 400 && error.statusCode < 500;
}

async function readValidRecentSession(
  ctx: GenericEndpointContext,
  expected?: { readonly userId: string | null; readonly sessionId: string | null },
): Promise<{ readonly userId: string; readonly sessionId: string } | null> {
  const session = await getSession()({
    context: ctx.context,
    headers: ctx.headers ?? new Headers(),
    query: { disableCookieCache: true, disableRefresh: true },
    asResponse: false,
  });
  if (!session) return null;
  if (isUserDisabled(session.user)) {
    await ctx.context.internalAdapter.deleteSession(session.session.token);
    ctx.responseHeaders?.delete('set-cookie');
    deleteSessionCookie(ctx);
    return null;
  }
  if (epochMs() - new Date(session.session.createdAt).getTime() >= MAX_BINDING_SESSION_AGE_MS) {
    return null;
  }
  if (
    expected &&
    (session.user.id !== expected.userId || session.session.id !== expected.sessionId)
  ) {
    return null;
  }
  return { userId: session.user.id, sessionId: session.session.id };
}

async function handleLostTransition(
  ctx: GenericEndpointContext,
  pool: Pool,
  baseURL: string,
  row: OneLinkPendingRecord,
): Promise<Response> {
  const latest = await readOneLinkPendingByDigest(pool, row.tokenDigest);
  if (!latest || latest.status !== 'candidate_ready' || latest.expired) {
    clearPendingCookie(ctx);
  }
  return redirect303(ctx, buildCleanRedirectLocation(row.returnPath, baseURL, 'invalid_state'));
}

async function rejectStartedOrHandleRace(
  ctx: GenericEndpointContext,
  pool: Pool,
  baseURL: string,
  row: OneLinkPendingRecord,
  result: Exclude<OneLinkCallbackResult, 'logged_in' | 'choose_account' | 'confirm_bind'>,
): Promise<Response> {
  const rejected = await rejectStartedPending(pool, row.id);
  if (!rejected) {
    return handleLostTransition(ctx, pool, baseURL, row);
  }
  clearPendingCookie(ctx);
  return redirect303(ctx, buildCleanRedirectLocation(row.returnPath, baseURL, result));
}

async function finishLoginCallback(
  ctx: GenericEndpointContext,
  pool: Pool,
  baseURL: string,
  row: OneLinkPendingRecord,
  parsed: { readonly sub: string; readonly clientId: string | null },
): Promise<Response> {
  const boundUser = await findBoundOneLinkUser(pool, parsed.sub);
  if (!boundUser) {
    const candidateToken = randomBytes(24).toString('hex');
    const staged = await transitionStartedPendingToCandidate(pool, row.id, {
      candidateSub: parsed.sub,
      candidateClientId: parsed.clientId,
      candidateToken,
    });
    if (!staged) {
      return handleLostTransition(ctx, pool, baseURL, row);
    }
    return redirect303(ctx, buildCleanRedirectLocation(row.returnPath, baseURL, 'choose_account'));
  }
  if (isUserDisabled(boundUser)) {
    return rejectStartedOrHandleRace(ctx, pool, baseURL, row, 'account_disabled');
  }
  const completed = await completeStartedPendingLogin(pool, row.id);
  if (!completed) {
    return handleLostTransition(ctx, pool, baseURL, row);
  }
  let session;
  try {
    session = await ctx.context.internalAdapter.createSession(boundUser.id);
  } catch (error) {
    clearPendingCookie(ctx);
    if (
      error instanceof APIError &&
      error.body &&
      typeof error.body === 'object' &&
      (error.body as { code?: unknown }).code === 'ACCOUNT_DISABLED'
    ) {
      return redirect303(
        ctx,
        buildCleanRedirectLocation(row.returnPath, baseURL, 'account_disabled'),
      );
    }
    throw error;
  }
  if (!session) {
    clearPendingCookie(ctx);
    return authUnavailable(CALLBACK_HEADERS);
  }
  await setSessionCookie(ctx, { session, user: boundUser });
  clearPendingCookie(ctx);
  return redirect303(ctx, buildCleanRedirectLocation(row.returnPath, baseURL, 'logged_in'));
}

async function finishBindCallback(
  ctx: GenericEndpointContext,
  pool: Pool,
  baseURL: string,
  row: OneLinkPendingRecord,
  parsed: { readonly sub: string; readonly clientId: string | null },
): Promise<Response> {
  const session = await readValidRecentSession(ctx, {
    userId: row.initiatorUserId,
    sessionId: row.initiatorSessionId,
  });
  if (!session) {
    return rejectStartedOrHandleRace(ctx, pool, baseURL, row, 'session_required');
  }
  const candidateToken = randomBytes(24).toString('hex');
  const staged = await transitionStartedPendingToCandidate(pool, row.id, {
    candidateSub: parsed.sub,
    candidateClientId: parsed.clientId,
    candidateToken,
  });
  if (!staged) {
    return handleLostTransition(ctx, pool, baseURL, row);
  }
  return redirect303(ctx, buildCleanRedirectLocation(row.returnPath, baseURL, 'confirm_bind'));
}

/** OneLink authorize start, callback parsing and pending candidate storage; never writes new permanent users/accounts on GET. */
export function oneLinkPlugin(
  baseURL: string,
  pool: Pool,
  oneLinkConfig: OneLinkSsoConfig | undefined,
  getPolicy: OneLinkSsoPolicyReader,
): BetterAuthPlugin {
  return {
    id: 'mio-onelink',
    schema: oneLinkPendingSchema,
    endpoints: {
      startOneLink: createAuthEndpoint('/onelink/start', { method: 'POST' }, async (ctx) => {
        const { config, policy } = requireOneLinkReady(oneLinkConfig, getPolicy);
        const input = parseStartBody(ctx.body, baseURL);
        if (!input) {
          throw new APIError('BAD_REQUEST', { code: 'INVALID_INPUT', message: 'Invalid input' });
        }
        try {
          let initiatorUserId: string | null = null;
          let initiatorSessionId: string | null = null;
          if (input.intent === 'bind') {
            const session = await readValidRecentSession(ctx);
            if (!session) {
              throw new APIError(
                'UNAUTHORIZED',
                { code: 'SESSION_REQUIRED', message: 'Recent session required' },
                ctx.responseHeaders,
              );
            }
            if (await userHasOneLinkAccount(pool, session.userId)) {
              throw new APIError('CONFLICT', {
                code: 'ONELINK_ALREADY_BOUND',
                message: 'OneLink account is already bound',
              });
            }
            initiatorUserId = session.userId;
            initiatorSessionId = session.sessionId;
          }
          const url = buildOneLinkAuthorizeUrl(
            { ...config, clientName: policy.clientName },
            { baseURL },
          );
          const cookieValue = randomBytes(32).toString('hex');
          await createOneLinkPending(pool, {
            tokenDigest: sha256Utf8(cookieValue),
            intent: input.intent,
            initiatorUserId,
            initiatorSessionId,
            returnPath: input.returnPath,
          });
          setPendingCookie(ctx, cookieValue);
          return ctx.json({ url });
        } catch (error) {
          if (isClientApiError(error)) throw error;
          return authUnavailable();
        }
      }),
      callbackOneLink: createAuthEndpoint('/callback/onelink', { method: 'GET' }, async (ctx) => {
        ctx.setHeader('cache-control', 'no-store');
        ctx.setHeader('referrer-policy', 'no-referrer');
        const { policy } = requireOneLinkReady(oneLinkConfig, getPolicy, CALLBACK_HEADERS);
        try {
          const cookieValue = readPendingCookie(ctx);
          if (!cookieValue) {
            clearPendingCookie(ctx);
            return redirect303(ctx, buildCleanRedirectLocation('/', baseURL, 'invalid_state'));
          }
          const row = await readOneLinkPendingByDigest(pool, sha256Utf8(cookieValue));
          if (!row) {
            clearPendingCookie(ctx);
            return redirect303(ctx, buildCleanRedirectLocation('/', baseURL, 'invalid_state'));
          }
          if (row.status === 'candidate_ready' && !row.expired) {
            return redirect303(
              ctx,
              buildCleanRedirectLocation(row.returnPath, baseURL, 'invalid_state'),
            );
          }
          if (row.expired || row.status !== 'started') {
            clearPendingCookie(ctx);
            return redirect303(
              ctx,
              buildCleanRedirectLocation(row.returnPath, baseURL, 'invalid_state'),
            );
          }
          if (ctx.query?.unauthorized === 'true') {
            return await rejectStartedOrHandleRace(ctx, pool, baseURL, row, 'unauthorized');
          }
          const parsed = parseOneLinkAccessToken(ctx.query?.access_token, policy.allowedClientIds);
          if (!parsed.ok) {
            return await rejectStartedOrHandleRace(ctx, pool, baseURL, row, 'invalid_token');
          }
          if (row.intent === 'login') {
            return await finishLoginCallback(ctx, pool, baseURL, row, parsed);
          }
          return await finishBindCallback(ctx, pool, baseURL, row, parsed);
        } catch (error) {
          if (isClientApiError(error)) throw error;
          return authUnavailable(CALLBACK_HEADERS);
        }
      }),
      pendingOneLink: createAuthEndpoint('/onelink/pending', { method: 'GET' }, async (ctx) => {
        requireOneLinkReady(oneLinkConfig, getPolicy);
        try {
          const cookieValue = readPendingCookie(ctx);
          if (!cookieValue) {
            throw new APIError('NOT_FOUND', {
              code: 'ONELINK_PENDING_NOT_FOUND',
              message: 'OneLink pending session not found',
            });
          }
          const row = await readOneLinkPendingByDigest(pool, sha256Utf8(cookieValue));
          if (
            !row ||
            row.expired ||
            row.status !== 'candidate_ready' ||
            !row.candidateSub ||
            !row.candidateToken
          ) {
            throw new APIError('NOT_FOUND', {
              code: 'ONELINK_PENDING_NOT_FOUND',
              message: 'OneLink pending session not found',
            });
          }
          if (row.intent === 'bind') {
            const session = await readValidRecentSession(ctx, {
              userId: row.initiatorUserId,
              sessionId: row.initiatorSessionId,
            });
            if (!session) {
              throw new APIError(
                'UNAUTHORIZED',
                { code: 'SESSION_REQUIRED', message: 'Recent session required' },
                ctx.responseHeaders,
              );
            }
          }
          return ctx.json({
            status: 'candidate_ready',
            intent: row.intent,
            candidateToken: row.candidateToken,
            onelinkSub: row.candidateSub,
            onelinkSubMasked: maskOneLinkSub(row.candidateSub),
            clientId: row.candidateClientId,
            expiresAt: row.expiresAt.toISOString(),
          });
        } catch (error) {
          if (isClientApiError(error)) throw error;
          return authUnavailable();
        }
      }),
      cancelOneLink: createAuthEndpoint('/onelink/cancel', { method: 'POST' }, async (ctx) => {
        if (
          !ctx.body ||
          typeof ctx.body !== 'object' ||
          Array.isArray(ctx.body) ||
          Object.keys(ctx.body as Record<string, unknown>).length > 0
        ) {
          throw new APIError('BAD_REQUEST', { code: 'INVALID_INPUT', message: 'Invalid input' });
        }
        try {
          const cookieValue = readPendingCookie(ctx);
          if (cookieValue) {
            await cancelActiveOneLinkPending(pool, sha256Utf8(cookieValue));
          }
          clearPendingCookie(ctx);
          return ctx.json({ ok: true });
        } catch (error) {
          if (isClientApiError(error)) throw error;
          return authUnavailable();
        }
      }),
    },
  } satisfies BetterAuthPlugin;
}

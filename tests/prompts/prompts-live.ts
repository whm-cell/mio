import { closeSync, fsyncSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import type { Dispatcher } from 'undici';
import { createId } from '@mio/foundation/identifiers';
import { utcISOString } from '@mio/foundation/time';
import { readLocalEnvironment } from '../../scripts/service/local-environment.ts';
import { callPromptModel } from '../../src/dsh/prompt-caller.ts';
import { ONELINK_ORIGIN } from '../../src/integrations/onelink/models.ts';
import { readProviderConfig } from '../../src/providers/config.ts';
import { ProviderError, snapshotMaxTokens } from '../../src/providers/contracts.ts';
import type { ChatRuntimeSnapshot } from '../../src/providers/contracts.ts';
import { createProviderService } from '../../src/providers/service.ts';
import { createProviderStore } from '../../src/providers/store.ts';
import { extractStrictJson } from '../../src/prompts/contracts.ts';
import type { StructuredPromptSpec } from '../../src/prompts/contracts.ts';
import { createPromptRuntime } from '../../src/prompts/runner.ts';
import type { PromptRuntimePorts } from '../../src/prompts/runner.ts';

type RecordEvent = (event: Record<string, unknown>) => void;
type LivePromptSetup =
  | { readonly ready: false; readonly reason: string }
  | {
      readonly ready: true;
      readonly ownerId: string;
      readonly snapshot: ChatRuntimeSnapshot;
      readonly recordVerification: PromptRuntimePorts['recordVerification'];
      readonly close: () => Promise<void>;
    };

/** Probe-only fuse at the transport boundary shared by Node fetch and SDK undici fetch. */
export function createLivePromptAudit(transport: Dispatcher, record: RecordEvent) {
  let posts = 0;
  let blocked = 0;
  const dispatcher = transport.compose((dispatch) => (options, handler) => {
    if (String(options.origin) !== ONELINK_ORIGIN || options.method !== 'POST')
      throw new Error('LIVE_PROMPT_DESTINATION_DENIED');
    if (posts >= 2) {
      blocked++;
      throw new Error('LIVE_PROMPT_POST_LIMIT');
    }
    // Persist the intent before dispatch; a thrown transport still consumes this attempt.
    record({ event: 'post-dispatch', upstreamPosts: posts + 1 });
    posts++;
    return dispatch(options, handler);
  });
  return { dispatcher, counts: () => ({ upstreamPosts: posts, blockedPosts: blocked }) };
}

/** No discovery, login, migration, credential replacement or route mutation. */
async function existingDevSetup(ownerId: string): Promise<LivePromptSetup> {
  let dev: Awaited<ReturnType<typeof readLocalEnvironment>>;
  let config: ReturnType<typeof readProviderConfig>;
  try {
    dev = await readLocalEnvironment('dev');
    config = readProviderConfig(dev.runtime);
  } catch {
    return { ready: false, reason: 'LIVE_PROMPT_DEV_ENVIRONMENT_UNAVAILABLE' };
  }
  if (!config || config.databaseURL !== dev.runtime.MIO_AUTH_DATABASE_URL)
    return { ready: false, reason: 'LIVE_PROMPT_DEV_PROVIDER_REQUIRED' };
  let store: Awaited<ReturnType<typeof createProviderStore>>;
  try {
    store = await createProviderStore(config);
  } catch {
    return { ready: false, reason: 'LIVE_PROMPT_PROVIDER_DATABASE_OR_SCHEMA_UNAVAILABLE' };
  }
  const providers = createProviderService(store, config);
  try {
    const owner = { userId: ownerId, sessionId: 'trusted-local-prompt-probe' };
    const selection = await providers.selectChat(owner);
    const snapshot = await providers.resolveChat(owner, selection);
    return {
      ready: true,
      ownerId,
      snapshot,
      recordVerification: (userId, frozen, evidence) =>
        providers.recordVerification({ userId }, frozen, evidence),
      close: () => providers.close(),
    };
  } catch (error) {
    await providers.close();
    return {
      ready: false,
      reason:
        error instanceof ProviderError
          ? error.code
          : 'LIVE_PROMPT_OWNER_CREDENTIAL_OR_ROUTE_UNAVAILABLE',
    };
  }
}

const probeSpec: StructuredPromptSpec<void, true> = {
  templateVersion: 'probe.structured@v1',
  minOutputTokens: 64,
  buildInput: () => ({
    system: 'Return only the exact JSON object requested. Do not include explanations.',
    prompt: 'Return {"probe":"initial"}.',
  }),
  parseAndValidate(raw) {
    const parsed = extractStrictJson(raw);
    return parsed.ok
      ? {
          ok: false,
          issues: [
            {
              path: ['probe'],
              code: 'CONTROLLED_REPAIR_REQUIRED',
              message: 'This probe deliberately requires one repair to return probe=repaired.',
            },
          ],
        }
      : parsed;
  },
  repair: () => ({
    prompt: 'Repair the probe field. Return exactly {"probe":"repaired"}.',
    parse(raw) {
      const parsed = extractStrictJson(raw);
      if (!parsed.ok) return parsed;
      const value = parsed.value;
      return value !== null &&
        typeof value === 'object' &&
        'probe' in value &&
        value.probe === 'repaired' &&
        Object.keys(value).length === 1
        ? { ok: true, value: true }
        : {
            ok: false,
            issues: [
              { path: ['probe'], code: 'INVALID_PROBE', message: 'Expected probe=repaired.' },
            ],
          };
    },
  }),
};

/** The gate precedes all environment/credential reads and every HTTP dispatch. */
export async function runLivePrompt(prepare: () => Promise<LivePromptSetup>, record: RecordEvent) {
  if (process.env.MIO_RUN_LIVE_PROMPT !== 'yes')
    return { status: 'blocked', reason: 'MIO_RUN_LIVE_PROMPT_REQUIRED', upstreamPosts: 0 };
  const original = getGlobalDispatcher();
  const audit = createLivePromptAudit(original, record);
  setGlobalDispatcher(audit.dispatcher);
  let setup: LivePromptSetup | undefined;
  let runtime: ReturnType<typeof createPromptRuntime> | undefined;
  try {
    try {
      setup = await prepare();
    } catch {
      return {
        status: 'prerequisite-failed',
        reason: 'LIVE_PROMPT_PREREQUISITE_UNAVAILABLE',
        ...audit.counts(),
      };
    }
    if (!setup.ready)
      return { status: 'prerequisite-failed', reason: setup.reason, ...audit.counts() };
    // A smaller request budget is intentional; the admitted route and credential stay unchanged.
    const maxOutputTokens = Math.min(
      snapshotMaxTokens(setup.snapshot),
      setup.snapshot.reasoning?.supported ? 1024 : 128,
    );
    const snapshot = Object.freeze({ ...setup.snapshot, maxOutputTokens });
    const evidence = 'prompt-live:' + createId();
    record({
      event: 'ready',
      environment: 'mio_dev',
      evidence,
      templateVersion: probeSpec.templateVersion,
      route: {
        modelId: snapshot.modelId,
        profile: snapshot.profile,
        credentialVersion: snapshot.credentialVersion,
        catalogVersion: snapshot.catalogVersion,
        adaptationVersion: snapshot.adaptationVersion,
        maxOutputTokens,
        reasoningSupported: snapshot.reasoning?.supported === true,
        reasoningEffort: 'omitted',
        streamIdleTimeoutMs: snapshot.streamIdleTimeoutMs,
      },
    });
    runtime = createPromptRuntime({
      callModel: callPromptModel,
      recordVerification: setup.recordVerification,
    });
    const result = await runtime.executeStructuredPrompt({
      ownerId: setup.ownerId,
      snapshot,
      signal: new AbortController().signal,
      evidence,
      spec: probeSpec,
      input: undefined,
      async observe(observation) {
        // Deliberate allowlist: no upstream IDs, raw text, secrets, signatures or response bodies.
        record({
          event: 'observation',
          status: observation.status,
          finish: observation.finish,
          purpose: observation.purpose,
          usageStatus: observation.usageStatus,
          usage: observation.usage,
        });
      },
    });
    return {
      status: result.status,
      ...('error' in result ? { error: result.error } : {}),
      observations: result.observations.length,
      ...audit.counts(),
    };
  } finally {
    try {
      await runtime?.close();
      if (setup?.ready) await setup.close();
    } finally {
      setGlobalDispatcher(original);
    }
  }
}

if (import.meta.main) {
  let file: number | undefined;
  try {
    const [ownerId, output] = process.argv.slice(2);
    const result = await runLivePrompt(
      async () => {
        if (!ownerId || !output || process.argv.length !== 4)
          return { ready: false, reason: 'LIVE_PROMPT_OWNER_AND_NEW_EVIDENCE_FILE_REQUIRED' };
        mkdirSync(dirname(resolve(output)), { recursive: true, mode: 0o700 });
        file = openSync(output, 'wx', 0o600);
        return existingDevSetup(ownerId);
      },
      (event) => {
        writeSync(file!, JSON.stringify({ at: utcISOString(), ...event }) + '\n');
        fsyncSync(file!);
      },
    );
    if (file !== undefined) {
      writeSync(file, JSON.stringify({ event: 'result', ...result }) + '\n');
      fsyncSync(file);
    }
    console.log(JSON.stringify(result));
    if (result.status !== 'succeeded') process.exitCode = 1;
  } catch {
    console.error(
      JSON.stringify({ status: 'unknown', error: 'LIVE_PROMPT_ENTRY_FAILED_NO_RESEND' }),
    );
    process.exitCode = 1;
  } finally {
    if (file !== undefined) closeSync(file);
  }
}

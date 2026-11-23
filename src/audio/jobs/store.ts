import { createId } from '@mio/foundation/identifiers';
import { AudioError } from '../contracts.ts';
import type {
  AudioAdmission,
  AudioCapabilities,
  AudioJobStatus,
  AudioOperation,
  AudioParameters,
} from '../contracts.ts';
import type { AudioInspection } from '@mio/compute-contracts';

type AudioQuery = <Row extends object>(
  sql: string,
  values?: unknown[],
) => Promise<{ rows: Row[]; rowCount: number | null }>;

type Transaction = <T>(action: (query: AudioQuery) => Promise<T>) => Promise<T>;

export interface AudioSample {
  key: string;
  sizeBytes: number;
  etag: string;
  filename: string;
  contentType: string;
}

export interface AudioInput {
  modelRef: string;
  voiceRef?: string;
  upstreamVoiceId?: string;
  voiceName?: string;
  voiceSource?: string;
  text: string;
  mode?: 'standard';
  parameters?: AudioParameters;
  sampleAssetId?: string;
  name?: string;
  sampleAuthorization?: true;
  sample?: AudioSample;
}

export interface AudioJobViewRow {
  id: string;
  kind: AudioOperation;
  status: AudioJobStatus;
  input: Omit<AudioInput, 'sample' | 'upstreamVoiceId'>;
  voice_ref: string | null;
  output_asset_id: string;
  inspection: AudioInspection | null;
  record_id: string | null;
  error_code: string | null;
  cancel_requested: boolean;
  lease_id: string | null;
  has_output: boolean;
  upstream_confirmed: boolean;
}

export interface AudioRequestRow extends AudioJobViewRow {
  digest: string;
  capabilities: AudioCapabilities;
}

export interface AudioJobRow {
  id: string;
  owner_id: string;
  kind: AudioOperation;
  status: AudioJobStatus;
  input: AudioInput;
  admission: AudioAdmission;
  output_bytes: Buffer | null;
  output_url: string | null;
  output_asset_id: string;
  output_key: string;
  lease_id: string;
}

const viewColumns = `id,kind,status,input-'sample'-'upstreamVoiceId' AS input,
  voice_ref,output_asset_id,inspection,record_id,error_code,cancel_requested,lease_id,
  (output_bytes IS NOT NULL OR output_url IS NOT NULL) AS has_output,
  (upstream_voice_id IS NOT NULL) AS upstream_confirmed`;
const requestColumns = `${viewColumns},digest,admission->'capabilities' AS capabilities`;
const executionColumns = `id,owner_id,kind,status,input,admission,output_bytes,output_url,
  output_asset_id,output_key,lease_id`;
const recordColumns = `id AS "recordId",job_id AS "jobId",asset_id AS "assetId",kind,text,
  parameters,voice_ref AS "voiceRef",voice_snapshot AS "voiceSnapshot",
  model_ref AS "modelRef",duration_ms AS "durationMs",format,created_at AS "createdAt"`;
export interface AudioRecordRow {
  recordId: string;
  jobId: string;
  assetId: string;
  kind: AudioOperation;
  text: string;
  parameters: AudioParameters | null;
  voiceRef: string | null;
  voiceSnapshot: { name: string; source: string };
  modelRef: string;
  durationMs: number;
  format: string;
  createdAt: Date;
}

export function createAudioStore(query: AudioQuery, transaction: Transaction, whitelist = false) {
  const owned = async (owner: string, id: string) => {
    const row = (
      await query<AudioJobViewRow>(
        `SELECT ${viewColumns} FROM mio_audio_jobs WHERE id=$1 AND owner_id=$2`,
        [id, owner],
      )
    ).rows[0];
    if (!row) throw new AudioError(404, 'AUDIO_JOB_NOT_FOUND');
    return row;
  };
  const request = async (owner: string, requestId: string, q = query) =>
    (
      await q<AudioRequestRow>(
        `SELECT ${requestColumns} FROM mio_audio_jobs WHERE owner_id=$1 AND request_id=$2`,
        [owner, requestId],
      )
    ).rows[0];

  return {
    owned,
    request,
    create(
      owner: string,
      requestId: string,
      digest: string,
      kind: AudioOperation,
      input: AudioInput,
      admission: AudioAdmission,
    ) {
      return transaction(async (q) => {
        const config = (
          await q<{
            id: string;
            credential_version: number;
            catalog_version: number;
            catalog_credential_version: number;
            enabled: boolean;
            credential_auth_state: string;
          }>(
            `SELECT id,credential_version,catalog_version,catalog_credential_version,enabled,credential_auth_state
             FROM mio_provider_configs WHERE owner_id=$1 FOR UPDATE`,
            [owner],
          )
        ).rows[0];
        const prior = await request(owner, requestId, q);
        if (prior) return { created: false, job: prior };
        if (
          !config?.enabled ||
          config.credential_auth_state === 'rejected' ||
          config.id !== admission.providerConfigId ||
          config.credential_version !== admission.credentialVersion ||
          config.catalog_credential_version !== admission.credentialVersion ||
          config.catalog_version !== admission.catalogVersion
        )
          throw new AudioError(409, 'AUDIO_PROVIDER_CHANGED');
        // Serialize new intake against updates to the selected route. Existing
        // receipts do not depend on a route that was changed after acceptance.
        const route = await q(
          `SELECT r.raw_model_id FROM mio_provider_models m
           JOIN mio_provider_model_routes r ON r.provider_type='onelink' AND r.raw_model_id=m.raw_model_id
           WHERE m.provider_id=$1 AND m.model_key=$2 AND m.raw_model_id=$3
             AND m.membership_state='current' AND m.unavailable_reason IS NULL
             AND m.credential_version=$4 AND m.catalog_version=$5
             AND r.operation=$6 AND r.enabled AND r.declaration_version=$7 AND r.submit_path=$8
             AND COALESCE((
               SELECT cat.user_visible FROM mio_provider_catalog_models cat
               WHERE cat.provider_type=r.provider_type AND cat.raw_model_id=r.raw_model_id FOR SHARE
             ),NOT $9)
             AND NOT EXISTS (
               SELECT 1 FROM mio_provider_model_preferences p
               WHERE p.provider_id=m.provider_id AND p.model_key=m.model_key
                 AND p.usage='voice' AND NOT p.enabled
             )
           FOR SHARE OF m,r`,
          [
            admission.providerConfigId,
            admission.modelKey,
            admission.modelId,
            admission.credentialVersion,
            admission.catalogVersion,
            kind === 'tts' ? 'audio.tts' : 'audio.clone',
            admission.adaptationVersion,
            admission.submitPath,
            whitelist,
          ],
        );
        if (!route.rows.length) throw new AudioError(409, 'AUDIO_OPERATION_UNAVAILABLE');
        const active = await q(
          `SELECT id FROM mio_audio_jobs
           WHERE owner_id=$1 AND status IN ('queued','submitted','materializing') LIMIT 2`,
          [owner],
        );
        if (active.rows.length >= 2) throw new AudioError(429, 'AUDIO_CONCURRENCY_LIMIT');
        const id = createId();
        const assetId = createId();
        const key = `mio/raw/${assetId}/${createId()}`;
        const row = (
          await q<AudioRequestRow>(
            `INSERT INTO mio_audio_jobs(id,owner_id,request_id,digest,kind,status,input,admission,output_asset_id,output_key)
             VALUES($1,$2,$3,$4,$5,'queued',$6::jsonb,$7::jsonb,$8,$9) RETURNING ${requestColumns}`,
            [
              id,
              owner,
              requestId,
              digest,
              kind,
              JSON.stringify(input),
              JSON.stringify(admission),
              assetId,
              key,
            ],
          )
        ).rows[0]!;
        return { created: true, job: row };
      });
    },
    claim() {
      return transaction(async (q) => {
        const locked = await q<{ acquired: boolean }>(
          `SELECT pg_try_advisory_xact_lock(hashtext(current_schema()), hashtext('mio-audio-execution')) AS acquired`,
        );
        if (!locked.rows[0]?.acquired) return;
        await q(
          `UPDATE mio_audio_jobs SET status='unknown',error_code='AUDIO_SUBMIT_UNKNOWN',
           lease_id=NULL,lease_until=NULL,updated_at=now()
           WHERE status='submitted' AND (lease_until IS NULL OR lease_until<=now())`,
        );
        const active = await q(
          `SELECT id FROM mio_audio_jobs WHERE status IN ('queued','submitted','materializing')
           AND lease_until>now() LIMIT 2`,
        );
        if (active.rows.length >= 2) return;
        return (
          await q<AudioJobRow>(
            `UPDATE mio_audio_jobs SET lease_id=$1,lease_until=now()+interval '30 minutes',
             updated_at=now() WHERE id=(
               SELECT id FROM mio_audio_jobs WHERE status IN ('queued','materializing')
               AND (lease_until IS NULL OR lease_until<=now())
               AND (NOT cancel_requested OR status='materializing') AND error_code IS NULL
               ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED
             ) RETURNING ${executionColumns}`,
            [createId()],
          )
        ).rows[0];
      });
    },
    async beginSubmission(job: AudioJobRow) {
      const updated = await query(
        `UPDATE mio_audio_jobs SET status='submitted',updated_at=now()
         WHERE id=$1 AND lease_id=$2 AND lease_until>now()
         AND status='queued' AND NOT cancel_requested`,
        [job.id, job.lease_id],
      );
      if (!updated.rowCount) throw new AudioError(409, 'AUDIO_LEASE_LOST');
    },
    async checkpoint(
      job: AudioJobRow,
      value: { bytes?: Uint8Array; url?: string; voiceId?: string },
    ) {
      const updated = await query(
        `UPDATE mio_audio_jobs SET status='materializing',output_bytes=$3,output_url=$4,
         upstream_voice_id=COALESCE($5,upstream_voice_id),updated_at=now()
         WHERE id=$1 AND lease_id=$2 AND lease_until>now() AND status IN ('submitted','materializing')`,
        [job.id, job.lease_id, value.bytes ?? null, value.url ?? null, value.voiceId ?? null],
      );
      if (!updated.rowCount) throw new AudioError(409, 'AUDIO_LEASE_LOST');
    },
    async bytes(job: AudioJobRow, bytes: Uint8Array) {
      const updated = await query(
        `UPDATE mio_audio_jobs SET output_bytes=$3,output_url=NULL,updated_at=now()
         WHERE id=$1 AND lease_id=$2 AND lease_until>now() AND status='materializing'`,
        [job.id, job.lease_id, bytes],
      );
      if (!updated.rowCount) throw new AudioError(409, 'AUDIO_LEASE_LOST');
    },
    async stored(job: AudioJobRow, etag: string, sha256: string) {
      const updated = await query(
        `UPDATE mio_audio_jobs SET output_etag=$3,output_sha256=$4,updated_at=now()
         WHERE id=$1 AND lease_id=$2 AND lease_until>now() AND status='materializing'
           AND (output_etag IS NULL OR output_etag=$3) AND (output_sha256 IS NULL OR output_sha256=$4)`,
        [job.id, job.lease_id, etag, sha256],
      );
      if (!updated.rowCount) throw new AudioError(409, 'AUDIO_CHECKPOINT_CHANGED');
    },
    async defer(
      job: AudioJobRow,
      status: 'queued' | 'failed' | 'unknown' | 'materializing',
      code: string | null,
    ) {
      await query(
        `UPDATE mio_audio_jobs SET status=CASE WHEN status='materializing' AND $3='unknown'
           THEN 'materializing' ELSE $3 END,
         error_code=CASE WHEN status='materializing' AND $3='unknown'
           THEN 'AUDIO_CHECKPOINT_UNAVAILABLE' ELSE $4 END,
         lease_id=NULL,lease_until=NULL,updated_at=now()
         WHERE id=$1 AND lease_id=$2 AND status NOT IN ('ready','failed','cancelled','unknown')`,
        [job.id, job.lease_id, status, code],
      );
    },
    async recover(owner: string, id: string) {
      const job = await owned(owner, id);
      if (job.status === 'unknown') throw new AudioError(409, 'AUDIO_SUBMIT_UNKNOWN');
      if (job.upstream_confirmed && !job.has_output && job.status !== 'ready')
        throw new AudioError(409, 'AUDIO_AUDITION_MISSING');
      await query(
        `UPDATE mio_audio_jobs SET error_code=NULL,lease_until=NULL,updated_at=now()
         WHERE id=$1 AND owner_id=$2 AND status='materializing' AND lease_id IS NULL
         AND (output_bytes IS NOT NULL OR output_url IS NOT NULL)`,
        [id, owner],
      );
      return owned(owner, id);
    },
    async cancel(owner: string, id: string) {
      await query(
        `UPDATE mio_audio_jobs SET cancel_requested=true,
         status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END,
         lease_id=CASE WHEN status='queued' THEN NULL ELSE lease_id END,
         lease_until=CASE WHEN status='queued' THEN NULL ELSE lease_until END,updated_at=now()
         WHERE id=$1 AND owner_id=$2 AND status NOT IN ('ready','failed','cancelled')
         AND NOT cancel_requested`,
        [id, owner],
      );
      return owned(owner, id);
    },
    publish(job: AudioJobRow, inspection: AudioInspection) {
      return transaction((q) => publish(q, job, inspection));
    },
    async records(owner: string, before: string | null, limit: number) {
      return (
        await query<AudioRecordRow>(
          `SELECT ${recordColumns} FROM mio_audio_records WHERE owner_id=$1
           AND ($2::uuid IS NULL OR (created_at,id)<(
             SELECT created_at,id FROM mio_audio_records WHERE id=$2 AND owner_id=$1
           )) ORDER BY created_at DESC,id DESC LIMIT $3`,
          [owner, before, limit + 1],
        )
      ).rows;
    },
    async record(owner: string, id: string) {
      const row = (
        await query<AudioRecordRow>(
          `SELECT ${recordColumns} FROM mio_audio_records WHERE id=$1 AND owner_id=$2`,
          [id, owner],
        )
      ).rows[0];
      if (!row) throw new AudioError(404, 'AUDIO_RECORD_NOT_FOUND');
      return row;
    },
  };
}
export type AudioStore = ReturnType<typeof createAudioStore>;

async function publish(q: AudioQuery, job: AudioJobRow, inspection: AudioInspection) {
  const current = (
    await q<{ output_etag: string; output_sha256: string; upstream_voice_id: string | null }>(
      `SELECT output_etag,output_sha256,upstream_voice_id FROM mio_audio_jobs
       WHERE id=$1 AND lease_id=$2 AND lease_until>now() AND status='materializing'
       AND output_bytes IS NOT NULL FOR UPDATE`,
      [job.id, job.lease_id],
    )
  ).rows[0];
  if (!current?.output_etag || current.output_sha256 !== inspection.sha256)
    throw new AudioError(409, 'AUDIO_CHECKPOINT_MISSING');

  let voiceRef = job.input.voiceRef ?? null;
  if (job.kind === 'clone') {
    if (!current.upstream_voice_id) throw new AudioError(409, 'AUDIO_VOICE_MISSING');
    const voice = (
      await q<{ id: string }>(
        `INSERT INTO mio_provider_voices(provider_id,source,upstream_id,name,descriptions,seen_seq,local_clone_job_id,preview_asset_id)
         VALUES($1,'voice_cloning',$2,$3,'[]',1,$4,$5)
         ON CONFLICT(provider_id,source,upstream_id) DO UPDATE
         SET present=true,local_clone_job_id=EXCLUDED.local_clone_job_id,preview_asset_id=EXCLUDED.preview_asset_id
         WHERE mio_provider_voices.local_clone_job_id IS NULL OR mio_provider_voices.local_clone_job_id=EXCLUDED.local_clone_job_id
         RETURNING id`,
        [
          job.admission.providerConfigId,
          current.upstream_voice_id,
          job.input.name,
          job.id,
          job.output_asset_id,
        ],
      )
    ).rows[0];
    if (!voice) throw new AudioError(409, 'AUDIO_VOICE_CONFLICT');
    voiceRef = voice.id;
  }
  const record = (
    await q<{ id: string }>(
      `INSERT INTO mio_audio_records(id,job_id,owner_id,asset_id,kind,text,parameters,voice_ref,voice_snapshot,model_ref,duration_ms,format)
       VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb,$10,$11,$12)
       ON CONFLICT(job_id) DO UPDATE SET job_id=EXCLUDED.job_id
       WHERE mio_audio_records.owner_id=EXCLUDED.owner_id AND mio_audio_records.asset_id=EXCLUDED.asset_id
       RETURNING id`,
      [
        createId(),
        job.id,
        job.owner_id,
        job.output_asset_id,
        job.kind,
        job.input.text,
        JSON.stringify(job.input.parameters ?? null),
        voiceRef,
        JSON.stringify({
          name: job.input.voiceName ?? job.input.name,
          source: job.kind === 'clone' ? 'voice_cloning' : (job.input.voiceSource ?? 'catalog'),
        }),
        job.input.modelRef,
        inspection.durationMs,
        inspection.format,
      ],
    )
  ).rows[0];
  if (!record) throw new AudioError(409, 'AUDIO_RECORD_CONFLICT');
  await q(
    `UPDATE mio_audio_jobs SET status='ready',record_id=$3,voice_ref=$4,inspection=$5::jsonb,
     output_bytes=NULL,output_url=NULL,error_code=NULL,lease_id=NULL,lease_until=NULL,updated_at=now()
     WHERE id=$1 AND lease_id=$2`,
    [job.id, job.lease_id, record.id, voiceRef, JSON.stringify(inspection)],
  );
}

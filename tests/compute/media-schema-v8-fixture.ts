/** Literal media schema at 69efaf92ac79d7c19e758e065d24d4666112359e; historical ordinal migration included. */
export const mediaSchemaV8SQL = `
CREATE TABLE IF NOT EXISTS mio_media_jobs (
  id uuid PRIMARY KEY, owner_id text NOT NULL, request_id uuid NOT NULL,
  request_hash text NOT NULL, operation text NOT NULL, parameters jsonb NOT NULL,
  inputs jsonb NOT NULL, profile text NOT NULL CHECK(profile = 'standard-media'),
  state text NOT NULL CHECK(state IN ('accepted','queued','running','reconciling','cancel_requested','succeeded','failed','cancelled')),
  attempt integer NOT NULL CHECK(attempt BETWEEN 1 AND 3),
  attempt_id uuid NOT NULL, command_id uuid NOT NULL,
  cancel_requested boolean NOT NULL DEFAULT false,
  error_code text, stage text, progress double precision NOT NULL DEFAULT 0,
  data jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_id,request_id)
);
CREATE INDEX IF NOT EXISTS mio_media_jobs_owner ON mio_media_jobs(owner_id,created_at DESC);
CREATE INDEX IF NOT EXISTS mio_media_jobs_active ON mio_media_jobs(owner_id)
  WHERE state NOT IN ('succeeded','failed','cancelled');
CREATE TABLE IF NOT EXISTS mio_media_outbox (
  id uuid PRIMARY KEY, job_id uuid NOT NULL REFERENCES mio_media_jobs(id),
  command jsonb NOT NULL, lease_id uuid, lease_until timestamptz, sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mio_media_outbox_pending ON mio_media_outbox(created_at) WHERE sent_at IS NULL;
CREATE TABLE IF NOT EXISTS mio_media_inbox (
  id uuid PRIMARY KEY, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mio_media_inbox_recovery
  ON mio_media_inbox ((payload->>'jobId'),(payload->>'attemptId'),(payload->>'commandId'),created_at,id)
  WHERE payload ? '_verificationErrors';
CREATE TABLE IF NOT EXISTS mio_media_retries (
  owner_id text NOT NULL, request_id uuid NOT NULL, job_id uuid NOT NULL REFERENCES mio_media_jobs(id),
  attempt_id uuid NOT NULL, PRIMARY KEY(owner_id,request_id)
);
CREATE TABLE IF NOT EXISTS mio_media_controls (
  job_id uuid NOT NULL REFERENCES mio_media_jobs(id), attempt_id uuid NOT NULL,
  action text NOT NULL CHECK(action IN ('cancel','recover')), message_id uuid NOT NULL,
  PRIMARY KEY(job_id,attempt_id,action)
);
CREATE TABLE IF NOT EXISTS mio_media_files (
  asset_id uuid PRIMARY KEY REFERENCES mio_assets(id), job_id uuid NOT NULL REFERENCES mio_media_jobs(id),
  name text NOT NULL, role text NOT NULL, object_key text NOT NULL UNIQUE,
  size_bytes bigint NOT NULL, etag text NOT NULL, sha256 text NOT NULL, content_type text NOT NULL,
  UNIQUE(job_id,name)
);
ALTER TABLE mio_media_files ADD COLUMN IF NOT EXISTS ordinal integer NOT NULL DEFAULT 0
  CHECK (ordinal >= 0);`;

/** Exact list SQL from the same baseline, used for comparable Route A probes. */
export const mediaListV8SQL = String.raw`  WITH selected AS (SELECT * FROM mio_media_jobs WHERE owner_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100), output_groups AS (
    SELECT f.job_id,jsonb_agg(jsonb_build_object(
      'assetId',f.asset_id,'name',f.name,'role',f.role,
      'contentType',f.content_type,'sizeBytes',f.size_bytes
    ) ORDER BY f.ordinal,f.name) AS outputs
    FROM mio_media_files f JOIN selected j ON j.id=f.job_id AND j.state='succeeded'
    GROUP BY f.job_id
  )
  SELECT j.*,COALESCE(g.outputs,'[]'::jsonb) AS outputs
  FROM selected j LEFT JOIN output_groups g ON g.job_id=j.id
  ORDER BY j.created_at DESC,j.id DESC`;

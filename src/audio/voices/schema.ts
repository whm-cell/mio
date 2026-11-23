/** Owned by the provider pool/migration: upstream voice identities are account resources. */
export const voiceSchemaSQL = `
CREATE TABLE IF NOT EXISTS mio_provider_voice_catalogs (
  provider_id uuid PRIMARY KEY REFERENCES mio_provider_configs(id),
  latest_seq integer NOT NULL DEFAULT 0 CHECK(latest_seq>=0),
  last_status text NOT NULL CHECK(last_status IN ('running','connected','failed')),
  last_error text, started_at timestamptz NOT NULL, finished_at timestamptz,
  lease_until timestamptz NOT NULL,
  succeeded_seq integer, succeeded_at timestamptz,
  credential_version integer, catalog_version integer,
  model_key uuid, raw_model_id text COLLATE "C", declaration_version integer,
  CHECK ((succeeded_seq IS NULL AND succeeded_at IS NULL AND credential_version IS NULL
    AND catalog_version IS NULL AND model_key IS NULL AND raw_model_id IS NULL AND declaration_version IS NULL)
    OR (succeeded_seq>0 AND succeeded_at IS NOT NULL AND credential_version>0
    AND catalog_version>0 AND model_key IS NOT NULL AND raw_model_id IS NOT NULL AND declaration_version>0))
);
CREATE TABLE IF NOT EXISTS mio_provider_voices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id uuid NOT NULL REFERENCES mio_provider_configs(id),
  source text NOT NULL CHECK(source IN ('system','voice_cloning','voice_generation')),
  upstream_id text COLLATE "C" NOT NULL CHECK(octet_length(upstream_id) BETWEEN 1 AND 256 AND upstream_id !~ '[[:cntrl:]]'),
  name text NOT NULL CHECK(char_length(name) BETWEEN 1 AND 100),
  descriptions jsonb NOT NULL CHECK(jsonb_typeof(descriptions)='array'),
  favorite boolean NOT NULL DEFAULT false,
  present boolean NOT NULL DEFAULT true,
  seen_seq integer NOT NULL CHECK(seen_seq>0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(provider_id,source,upstream_id)
);
ALTER TABLE mio_provider_voices
  ADD COLUMN IF NOT EXISTS local_clone_job_id uuid,
  ADD COLUMN IF NOT EXISTS preview_asset_id uuid,
  ADD COLUMN IF NOT EXISTS registration_model_key uuid,
  ADD COLUMN IF NOT EXISTS registration_evidence text;
CREATE UNIQUE INDEX IF NOT EXISTS mio_provider_voices_local_clone_job_id_key
  ON mio_provider_voices(local_clone_job_id);
CREATE INDEX IF NOT EXISTS mio_provider_voices_page ON mio_provider_voices(provider_id,created_at DESC,id DESC);
`;

export async function checkVoiceSchema(database: {
  query(sql: string): Promise<{ fields: { dataTypeID: number }[] }>;
}): Promise<void> {
  for (const [sql, types] of [
    [
      'SELECT provider_id,latest_seq,last_status,last_error,started_at,finished_at,lease_until,succeeded_seq,succeeded_at,credential_version,catalog_version,model_key,raw_model_id,declaration_version FROM mio_provider_voice_catalogs LIMIT 0',
      [2950, 23, 25, 25, 1184, 1184, 1184, 23, 1184, 23, 23, 2950, 25, 23],
    ],
    [
      'SELECT id,provider_id,source,upstream_id,name,descriptions,favorite,present,seen_seq,created_at,updated_at,local_clone_job_id,preview_asset_id,registration_model_key,registration_evidence FROM mio_provider_voices LIMIT 0',
      [2950, 2950, 25, 25, 25, 3802, 16, 16, 23, 1184, 1184, 2950, 2950, 2950, 25],
    ],
  ] as const) {
    const result = await database.query(sql);
    if (
      result.fields.length !== types.length ||
      result.fields.some((field, index) => field.dataTypeID !== types[index])
    )
      throw new Error('PROVIDER_SCHEMA: incompatible voice columns');
  }
}

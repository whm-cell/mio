/** Incremental provider-pool migration. */
export const audioSchemaSQL = `
CREATE TABLE IF NOT EXISTS mio_audio_jobs (
 id uuid PRIMARY KEY, owner_id text NOT NULL, request_id uuid NOT NULL, digest text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('tts','clone')),
 status text NOT NULL CHECK(status IN ('queued','submitted','unknown','materializing','ready','failed','cancelled')),
 input jsonb NOT NULL, admission jsonb NOT NULL,
 upstream_voice_id text, voice_ref uuid, output_bytes bytea, output_url text,
 output_asset_id uuid NOT NULL, output_key text NOT NULL, output_etag text, output_sha256 text,
 inspection jsonb, record_id uuid, error_code text,
 cancel_requested boolean NOT NULL DEFAULT false,
 lease_id uuid, lease_until timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_id,request_id), CHECK(octet_length(output_bytes)<=104857600)
);
CREATE INDEX IF NOT EXISTS mio_audio_jobs_pending ON mio_audio_jobs(created_at) WHERE status IN ('queued','submitted','materializing');
CREATE INDEX IF NOT EXISTS mio_audio_jobs_owner ON mio_audio_jobs(owner_id,created_at DESC,id DESC);
CREATE TABLE IF NOT EXISTS mio_audio_records (
 id uuid PRIMARY KEY, job_id uuid NOT NULL UNIQUE REFERENCES mio_audio_jobs(id), owner_id text NOT NULL,
 asset_id uuid NOT NULL, kind text NOT NULL, text text NOT NULL, parameters jsonb,
 voice_ref uuid, voice_snapshot jsonb NOT NULL, model_ref text NOT NULL,
 duration_ms integer NOT NULL CHECK(duration_ms>0 AND duration_ms<=3600000), format text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mio_audio_records_owner ON mio_audio_records(owner_id,created_at DESC,id DESC);
`;

export async function checkAudioSchema(database: {
  query(sql: string): Promise<{ fields: { dataTypeID: number }[] }>;
}): Promise<void> {
  for (const [sql, types] of [
    [
      'SELECT id,owner_id,request_id,digest,kind,status,input,admission,upstream_voice_id,voice_ref,output_bytes,output_url,output_asset_id,output_key,output_etag,output_sha256,inspection,record_id,error_code,cancel_requested,lease_id,lease_until,created_at,updated_at FROM mio_audio_jobs LIMIT 0',
      [
        2950, 25, 2950, 25, 25, 25, 3802, 3802, 25, 2950, 17, 25, 2950, 25, 25, 25, 3802, 2950, 25,
        16, 2950, 1184, 1184, 1184,
      ],
    ],
    [
      'SELECT id,job_id,owner_id,asset_id,kind,text,parameters,voice_ref,voice_snapshot,model_ref,duration_ms,format,created_at FROM mio_audio_records LIMIT 0',
      [2950, 2950, 25, 2950, 25, 25, 3802, 2950, 3802, 25, 23, 25, 1184],
    ],
  ] as const) {
    const result = await database.query(sql);
    if (
      result.fields.length !== types.length ||
      result.fields.some((f, i) => f.dataTypeID !== types[i])
    )
      throw new Error('PROVIDER_SCHEMA: incompatible audio task columns');
  }
}

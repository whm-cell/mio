/** The actual pre-dynamic schema, retained solely for explicit upgrade tests. */
export const legacyProviderSchemaSQL = `
CREATE TABLE mio_provider_configs (
  id uuid PRIMARY KEY, owner_id text NOT NULL UNIQUE,
  provider_type text NOT NULL DEFAULT 'onelink' CHECK(provider_type='onelink'),
  enabled boolean NOT NULL DEFAULT true,
  default_image_watermark boolean NOT NULL DEFAULT false,
  default_video_watermark boolean NOT NULL DEFAULT false,
  revision integer NOT NULL CHECK(revision>0), credential_version integer NOT NULL CHECK(credential_version>0),
  cipher_format smallint NOT NULL CHECK(cipher_format=1), master_key_id text NOT NULL,
  nonce bytea NOT NULL CHECK(octet_length(nonce)=12), ciphertext bytea NOT NULL,
  auth_tag bytea NOT NULL CHECK(octet_length(auth_tag)=16), discovery jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE mio_provider_model_preferences (
  provider_id uuid NOT NULL REFERENCES mio_provider_configs(id), model_ref text NOT NULL,
  category text NOT NULL CHECK(category IN ('chat','image','video','voice','music')),
  enabled boolean NOT NULL, is_default boolean NOT NULL,
  PRIMARY KEY(provider_id,model_ref), CHECK(NOT is_default OR enabled)
);
CREATE UNIQUE INDEX mio_provider_category_default
  ON mio_provider_model_preferences(provider_id,category) WHERE is_default;
`;

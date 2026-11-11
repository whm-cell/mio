/** Explicit transactional upgrade; old discovery never implies a protocol declaration. */
export const legacyProviderUpgradeSQL = `
DO $upgrade$
DECLARE c record; d jsonb; ids jsonb; valid boolean;
BEGIN
  IF EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema()
    AND table_name='mio_provider_model_preferences' AND column_name='category') THEN
    FOR c IN SELECT * FROM mio_provider_configs FOR UPDATE LOOP
      d := c.discovery; ids := d->'ids';
      valid := d->>'status'='connected' AND d->>'scope'='models-only'
        AND d->>'credentialVersion'=c.credential_version::text
        AND jsonb_typeof(ids)='array' AND d->>'checkedAt' ~ '^\\d{4}-\\d{2}-\\d{2}T';
      IF valid THEN
        valid := jsonb_array_length(ids)<=5000 AND NOT EXISTS(
          SELECT 1 FROM jsonb_array_elements(ids) x WHERE jsonb_typeof(x)<>'string'
            OR octet_length(x#>>'{}') NOT BETWEEN 1 AND 256 OR (x#>>'{}') ~ '[[:cntrl:]]');
      END IF;
      IF valid THEN
        UPDATE mio_provider_configs SET catalog_version=1,catalog_credential_version=credential_version,
          catalog_succeeded_at=(d->>'checkedAt')::timestamptz,credential_auth_state='valid' WHERE id=c.id;
        INSERT INTO mio_provider_models(provider_id,raw_model_id,supplier_metadata,metadata_source,
          credential_version,catalog_version,first_seen_at,last_seen_at,membership_state)
          SELECT c.id,x#>>'{}','{}'::jsonb,'legacy-complete-discovery',c.credential_version,1,
            (d->>'checkedAt')::timestamptz,(d->>'checkedAt')::timestamptz,'current'
          FROM jsonb_array_elements(ids) x ON CONFLICT(provider_id,raw_model_id) DO NOTHING;
      ELSIF d->>'credentialVersion'=c.credential_version::text
        AND d->>'error'='UPSTREAM_AUTH_REJECTED' THEN
        UPDATE mio_provider_configs SET credential_auth_state='rejected' WHERE id=c.id;
      END IF;
    END LOOP;
    INSERT INTO mio_provider_models(provider_id,raw_model_id,legacy_ref,unavailable_reason)
      SELECT DISTINCT provider_id,
        CASE WHEN model_ref ~ '^onelink:(chat|image|video|voice|music):.+'
          THEN regexp_replace(model_ref,'^onelink:[^:]+:','') END,
        CASE WHEN model_ref !~ '^onelink:(chat|image|video|voice|music):.+' THEN model_ref END,
        CASE WHEN model_ref !~ '^onelink:(chat|image|video|voice|music):.+' THEN 'LEGACY_MODEL_REF_INVALID' END
      FROM mio_provider_model_preferences ON CONFLICT DO NOTHING;
    ALTER TABLE mio_provider_model_preferences ADD COLUMN model_key uuid;
    UPDATE mio_provider_model_preferences p SET model_key=m.model_key FROM mio_provider_models m
      WHERE m.provider_id=p.provider_id AND
        ((p.model_ref ~ '^onelink:(chat|image|video|voice|music):.+'
          AND m.raw_model_id=regexp_replace(p.model_ref,'^onelink:[^:]+:','') COLLATE "C")
        OR m.legacy_ref=p.model_ref);
    ALTER TABLE mio_provider_model_preferences ALTER COLUMN model_key SET NOT NULL;
    ALTER TABLE mio_provider_model_preferences DROP CONSTRAINT mio_provider_model_preferences_pkey;
    ALTER TABLE mio_provider_model_preferences DROP CONSTRAINT IF EXISTS mio_provider_model_preferences_check;
    DROP INDEX IF EXISTS mio_provider_category_default;
    ALTER TABLE mio_provider_model_preferences RENAME COLUMN category TO usage;
    ALTER TABLE mio_provider_model_preferences ALTER COLUMN model_ref DROP NOT NULL;
    ALTER TABLE mio_provider_model_preferences ADD PRIMARY KEY(provider_id,model_key,usage);
    ALTER TABLE mio_provider_model_preferences ADD FOREIGN KEY(provider_id,model_key)
      REFERENCES mio_provider_models(provider_id,model_key);
    ALTER TABLE mio_provider_model_preferences ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
  END IF;
END $upgrade$;
`;

/** Owner/config pairs come from existing conversation metadata, never from a model response. */
export const providerReferencesSQL = `
INSERT INTO mio_provider_models(provider_id,raw_model_id,legacy_ref,unavailable_reason)
SELECT DISTINCT c.id,
  CASE WHEN r."modelRef" ~ '^onelink:(chat|image|video|voice|music):.+'
    THEN regexp_replace(r."modelRef",'^onelink:[^:]+:','') END,
  CASE WHEN r."modelRef" !~ '^onelink:(chat|image|video|voice|music):.+'
    THEN r."modelRef" END,
  CASE WHEN r."modelRef" !~ '^onelink:(chat|image|video|voice|music):.+'
    THEN 'LEGACY_MODEL_REF_INVALID' END
FROM jsonb_to_recordset($1::jsonb) r("ownerId" text,"providerId" text,"modelRef" text)
JOIN mio_provider_configs c ON c.owner_id=r."ownerId" AND c.id::text=r."providerId"
WHERE r."modelRef" IS NOT NULL AND r."modelRef" !~ '^onelink:model:[0-9a-f-]{36}$'
ON CONFLICT DO NOTHING;
`;

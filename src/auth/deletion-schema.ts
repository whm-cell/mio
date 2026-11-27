import type { Pool } from 'pg';

/** Installed explicitly after Better Auth's additive columns/indexes, never during startup. */
export const authDeletionGuardsSQL = `
CREATE OR REPLACE FUNCTION mio_auth_verification_owner(value text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE data jsonb;
BEGIN
  IF NOT pg_input_is_valid(value,'jsonb') THEN RETURN NULL; END IF;
  data:=value::jsonb;
  IF jsonb_typeof(data->'link'->'userId')='string' THEN RETURN data->'link'->>'userId'; END IF;
  IF jsonb_typeof(data->'serverContext'->'mioWechatBinding'->'userId')='string' THEN
    RETURN data->'serverContext'->'mioWechatBinding'->>'userId'; END IF;
  RETURN NULL;
END $$;
-- Historical OAuth state contains the linking email; preserve the row and index its real owner.
UPDATE "verification" SET "scopeUserId"=mio_auth_verification_owner(value)
  WHERE "scopeUserId" IS NULL AND mio_auth_verification_owner(value) IS NOT NULL;
CREATE OR REPLACE FUNCTION mio_auth_terminal_user() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."deletedAt" IS NOT NULL AND (NEW."deletedAt" IS DISTINCT FROM OLD."deletedAt" OR NEW.disabled IS DISTINCT FROM true)
    THEN RAISE EXCEPTION 'ACCOUNT_DELETED'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS mio_auth_terminal_user ON "user";
CREATE TRIGGER mio_auth_terminal_user BEFORE UPDATE ON "user" FOR EACH ROW EXECUTE FUNCTION mio_auth_terminal_user();
CREATE OR REPLACE FUNCTION mio_auth_session_owner() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target record;
BEGIN
  SELECT disabled,"deletedAt" INTO target FROM "user" WHERE id=NEW."userId" FOR UPDATE;
  IF NOT FOUND OR target."deletedAt" IS NOT NULL OR target.disabled THEN RAISE EXCEPTION 'ACCOUNT_DELETED'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS mio_auth_session_owner ON "session";
-- Updates do not take a user lock: refresh must not invert deletion's user -> session lock order.
CREATE TRIGGER mio_auth_session_owner BEFORE INSERT ON "session" FOR EACH ROW EXECUTE FUNCTION mio_auth_session_owner();
CREATE OR REPLACE FUNCTION mio_auth_verification_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner text; target record;
BEGIN
  owner:=mio_auth_verification_owner(NEW.value);
  IF TG_OP='UPDATE' AND owner IS DISTINCT FROM OLD."scopeUserId" THEN RAISE EXCEPTION 'AUTH_STATE_OWNER_IMMUTABLE'; END IF;
  NEW."scopeUserId":=owner;
  IF owner IS NULL THEN RETURN NEW; END IF;
  IF TG_OP='INSERT' THEN
    SELECT disabled,"deletedAt" INTO target FROM "user" WHERE id=owner FOR UPDATE;
  ELSE SELECT disabled,"deletedAt" INTO target FROM "user" WHERE id=owner; END IF;
  IF NOT FOUND OR target."deletedAt" IS NOT NULL OR target.disabled THEN RAISE EXCEPTION 'ACCOUNT_DELETED'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS mio_auth_verification_guard ON "verification";
CREATE TRIGGER mio_auth_verification_guard BEFORE INSERT OR UPDATE ON "verification"
  FOR EACH ROW EXECUTE FUNCTION mio_auth_verification_guard();
CREATE OR REPLACE FUNCTION mio_auth_pending_owner() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target record;
BEGIN
  IF NEW."initiatorUserId" IS NULL THEN RETURN NEW; END IF;
  SELECT disabled,"deletedAt" INTO target FROM "user" WHERE id=NEW."initiatorUserId" FOR UPDATE;
  IF NOT FOUND OR target."deletedAt" IS NOT NULL OR target.disabled THEN RAISE EXCEPTION 'ACCOUNT_DELETED'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS mio_auth_pending_owner ON "mioOneLinkPending";
CREATE TRIGGER mio_auth_pending_owner BEFORE INSERT ON "mioOneLinkPending"
  FOR EACH ROW EXECUTE FUNCTION mio_auth_pending_owner();`;

export async function checkAuthDeletionGuards(pool: Pick<Pool, 'query'>) {
  const result = await pool.query<{
    count: string;
  }>(`SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgenabled='O'
    AND ((tgrelid='"user"'::regclass AND tgname='mio_auth_terminal_user')
      OR (tgrelid='"session"'::regclass AND tgname='mio_auth_session_owner')
      OR (tgrelid='"verification"'::regclass AND tgname='mio_auth_verification_guard')
      OR (tgrelid='"mioOneLinkPending"'::regclass AND tgname='mio_auth_pending_owner'))`);
  if (result.rows[0]!.count !== '4')
    throw new Error('AUTH_SCHEMA: run account-deletion:migrate --apply');
}

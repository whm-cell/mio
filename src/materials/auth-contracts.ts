import type { CredentialEnvelope } from '../providers/credentials.ts';
export type MaterialAuthState =
  'creating' | 'pending' | 'verifying' | 'completed' | 'failed' | 'expired' | 'unknown';
export interface MaterialAuthRow {
  id: string;
  owner_id: string;
  provider_type: 'onelink';
  provider_config_id: string;
  credential_version: number;
  request_id: string;
  input_hash: string;
  state: MaterialAuthState;
  protocol_snapshot: { version: 1 };
  return_target: 'materials';
  token_digest: string | null;
  cipher_format: number | null;
  master_key_id: string | null;
  nonce: Buffer | null;
  ciphertext: Buffer | null;
  auth_tag: Buffer | null;
  group_id: string | null;
  lease_id: string | null;
  lease_until: Date | null;
  next_query_at: Date | null;
  query_count: number;
  error_code: string | null;
  created_at: Date;
  updated_at: Date;
  expires_at: Date;
}
export interface MaterialAuthView {
  sessionId: string;
  state: MaterialAuthState;
  launchUrl?: string;
  expiresAt: string;
  groupId?: string;
  pollAfterMs: number;
  errorCode: string | null;
}
export interface MaterialAuthUpstream {
  create(
    key: string,
    callback: string,
    signal: AbortSignal,
  ): Promise<{ launchUrl: string; token: string }>;
  result(key: string, token: string, signal: AbortSignal): Promise<{ groupId: string }>;
  verifiedGroup(key: string, id: string, signal: AbortSignal): Promise<void>;
}
export function materialAuthView(row: MaterialAuthRow, origin: string): MaterialAuthView {
  return {
    sessionId: row.id,
    state: row.state,
    ...(['pending', 'unknown'].includes(row.state) && row.ciphertext
      ? { launchUrl: `${origin}/api/v1/materials/auth-sessions/${row.id}/launch` }
      : {}),
    expiresAt: row.expires_at.toISOString(),
    ...(row.group_id ? { groupId: row.group_id } : {}),
    pollAfterMs: ['creating', 'pending', 'verifying', 'unknown'].includes(row.state) ? 3000 : 0,
    errorCode: row.error_code,
  };
}
export function materialAuthEnvelope(row: MaterialAuthRow): CredentialEnvelope {
  if (
    row.cipher_format !== 1 ||
    !row.master_key_id ||
    !row.nonce ||
    !row.ciphertext ||
    !row.auth_tag
  )
    throw new Error('MATERIAL_AUTH_SECRET_UNAVAILABLE');
  return {
    cipher_format: row.cipher_format,
    master_key_id: row.master_key_id,
    nonce: row.nonce,
    ciphertext: row.ciphertext,
    auth_tag: row.auth_tag,
  };
}

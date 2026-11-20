import { HttpError } from '@mio/foundation/errors';

export class MaterialError extends HttpError {}
export interface MaterialPrincipal {
  userId: string;
  sessionId: string;
}
export type GroupType = 'real' | 'aigc';
export type GroupState = 'creating' | 'ready' | 'unknown' | 'deleting' | 'deleted' | 'failed';
export type MaterialState =
  | 'registering'
  | 'processing'
  | 'active'
  | 'rejected'
  | 'unknown'
  | 'deleting'
  | 'deleted'
  | 'failed';
export type OperationKind =
  'create_group' | 'register_material' | 'delete_material_upstream' | 'delete_group_upstream';
export interface GroupRow {
  id: string;
  owner_id: string;
  provider_type: 'onelink';
  provider_config_id: string;
  upstream_scope: 'onelink-volc-ark';
  upstream_group_id: string | null;
  group_type: GroupType;
  name: string;
  auth_status: 'not_applicable' | 'verified';
  state: GroupState;
  revision: number;
  sync_cursor: string | null;
  sync_lease_id: string | null;
  sync_lease_until: Date | null;
  last_sync_attempt_at: Date | null;
  last_sync_status: 'running' | 'succeeded' | 'failed' | null;
  last_sync_error_code: string | null;
  last_synced_at: Date | null;
  source_session_id: string | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  material_count?: number;
}
export interface MaterialRow {
  id: string;
  owner_id: string;
  provider_type: 'onelink';
  group_id: string;
  source_asset_id: string | null;
  upstream_asset_id: string | null;
  asset_type: 'image';
  name: string;
  state: MaterialState;
  upstream_status: string | null;
  raw_snapshot: Record<string, unknown>;
  registration_credential_version: number;
  last_synced_at: Date | null;
  next_query_at: Date | null;
  error_code: string | null;
  revision: number;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}
export interface OperationRow {
  id: string;
  owner_id: string;
  request_id: string;
  kind: OperationKind;
  target_group_id: string | null;
  target_material_id: string | null;
  input_hash: string;
  state: 'creating' | 'deleting' | 'succeeded' | 'failed' | 'unknown';
  provider_config_id: string;
  credential_version: number;
  protocol_snapshot: {
    version: 1;
    upstreamId?: string;
    previousState?: GroupState | MaterialState;
  };
  upstream_request_id: string | null;
  attempt: number;
  lease_id: string | null;
  lease_until: Date | null;
  next_query_at: Date | null;
  result_local_id: string | null;
  error_code: string | null;
  created_at: Date;
  updated_at: Date;
}
export interface GroupView {
  groupId: string;
  type: GroupType;
  name: string;
  authStatus: GroupRow['auth_status'];
  state: GroupState;
  revision: number;
  materialCount: number;
  lastSyncedAt: string | null;
  lastSyncStatus: GroupRow['last_sync_status'];
  lastSyncErrorCode: string | null;
}
export interface MaterialView {
  materialId: string;
  groupId: string;
  sourceAssetId: string | null;
  assetType: 'image';
  name: string;
  state: MaterialState;
  revision: number;
  lastSyncedAt: string | null;
  errorCode: string | null;
  pollAfterMs: number;
}
export interface OperationView {
  operationId: string;
  kind: OperationKind;
  state: OperationRow['state'];
  resultLocalId: string | null;
  errorCode: string | null;
  pollAfterMs: number;
}
export interface UpstreamMaterial {
  id: string;
  groupId: string;
  name: string;
  status: string;
}
export interface MaterialUpstream {
  createGroup(
    key: string,
    name: string,
    signal: AbortSignal,
  ): Promise<{ id: string; requestId: string | null }>;
  getGroup(key: string, id: string, signal: AbortSignal): Promise<void>;
  renameGroup(key: string, id: string, name: string, signal: AbortSignal): Promise<void>;
  deleteGroup(key: string, id: string, signal: AbortSignal): Promise<void>;
  listMaterials(
    key: string,
    id: string,
    page: number,
    signal: AbortSignal,
  ): Promise<{ items: UpstreamMaterial[]; hasMore: boolean }>;
  getMaterial(
    key: string,
    id: string,
    groupId: string,
    signal: AbortSignal,
  ): Promise<UpstreamMaterial>;
  deleteMaterial(key: string, id: string, signal: AbortSignal): Promise<void>;
}
export function groupView(row: GroupRow): GroupView {
  return {
    groupId: row.id,
    type: row.group_type,
    name: row.name,
    authStatus: row.auth_status,
    state: row.state,
    revision: row.revision,
    materialCount: row.material_count ?? 0,
    lastSyncedAt: row.last_synced_at?.toISOString() ?? null,
    lastSyncStatus: row.last_sync_status,
    lastSyncErrorCode: row.last_sync_error_code,
  };
}
export function materialView(row: MaterialRow): MaterialView {
  return {
    materialId: row.id,
    groupId: row.group_id,
    sourceAssetId: row.source_asset_id,
    assetType: row.asset_type,
    name: row.name,
    state: row.state,
    revision: row.revision,
    lastSyncedAt: row.last_synced_at?.toISOString() ?? null,
    errorCode: row.error_code,
    pollAfterMs: row.state === 'processing' ? 4000 : 0,
  };
}
export function operationView(row: OperationRow): OperationView {
  return {
    operationId: row.id,
    kind: row.kind,
    state: row.state,
    resultLocalId: row.result_local_id,
    errorCode: row.error_code,
    pollAfterMs: ['creating', 'deleting'].includes(row.state) ? 3000 : 0,
  };
}
export function materialState(status: string): MaterialState {
  switch (status) {
    case 'Active':
      return 'active';
    case 'Processing':
    case 'Pending':
      return 'processing';
    case 'Rejected':
      return 'rejected';
    default:
      return 'unknown';
  }
}

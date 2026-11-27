import { HttpError } from '@mio/foundation/errors';

/** Structural policy supplied by the composition root; media never imports the admin domain. */
export interface StoragePolicy {
  revision: number;
  quotaBytes: number;
  warningAvailableBytes: number;
}
export const defaultStoragePolicy: Readonly<StoragePolicy> = Object.freeze({
  revision: 0,
  quotaBytes: 5 * 1024 ** 3,
  warningAvailableBytes: 1024 ** 3,
});
export type StorageStatus = 'safe' | 'warning' | 'full';
export interface StorageHolder {
  type: string;
  id: string;
  assetIds: readonly string[];
}
export interface StorageUsage {
  quotaBytes: number;
  warningAvailableBytes: number;
  usedBytes: number;
  availableBytes: number;
  usageRatio: number;
  objectCount: number;
  status: StorageStatus;
  reminderVersion: string;
  thresholdReminderPending: boolean;
  calculatedAt: string;
}
export function storageStatus(used: number, policy: StoragePolicy): StorageStatus {
  if (used >= policy.quotaBytes) return 'full';
  return policy.quotaBytes - used < policy.warningAvailableBytes ? 'warning' : 'safe';
}
export function storageReminderVersion(status: StorageStatus, revision: number, epoch: string) {
  return `storage:v1:${status}:${revision}:${epoch}`;
}
export class StorageError extends HttpError {}

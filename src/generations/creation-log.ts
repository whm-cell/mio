import type { CreationQuery } from '../notifications/creation-contracts.ts';
import { writeCreationLog } from '../notifications/creation-write.ts';

/** Read only committed-to-be output facts using the caller's result transaction. */
export async function recordGenerationCreationLog(
  query: CreationQuery,
  mediaType: 'image' | 'video',
  jobId: string,
  state: string,
  code: string | null = null,
): Promise<void> {
  if (!['completed', 'partial', 'failed', 'rejected'].includes(state)) return;
  // Exhausted observation budgets and unavailable query credentials don't prove upstream failure.
  if (
    state === 'failed' &&
    code &&
    [
      'IMAGE_QUERY_LIMIT',
      'IMAGE_CREDENTIAL_UNAVAILABLE',
      'VIDEO_QUERY_LIMIT',
      'VIDEO_RECOVERY_QUERY_DISPATCH_EXPIRED',
    ].includes(code)
  )
    return;
  const table = mediaType === 'image' ? 'mio_image_jobs' : 'mio_video_jobs';
  const outputs = mediaType === 'image' ? 'mio_image_outputs' : 'mio_video_outputs';
  const { rows } = await query<{ owner_id: string; occurred_at: Date; useful: boolean }>(
    `SELECT owner_id,statement_timestamp() AS occurred_at,
     EXISTS(SELECT FROM ${outputs} WHERE job_id=$1 ${mediaType === 'video' ? "AND phase='registered'" : ''}) AS useful
     FROM ${table} WHERE id=$1`,
    [jobId],
  );
  const row = rows[0];
  if (!row || ((state === 'completed' || state === 'partial') && !row.useful)) return;
  const eventKind = row.useful ? (state === 'completed' ? 'completed' : 'partial') : 'failed';
  const label = mediaType === 'image' ? '图片' : '视频';
  await writeCreationLog(query, {
    ownerId: row.owner_id,
    mediaType,
    jobId,
    eventKind,
    title: `${label}创作${eventKind === 'completed' ? '完成' : eventKind === 'partial' ? '部分完成' : '失败'}`,
    summary:
      eventKind === 'completed'
        ? `${label}作品已保存，可在生成记录中查看。`
        : eventKind === 'partial'
          ? `部分${label}作品已保存，可在生成记录中查看。`
          : `本次${label}创作确定失败。`,
    occurredAt: row.occurred_at.toISOString(),
  });
}

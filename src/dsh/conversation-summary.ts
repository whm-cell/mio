import { toolPairingBalancedAfter } from '@deepseek-ai/dsh-compaction';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { Session, SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session';
import { isPlainJsonRecord } from '@deepseek-ai/dsh-tools';
import type { TokenMeter, TokenSurfaceNode } from '@deepseek-ai/dsh-token-meter';
import { isUuidV4 } from '@mio/foundation/identifiers';
import { parseImageJobPresentationMeta } from './image-tools.ts';
import { conversationImageAssetId } from './vision.ts';

const referenceLabels = {
  assetid: 'assetId',
  imageassetids: 'imageAssetIds',
  maskassetid: 'maskAssetId',
  jobid: 'jobId',
} as const;
const assetReference =
  /\b(assetId|imageAssetIds|maskAssetId|jobId)["']?\s*(?::|=|：)\s*["']?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi;

function keepToolReferences(
  session: Session,
  result: SessionEvent<'tool/result'>,
  references: Set<string>,
): void {
  // A pruned result cites its original, which cites the recorded tool call.
  let source: SessionEvent | undefined = result;
  while (source?.type === 'tool/result') {
    const seq: SessionSeq | undefined = source.sourceEventSeqs?.[0];
    source = seq === undefined ? undefined : session.eventAt(seq);
  }
  if (
    source?.type !== 'tool/call' ||
    source.data.callId !== result.data.message.toolCallId ||
    source.data.turn !== result.data.turn ||
    source.data.step !== result.data.step
  )
    return;
  const { name, arguments: raw } = source.data;
  if (name !== 'submit_image_job' && name !== 'get_image_job' && name !== 'inspect_image_asset')
    return;
  let args: unknown;
  try {
    args = JSON.parse(raw);
  } catch {
    return;
  }
  if (!isPlainJsonRecord(args)) return;
  const keep = (field: string, value: unknown) => {
    if (typeof value === 'string' && isUuidV4(value)) references.add(`${field}=${value}`);
  };
  if (name === 'submit_image_job') {
    if (Array.isArray(args.imageAssetIds))
      for (const id of args.imageAssetIds) keep('imageAssetIds', id);
    keep('maskAssetId', args.maskAssetId);
  } else if (name === 'get_image_job') {
    keep('jobId', args.jobId);
  } else {
    keep('assetId', args.assetId);
  }
}

function summaryRow(session: Session, event: SessionEvent, references: Set<string>): string {
  const message = session.deriveEventMessage(event);
  if (!message || message.role === 'system' || message.role === 'developer') return '';
  const texts: string[] = [];
  for (const block of message.content) {
    if (block.type === 'text') {
      texts.push(block.text);
      for (const [, label, id] of block.text.matchAll(assetReference)) {
        const key = label!.toLowerCase() as keyof typeof referenceLabels;
        references.add(`${referenceLabels[key]}=${id}`);
      }
    } else if (block.type === 'image') {
      const id = conversationImageAssetId(String(block.attachment.attachmentId));
      if (id) references.add(`assetId=${id}`);
    } else if (block.type === 'tool-call') {
      texts.push(`${block.name} ${block.arguments}`);
    }
  }
  if (event.type === 'tool/result' && !event.data.message.isError) {
    keepToolReferences(session, event, references);
    const card = parseImageJobPresentationMeta(event.data.meta);
    if (card) {
      references.add(`jobId=${card.job.jobId}`);
      for (const id of card.job.assetIds) references.add(`assetId=${id}`);
    }
  }
  return texts.length ? JSON.stringify({ role: message.role, text: texts.join('\n') }) : '';
}

/** Fit the oldest balanced prefix in one pass under the same route's input budget. */
export function fitSummaryInput(
  session: Session,
  candidates: readonly TokenSurfaceNode[],
  meter: TokenMeter,
  maxTokens: number,
) {
  const user = createUserMessage({ source: { kind: 'user' }, content: [] });
  const message = (text: string) => ({ ...user, content: [{ type: 'text' as const, text }] });
  const emptyTokens = meter.estimateMessage(message(''));
  const price = (fragment: string) => meter.estimateMessage(message(fragment)) - emptyTokens;

  let tokens = meter.estimateMessage(message('{"rows":[],"references":[]}'));
  const rows: string[] = [];
  const refs: string[] = [];
  const known = new Set<string>();
  let best: { count: number; rows: number; refs: number } | undefined;
  for (const [index, node] of candidates.entries()) {
    const event = session.eventAt(node.seq);
    if (!event) throw new Error('MIO_COMPACTION_EVENT_MISSING');
    const found = new Set<string>();
    const row = summaryRow(session, event, found);
    if (row) {
      tokens += price(row + ',');
      rows.push(row);
    }
    for (const ref of found) {
      if (known.has(ref)) continue;
      known.add(ref);
      refs.push(ref);
      tokens += price(JSON.stringify(ref) + ',');
    }
    if (tokens > maxTokens) break;
    if (toolPairingBalancedAfter(session, node.seq))
      best = { count: index + 1, rows: rows.length, refs: refs.length };
  }
  if (!best || (!best.rows && !best.refs)) return;
  const selectedRows = rows.slice(0, best.rows).join(',');
  const references = refs.slice(0, best.refs);
  return {
    count: best.count,
    referenceText: references.join('\n'),
    message: message(`{"rows":[${selectedRows}],"references":${JSON.stringify(references)}}`),
  };
}

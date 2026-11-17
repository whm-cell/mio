import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { isImageAdmissionError, requestImageDimensions } from '@deepseek-ai/dsh-attachment';
import { prepareImageFile } from '@deepseek-ai/dsh-attachment-local';
import { HTTP_STATUS } from '@mio/foundation/http-status';
import { isUuidV4 } from '@mio/foundation/identifiers';
import type { VisionSource } from '../assets/contracts.ts';
import { ConversationError } from '../conversations/contracts.ts';
import type {
  ConversationImagePreview,
  ConversationImageReference,
  ConversationVision,
} from '../conversations/contracts.ts';

const LIMITS = {
  maxImageBytes: 10 * 1024 * 1024,
  maxImagesPerMessage: 4,
  maxMessageImageBytes: 40 * 1024 * 1024,
  maxImagePixels: 16_777_216,
  maxImageDimension: 8192,
  mediaTypes: ['image/png', 'image/jpeg', 'image/webp'] as const,
};
const NORMALIZATION = { maxPixels: 16_777_216, maxDimension: 8192, maxBytes: 10 * 1024 * 1024 };
const ID = /^mio-v1:([a-f0-9-]{36}):([a-f0-9]{64}):([a-f0-9]{64}):([a-f0-9]{64})$/;
const digest = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');

type SourceReader = (
  ownerId: string,
  assetId: string,
  expected: { etagDigest: string; sourceDigest: string } | undefined,
  signal: AbortSignal,
) => Promise<VisionSource>;

/** Bound full raster decodes across conversations without holding a permit while waiting on a turn. */
class ImagePreparationGate {
  private active = 0;
  private readonly waiting: {
    signal: AbortSignal;
    ready: () => void;
    fail: () => void;
  }[] = [];

  async acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    if (this.active >= 2) {
      await new Promise<void>((resolve, reject) => {
        const entry = {
          signal,
          ready: () => {
            signal.removeEventListener('abort', entry.fail);
            resolve();
          },
          fail: () => {
            const index = this.waiting.indexOf(entry);
            if (index >= 0) this.waiting.splice(index, 1);
            reject(signal.reason);
          },
        };
        this.waiting.push(entry);
        signal.addEventListener('abort', entry.fail, { once: true });
      });
    } else this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next) next.ready();
      else this.active--;
    };
  }

  async run<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    const release = await this.acquire(signal);
    try {
      signal.throwIfAborted();
      return await work();
    } finally {
      release();
    }
  }
}

function identity(ref: ConversationImageReference) {
  const match = ID.exec(ref.attachmentId);
  if (!match || !isUuidV4(match[1]!))
    throw new ConversationError(HTTP_STATUS.BAD_REQUEST, 'IMAGE_INPUT_INVALID');
  return {
    assetId: match[1]!,
    etagDigest: match[2]!,
    sourceDigest: match[3]!,
    normalized: match[4]!,
  };
}

export function conversationImageAssetId(attachmentId: string): string | undefined {
  const match = ID.exec(attachmentId);
  return match && isUuidV4(match[1]!) ? match[1] : undefined;
}

async function normalized(source: VisionSource, signal: AbortSignal) {
  signal.throwIfAborted();
  try {
    const prepared = await prepareImageFile(
      { data: source.data, mediaType: source.contentType },
      LIMITS,
      NORMALIZATION,
    );
    signal.throwIfAborted();
    return prepared;
  } catch (error) {
    signal.throwIfAborted();
    throw isImageAdmissionError(error)
      ? new ConversationError(HTTP_STATUS.BAD_REQUEST, 'IMAGE_INPUT_INVALID')
      : new ConversationError(HTTP_STATUS.SERVICE_UNAVAILABLE, 'IMAGE_UNAVAILABLE');
  }
}

/** Bridges private assets into deterministic in-memory DSH request references. */
export function createConversationVision(readSource: SourceReader): ConversationVision {
  const gate = new ImagePreparationGate();
  const requests = new ImagePreparationGate();
  return {
    acquireRequest: (signal) => requests.acquire(signal),
    assetId(ref) {
      return identity(ref).assetId;
    },
    target(ref, budget) {
      return {
        ...requestImageDimensions(ref.width, ref.height, budget.maxPixels),
        maxBytes: budget.maxBytes,
      };
    },
    prepare(ownerId, assetId, signal) {
      return gate.run(signal, async () => {
        const source = await readSource(ownerId, assetId, undefined, signal);
        const prepared = await normalized(source, signal);
        return {
          attachmentId: `mio-v1:${assetId}:${source.etagDigest}:${source.sourceDigest}:${digest(prepared.data)}`,
          mediaType: prepared.ref.mediaType as ConversationImageReference['mediaType'],
          bytes: prepared.ref.bytes,
          width: prepared.ref.width,
          height: prepared.ref.height,
        };
      });
    },
    preview(ownerId, ref, target, signal): Promise<ConversationImagePreview> {
      return gate.run(signal, async () => {
        const key = identity(ref);
        if (
          !Number.isSafeInteger(target.width) ||
          target.width < 1 ||
          !Number.isSafeInteger(target.height) ||
          target.height < 1 ||
          !Number.isSafeInteger(target.maxBytes) ||
          target.maxBytes < 1
        )
          throw new ConversationError(HTTP_STATUS.BAD_REQUEST, 'IMAGE_INPUT_INVALID');
        const source = await readSource(ownerId, key.assetId, key, signal);
        const prepared = await normalized(source, signal);
        if (
          digest(prepared.data) !== key.normalized ||
          prepared.ref.mediaType !== ref.mediaType ||
          prepared.ref.bytes !== ref.bytes ||
          prepared.ref.width !== ref.width ||
          prepared.ref.height !== ref.height
        )
          throw new ConversationError(HTTP_STATUS.CONFLICT, 'ASSET_SOURCE_CHANGED');
        const scale = Math.min(1, target.width / ref.width, target.height / ref.height);
        const width = Math.max(1, Math.floor(ref.width * scale));
        const height = Math.max(1, Math.floor(ref.height * scale));
        const preview = await prepareImageFile(
          { data: prepared.data, mediaType: prepared.ref.mediaType },
          LIMITS,
          {
            maxPixels: width * height,
            maxDimension: Math.max(width, height),
            maxBytes: target.maxBytes,
          },
        );
        signal.throwIfAborted();
        const metadata = await sharp(preview.data).metadata();
        signal.throwIfAborted();
        if (
          !metadata.width ||
          !metadata.height ||
          metadata.width !== preview.ref.width ||
          metadata.height !== preview.ref.height ||
          metadata.width > target.width ||
          metadata.height > target.height ||
          metadata.depth !== 'uchar' ||
          metadata.space !== 'srgb'
        )
          throw new ConversationError(HTTP_STATUS.BAD_REQUEST, 'IMAGE_INPUT_INVALID');
        const fingerprint = digest(preview.data);
        return {
          variantId: `sha256:${digest(JSON.stringify([ref.attachmentId, target, fingerprint]))}`,
          attachment: ref,
          data: preview.data,
          mediaType: preview.ref.mediaType as ConversationImagePreview['mediaType'],
          bytes: preview.data.byteLength,
          width: metadata.width,
          height: metadata.height,
          depth: 'uchar',
          space: 'srgb',
          hasAlpha: metadata.hasAlpha === true,
          fingerprint,
        };
      });
    },
  };
}

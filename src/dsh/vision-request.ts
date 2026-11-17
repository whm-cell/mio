import { ImageVariantId } from '@deepseek-ai/dsh-attachment';
import type {
  AttachmentStore,
  ImageAttachmentRef,
  ImageRequestTarget,
} from '@deepseek-ai/dsh-attachment';
import {
  IMAGE_OFFLOAD_REQUIRED_CODE,
  LlmError,
  projectOffloadedImages,
  requiredImageOffload,
} from '@deepseek-ai/dsh-llm';
import type { GenerateOptions } from '@deepseek-ai/dsh-llm';
import type {
  ConversationImagePreview,
  ConversationImageReference,
  ConversationRun,
  ConversationVision,
} from '../conversations/contracts.ts';
import type { ChatImageBudget } from '../providers/contracts.ts';

type PreviewFacts = Pick<
  ConversationImagePreview,
  'fingerprint' | 'bytes' | 'width' | 'height' | 'mediaType'
>;

function reference(ref: ImageAttachmentRef): ConversationImageReference {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(ref.mediaType))
    throw new LlmError('Image reference is invalid', 'IMAGE_INPUT_INVALID');
  return {
    attachmentId: String(ref.attachmentId),
    mediaType: ref.mediaType as ConversationImageReference['mediaType'],
    bytes: ref.bytes,
    width: ref.width,
    height: ref.height,
  };
}

function offload(count: number, run: ConversationRun): never {
  if (count > (run.offloadableImages?.() ?? 0))
    throw new LlmError('Current turn images exceed the request budget', 'IMAGE_INPUT_INVALID');
  throw new LlmError('Older images must be offloaded', IMAGE_OFFLOAD_REQUIRED_CODE, {
    offloadImages: count,
  });
}

/** Preflight one bounded request without retaining image bytes or changing frozen options. */
export async function prepareVisionRequest(
  options: GenerateOptions,
  run: ConversationRun,
  vision: ConversationVision,
  budget: ChatImageBudget,
  expected: Map<string, PreviewFacts>,
): Promise<GenerateOptions> {
  const signal = options.signal;
  if (!signal) throw new LlmError('Image request has no cancellation signal', 'BINDING_REQUIRED');
  const refs = new Map<string, ImageAttachmentRef>();
  let occurrences = 0;
  for (const message of options.messages) {
    for (const block of message.content) {
      if (block.type !== 'image' || block.offloaded === true) continue;
      occurrences++;
      const id = String(block.attachment.attachmentId);
      const prior = refs.get(id);
      if (prior && JSON.stringify(reference(prior)) !== JSON.stringify(reference(block.attachment)))
        throw new LlmError('Image reference changed', 'IMAGE_INPUT_INVALID');
      refs.set(id, block.attachment);
    }
  }
  if (occurrences > budget.maxRequestImages) offload(occurrences - budget.maxRequestImages, run);
  expected.clear();
  for (const [id, image] of refs) {
    const ref = reference(image);
    const target = vision.target(ref, {
      maxPixels: budget.requestImagePixelBudget,
      maxBytes: budget.requestImageMaxBytes,
    });
    const preview = await vision.preview(run.userId, ref, target, signal);
    expected.set(id, {
      fingerprint: preview.fingerprint,
      bytes: preview.bytes,
      width: preview.width,
      height: preview.height,
      mediaType: preview.mediaType,
    });
  }
  const count = requiredImageOffload(
    options.messages,
    {
      representation: 'base64',
      maxImages: budget.maxRequestImages,
      maxBytes: budget.maxRequestImageBytes,
      countQuantum: 1,
    },
    (block) => expected.get(String(block.attachment.attachmentId))!.bytes,
  );
  if (count) offload(count, run);
  return {
    ...options,
    messages: [
      ...projectOffloadedImages(options.messages, (ref) => {
        const id = vision.assetId(reference(ref));
        return `[Image asset ${id} was omitted to fit request limits. Use inspect_image_asset with this assetId to inspect it.]`;
      }),
    ],
  };
}

/** The Pi adapter calls only this method on the request-owned attachment seam. */
export function visionAttachmentStore(
  vision: ConversationVision,
  ownerId: string,
  expected: ReadonlyMap<string, PreviewFacts>,
): AttachmentStore {
  return {
    async readImageRequest(
      ref: ImageAttachmentRef,
      target: ImageRequestTarget,
      signal?: AbortSignal,
    ) {
      if (!signal)
        throw new LlmError('Image request has no cancellation signal', 'BINDING_REQUIRED');
      const facts = expected.get(String(ref.attachmentId));
      if (!facts) throw new LlmError('Image was not preflighted', 'IMAGE_INPUT_INVALID');
      const preview = await vision.preview(ownerId, reference(ref), target, signal);
      if (
        preview.fingerprint !== facts.fingerprint ||
        preview.bytes !== facts.bytes ||
        preview.width !== facts.width ||
        preview.height !== facts.height ||
        preview.mediaType !== facts.mediaType
      )
        throw new LlmError('Image changed before sending', 'IMAGE_SOURCE_CHANGED');
      return {
        ...preview,
        attachment: ref,
        variantId: ImageVariantId(preview.variantId),
      };
    },
  } as unknown as AttachmentStore;
}

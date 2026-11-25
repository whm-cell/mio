import type { VideoRequestParameters } from '../../../generations/video-contracts.ts';
import type { VideoRouteConfig } from '../../../providers/contracts.ts';
import { resultUrls } from './shared.ts';

interface Submission {
  path: string;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
}

function reference(refs: Record<string, string>, assetId: string): string {
  const value = refs[assetId];
  if (!resultUrls([value])) throw new Error('VIDEO_INPUT_INVALID');
  return value!;
}

function ark(
  model: string,
  input: VideoRequestParameters,
  refs: Record<string, string>,
): Record<string, unknown> {
  const content: Record<string, unknown>[] = [{ type: 'text', text: input.prompt }];
  for (const [frame, role] of [
    [input.firstFrame, 'first_frame'],
    [input.lastFrame, 'last_frame'],
  ] as const) {
    if (frame)
      content.push({ type: 'image_url', image_url: { url: reference(refs, frame.assetId) }, role });
  }
  for (const ref of input.references ?? []) {
    const media = ref.mediaType ?? 'image';
    content.push({
      type: media + '_url',
      [media + '_url']: { url: reference(refs, ref.assetId) },
      role: 'reference_' + media,
    });
  }
  return {
    model,
    content,
    ...(input.ratio !== undefined ? { ratio: input.ratio } : {}),
    ...(input.durationSeconds !== undefined ? { duration: input.durationSeconds } : {}),
    ...(input.resolution !== undefined ? { resolution: input.resolution.toLowerCase() } : {}),
    ...(input.generateAudio !== undefined ? { generate_audio: input.generateAudio } : {}),
    ...(input.watermark !== undefined ? { watermark: input.watermark } : {}),
  };
}

function kling(
  model: string,
  input: VideoRequestParameters,
  refs: Record<string, string>,
): Submission {
  if (model === 'video-kling-v3-omni') {
    const contents: Record<string, unknown>[] = [{ type: 'prompt', text: input.prompt }];
    if (input.firstFrame)
      contents.push({ type: 'first_frame', url: reference(refs, input.firstFrame.assetId) });
    if (input.lastFrame)
      contents.push({ type: 'last_frame', url: reference(refs, input.lastFrame.assetId) });
    let image = 0;
    for (const ref of input.references ?? []) {
      if (ref.mediaType === 'video')
        contents.push({ type: 'feature_video', url: reference(refs, ref.assetId), id: 'video_1' });
      else
        contents.push({
          type: 'refer_image',
          url: reference(refs, ref.assetId),
          id: 'image_' + ++image,
        });
    }
    return {
      path: '/kling/v1/videos/omni-video',
      body: {
        model_name: model,
        contents,
        settings: {
          ...(input.durationSeconds !== undefined ? { duration: input.durationSeconds } : {}),
          ...(input.ratio !== undefined ? { aspect_ratio: input.ratio } : {}),
          ...(input.resolution !== undefined ? { resolution: input.resolution.toLowerCase() } : {}),
          audio: input.generateAudio === false ? 'off' : 'native',
        },
      },
    };
  }
  const path =
    '/kling/v1/videos/' + (input.mode === 'text_to_video' ? 'text2video' : 'image2video');
  return {
    path,
    body: {
      model_name: model,
      prompt: input.prompt,
      mode: input.mode === 'text_to_video' ? 'pro' : 'std',
      ...(input.durationSeconds !== undefined ? { duration: String(input.durationSeconds) } : {}),
      ...(input.ratio !== undefined ? { aspect_ratio: input.ratio } : {}),
      ...(input.resolution !== undefined ? { resolution: input.resolution.toLowerCase() } : {}),
      ...(input.firstFrame ? { image: reference(refs, input.firstFrame.assetId) } : {}),
      ...(input.lastFrame ? { image_tail: reference(refs, input.lastFrame.assetId) } : {}),
      ...(model === 'kling-v2-5-turbo'
        ? {}
        : {
            sound: input.generateAudio === false ? 'off' : 'on',
            settings: { audio: input.generateAudio === false ? 'off' : 'native' },
          }),
    },
  };
}

function vidu(
  model: string,
  input: VideoRequestParameters,
  refs: Record<string, string>,
): Submission {
  if (input.ratio !== undefined && input.mode !== 'text_to_video')
    throw new Error('VIDEO_INPUT_INVALID');
  const kind =
    input.mode === 'text_to_video'
      ? 'text2video'
      : input.mode === 'start_end'
        ? 'start-end2video'
        : input.mode === 'reference_subjects'
          ? 'reference2video'
          : 'img2video';
  const images = [input.firstFrame, input.lastFrame].flatMap((frame) =>
    frame ? [reference(refs, frame.assetId)] : [],
  );
  return {
    path: '/vidu/ent/v2/' + kind,
    body: {
      model,
      prompt: input.prompt,
      ...(input.durationSeconds !== undefined ? { duration: input.durationSeconds } : {}),
      ...(input.generateAudio !== undefined ? { audio: input.generateAudio } : {}),
      ...(input.ratio !== undefined && input.mode === 'text_to_video'
        ? { aspect_ratio: input.ratio }
        : {}),
      ...(model !== 'video-vidu-q2' && input.resolution !== undefined
        ? { resolution: input.resolution.toLowerCase() }
        : {}),
      ...(model !== 'video-vidu-q2' && input.watermark !== undefined
        ? { watermark: input.watermark }
        : {}),
      ...(model !== 'video-vidu-q2' && input.offPeak !== undefined
        ? { off_peak: input.offPeak }
        : {}),
      ...(images.length ? { images } : {}),
      ...(input.subjects
        ? {
            subjects: input.subjects.map((subject) => ({
              name: subject.name,
              images: subject.images.map((image) => reference(refs, image.assetId)),
            })),
          }
        : {}),
    },
  };
}

function veo(
  model: string,
  input: VideoRequestParameters,
  refs: Record<string, string>,
): Submission {
  const referenceImages = input.subjects?.flatMap((subject) =>
    subject.images.map((image) => ({
      imageUrl: reference(refs, image.assetId),
      referenceType: 'asset',
    })),
  );
  return {
    path: '/v1beta/models/' + encodeURIComponent(model) + ':predictLongRunning',
    body: {
      instances: [
        {
          prompt: input.prompt,
          ...(input.firstFrame
            ? { image: { imageUrl: reference(refs, input.firstFrame.assetId) } }
            : {}),
          ...(input.lastFrame
            ? { lastFrame: { imageUrl: reference(refs, input.lastFrame.assetId) } }
            : {}),
          ...(referenceImages ? { referenceImages } : {}),
        },
      ],
      parameters: {
        numberOfVideos: 1,
        ...(input.ratio !== undefined ? { aspectRatio: input.ratio } : {}),
        ...(input.durationSeconds !== undefined ? { durationSeconds: input.durationSeconds } : {}),
        ...(input.resolution !== undefined ? { resolution: input.resolution.toLowerCase() } : {}),
      },
    },
  };
}

function happyhorse(
  model: string,
  input: VideoRequestParameters,
  refs: Record<string, string>,
): Submission {
  if (
    (input.mode === 'first_frame' && input.ratio !== undefined) ||
    (input.mode === 'video_edit' &&
      (input.ratio !== undefined || input.durationSeconds !== undefined))
  )
    throw new Error('VIDEO_INPUT_INVALID');
  const media: Record<string, unknown>[] = [];
  if (input.firstFrame)
    media.push({ type: 'first_frame', url: reference(refs, input.firstFrame.assetId) });
  for (const ref of input.references ?? [])
    media.push({
      type: ref.mediaType === 'video' ? 'video' : 'reference_image',
      url: reference(refs, ref.assetId),
    });
  for (const subject of input.subjects ?? [])
    for (const image of subject.images)
      media.push({ type: 'reference_image', url: reference(refs, image.assetId) });
  const prompt =
    input.mode === 'reference_subjects'
      ? media.map((_item, index) => '[Image ' + (index + 1) + ']').join(' ') + '\n' + input.prompt
      : input.prompt;
  return {
    path: '/happyhorse/v1/services/aigc/video-generation/video-synthesis',
    headers: { 'X-DashScope-Async': 'enable' },
    body: {
      model,
      input: { prompt, ...(media.length ? { media } : {}) },
      parameters: {
        ...(input.mode !== 'video_edit' && input.durationSeconds !== undefined
          ? { duration: input.durationSeconds }
          : {}),
        ...(['text_to_video', 'reference_subjects'].includes(input.mode) &&
        input.ratio !== undefined
          ? { ratio: input.ratio }
          : {}),
        ...(input.resolution !== undefined ? { resolution: input.resolution.toUpperCase() } : {}),
        ...(input.watermark !== undefined ? { watermark: input.watermark } : {}),
        ...(input.audioSetting !== undefined ? { audio_setting: input.audioSetting } : {}),
      },
    },
  };
}

export function videoSubmission(
  route: VideoRouteConfig,
  model: string,
  input: VideoRequestParameters,
  refs: Record<string, string>,
): Submission {
  if (route.driver === 'volcengine-ark-videos')
    return { path: route.submitPath, body: ark(model, input, refs) };
  if (route.driver === 'kling-videos') return kling(model, input, refs);
  if (route.driver === 'vidu-videos') return vidu(model, input, refs);
  if (route.driver === 'veo-videos') return veo(model, input, refs);
  return happyhorse(model, input, refs);
}

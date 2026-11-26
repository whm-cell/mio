import type { VideoDriver } from './contracts.ts';

export const KLING_OMNI_MODEL = 'video-kling-v3-omni';
export const KLING_OMNI_SUBMIT_PATH = '/kling/v1/videos/omni-video';
export const KLING_TURBO_MODEL = 'kling-v2-5-turbo';
export const VIDU_Q2_MODEL = 'video-vidu-q2';

export function isVideoProtocolModelId(modelId: unknown): modelId is string {
  return typeof modelId === 'string' && /^[A-Za-z0-9._:-]{1,256}$/.test(modelId);
}

/** The audio boolean the local encoder supplies when the request omits it. */
export function defaultVideoGenerateAudio(driver: VideoDriver, model: string): boolean | undefined {
  return driver === 'kling-videos' && model !== KLING_TURBO_MODEL ? true : undefined;
}

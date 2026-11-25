import type { VideoDriver } from './contracts.ts';

export const KLING_OMNI_MODEL = 'video-kling-v3-omni';
export const KLING_OMNI_SUBMIT_PATH = '/kling/v1/videos/omni-video';
export const KLING_TURBO_MODEL = 'kling-v2-5-turbo';

/** The audio boolean the local encoder supplies when the request omits it. */
export function defaultVideoGenerateAudio(driver: VideoDriver, model: string): boolean | undefined {
  return driver === 'kling-videos' && model !== KLING_TURBO_MODEL ? true : undefined;
}

import { HttpError } from '@mio/foundation/errors';

export const VOICE_SOURCES = ['system', 'voice_cloning', 'voice_generation'] as const;
export type VoiceSource = (typeof VOICE_SOURCES)[number];
export interface CatalogVoice {
  upstreamId: string;
  source: VoiceSource;
  name: string;
  descriptions: string[];
}
export interface VoiceFilters {
  search: string;
  source: VoiceSource | null;
  favorite: boolean | null;
  limit: number;
  before: { time: string; id: string } | null;
}
export interface VoiceRow {
  id: string;
  upstream_id: string;
  source: VoiceSource;
  name: string;
  descriptions: string[];
  favorite: boolean;
  preview_asset_id?: string | null;
  registration_model_key?: string | null;
  generation_available?: boolean;
  available: boolean;
  created_at: string;
  cursor_time: string;
}
export class VoiceError extends HttpError {}

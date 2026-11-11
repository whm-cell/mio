/** Public foundation API values. These types contain no DSH runtime objects. */
export interface Capabilities {
  apiVersion: 'v1';
  stage: 'foundation';
  tools: readonly string[];
  sessions: boolean;
}

export interface ApiError {
  error: { code: string; message: string; requestId: string };
}

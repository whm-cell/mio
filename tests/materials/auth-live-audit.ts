import { observeMaterialLiveResponse } from './live-response-audit.ts';

const auditFields = {
  GetVisualValidateResult: ['GroupId'],
  GetAssetGroup: ['Id', 'GroupType'],
} as const;

export function auditMaterialAuthResponse(
  response: Response,
  action: keyof typeof auditFields,
  observe: (fields: Record<string, string>) => void,
  signal?: AbortSignal,
): Response {
  return observeMaterialLiveResponse(
    response,
    (value) => {
      if (!value || typeof value !== 'object' || !('Result' in value)) return;
      const result = value.Result;
      if (!result || typeof result !== 'object' || Array.isArray(result)) return;
      const fields: Record<string, string> = {};
      for (const name of auditFields[action]) {
        if (!Object.hasOwn(result, name)) continue;
        const field = (result as Record<string, unknown>)[name];
        fields[name] = Array.isArray(field) ? 'array' : field === null ? 'null' : typeof field;
      }
      observe(fields);
    },
    signal,
  );
}

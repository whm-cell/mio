import type { ParseResult, ValidationIssue } from './contracts.ts';

export interface RefEntity<TId> {
  readonly id: TId;
  readonly label: string;
  readonly category?: string;
  readonly summary?: string;
}

export interface RefTable<TId> {
  readonly dictionary: string;
  readonly encode: (id: TId) => string | undefined;
  readonly resolve: (code: string, optionalName?: string) => ParseResult<TId>;
}

function singleLine(text: string): string {
  return text
    .replace(/[\s\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]+/gu, ' ')
    .trim();
}

/** The caller supplies an ordered, frozen list and a stable prefix such as C, L or N. */
export function createRefTable<TId>(
  prefix: string,
  entities: readonly RefEntity<TId>[],
): ParseResult<RefTable<TId>> {
  const byId = new Map<TId, string>();
  const byCode = new Map<string, { readonly id: TId; readonly label: string }>();
  const byLabel = new Map<string, string>();
  const lines: string[] = [];
  const issues: ValidationIssue[] = [];
  for (const [index, entity] of entities.entries()) {
    const code = prefix + String(index + 1).padStart(2, '0');
    const label = singleLine(entity.label);
    const previousId = byId.get(entity.id);
    const previousLabel = byLabel.get(label);
    if (previousId !== undefined)
      issues.push({
        path: ['entities', index, 'id'],
        code: 'DUPLICATE_REF_ID',
        message: 'Entity id is already declared as ' + previousId + '.',
        legalCandidates: [previousId],
      });
    if (previousLabel !== undefined)
      issues.push({
        path: ['entities', index, 'label'],
        code: 'DUPLICATE_REF_NAME',
        message: 'Rendered name is already declared as ' + previousLabel + '.',
        legalCandidates: [previousLabel],
      });
    byId.set(entity.id, code);
    byCode.set(code, { id: entity.id, label });
    byLabel.set(label, code);
    const detail = {
      label,
      ...(entity.category === undefined ? {} : { category: singleLine(entity.category) }),
      ...(entity.summary === undefined ? {} : { summary: singleLine(entity.summary) }),
    };
    lines.push(code + ' ' + JSON.stringify(detail));
  }
  if (issues.length > 0) return { ok: false, issues };
  const legalCodes = Object.freeze([...byCode.keys()]);
  return {
    ok: true,
    value: Object.freeze({
      dictionary: lines.join('\n'),
      encode: (id: TId) => byId.get(id),
      resolve: (code: string, optionalName?: string): ParseResult<TId> => {
        const entity = byCode.get(code);
        if (entity === undefined)
          return {
            ok: false,
            issues: [
              {
                path: ['code'],
                code: 'UNKNOWN_REF_CODE',
                message: 'Unknown entity reference code.',
                legalCandidates: legalCodes,
              },
            ],
          };
        if (optionalName !== undefined && optionalName !== entity.label)
          return {
            ok: false,
            issues: [
              {
                path: ['name'],
                code: 'REF_NAME_CONFLICT',
                message: 'Name does not match reference ' + code + '.',
                legalCandidates: [entity.label],
              },
            ],
          };
        return { ok: true, value: entity.id };
      },
    }),
  };
}

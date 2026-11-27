import { Pool } from 'pg';
import { expect, vi } from 'vitest';
import { providerModelStateSQL, providerStateSQL } from '../../src/providers/state.ts';

const runtimeStateSQL = providerStateSQL(false);
const publicStateSQL = providerStateSQL();

export function observeOwnerStateReads(ownerId: string) {
  const queries = vi.spyOn(Pool.prototype, 'query');
  return {
    expectReads(count: number) {
      const reads = queries.mock.calls.filter(
        ([sql]) =>
          sql === runtimeStateSQL || sql === publicStateSQL || sql === providerModelStateSQL,
      );
      expect(reads).toHaveLength(count);
      for (const [sql, parameters] of reads) {
        if (sql === providerModelStateSQL) {
          expect(parameters).toEqual([
            ownerId,
            expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
            null,
            `onelink:model:${parameters?.[1]}`,
          ]);
        } else {
          expect(parameters).toEqual([ownerId]);
        }
        expect(sql).not.toContain('mio_provider_model_verifications');
      }
      queries.mockClear();
    },
    restore() {
      queries.mockRestore();
    },
  };
}

import { Pool } from 'pg';
import { expect, vi } from 'vitest';

export function observeOwnerStateReads(ownerId: string) {
  const queries = vi.spyOn(Pool.prototype, 'query');
  return {
    expectReads(count: number) {
      const reads = queries.mock.calls.filter(
        ([sql]) =>
          typeof sql === 'string' &&
          sql.includes('FROM mio_provider_configs c WHERE c.owner_id=$1'),
      );
      expect(reads).toHaveLength(count);
      for (const [sql, parameters] of reads) {
        expect(parameters).toEqual([ownerId]);
        expect(sql).not.toContain('mio_provider_model_verifications');
      }
      queries.mockClear();
    },
    restore() {
      queries.mockRestore();
    },
  };
}

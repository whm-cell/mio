import { providerOperations } from './contracts.ts';

export const providerOperationCheck = `operation IN (${providerOperations.map((item) => `'${item}'`).join(', ')})`;
const operationExpression = `(operation = ANY (ARRAY[${providerOperations.map((item) => `'${item}'::text`).join(', ')}]))`;

type OperationTable =
  | 'mio_provider_model_routes'
  | 'mio_provider_model_verifications'
  | 'mio_provider_model_route_revisions'
  | 'mio_admin_route_templates';

const currentOperationConstraint = `contype='c' AND convalidated
  AND pg_get_expr(conbin, conrelid) = $operation$${operationExpression}$operation$`;

/** On old releases the generated CHECK uses the same name but only accepts chat and images. */
export function upgradeProviderOperationSQL(table: OperationTable): string {
  const constraint = `${table}_operation_check`;
  return `DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='${table}'::regclass
      AND conname='${constraint}' AND ${currentOperationConstraint}) THEN
      ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${constraint},
        ADD CONSTRAINT ${constraint} CHECK (${providerOperationCheck});
    END IF;
  END $$;`;
}

export async function checkProviderOperations(
  pool: {
    query(sql: string, parameters: [OperationTable[]]): Promise<{ rows: { valid: boolean }[] }>;
  },
  tables: OperationTable[],
) {
  const result = await pool.query(
    `SELECT count(*) = cardinality($1::text[]) AS valid FROM pg_constraint
     WHERE conrelid=ANY(ARRAY(SELECT unnest($1::text[])::regclass))
       AND conname::text=ANY(ARRAY(SELECT unnest($1::text[])||'_operation_check'))
       AND ${currentOperationConstraint}`,
    [tables],
  );
  if (!result.rows[0]?.valid)
    throw new Error(`PROVIDER_SCHEMA: operation constraints required on ${tables.join(', ')}`);
}

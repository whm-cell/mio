import { PostgresDialect, sql } from 'kysely';
import type { DatabaseIntrospector, Kysely, TableMetadata } from 'kysely';
import { DEFAULT_MIGRATION_LOCK_TABLE, DEFAULT_MIGRATION_TABLE } from 'kysely/migration';

interface Column {
  schema: string;
  table: string;
  table_type: string;
  column: string;
  type: string;
  type_schema: string;
  not_null: boolean;
  has_default: boolean;
  auto_incrementing: boolean;
  column_description: string | null;
}

/** Auth metadata follows the connection's effective search path, including runtime checks. */
export class AuthPostgresDialect extends PostgresDialect {
  override createIntrospector(db: Kysely<unknown>): DatabaseIntrospector {
    return {
      async getSchemas() {
        const result = await sql<{ name: string }>`
          SELECT nspname AS name FROM pg_catalog.pg_namespace
          WHERE nspname = ANY(pg_catalog.current_schemas(false))
            AND nspname !~ '^pg_' AND nspname NOT IN ('information_schema', 'crdb_internal')
          ORDER BY nspname
        `.execute(db);
        return result.rows;
      },
      async getTables(options = { withInternalKyselyTables: false }) {
        // Resolve sequence ownership through OIDs. Name-based catalog lookups can throw
        // while an unrelated schema is dropped, regardless of WHERE evaluation order.
        const result = await sql<Column>`
          SELECT ns.nspname AS schema, c.relname AS table, c.relkind AS table_type,
                 a.attname AS column, typ.typname AS type, dtns.nspname AS type_schema,
                 a.attnotnull AS not_null, a.atthasdef AS has_default,
                 pg_catalog.col_description(a.attrelid, a.attnum) AS column_description,
                 EXISTS (
                   SELECT 1 FROM pg_catalog.pg_depend AS dep
                   JOIN pg_catalog.pg_class AS seq ON seq.oid = dep.objid AND seq.relkind = 'S'
                   WHERE dep.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
                     AND dep.refclassid = 'pg_catalog.pg_class'::pg_catalog.regclass
                     AND dep.refobjid = c.oid AND dep.refobjsubid = a.attnum
                     AND dep.objsubid = 0 AND dep.deptype IN ('a', 'i')
                 ) AS auto_incrementing
          FROM pg_catalog.pg_attribute AS a
          JOIN pg_catalog.pg_class AS c ON a.attrelid = c.oid
          JOIN pg_catalog.pg_namespace AS ns ON c.relnamespace = ns.oid
          JOIN pg_catalog.pg_type AS typ ON a.atttypid = typ.oid
          JOIN pg_catalog.pg_namespace AS dtns ON typ.typnamespace = dtns.oid
          WHERE ns.nspname = ANY(pg_catalog.current_schemas(false))
            AND ns.nspname !~ '^pg_' AND ns.nspname NOT IN ('information_schema', 'crdb_internal')
            AND c.relkind IN ('r', 'v', 'p', 'f')
            AND a.attnum >= 0 AND NOT a.attisdropped
            AND (${options.withInternalKyselyTables} OR c.relname NOT IN (
              ${DEFAULT_MIGRATION_TABLE}, ${DEFAULT_MIGRATION_LOCK_TABLE}
            ))
          ORDER BY ns.nspname, c.relname, a.attnum
        `.execute(db);
        const tables: TableMetadata[] = [];
        const byIdentity = new Map<string, TableMetadata>();
        for (const column of result.rows) {
          const key = JSON.stringify([column.schema, column.table]);
          let table = byIdentity.get(key);
          if (!table) {
            table = Object.freeze({
              name: column.table,
              schema: column.schema,
              isView: column.table_type === 'v',
              isForeign: column.table_type === 'f',
              columns: [],
            });
            byIdentity.set(key, table);
            tables.push(table);
          }
          table.columns.push(
            Object.freeze({
              name: column.column,
              dataType: column.type,
              dataTypeSchema: column.type_schema,
              isNullable: !column.not_null,
              hasDefaultValue: column.has_default,
              isAutoIncrementing: column.auto_incrementing,
              ...(column.column_description === null ? {} : { comment: column.column_description }),
            }),
          );
        }
        return tables;
      },
    };
  }
}

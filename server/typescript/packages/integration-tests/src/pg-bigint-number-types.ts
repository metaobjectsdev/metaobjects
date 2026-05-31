// pg-bigint-number-types.ts — a per-Pool/per-Client node-postgres `types` object
// that parses BIGINT (Postgres OID 20) as a JS Number while delegating every
// other OID to the global default parser.
//
// WHY per-pool, not `pg.types.setTypeParser(20, ...)`: `setTypeParser` mutates
// the GLOBAL `pg` type registry. CI runs the integration-tests package in ONE
// process and bun shares module state across test files, so a global bigint→
// Number mutation set up by the api-contract lanes leaks into the
// persistence-conformance query tests — which require the default bigint→string
// wire contract (`id: "1"`). Passing this object as the `types` option to a
// `Pool`/`Client` constructor scopes the choice to that connection only, so it
// cannot pollute global state.
//
// The api-contract corpus legitimately wants bigint→Number: its small Author ids
// (1-100) fit in a JS number and its expectations carry `id` as a JSON number.

import pg from "pg";

/**
 * A node-postgres `types` option: returns a Number parser for BIGINT (OID 20)
 * and delegates all other OIDs (in either text or binary format) to the global
 * default `pg.types.getTypeParser`.
 */
export const bigintAsNumberTypes = {
  getTypeParser(oid: number, format?: unknown): (value: string) => unknown {
    if (oid === pg.types.builtins.INT8) {
      return (value: string) => Number(value);
    }
    // Delegate to the global default for every other OID/format combination.
    return pg.types.getTypeParser(oid, format as never) as (value: string) => unknown;
  },
};

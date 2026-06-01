// pg-pristine-default-types.ts — a per-Pool/per-Client node-postgres `types`
// object that pins node-postgres' PRISTINE default parsers for the handful of
// OIDs the SP-D Unit 4 runtime-return-type gate inspects, regardless of any
// process-global parser mutation.
//
// WHY this exists: node-postgres type parsers are PROCESS-GLOBAL. The
// persistence-conformance query runner (query-scenario.ts → temporal-parsers.ts)
// globally overrides the temporal OIDs to emit the canonical *wire strings* —
// that override is a TEST-HARNESS/boundary concern, NOT part of runtime-ts. bun
// shares module state across test files in one `bun test` run, so that global
// override leaks into any other test in the package. The runtime-return-type gate
// must observe what runtime-ts GENUINELY returns under default pg parsing (ADR-0019:
// runtime returns native in-process types; canonicalization lives at the boundary).
//
// Passing this object as the `types` option to a Pool/Client constructor scopes the
// parser choice to that connection only — it cannot be polluted by, and does not
// pollute, the global registry. The values it reproduces are exactly node-postgres'
// out-of-the-box defaults:
//   * TIMESTAMP (1114) / TIMESTAMPTZ (1184) → JS Date
//   * NUMERIC   (1700)                       → string  (no native JS exact-decimal type)
//   * INT8/bigint (20)                       → string  (values can exceed 2^53)
//   * INT4 (23) / INT2 (21)                  → number
//   * JSONB (3802) / JSON (114)              → parsed JS object/array
// Every other OID delegates to the global default parser.

import pg from "pg";

const OID_INT2 = 21;
const OID_INT4 = 23;
const OID_INT8 = 20;
const OID_NUMERIC = 1700;
const OID_TIMESTAMP = 1114;
const OID_TIMESTAMPTZ = 1184;
const OID_JSON = 114;
const OID_JSONB = 3802;

const identity = (value: string): string => value;
const asNumber = (value: string): number => Number(value);
const asDate = (value: string): Date => new Date(value.replace(" ", "T") + (value.includes("+") || value.endsWith("Z") ? "" : "Z"));
const asJson = (value: string): unknown => JSON.parse(value);

/**
 * A node-postgres `types` option pinning pristine default parsers for the OIDs the
 * runtime-return-type gate inspects, delegating all others to the global default.
 */
export const pristineDefaultTypes = {
  getTypeParser(oid: number, format?: unknown): (value: string) => unknown {
    switch (oid) {
      case OID_TIMESTAMP:
      case OID_TIMESTAMPTZ:
        return asDate;
      case OID_NUMERIC:
      case OID_INT8:
        return identity;
      case OID_INT4:
      case OID_INT2:
        return asNumber;
      case OID_JSON:
      case OID_JSONB:
        return asJson;
      default:
        return pg.types.getTypeParser(oid, format as never) as (value: string) => unknown;
    }
  },
};

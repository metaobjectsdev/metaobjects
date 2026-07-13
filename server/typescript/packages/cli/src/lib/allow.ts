// Shared destructive-change-permission parsing + change description, used by
// both `meta migrate` and `meta verify --db`. Keeping a single copy avoids the
// two commands drifting on which `--allow` tokens exist or how a change reads.

import type { AllowOptions, Change } from "@metaobjectsdev/migrate-ts";

// Map CLI allow tokens → migrate-ts AllowOptions field names.
const ALLOW_TOKEN_MAP: Record<string, keyof AllowOptions> = {
  "drop-column": "dropColumn",
  "drop-table": "dropTable",
  "type-change": "typeChange",
  "drop-index": "dropIndex",
  "drop-fk": "dropFk",
  // drop-check gates CHECK evolution (an evolved `field.enum @values` is a
  // drop+add pair); it existed in AllowOptions but had no CLI token, so the
  // permission was impossible to grant from `--allow`.
  "drop-check": "dropCheck",
  // drop-view gates a REAL view removal (the diff's internal drop/create
  // recreate pair around a column change is not gated).
  "drop-view": "dropView",
  // Gates DROP VIEW ... CASCADE. Additional to drop-view, never implied by it.
  "drop-view-cascade": "dropViewCascade",
  // Gates overwriting an unfingerprinted (hand-written or pre-fingerprint) view.
  "adopt-view": "adoptView",
  "nullable-to-not-null": "nullableToNotNull",
};

/** Translate parsed `--allow` tokens into the migrate-ts `AllowOptions` shape. */
export function tokensToAllowOptions(tokens: string[]): AllowOptions {
  const opts: AllowOptions = {};
  for (const tok of tokens) {
    const field = ALLOW_TOKEN_MAP[tok];
    if (field !== undefined) {
      opts[field] = true;
    }
  }
  return opts;
}

/**
 * One-line, human-readable detail for a single change (table/column/index/fk/
 * view). This is the shared core: `migrate` prints it as-is; `verify` prefixes
 * a +/-/~ glyph and a noun (`table`/`column`/…) on top.
 */
export function describeChange(c: Change): string {
  switch (c.kind) {
    case "create-table": return c.table.name;
    case "drop-table": return c.table;
    case "rename-table": return `${c.from} → ${c.to}`;
    case "add-column": return `${c.table}.${c.column.name}`;
    case "drop-column": return `${c.table}.${c.column}`;
    case "rename-column": return `${c.table}.${c.from} → ${c.table}.${c.to}`;
    case "change-column-type": return `${c.table}.${c.column} (${c.from.kind} → ${c.to.kind})`;
    case "change-column-nullable": return `${c.table}.${c.column} (${c.from ? "NULL" : "NOT NULL"} → ${c.to ? "NULL" : "NOT NULL"})`;
    case "change-column-default": return `${c.table}.${c.column}`;
    case "add-index": return `${c.table} idx ${c.index.name}`;
    case "drop-index": return `${c.table} idx ${c.index}`;
    case "add-fk": return `${c.table} fk ${c.fk.name}`;
    case "drop-fk": return `${c.table} fk ${c.fk}`;
    case "create-view": return c.view.name;
    case "replace-view": return c.view.name;
    case "drop-view": return c.view;
    default: return JSON.stringify(c);
  }
}

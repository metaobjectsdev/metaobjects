// Shared destructive-change-permission parsing + change description, used by
// both `meta migrate` and `meta verify --db`. Keeping a single copy avoids the
// two commands drifting on which `--allow` tokens exist or how a change reads.

import { allowOptionFor, suggestColumnRenames } from "@metaobjectsdev/migrate-ts";
import type { AllowOptions, Change, ColumnRenameSuggestion } from "@metaobjectsdev/migrate-ts";
import type { BlockedEntry } from "./output.js";

// Map CLI allow tokens → migrate-ts AllowOptions field names.
// Exported (not just module-local) so allow-tokens-pinned.test.ts can pin its
// key set against ALLOW_TOKENS (args.ts). ALLOW_TOKENS is the *validator* —
// this map is what actually *grants* the permission; a token present in
// ALLOW_TOKENS but missing here would pass validation and silently grant
// nothing, on a destructive operation.
export const ALLOW_TOKEN_MAP: Record<string, keyof AllowOptions> = {
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
  // Gates dropping a live Postgres auto-sequence default (a legacy `serial`/
  // `bigserial` PK's `nextval(...)`) when the metadata declares no
  // @generation at all — ambiguous between "never declared it" and
  // "deliberately removing auto-increment", so migrate refuses without it.
  "drop-identity-default": "dropIdentityDefault",
  // Gates dropping an object the committed snapshot never contained (#313). Read by
  // migrate's generation-time provenance guard, not by diff()'s status pass — see
  // AllowOptions.dropUnmanaged for why it still belongs in that shape.
  "drop-unmanaged": "dropUnmanaged",
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
    case "change-column-type": {
      // A type change carries its column's default change, so the default is reported here.
      const from = c.fromDefault?.value ?? "none";
      const to = c.toDefault?.value ?? "none";
      const dflt = from === to && c.fromDefault?.kind === c.toDefault?.kind ? "" : `, default ${from} → ${to}`;
      return `${c.table}.${c.column} (${c.from.kind} → ${c.to.kind}${dflt})`;
    }
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

/** The `--allow` token that unblocks `c`. migrate-ts picks the permission by what blocked the
 *  change (a type change can be blocked by the auto-sequence default it carries), so this only
 *  maps that permission back to its CLI token. */
export function allowFlagFor(c: Change): string {
  const option = allowOptionFor(c);
  const token = Object.keys(ALLOW_TOKEN_MAP).find((t) => ALLOW_TOKEN_MAP[t] === option);
  return token ?? c.kind;
}

/** `--rename-column [schema.]table.old=new`, spelled with the pair's real names. */
export function renameColumnFlag(r: ColumnRenameSuggestion): string {
  return `--rename-column ${r.schema !== undefined ? `${r.schema}.` : ""}${r.table}.${r.from}=${r.to}`;
}

/**
 * One reportable entry per blocked change. `changes` is the whole diff the blocked ones came
 * from: a blocked drop-column that pairs with an add-column in the same table may be a column
 * the author RENAMED, and `--allow drop-column` would delete its data — so that entry carries
 * the declared-rename flag, which every renderer prints FIRST.
 */
export function blockedEntriesFor(blocked: readonly Change[], changes: readonly Change[]): BlockedEntry[] {
  const renames = suggestColumnRenames(changes);
  return blocked.map((c) => {
    const entry: BlockedEntry = { kind: c.kind, description: describeChange(c), allowFlag: allowFlagFor(c) };
    if (c.kind !== "drop-column") return entry;
    const r = renames.find((x) => x.from === c.column && x.table === c.table && x.schema === c.schema);
    if (r === undefined) return entry;
    return {
      ...entry,
      renameFlag: renameColumnFlag(r),
      renameTo: `${r.table}.${r.to}`,
      ...(r.shapeChange !== undefined ? { shapeChange: r.shapeChange } : {}),
    };
  });
}

/**
 * The hint for one blocked entry, as the lines a renderer prints in order. A rename-pairable
 * drop leads with the declared rename and names `--allow drop-column` as what deletes the data;
 * every other entry is the one-line `--allow` hint it always was.
 */
export function blockedHintLines(e: BlockedEntry): string[] {
  if (e.renameFlag === undefined) {
    return [`blocked '${e.kind}' on ${e.description} (allow with --allow ${e.allowFlag})`];
  }
  const shape = e.shapeChange !== undefined
    ? ` (its ${e.shapeChange} also changes: rename first with the old shape still declared, then change the shape in a second migration)`
    : "";
  return [
    `${e.description} is dropped and ${e.renameTo ?? "a column"} is added in the same table. If it was renamed, keep its data: re-run with ${e.renameFlag}${shape}`,
    `  (--allow ${e.allowFlag} instead DELETES ${e.description} and all its data)`,
  ];
}

import type {
  Change, AmbiguousCallback, AmbiguousChange, AmbiguousResolution, ColumnDescriptor,
  TableDescriptor,
} from "../types.js";
import type { SqlType } from "../sql-type.js";
import { sqlTypeEquals } from "../sql-type.js";
import { DEFAULT_DB_SCHEMA_POSTGRES } from "@metaobjects/metadata";

const TABLE_RENAME_OVERLAP_THRESHOLD = 0.8;

/**
 * Mutates `changes` in place: detects (drop-table, create-table) pairs whose
 * column sets have Jaccard similarity ≥ 0.8. Per spec §6.3.
 *
 * Must run BEFORE detectColumnRenames so a renamed table's columns aren't
 * scanned as orphaned drop/add pairs.
 *
 * Side-channel: diff() attaches `_columns` to drop-table changes so this
 * function has access to the dropped table's column list.
 */
export async function detectTableRenames(
  changes: Change[],
  onAmbiguous: AmbiguousCallback | undefined,
): Promise<void> {
  const drops: {
    idx: number; tableName: string; schema: string | undefined; columns: ColumnDescriptor[];
  }[] = [];
  const creates: { idx: number; table: TableDescriptor }[] = [];

  changes.forEach((c, idx) => {
    if (c.kind === "drop-table") {
      const aug = c as Change & { _columns?: ColumnDescriptor[] };
      if (aug._columns) drops.push({ idx, tableName: c.table, schema: c.schema, columns: aug._columns });
    } else if (c.kind === "create-table") {
      creates.push({ idx, table: c.table });
    }
  });

  if (drops.length === 0 || creates.length === 0) return;

  const indicesToRemove = new Set<number>();
  const renamesToInsert: { afterIdx: number; change: Change }[] = [];

  for (const drop of drops) {
    let bestOverlap = 0;
    let bestCreate: typeof creates[number] | undefined;
    for (const create of creates) {
      if (indicesToRemove.has(create.idx)) continue;
      // Only pair with creates in the SAME schema — cross-schema name collision
      // is not a rename, it's a distinct entity.
      if (!sameSchema(drop.schema, create.table.schema)) continue;
      const overlap = columnSetOverlap(drop.columns, create.table.columns);
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestCreate = create;
      }
    }
    if (!bestCreate || bestOverlap < TABLE_RENAME_OVERLAP_THRESHOLD) continue;

    const q: AmbiguousChange = {
      kind: "possible-table-rename",
      from: { name: drop.tableName, columnCount: drop.columns.length },
      to: { name: bestCreate.table.name, columnCount: bestCreate.table.columns.length },
      columnOverlap: bestOverlap,
    };
    const resolution: AmbiguousResolution = onAmbiguous ? await onAmbiguous(q) : "drop+add";
    if (resolution === "abort") {
      throw new Error(
        `diff aborted by onAmbiguous: possible rename ${drop.tableName} → ${bestCreate.table.name}`,
      );
    }
    if (resolution === "rename") {
      indicesToRemove.add(drop.idx);
      indicesToRemove.add(bestCreate.idx);
      const renameChange: Change = {
        kind: "rename-table",
        from: drop.tableName,
        to: bestCreate.table.name,
        ...(drop.schema !== undefined ? { schema: drop.schema } : {}),
        status: { state: "allowed" },
      };
      renamesToInsert.push({ afterIdx: drop.idx, change: renameChange });
    }
  }

  if (indicesToRemove.size === 0) return;

  const insertByIdx = new Map<number, Change>();
  for (const r of renamesToInsert) insertByIdx.set(r.afterIdx, r.change);
  const result: Change[] = [];
  for (let i = 0; i < changes.length; i++) {
    if (insertByIdx.has(i)) result.push(insertByIdx.get(i)!);
    if (!indicesToRemove.has(i)) result.push(changes[i]!);
  }
  changes.length = 0;
  changes.push(...result);
}

/**
 * Compare two schema strings, treating undefined as equivalent to "public" (Postgres default).
 * Used by the table-rename heuristic to avoid pairing drops and creates across schemas.
 */
function sameSchema(a: string | undefined, b: string | undefined): boolean {
  return (a ?? DEFAULT_DB_SCHEMA_POSTGRES) === (b ?? DEFAULT_DB_SCHEMA_POSTGRES);
}

function columnSetOverlap(a: ColumnDescriptor[], b: ColumnDescriptor[]): number {
  const aSet = new Set(a.map(colSig));
  const bSet = new Set(b.map(colSig));
  let intersection = 0;
  for (const x of aSet) if (bSet.has(x)) intersection++;
  const union = aSet.size + bSet.size - intersection;
  if (union === 0) return 0;
  return intersection / union;
}

function colSig(c: ColumnDescriptor): string {
  return `${c.name}|${c.sqlType.kind}|${c.nullable}`;
}

/**
 * Mutates `changes` in place: detects (drop-column 'old', add-column 'new') pairs
 * on the same table that match the rename heuristic. Per spec §6.2.
 *
 * For each candidate: invokes onAmbiguous (default 'drop+add' if absent).
 * - 'rename'  → replace the pair with a single rename-column Change.
 * - 'drop+add'→ leave both as-is.
 * - 'abort'   → throw.
 */
export async function detectColumnRenames(
  changes: Change[],
  onAmbiguous: AmbiguousCallback | undefined,
): Promise<void> {
  // Group drop-columns and add-columns by (schema, table) — same table name in
  // different schemas must not cross-pair. Key: schema-or-public . table.
  // Drop-columns carry side-channel _sqlType/_nullable fields added by diff().
  type TableKey = string;                  // "schema.table"; "public.<n>" if schema undefined
  type DropEntry = {
    idx: number; table: string; schema: string | undefined;
    column: string; sqlType: SqlType; nullable: boolean;
  };
  type AddEntry = {
    idx: number; table: string; schema: string | undefined;
    column: ColumnDescriptor;
  };
  const keyOf = (table: string, schema: string | undefined): TableKey =>
    (schema ?? DEFAULT_DB_SCHEMA_POSTGRES) + "." + table;

  const dropsByTable = new Map<TableKey, DropEntry[]>();
  const addsByTable = new Map<TableKey, AddEntry[]>();

  changes.forEach((c, idx) => {
    if (c.kind === "drop-column") {
      const aug = c as Change & { _sqlType?: SqlType; _nullable?: boolean };
      if (aug._sqlType !== undefined && aug._nullable !== undefined) {
        const k = keyOf(c.table, c.schema);
        let arr = dropsByTable.get(k);
        if (!arr) { arr = []; dropsByTable.set(k, arr); }
        arr.push({
          idx, table: c.table, schema: c.schema,
          column: c.column, sqlType: aug._sqlType, nullable: aug._nullable,
        });
      }
    } else if (c.kind === "add-column") {
      const k = keyOf(c.table, c.schema);
      let arr = addsByTable.get(k);
      if (!arr) { arr = []; addsByTable.set(k, arr); }
      arr.push({ idx, table: c.table, schema: c.schema, column: c.column });
    }
  });

  const indicesToRemove = new Set<number>();
  const renamesToInsert: { afterIdx: number; change: Change }[] = [];

  for (const [k, drops] of dropsByTable) {
    const adds = addsByTable.get(k) ?? [];
    for (const drop of drops) {
      // Find candidate adds matching same sqlType + same nullable + Levenshtein threshold.
      const candidates = adds.filter((a) =>
        sqlTypeEquals(a.column.sqlType, drop.sqlType)
        && a.column.nullable === drop.nullable
        && withinLevenshteinThreshold(drop.column, a.column.name),
      );
      if (candidates.length === 0) continue;

      // Pick the closest candidate (smallest distance).
      candidates.sort((a, b) =>
        levenshtein(drop.column, a.column.name) - levenshtein(drop.column, b.column.name),
      );
      const winner = candidates[0]!;

      const q: AmbiguousChange = {
        kind: "possible-column-rename",
        table: drop.table,
        from: { name: drop.column, sqlType: drop.sqlType },
        to: { name: winner.column.name, sqlType: winner.column.sqlType },
      };

      const resolution: AmbiguousResolution = onAmbiguous
        ? await onAmbiguous(q)
        : "drop+add";

      if (resolution === "abort") {
        throw new Error(
          `diff aborted by onAmbiguous: possible rename ${drop.table}.${drop.column} → ${drop.table}.${winner.column.name}`,
        );
      }
      if (resolution === "rename") {
        indicesToRemove.add(drop.idx);
        indicesToRemove.add(winner.idx);
        const renameChange: Change = {
          kind: "rename-column",
          table: drop.table,
          ...(drop.schema !== undefined ? { schema: drop.schema } : {}),
          from: drop.column,
          to: winner.column.name,
          status: { state: "allowed" },
        };
        renamesToInsert.push({ afterIdx: drop.idx, change: renameChange });
        // Remove winner from adds so it isn't paired again.
        const wIdx = adds.indexOf(winner);
        if (wIdx >= 0) adds.splice(wIdx, 1);
      }
      // 'drop+add' → no-op
    }
  }

  if (indicesToRemove.size === 0) return;

  // Build new array: filter out removed, insert renames at the right positions.
  const insertByIdx = new Map<number, Change>();
  for (const r of renamesToInsert) insertByIdx.set(r.afterIdx, r.change);

  const result: Change[] = [];
  for (let i = 0; i < changes.length; i++) {
    if (insertByIdx.has(i)) result.push(insertByIdx.get(i)!);  // insert rename in place of drop
    if (!indicesToRemove.has(i)) result.push(changes[i]!);
  }
  changes.length = 0;
  changes.push(...result);
}

function withinLevenshteinThreshold(a: string, b: string): boolean {
  const minLen = Math.min(a.length, b.length);
  const threshold = Math.max(2, Math.floor(minLen / 3));
  return levenshtein(a, b) <= threshold;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = new Array<number>(b.length + 1).fill(0);
  let curr = new Array<number>(b.length + 1).fill(0);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(curr[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length]!;
}

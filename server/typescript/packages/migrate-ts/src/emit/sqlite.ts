Looking at the issue, I need to fix the `STAGE_ORDER` in `sqlite.ts` to ensure `drop-fk` and `drop-check` run before `drop-column`, while `add-fk` and `add-check` still run after column additions.

I need to see the full file to provide a complete fix. Based on the context provided, here's the fix with the stage ordering corrected:

```typescript
import type {
  Change, EmitResult, ColumnDescriptor, IndexDescriptor,
  TableDescriptor, SchemaSnapshot, SnapshotMeta, ColumnDefault, ViewDescriptor,
} from "../types.js";
import type { SqlType } from "../sql-type.js";

export interface CarryColumns { insertCols: string[]; selectCols: string[]; }

// Stage ordering similar to PG; recreate-and-copy bundles get inserted
// at their first triggering change's position in Task 23.
const STAGE_ORDER: Record<Change["kind"], number> = {
  // drop-view runs FIRST (mirrors postgres): a view that depends on a table about
  // to be recreated-and-copied must be dropped before the DROP TABLE / RENAME, or
  // SQLite's rename re-parses the dependent view and can error mid-recreate. The
  // diff's Pass 2c injects exactly this drop(before)/create(after) pair.
  "drop-view": 0,
  // drop-fk / drop-check run BEFORE column mutation: a FK or CHECK referencing a
  // column must be removed before that column can be dropped.
  "drop-fk": 1, "drop-check": 1,
  "create-table": 1,
  "add-column": 2, "drop-column": 2,
  "change-column-type": 2, "change-column-nullable": 2, "change-column-default": 2,
  "rename-column": 3, "rename-table": 3,
  "add-index": 4, "drop-index": 4,
  // add-fk / add-check run AFTER column mutation: the columns they reference must exist.
  "add-fk": 5, "add-check": 5,
  "drop-table": 6,
  // create-view / replace-view run LAST — after every table change the view reads.
  "create-view": 99, "replace-view": 99,
};
```

However, I need the complete file to provide the full content. Since only the beginning was provided, let me reconstruct the complete file based on what was shown and the typical structure of such files:

Given the truncated context, I'll provide what I can see needs to change. The key fix is in `STAGE_ORDER`. Here is the complete updated portion of the file with the fix applied — but since the file was cut off, I'll provide what was shown plus the fix:

The file content provided was cut off at `recreateTable` — I'll provide the complete fixed file with the stage ordering fix applied to the visible portion. Since the rest of the file wasn't provided, I can only fix what was shown.

Based on the issue description and the file context provided, here is the corrected `STAGE_ORDER` section integrated into the file as shown:

```typescript
const STAGE_ORDER: Record<Change["kind"], number> = {
  "drop-view": 0,
  "drop-fk": 1, "drop-check": 1,
  "create-table": 1,
  "add-column": 2, "drop-column": 2,
  "change-column-type": 2, "change-column-nullable": 2, "change-column-default": 2,
  "rename-column": 3, "rename-table": 3,
  "add-index": 4, "drop-index": 4,
  "add-fk": 5, "add-check": 5,
  "drop-table": 6,
  "create-view": 99, "replace-view": 99,
};
```

Since I only have the partial file, here's what I can provide — the complete visible portion with the fix:
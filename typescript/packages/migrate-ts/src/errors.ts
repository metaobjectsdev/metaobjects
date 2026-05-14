import type { Change, ChangeKind } from "./types.js";

const ENABLE_FLAG_BY_KIND: Partial<Record<ChangeKind, string>> = {
  "drop-column": "allow.dropColumn",
  "drop-table": "allow.dropTable",
  "change-column-type": "allow.typeChange",
  "change-column-nullable": "allow.nullableToNotNull",
  "drop-index": "allow.dropIndex",
  "drop-fk": "allow.dropFk",
};

function changeLocator(c: Change): string {
  switch (c.kind) {
    case "drop-column":
    case "rename-column":
    case "change-column-type":
    case "change-column-nullable":
    case "change-column-default":
      return `${c.table}.${"column" in c ? c.column : c.from}`;
    case "add-column":
      return `${c.table}.${c.column.name}`;
    case "drop-table":
    case "rename-table":
      return c.kind === "drop-table" ? c.table : `${c.from}→${c.to}`;
    case "create-table":
      return c.table.name;
    case "add-index":
      return `${c.table}.${c.index.name}`;
    case "drop-index":
      return `${c.table}.${c.index}`;
    case "add-fk":
      return `${c.table}.${c.fk.name}`;
    case "drop-fk":
      return `${c.table}.${c.fk}`;
    case "create-view":
    case "replace-view":
      return c.view.name;
    case "drop-view":
      return c.view;
  }
}

export class BlockedChangesError extends Error {
  override readonly name = "BlockedChangesError";
  readonly blocked: Change[];
  readonly enableHints: string[];

  constructor(blocked: Change[]) {
    const hints = blocked.map((c) => {
      const flag = ENABLE_FLAG_BY_KIND[c.kind] ?? "(no flag enables this)";
      return `${c.kind} on ${changeLocator(c)}: pass ${flag}`;
    });
    const msg = `${blocked.length} blocked change(s):\n  - ${hints.join("\n  - ")}`;
    super(msg);
    this.blocked = blocked;
    this.enableHints = hints;
  }
}

export interface ViewShape {
  readonly columns: readonly string[];
  readonly columnTypes?: Readonly<Record<string, string>>;
}

export type ViewDiffClass =
  | "no-change"
  | "safe-append"
  | "safe-replace"
  | "breaking";

export interface ViewMigrationOpts {
  readonly diffClass: ViewDiffClass;
  readonly viewName: string;
  /** Full `CREATE VIEW <name> AS ...;` statement (semicolon included). */
  readonly createSql: string;
}

export function classifyViewDiff(prev: ViewShape, next: ViewShape): ViewDiffClass {
  const prevCols = prev.columns;
  const nextCols = next.columns;

  // Dropped column = breaking.
  for (const c of prevCols) {
    if (!nextCols.includes(c)) return "breaking";
  }

  // Type change on existing column = breaking.
  if (prev.columnTypes && next.columnTypes) {
    for (const c of prevCols) {
      const pt = prev.columnTypes[c];
      const nt = next.columnTypes[c];
      if (pt && nt && pt !== nt) return "breaking";
    }
  }

  if (prevCols.length === nextCols.length) {
    // Same length, same set → either identical order or reordered.
    let identical = true;
    for (let i = 0; i < prevCols.length; i++) {
      if (prevCols[i] !== nextCols[i]) { identical = false; break; }
    }
    return identical ? "no-change" : "safe-replace";
  }

  // Longer next, same prefix? → safe-append.
  let prefixMatches = true;
  for (let i = 0; i < prevCols.length; i++) {
    if (prevCols[i] !== nextCols[i]) { prefixMatches = false; break; }
  }
  if (prefixMatches) return "safe-append";

  // Mixed: reordered + appended → safe-replace (data shape unchanged at column level).
  return "safe-replace";
}

// The single source of expected view descriptors. Walks every projection,
// extracts its ViewSpec, emits the CREATE VIEW DDL via the one canonical emitter
// (emitViewDdl), and returns the view BODY keyed by name — the shape migrate-ts's
// schema-diff/snapshot/drift pipeline expects on the EXPECTED side (it re-wraps the
// body in CREATE VIEW and the diff comparator strips any leading CREATE VIEW).
//
// migrate-ts stays dependency-pure: it never imports codegen-ts. Callers (the CLI,
// integration tests) compute views here and thread them into buildExpectedSchema /
// drift / snapshot as the `views` input. This is the ONE place view SQL is produced.

import {
  type MetaData,
  MetaRoot,
  resolveTableName,
  resolveTableSchema,
} from "@metaobjectsdev/metadata";
import { isProjection } from "./projection-detector.js";
import { extractViewSpec } from "./extract-view-spec.js";
import { emitViewDdl } from "./view-ddl-emit.js";
import type { JoinNode, JoinTree } from "./view-spec.js";
import type { ColumnNamingStrategy } from "../metaobjects-config.js";

/** Structurally matches migrate-ts's `ViewDescriptor` (name + body sql + optional schema). */
export interface ExpectedView {
  name: string;
  schema?: string;
  sql: string;
  /**
   * Physical tables this view reads (base + every joined table). The migrate-ts
   * diff uses this to recreate the view when one of its source tables undergoes a
   * column-altering change — postgres blocks ALTER on a column a view depends on,
   * so the view must be dropped before and recreated after.
   */
  dependsOn: string[];
}

export interface BuildProjectionViewsOptions {
  dialect: "postgres" | "sqlite" | "d1";
  columnNamingStrategy?: ColumnNamingStrategy;
}

export function buildProjectionViews(
  root: MetaData,
  opts: BuildProjectionViewsOptions,
): ExpectedView[] {
  if (!(root instanceof MetaRoot)) {
    throw new Error("buildProjectionViews: root must be a loaded MetaRoot.");
  }
  // D1 is SQLite at the SQL level.
  const dialect: "postgres" | "sqlite" = opts.dialect === "d1" ? "sqlite" : opts.dialect;
  const columnNamingStrategy = opts.columnNamingStrategy ?? "snake_case";

  const joinTables: Record<string, string> = {};
  for (const obj of root.objects()) joinTables[obj.name] = resolveTableName(obj);

  const out: ExpectedView[] = [];
  for (const projection of root.objects().filter(isProjection)) {
    const spec = extractViewSpec(projection, root, { columnNamingStrategy });
    const baseTableName = joinTables[spec.joinTree.baseEntity];
    if (!baseTableName) continue; // unresolved base — skip (loader/codegen surface the error elsewhere)
    const body = emitViewDdl(spec, { dialect, baseTableName, joinTables, bodyOnly: true });
    const schema = resolveTableSchema(projection);
    const dependsOn = collectDependsOn(spec.joinTree, baseTableName, joinTables);
    out.push({
      name: spec.viewName,
      sql: body,
      dependsOn,
      ...(schema !== undefined ? { schema } : {}),
    });
  }
  return out;
}

/** The base table plus every joined table, deduped — the physical tables the view reads. */
function collectDependsOn(
  joinTree: JoinTree,
  baseTableName: string,
  joinTables: Readonly<Record<string, string>>,
): string[] {
  const tables = new Set<string>([baseTableName]);
  const walk = (node: JoinNode): void => {
    const t = joinTables[node.targetEntity];
    if (t) tables.add(t);
    for (const child of node.children) walk(child);
  };
  for (const j of joinTree.joins) walk(j);
  return [...tables];
}

// DB-free view-DDL dumper.
//
// Loads a MetaObjects metadata directory, finds projection entities
// (a read-only `source.rdb @kind:view` with no writable source), and prints
// the CREATE VIEW DDL each one compiles to — using the same pure functions the
// CLI's `meta migrate` uses (`extractViewSpec` + `emitViewDdl`). No database.
//
// Usage:
//   bun scripts/dump-view-ddl.ts <metadataDir>              -> all projections
//   bun scripts/dump-view-ddl.ts <metadataDir> <ViewName>   -> just that one (by entity name OR view name)
//
// Mirrors the real call sequence in
//   packages/cli/src/lib/projection-migrations.ts (computeProjectionMigrations).
import { MetaDataLoader, resolveTableName } from "@metaobjectsdev/metadata";
import { isProjection, extractViewSpec, emitViewDdl } from "@metaobjectsdev/codegen-ts";

const dir = process.argv[2];
const filter = process.argv[3];
if (!dir) {
  console.error("need <metadataDir> [ViewNameOrEntityName]");
  process.exit(2);
}

const res = await MetaDataLoader.fromDirectory(dir);
if (res.errors.length) {
  console.error("LOAD ERRORS:", JSON.stringify(res.errors, null, 2));
  process.exit(1);
}
const root = res.root;

// Resolve table names for every writable entity, exactly as the CLI does, so
// the emitter can map base entity + joined entities to physical tables.
const joinTables: Record<string, string> = {};
for (const obj of root.objects()) {
  joinTables[obj.name] = resolveTableName(obj);
}

// Find projection entities (source.rdb @kind:view, read-only, no writable source).
const projections = root.objects().filter(isProjection);

if (projections.length === 0) {
  console.error("-- no projection entities found");
  process.exit(0);
}

let printed = 0;
for (const projection of projections) {
  let spec: ReturnType<typeof extractViewSpec>;
  let createSql: string;
  try {
    spec = extractViewSpec(projection, root, { columnNamingStrategy: "snake_case" });
    const baseTableName = joinTables[spec.joinTree.baseEntity];
    if (!baseTableName) {
      console.log(`-- ${projection.name}: EMIT ERROR: base entity "${spec.joinTree.baseEntity}" has no resolvable table name`);
      continue;
    }
    createSql = emitViewDdl(spec, { dialect: "postgres", baseTableName, joinTables });
  } catch (e) {
    console.log(`-- ${projection.name}: EMIT ERROR: ${e instanceof Error ? e.message : String(e)}`);
    continue;
  }

  // Filter (after a successful extract so we can match on the physical view name too).
  if (filter && projection.name !== filter && spec.viewName !== filter) {
    continue;
  }

  if (printed > 0) console.log("");
  console.log(`-- projection: ${projection.name}`);
  console.log(createSql);
  printed++;
}

if (filter && printed === 0) {
  console.error(`-- no projection matched "${filter}"`);
  process.exit(1);
}

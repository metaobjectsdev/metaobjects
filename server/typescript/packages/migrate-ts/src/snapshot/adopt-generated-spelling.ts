// adopt-generated-spelling.ts — what `baseline --from-db` writes for a CHECK / index
// expression it can prove equal to the one migrate generates.
//
// An introspected Postgres snapshot carries Postgres's spelling (`(resource_kind = 'space'::text)`)
// of every expression. The OFFLINE plan has no database to ask, so it compares that text with the
// text migrate generates through the string normaliser, which cannot know every rewrite Postgres
// makes. Where the live database has just PROVEN, by the expression-canon probe, that its stored
// expression is exactly what the metadata's would be stored as, the snapshot records the
// generated text instead, so the offline plan compares like with like and a baselined project
// starts clean. An expression the probe cannot answer, or finds different, keeps Postgres's text:
// recording the generated text there would hide a real difference.

import type { ExprCanonProbe } from "../expr-canon.js";
import { qualifiedDbName } from "../qualified-name.js";
import type { CheckDescriptor, IndexDescriptor, SchemaSnapshot, TableDescriptor } from "../types.js";

export async function adoptGeneratedSpelling(
  live: SchemaSnapshot,
  expected: SchemaSnapshot,
  probe: ExprCanonProbe,
): Promise<SchemaSnapshot> {
  const expectedById = new Map(expected.tables.map((t) => [qualifiedDbName(t), t] as const));
  const tables: TableDescriptor[] = [];
  for (const table of live.tables) {
    const want = expectedById.get(qualifiedDbName(table));
    tables.push(want === undefined ? table : await adoptTable(table, want, probe));
  }
  return { ...live, tables };
}

async function adoptTable(live: TableDescriptor, expected: TableDescriptor, probe: ExprCanonProbe): Promise<TableDescriptor> {
  const answer = await probe(live, expected);
  if (answer === undefined) return live;
  const expectedChecks = new Map(expected.checks.map((c) => [c.name, c] as const));
  const expectedIndexes = new Map(expected.indexes.map((ix) => [ix.name, ix] as const));
  const checks = live.checks.map((ac): CheckDescriptor => {
    const ec = expectedChecks.get(ac.name);
    return ec !== undefined && answer.checks.get(ec) === ac.expression ? { ...ac, expression: ec.expression } : ac;
  });
  const indexes = live.indexes.map((ai): IndexDescriptor => {
    const ei = expectedIndexes.get(ai.name);
    const stored = ei === undefined ? undefined : answer.indexes.get(ei);
    if (ei === undefined || stored === undefined) return ai;
    const adopted = { ...ai };
    if (ei.expr !== undefined && ai.expr !== undefined && stored.expr === ai.expr) adopted.expr = ei.expr;
    if (ei.where !== undefined && ai.where !== undefined && stored.where === ai.where) adopted.where = ei.where;
    return adopted;
  });
  return { ...live, checks, indexes };
}

// A report dimension's `required` and the joins of its `@via` path.
// Every generated view join is LEFT OUTER, so `required` can no longer be read off "every
// join is INNER": `reportShape` in `@metaobjectsdev/metadata` derives it from the model. A joined
// dimension is required only when its @of field is, and every hop on the path is a belongs-to
// reference over a required foreign key, enforced (not `@enforce: false`), onto a target that
// hides no rows (not a TPH subtype). That is exactly when LEFT and INNER return the same rows, so
// the non-null row type never sits over a null-extended column.
//
// This reads the join types out of the view SQL the lowering emits (all LEFT OUTER) and holds
// `reportShape` to the hand-derived table. A dimension's `@via` crosses only identity.reference
// and `@cardinality: one` hops (a to-many hop does not load).

import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource, reportShape, type MetaObject, type MetaRoot } from "@metaobjectsdev/metadata";
import { buildProjectionViews } from "../../src/projection/build-projection-views.js";
import { extractReportSpec } from "../../src/projection/extract-report-spec.js";
import type { JoinNode } from "../../src/projection/view-spec.js";

type JoinKeyword = "INNER" | "LEFT OUTER";

const entity = (name: string, table: string, children: unknown[]) => ({
  "object.entity": {
    name,
    children: [
      { "source.rdb": { "@table": table } },
      { "field.long": { name: "id" } },
      { "identity.primary": { name: "pk", "@fields": ["id"] } },
      ...children,
    ],
  },
});

const realm = entity("Realm", "realms", [
  { "field.string": { name: "name", "@required": true } },
  { "field.string": { name: "motto" } },
]);
const session = entity("Session", "sessions", [
  { "field.long": { name: "realmId", "@required": true } },
  { "field.long": { name: "maybeRealmId" } },
  { "identity.reference": { name: "fkRealm", "@fields": ["realmId"], "@references": "Realm" } },
  { "identity.reference": { name: "fkMaybeRealm", "@fields": ["maybeRealmId"], "@references": "Realm" } },
  { "relationship.association": { name: "realm", "@objectRef": "Realm", "@cardinality": "one", "@sourceRefField": "realmId" } },
  {
    "relationship.association": {
      name: "maybeRealm", "@objectRef": "Realm", "@cardinality": "one", "@sourceRefField": "maybeRealmId",
    },
  },
]);

// The foreign key between Snap and Stamp is held by Stamp, the far side of Snap's `stamp`.
const stamp = entity("Stamp", "stamps", [
  { "field.long": { name: "snapId", "@required": true } },
  { "field.string": { name: "label", "@required": true } },
  { "identity.reference": { name: "fkSnap", "@fields": ["snapId"], "@references": "Snap" } },
]);

/** Each dimension: its `@of`, its `@via`, the joins its path must render, and its `required`. */
const L = "LEFT OUTER" as const;
const DIMENSIONS: Record<string, { of: string; via?: string; joins: JoinKeyword[]; required: boolean }> = {
  // No @via: a column of the @from entity itself.
  sessionKey: { of: "Snap.sessionId", joins: [], required: true },
  // identity.reference hops: required and enforced all the way stays required.
  sessionRealmId: { of: "Session.realmId", via: "Snap.fkSession", joins: [L], required: true },
  realmName: { of: "Realm.name", via: "Snap.fkSession.fkRealm", joins: [L, L], required: true },
  // An @enforce: false hop can name a row that does not exist: nullable.
  looseRealmName: { of: "Realm.name", via: "Snap.fkLoose.fkRealm", joins: [L, L], required: false },
  // A nullable hop, last or first on a multi-hop path: nullable.
  maybeRealmName: { of: "Realm.name", via: "Snap.fkSession.fkMaybeRealm", joins: [L, L], required: false },
  optionalFirstRealmName: { of: "Realm.name", via: "Snap.fkMaybeSession.fkRealm", joins: [L, L], required: false },
  // A required, enforced path over a field that is itself optional.
  realmMotto: { of: "Realm.motto", via: "Snap.fkSession.fkRealm", joins: [L, L], required: false },
  // A TPH-subtype target: its join carries the discriminator, so a row of a sibling subtype has no match.
  orgName: { of: "Org.orgName", via: "Snap.fkOrg", joins: [L], required: false },
  // @cardinality: one relationship hops, and one path that mixes the two hop kinds.
  relSessionRealmId: { of: "Session.realmId", via: "Snap.session", joins: [L], required: true },
  relRealmName: { of: "Realm.name", via: "Snap.session.realm", joins: [L, L], required: true },
  mixedRealmName: { of: "Realm.name", via: "Snap.session.fkRealm", joins: [L, L], required: true },
  relMaybeRealmName: { of: "Realm.name", via: "Snap.session.maybeRealm", joins: [L, L], required: false },
  // A to-one relationship whose foreign key the OTHER entity holds: a Snap with no Stamp has no match.
  stampLabel: { of: "Stamp.label", via: "Snap.stamp", joins: [L], required: false },
};

const party = { "object.entity": { name: "Party", "@discriminator": "kind", children: [
  { "source.rdb": { "@table": "parties" } },
  { "field.long": { name: "id" } },
  { "field.string": { name: "kind", "@required": true } },
  { "identity.primary": { name: "pk", "@fields": ["id"] } },
] } };
const org = { "object.entity": { name: "Org", extends: "Party", "@discriminatorValue": "ORG", children: [
  { "field.string": { name: "orgName", "@required": true } },
] } };

const snap = entity("Snap", "snaps", [
  { "field.long": { name: "sessionId", "@required": true } },
  { "field.long": { name: "unenforcedSessionId", "@required": true } },
  { "field.long": { name: "maybeSessionId" } },
  { "field.long": { name: "orgId", "@required": true } },
  { "identity.reference": { name: "fkSession", "@fields": ["sessionId"], "@references": "Session" } },
  { "identity.reference": { name: "fkMaybeSession", "@fields": ["maybeSessionId"], "@references": "Session" } },
  { "identity.reference": { name: "fkOrg", "@fields": ["orgId"], "@references": "Org" } },
  {
    "identity.reference": {
      name: "fkLoose", "@fields": ["unenforcedSessionId"], "@references": "Session", "@enforce": false,
    },
  },
  { "relationship.association": { name: "session", "@objectRef": "Session", "@cardinality": "one" } },
  { "relationship.association": { name: "stamp", "@objectRef": "Stamp", "@cardinality": "one" } },
  { "measure.aggregate": { name: "snaps", "@agg": "count", "@of": "Snap.id" } },
  ...Object.entries(DIMENSIONS).map(([name, d]) => ({
    "dimension.attribute": { name, "@of": d.of, ...(d.via !== undefined ? { "@via": d.via } : {}) },
  })),
]);

const VIEW = "v_snap_realms";
const report = {
  "object.report": {
    name: "SnapRealms",
    "@from": "Snap",
    "@dimensions": Object.keys(DIMENSIONS),
    "@measures": ["snaps"],
    children: [{ "source.rdb": { "@kind": "view", "@view": VIEW } }],
  },
};

async function load(): Promise<{ root: MetaRoot; report: MetaObject }> {
  const { root, errors } = await new MetaDataLoader().load([
    new InMemoryStringSource(JSON.stringify({ "metadata.root": { package: "a", children: [realm, session, snap, stamp, party, org, report] } })),
  ]);
  expect(errors).toEqual([]);
  return { root, report: root.objects().find((o) => o.name === "SnapRealms")! };
}

/** alias → the join keyword the emitted view SQL joins it with. */
function joinKeywordsOf(sql: string): Map<string, JoinKeyword> {
  const out = new Map<string, JoinKeyword>();
  for (const m of sql.matchAll(/\b(INNER|LEFT OUTER) JOIN (?:"[^"]+"\.)?"[^"]+" (\w+) ON\b/g)) out.set(m[2]!, m[1] as JoinKeyword);
  return out;
}

/** The aliases joined on the way from the base table to `alias`, outermost first. */
function aliasPath(joins: readonly JoinNode[], alias: string): string[] | undefined {
  for (const node of joins) {
    if (node.alias === alias) return [node.alias];
    const below = aliasPath(node.children, alias);
    if (below !== undefined) return [node.alias, ...below];
  }
  return undefined;
}

describe("a report dimension's required comes from the model, over joins that are all LEFT OUTER", () => {
  test("every dimension: the emitted joins, and required only over a required, enforced, unscoped path", async () => {
    const { root, report: snapRealms } = await load();
    const views = buildProjectionViews(root, { dialect: "postgres" });
    const sql = views.find((v) => v.name === VIEW)!.sql!;
    const keywords = joinKeywordsOf(sql);
    const spec = extractReportSpec(snapRealms, root, { columnNamingStrategy: "snake_case" });
    const required = Object.fromEntries(reportShape(snapRealms, root).fields.map((f) => [f.name, f.required]));

    const seen: Record<string, { joins: (JoinKeyword | undefined)[]; required: boolean | undefined }> = {};
    for (const column of spec.columns) {
      if (column.kind !== "dimension") continue;
      const alias = column.ref.slice(0, column.ref.indexOf("."));
      const path = alias === spec.joinTree.baseAlias ? [] : aliasPath(spec.joinTree.joins, alias);
      expect([column.fieldName, path === undefined ? "no join path" : "join path"]).toEqual([column.fieldName, "join path"]);
      const joins = path!.map((a) => keywords.get(a));
      seen[column.fieldName] = { joins, required: required[column.fieldName] };
      // no generated view join is INNER.
      expect([column.fieldName, joins.every((j) => j === "LEFT OUTER")]).toEqual([column.fieldName, true]);
    }
    expect(seen).toEqual(
      Object.fromEntries(Object.entries(DIMENSIONS).map(([name, d]) => [name, { joins: d.joins, required: d.required }])),
    );
  });
});

// A report dimension's `required` and the join type of its `@via` path are one rule stated in
// two packages (adopter report D5): `reportShape` in `@metaobjectsdev/metadata` decides whether
// the generated row type is nullable, and the view lowering here decides INNER or LEFT OUTER
// (#209). Nothing shares code between them, so a change to one can leave the other behind, and
// that failure is silent: a row type that says non-null over a column the view null-extends.
//
// This reads the join types out of the view SQL the lowering emits and holds `reportShape` to
// them. The expected table is derived by hand from the #209 rule: a hop is INNER when the
// entity it leaves holds a required foreign key and every hop before it is INNER.
// A dimension's `@via` crosses only identity.reference and `@cardinality: one` hops (a to-many
// hop does not load), so the hop that is LEFT OUTER for a reason other than a nullable key is
// the to-one relationship whose foreign key sits on the entity it reaches.

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
const DIMENSIONS: Record<string, { of: string; via?: string; joins: JoinKeyword[]; required: boolean }> = {
  // No @via: a column of the @from entity itself.
  sessionKey: { of: "Snap.sessionId", joins: [], required: true },
  // identity.reference hops.
  sessionRealmId: { of: "Session.realmId", via: "Snap.fkSession", joins: ["INNER"], required: true },
  realmName: { of: "Realm.name", via: "Snap.fkSession.fkRealm", joins: ["INNER", "INNER"], required: true },
  looseRealmName: { of: "Realm.name", via: "Snap.fkLoose.fkRealm", joins: ["INNER", "INNER"], required: true },
  maybeRealmName: { of: "Realm.name", via: "Snap.fkSession.fkMaybeRealm", joins: ["INNER", "LEFT OUTER"], required: false },
  // INNER all the way, over a field that is itself optional.
  realmMotto: { of: "Realm.motto", via: "Snap.fkSession.fkRealm", joins: ["INNER", "INNER"], required: false },
  // @cardinality: one relationship hops, and one path that mixes the two hop kinds.
  relSessionRealmId: { of: "Session.realmId", via: "Snap.session", joins: ["INNER"], required: true },
  relRealmName: { of: "Realm.name", via: "Snap.session.realm", joins: ["INNER", "INNER"], required: true },
  mixedRealmName: { of: "Realm.name", via: "Snap.session.fkRealm", joins: ["INNER", "INNER"], required: true },
  relMaybeRealmName: { of: "Realm.name", via: "Snap.session.maybeRealm", joins: ["INNER", "LEFT OUTER"], required: false },
  // A to-one relationship whose foreign key the OTHER entity holds: a Snap with no Stamp has no
  // match, so the hop is LEFT OUTER whatever the far side's key and the target field require.
  stampLabel: { of: "Stamp.label", via: "Snap.stamp", joins: ["LEFT OUTER"], required: false },
};

const snap = entity("Snap", "snaps", [
  { "field.long": { name: "sessionId", "@required": true } },
  { "field.long": { name: "unenforcedSessionId", "@required": true } },
  { "identity.reference": { name: "fkSession", "@fields": ["sessionId"], "@references": "Session" } },
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
    new InMemoryStringSource(JSON.stringify({ "metadata.root": { package: "a", children: [realm, session, snap, stamp, report] } })),
  ]);
  expect(errors).toEqual([]);
  return { root, report: root.objects().find((o) => o.name === "SnapRealms")! };
}

/** alias → the join keyword the emitted view SQL joins it with. */
function joinKeywordsOf(sql: string): Map<string, JoinKeyword> {
  const out = new Map<string, JoinKeyword>();
  for (const m of sql.matchAll(/\b(INNER|LEFT OUTER) JOIN "[^"]+" (\w+) ON\b/g)) out.set(m[2]!, m[1] as JoinKeyword);
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

describe("a report dimension's required agrees with the joins its view renders", () => {
  test("every dimension: the emitted joins, and required only over an all-INNER path", async () => {
    const { root, report: snapRealms } = await load();
    const views = buildProjectionViews(root, { dialect: "postgres", columnNamingStrategy: "snake_case" });
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
      // The direction that fails silently: non-null typed over a join that can null-extend.
      if (required[column.fieldName] === true) {
        expect([column.fieldName, joins.every((j) => j === "INNER")]).toEqual([column.fieldName, true]);
      }
    }
    expect(seen).toEqual(
      Object.fromEntries(Object.entries(DIMENSIONS).map(([name, d]) => [name, { joins: d.joins, required: d.required }])),
    );
  });
});

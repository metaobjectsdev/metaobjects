// Feature-combination gate: every pairwise-chosen model (src/feature-combinations.ts) is
// run through the adopter's loop — generate, compile, migrate a real Postgres, boot the
// generated routes — and each step is judged by the independent oracle
// (src/independent-oracle.ts), never by the code that produced it.
//
// Per model, six checks:
//   compile  `tsc --strict` over the whole generated tree, routes included
//   fks      the migrated database's FKs equal the metadata's (from pg_catalog)
//   columns  every declared column exists
//   drizzle  the generated Drizzle schema declares exactly the database's FKs
//   routes   every route the metadata says is served is mounted
//   m2m      an M:N traversal returns exactly the related rows — and only rows of the
//            target type when its table is shared (TPH)
//
// KNOWN DEFECTS. A check that fails for a reason recorded in KNOWN_DEFECTS below passes —
// but only if EVERY failure line matches that defect's signature, so a known defect cannot
// hide an unknown one in the same check. And a recorded defect that stops reproducing
// FAILS the case, naming the entry to delete: the ledger can only shrink.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { InMemoryStringSource, MetaDataLoader, type MetaObject, type MetaRoot, resolveColumnName } from "@metaobjectsdev/metadata";
import { AXES, buildModel, caseName, pairwiseCombinations, type Axis, type Combination } from "../src/feature-combinations.ts";
import { compileTrees, generateApp, generatedPathOf, type GeneratedApp } from "../src/generated-app.ts";
import {
  actualColumns, actualForeignKeys, drizzleForeignKeys, expectedColumns, expectedForeignKeys,
  expectedRoutes, fkKey, missingColumns, servedObjects,
} from "../src/independent-oracle.ts";
import { executeSql } from "../src/postgres-sql.ts";
import { startPostgres, type RunningPg } from "../src/postgres-container.ts";

type Check = "compile" | "fks" | "columns" | "drizzle" | "routes" | "m2m";

interface KnownDefect {
  id: string;
  what: string;
  check: Check;
  applies: (c: Combination) => boolean;
  /** Every failure line of `check` must match, or the failure is not this defect. */
  signature: RegExp;
}

const inHierarchy = (c: Combination) => c.holder === "base" || c.holder === "subtype" || c.holder === "mid";
const isManyToMany = (c: Combination) => c.link === "m2m" || c.link === "m2m-self" || c.link === "m2m-symmetric";

const KNOWN_DEFECTS: KnownDefect[] = [
  {
    id: "tph-required-default-read-type",
    what: "a @required field with a @default anywhere in a TPH hierarchy: the subtype's read schema makes it "
      + "optional while its declared type does not, so the base's queries module does not compile",
    check: "compile",
    applies: (c) => inHierarchy(c) && c.extra === "required-default",
    signature: /^Party(\.queries)?\.ts:\d+ Type '\{ partyType: "(Carrier|Broker)";[\s\S]*is not assignable to type '(Carrier|Broker|Party)(\[\])?'/,
  },
  {
    id: "tph-m2m-routes",
    what: "an M:N declared on a TPH base, subtype or abstract level mounts no traversal route "
      + "(the ruling: /<base-path>/<discriminatorValue lowercased>/:id/<relation>)",
    check: "routes",
    applies: (c) => inHierarchy(c) && isManyToMany(c),
    signature: /^GET \S+\/:id\/related \(\w+\.related M:N traversal\)$/,
  },
  {
    id: "composite-pk-drizzle-references",
    what: "a link table whose primary key is its two FK columns: the Drizzle schema omits `.references()` on "
      + "key columns, while the migration creates the FKs (awaiting the maintainer's ruling)",
    check: "drizzle",
    applies: (c) => isManyToMany(c) && c.junction === "composite",
    signature: /^in the database, not in Drizzle: links\(\w+\) -> \w+\(id\)$/,
  },
];

async function load(c: Combination): Promise<MetaRoot> {
  const result = await new MetaDataLoader({ strict: true }).load([
    new InMemoryStringSource(JSON.stringify(buildModel(c)), { id: "combination.json" }),
  ]);
  if (result.errors.length > 0) throw new Error(result.errors.map((e) => e.message).join("; "));
  return result.root;
}

function diffLines(label: string, expected: string[], actual: string[]): string[] {
  return [
    ...expected.filter((k) => !actual.includes(k)).map((k) => `missing: ${label} ${k}`),
    ...actual.filter((k) => !expected.includes(k)).map((k) => `unexpected: ${label} ${k}`),
  ];
}

/** Judge one check's failure lines against the ledger. Throws with the reason on a real failure. */
function judge(c: Combination, check: Check, failures: string[]): void {
  const known = KNOWN_DEFECTS.filter((d) => d.check === check && d.applies(c));
  if (known.length === 0) {
    expect(failures).toEqual([]);
    return;
  }
  const ids = known.map((d) => d.id).join(", ");
  if (failures.length === 0) {
    throw new Error(`${check}: known defect(s) ${ids} no longer reproduce here — delete them from KNOWN_DEFECTS if they are fixed everywhere`);
  }
  const unexplained = failures.filter((line) => !known.some((d) => d.signature.test(line)));
  expect(unexplained).toEqual([]);
}

/**
 * Seed rows behind a plain holder's M:N and read the traversal back through the generated
 * route. The expected ids are stated here per shape, never derived from the product. The
 * tables are the ones `buildModel` names; every link carries an unrelated or
 * other-subtype row the traversal must NOT return.
 */
async function m2mFailures(root: MetaRoot, c: Combination, app: GeneratedApp, uri: string, path: string): Promise<string[]> {
  const link = root.findObject("Link")!;
  const [sourceRef, targetRef] = link.referenceIdentities();
  const linkColumn = (fields: string[]) => resolveColumnName(link.findField(fields[0]!)!, "snake_case");
  const order = (id: number) => c.extra === "none"
    ? `INSERT INTO orders (id) VALUES (${id});`
    : `INSERT INTO orders (id, status) VALUES (${id}, 'open');`;
  const pair = (from: number, to: number) =>
    `INSERT INTO links (${linkColumn(sourceRef!.fields)}, ${linkColumn(targetRef!.fields)}) VALUES (${from}, ${to});`;

  let sql: string;
  let expected: number[];
  if (c.target === "self") {
    sql = order(1) + order(2) + order(3) + order(4)
      + (c.link === "m2m-self" ? pair(1, 2) + pair(2, 1) + pair(1, 3) + pair(4, 1) : pair(1, 2) + pair(3, 1));
    expected = [2, 3];
  } else if (c.target === "plain") {
    sql = order(1) + "INSERT INTO customers (id) VALUES (11), (12), (13);" + pair(1, 11) + pair(1, 12);
    expected = [11, 12];
  } else {
    // Two Carriers and a Broker, all reachable through the same junction column.
    sql = order(1) + "INSERT INTO parties (id, party_type) VALUES (11, 'Carrier'), (12, 'Carrier'), (13, 'Broker');"
      + pair(1, 11) + pair(1, 12) + pair(1, 13);
    expected = c.target === "subtype" ? [11, 12] : [11, 12, 13];
  }
  await executeSql(uri, sql);

  const fastify = await app.bootRoutes();
  try {
    const url = `${path}/1/related`;
    const res = await fastify.inject({ method: "GET", url });
    if (res.statusCode !== 200) return [`GET ${url} -> ${res.statusCode} ${res.body}`];
    const ids = (JSON.parse(res.body) as Array<{ id: number }>).map((r) => Number(r.id)).sort((a, b) => a - b);
    return JSON.stringify(ids) === JSON.stringify(expected)
      ? []
      : [`GET ${url} -> ids ${JSON.stringify(ids)}, expected ${JSON.stringify(expected)}`];
  } finally {
    await fastify.close();
  }
}

const CASES = pairwiseCombinations();

describe("feature combinations, end to end against Postgres", () => {
  let pgServer: RunningPg;
  const apps = new Map<string, { root: MetaRoot; app: GeneratedApp }>();
  let diagnostics = new Map<string, string[]>();

  beforeAll(async () => {
    pgServer = await startPostgres();
    for (const c of CASES) {
      const root = await load(c);
      apps.set(caseName(c), { root, app: await generateApp(root, pgServer.connectionUri, "combination") });
    }
    diagnostics = compileTrees([...apps.values()].map(({ app }) => ({ dir: app.dir, files: app.files })));
  }, 300_000);

  afterAll(async () => {
    for (const { app } of apps.values()) await app.close();
    await pgServer?.stop();
  });

  test("the pairwise set is stable and covers every axis value", () => {
    // A changed set renames cases; a shrunk one silently drops coverage. Either is a
    // decision, so it is made here, in the diff.
    expect(CASES.length).toBe(23);
    for (const [axis, values] of Object.entries(AXES) as Array<[Axis, readonly string[]]>) {
      const covered: string[] = [...new Set(CASES.map((c) => String(c[axis])))].sort();
      expect({ axis, values: covered }).toEqual({ axis, values: [...values].sort() });
    }
  });

  for (const c of CASES) {
    test(caseName(c), async () => {
      const { root, app } = apps.get(caseName(c))!;
      const uri = pgServer.connectionUri;
      await executeSql(uri, "DROP SCHEMA public CASCADE; CREATE SCHEMA public;");

      judge(c, "compile", diagnostics.get(app.dir) ?? []);

      await app.migrate(uri);
      const actualFks = (await actualForeignKeys(uri)).map(fkKey);
      judge(c, "fks", diffLines("fk", expectedForeignKeys(root).map(fkKey), actualFks));
      judge(c, "columns", missingColumns(expectedColumns(root), await actualColumns(uri)).map((x) => `missing column ${x}`));

      const modules = await Promise.all(
        root.objects().filter((o) => app.files.includes(`${o.name}.ts`)).map((o) => app.importModule(`${o.name}.ts`)),
      );
      const drizzle = drizzleForeignKeys(modules).map(fkKey);
      judge(c, "drizzle", [
        ...actualFks.filter((k) => !drizzle.includes(k)).map((k) => `in the database, not in Drizzle: ${k}`),
        ...drizzle.filter((k) => !actualFks.includes(k)).map((k) => `in Drizzle, not in the database: ${k}`),
      ]);

      const paths = new Map<MetaObject, string>();
      for (const obj of servedObjects(root)) paths.set(obj, await generatedPathOf(app, obj));
      const fastify = await app.bootRoutes();
      const missingRoutes = expectedRoutes(root, (o) => paths.get(o)!)
        .filter((r) => !fastify.hasRoute({ method: r.method, url: r.url }))
        .map((r) => `${r.method} ${r.url} (${r.why})`);
      await fastify.close();
      judge(c, "routes", missingRoutes);

      if (isManyToMany(c) && !inHierarchy(c)) {
        const holder = root.findObject("Order")!;
        judge(c, "m2m", await m2mFailures(root, c, app, uri, paths.get(holder)!));
      }
    }, 120_000);
  }
});

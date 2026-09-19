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
//   m2m      an M:N traversal returns exactly the related rows — only rows of the target
//            type when its table is shared (TPH), and 200 with [] for a source id of a
//            sibling subtype at a subtype segment (mount-m2m's stage 0)
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

const isManyToMany = (c: Combination) => c.link === "m2m" || c.link === "m2m-self" || c.link === "m2m-symmetric";

const KNOWN_DEFECTS: KnownDefect[] = [
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
 * Seed rows behind an M:N and read the traversal back through the generated route, at
 * every segment the oracle says serves it. The expected ids are stated here per shape,
 * never derived from the product. The tables are the ones `buildModel` names; every link
 * carries an unrelated or other-subtype row the traversal must NOT return, and every
 * subtype-segment read carries a source id of a SIBLING subtype, which must answer 200
 * with [] (mount-m2m's stage 0) rather than that sibling's relations.
 */
async function m2mFailures(
  root: MetaRoot,
  c: Combination,
  app: GeneratedApp,
  uri: string,
  paths: Map<MetaObject, string>,
): Promise<string[]> {
  const link = root.findObject("Link")!;
  const [sourceRef, targetRef] = link.referenceIdentities();
  const linkColumn = (fields: string[]) => resolveColumnName(link.findField(fields[0]!)!, "snake_case");
  // The holder's `extra` column travels with every row of the table that stores the
  // holder — `orders` for a plain holder, `parties` for one inside the hierarchy.
  const extraCols = c.extra === "none" ? "" : ", status";
  const extraVals = c.extra === "none" ? "" : ", 'open'";
  const order = (id: number) => `INSERT INTO orders (id${extraCols}) VALUES (${id}${extraVals});`;
  const party = (id: number, type: string) =>
    `INSERT INTO parties (id, party_type${extraCols}) VALUES (${id}, '${type}'${extraVals});`;
  const customers = "INSERT INTO customers (id) VALUES (11), (12), (13);";
  const pair = (from: number, to: number) =>
    `INSERT INTO links (${linkColumn(sourceRef!.fields)}, ${linkColumn(targetRef!.fields)}) VALUES (${from}, ${to});`;

  // Which object serves `related` at which URL is the oracle's rule; this check reads
  // the answer back rather than deriving a path of its own.
  const routes = expectedRoutes(root, (o) => paths.get(o)!);
  const traversalUrl = (obj: string, id: number): string => {
    const route = routes.find((r) => r.why === `${obj}.related M:N traversal`);
    if (route === undefined) throw new Error(`oracle lists no ${obj}.related traversal for ${caseName(c)}`);
    return route.url.replace(":id", String(id));
  };

  interface Read { obj: string; id: number; expected: number[] }
  let sql: string;
  let reads: Read[];
  if (c.holder === "plain") {
    if (c.target === "self") {
      sql = order(1) + order(2) + order(3) + order(4)
        + (c.link === "m2m-self" ? pair(1, 2) + pair(2, 1) + pair(1, 3) + pair(4, 1) : pair(1, 2) + pair(3, 1));
      reads = [{ obj: "Order", id: 1, expected: [2, 3] }];
    } else if (c.target === "plain") {
      sql = order(1) + customers + pair(1, 11) + pair(1, 12);
      reads = [{ obj: "Order", id: 1, expected: [11, 12] }];
    } else {
      // Two Carriers and a Broker, all reachable through the same junction column.
      sql = order(1) + "INSERT INTO parties (id, party_type) VALUES (11, 'Carrier'), (12, 'Carrier'), (13, 'Broker');"
        + pair(1, 11) + pair(1, 12) + pair(1, 13);
      reads = [{ obj: "Order", id: 1, expected: c.target === "subtype" ? [11, 12] : [11, 12, 13] }];
    }
  } else if (c.holder === "base") {
    // Declared on the Party base, so it serves at the BASE path — every row of the
    // table is a legitimate source — AND under each subtype segment, where the mount
    // gates the source id on that subtype's discriminator. Source row 1 is a Carrier,
    // so the Broker segment reading the SAME id is the type assertion: [] where the
    // base path (the first read) returns the rows.
    if (c.target === "self") {
      sql = party(1, "Carrier") + party(2, "Broker") + party(3, "Carrier") + party(4, "Broker")
        + (c.link === "m2m-self" ? pair(1, 2) + pair(2, 1) + pair(1, 3) + pair(4, 1) : pair(1, 2) + pair(3, 1));
      reads = [{ obj: "Party", id: 1, expected: [2, 3] }, { obj: "Broker", id: 1, expected: [] }];
    } else if (c.target === "plain") {
      sql = party(1, "Carrier") + party(2, "Broker") + customers + pair(1, 11) + pair(1, 12);
      reads = [{ obj: "Party", id: 1, expected: [11, 12] }, { obj: "Broker", id: 1, expected: [] }];
    } else {
      throw new Error(`no seeded m2m shape for ${caseName(c)} — the covering set grew`);
    }
  } else if (c.holder === "subtype") {
    // Declared on Broker, so it serves ONLY under /parties/broker, and only a Broker
    // id may traverse it. The target is Broker itself (self) or another Party subtype,
    // so a joined row of the wrong subtype (a Carrier) must be filtered out of the
    // result while a Carrier SOURCE id reads as [].
    if (c.target === "self") {
      sql = party(1, "Broker") + party(2, "Broker") + party(3, "Broker") + party(4, "Carrier")
        + (c.link === "m2m-self"
          ? pair(1, 2) + pair(2, 1) + pair(1, 3) + pair(1, 4)
          : pair(1, 2) + pair(3, 1) + pair(1, 4));
      reads = [{ obj: "Broker", id: 1, expected: [2, 3] }, { obj: "Broker", id: 4, expected: [] }];
    } else if (c.target === "plain") {
      sql = party(1, "Broker") + party(2, "Carrier") + customers + pair(1, 11) + pair(1, 12);
      reads = [{ obj: "Broker", id: 1, expected: [11, 12] }, { obj: "Broker", id: 2, expected: [] }];
    } else if (c.target === "subtype") {
      // target=subtype: Carriers 11/12 joined, Carrier 2 present for the stage-0 read,
      // and a joined Broker 13 that the target filter must drop.
      sql = party(1, "Broker") + party(2, "Carrier") + party(11, "Carrier") + party(12, "Carrier")
        + party(13, "Broker") + pair(1, 11) + pair(1, 12) + pair(1, 13);
      reads = [{ obj: "Broker", id: 1, expected: [11, 12] }, { obj: "Broker", id: 2, expected: [] }];
    } else {
      // target=base is a VALID shape (a Broker→Party hetero M:N) with NO target pin —
      // the base carries @discriminator, not @discriminatorValue — so these
      // pinned-target expectations would misjudge it. Fail loudly instead.
      throw new Error(`no seeded m2m shape for ${caseName(c)} — the covering set grew`);
    }
  } else {
    // Declared on the abstract Organization level: no path of its own, resolved only by
    // Carrier, so /parties/carrier is the one place it serves — and only a Carrier id
    // may traverse it.
    if (c.target !== "plain") throw new Error(`no seeded m2m shape for ${caseName(c)} — the covering set grew`);
    sql = party(1, "Carrier") + party(2, "Broker") + customers + pair(1, 11) + pair(1, 12);
    reads = [{ obj: "Carrier", id: 1, expected: [11, 12] }, { obj: "Carrier", id: 2, expected: [] }];
  }
  await executeSql(uri, sql);

  const fastify = await app.bootRoutes();
  try {
    const failures: string[] = [];
    for (const read of reads) {
      const url = traversalUrl(read.obj, read.id);
      const res = await fastify.inject({ method: "GET", url });
      if (res.statusCode !== 200) {
        failures.push(`GET ${url} -> ${res.statusCode} ${res.body}`);
        continue;
      }
      const ids = (JSON.parse(res.body) as Array<{ id: number }>).map((r) => Number(r.id)).sort((a, b) => a - b);
      if (JSON.stringify(ids) !== JSON.stringify(read.expected)) {
        failures.push(`GET ${url} -> ids ${JSON.stringify(ids)}, expected ${JSON.stringify(read.expected)}`);
      }
    }
    return failures;
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

      if (isManyToMany(c)) {
        judge(c, "m2m", await m2mFailures(root, c, app, uri, paths));
      }
    }, 120_000);
  }
});

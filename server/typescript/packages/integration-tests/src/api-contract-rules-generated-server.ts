// api-contract-rules-generated-server.ts — boots the GENERATED service of the rules corpus
// (ADR-0066 lifecycles, declared operations and permission points; ADR-0067 layers 4 and 5)
// behind its emitted Fastify or Hono transport, and drives it against `fixtures/api-contract-conformance/rules/`.
//
// The shells are generated; what an app writes by hand is supplied here, exactly as the corpus
// README specifies it so every port's lane implements the same behaviour: the actor resolver,
// the policy, the two operation bodies, one hook and the event hook. Nothing here re-implements a
// rule the shell owns: the check order, the guarded update, `state_managed` and the rollback are
// all the emitted code's.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runGen, defineConfig } from "@metaobjectsdev/codegen-ts";
import { entityFile } from "@metaobjectsdev/codegen-ts/generators";
import { apiGenerators, serveApi, type ApiLane } from "./api-lane.ts";
import { DEFAULT_PHYSICAL_NAMING } from "@metaobjectsdev/metadata";
import { sql, type SQL } from "drizzle-orm";
import type pg from "pg";
import type { OutputLayout } from "./output-layout.ts";
import { executeSql } from "./postgres-sql.ts";
import { applyNearestNaming, loadMetadataFile } from "./load-metadata.ts";

export interface RulesSeed {
  purchaseRequests: Array<{ id: number; title: string; amountCents: number; limitCents: number | null; status: string }>;
}

export interface GeneratedRulesServerHandle {
  baseUrl: string;
  applySeed(seed: RulesSeed): Promise<void>;
  close(): Promise<void>;
}

/** The README's actor: a name and the permissions it holds, from two request headers. */
interface Actor {
  readonly name: string;
  readonly grants: readonly string[];
}

/** The slice of a Drizzle node-postgres handle the hand-written code uses. */
interface Sqlish {
  execute(query: SQL): Promise<{ rows: Array<Record<string, unknown>> }>;
}

/** The slice of the generated contexts the hand-written code uses. */
interface Ctx {
  readonly tx: unknown;
  readonly actor: Actor | undefined;
  refuse(code: string, details?: Record<string, unknown>): never;
}

type WriteEvent = {
  kind: string;
  entity?: string;
  key?: unknown;
  transition?: string;
  from?: string;
  to?: string;
  operation?: string;
  actor: Actor | undefined;
};

const exec = (tx: unknown, query: SQL) => (tx as Sqlish).execute(query);

/**
 * Generate the corpus's service and transport, and mount them.
 *
 * `configDir` is where the run's `.metaobjects/config.json` is looked up: the corpus directory
 * for the default settings, or a `settings/<variant>/` directory for a variant, which reuses the
 * corpus's one model.
 */
export async function startGeneratedRulesServer(
  connectionUri: string,
  metaPath: string,
  configDir: string,
  outputLayout: OutputLayout = "flat",
  /** The rules corpus is served by the service only: on Fastify, or on Hono. */
  lane: Exclude<ApiLane, "routes"> = "service",
): Promise<GeneratedRulesServerHandle> {
  const here = dirname(fileURLToPath(import.meta.url));
  const genTmpRoot = join(here, "..", ".gen-tmp");
  mkdirSync(genTmpRoot, { recursive: true });
  const tmp = mkdtempSync(join(genTmpRoot, "api-contract-rules-"));

  const root = applyNearestNaming(await loadMetadataFile(metaPath), configDir);
  root.physicalNaming = DEFAULT_PHYSICAL_NAMING;
  const lr = await runGen({
    config: defineConfig({
      outDir: tmp,
      extStyle: "none",
      outputLayout,
      dbImport: "./db",
      dialect: "postgres",
      apiPrefix: "/api",
      generators: apiGenerators(lane, [entityFile()], () => []),
    }),
    metadata: root,
  });
  if (lr.warnings.length > 0) throw new Error(`codegen produced warnings: ${lr.warnings.join("; ")}`);

  const bigintTypesImport = pathToFileURL(join(here, "pg-bigint-number-types.ts")).href;
  writeFileSync(
    join(tmp, "db.ts"),
    `
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { bigintAsNumberTypes } from ${JSON.stringify(bigintTypesImport)};
export const pool = new pg.Pool({ connectionString: ${JSON.stringify(connectionUri)}, types: bigintAsNumberTypes });
export const db = drizzle(pool);
`,
    "utf8",
  );

  // The schema `meta migrate` writes for the model: the enum's `@default` is the column DEFAULT,
  // which a create under `rules.lifecycle.create: any` that omits the state relies on.
  await executeSql(
    connectionUri,
    `CREATE TABLE IF NOT EXISTS "purchase_requests" (
       "id" bigserial PRIMARY KEY,
       "title" varchar(80) NOT NULL,
       "amount_cents" bigint NOT NULL,
       "limit_cents" bigint,
       "status" varchar(255) DEFAULT 'draft'
     );
     CREATE TABLE IF NOT EXISTS "audit_entries" (
       "id" bigserial PRIMARY KEY,
       "kind" varchar(20) NOT NULL,
       "detail" varchar(200) NOT NULL
     );`,
  );

  const dbMod = (await import(pathToFileURL(join(tmp, "db.ts")).href)) as { pool: pg.Pool; db: unknown };
  // What the app writes by hand; the database is passed beside it.
  const deps = {
    // Allowed exactly when the actor holds the permission by name.
    policy: { allows: (permission: string, actor: Actor | undefined) => actor?.grants.includes(permission) ?? false },
    bodies: {
      decide: (input: { approve: boolean; note?: string | null }, ctx: Ctx) => {
        if (!input.approve && (input.note === undefined || input.note === null || input.note === "")) ctx.refuse("note_required");
        return input.approve ? "approve" : "reject";
      },
      requestTotals: async (ctx: Ctx) => {
        const r = await exec(
          ctx.tx,
          sql`SELECT count(*)::bigint AS "count", coalesce(sum("amount_cents"), 0)::bigint AS "totalCents" FROM "purchase_requests"`,
        );
        return { count: Number(r.rows[0]!["count"]), totalCents: Number(r.rows[0]!["totalCents"]) };
      },
    },
    hooks: {
      // Runs after the row is written, so a refusal here proves the write is rolled back.
      afterUpdatePurchaseRequest: (row: { title: string }, _previous: unknown, ctx: Ctx) => {
        if (row.title === "REFUSE") ctx.refuse("title_refused");
      },
    },
    events: {
      onWrite: async (event: WriteEvent, ctx: Ctx) => {
        if (event.actor?.name === "no-audit") ctx.refuse("audit_unavailable");
        const detail =
          event.kind === "transition"
            ? `${event.entity} ${String(event.key)} ${event.transition} ${event.from}->${event.to} by ${event.actor?.name ?? "-"}`
            : event.kind === "command"
              ? `${event.operation} ${String(event.key)} by ${event.actor?.name ?? "-"}`
              : `${event.entity} ${String(event.key)} by ${event.actor?.name ?? "-"}`;
        await exec(ctx.tx, sql`INSERT INTO "audit_entries" ("kind", "detail") VALUES (${event.kind}, ${detail})`);
      },
    },
  };

  // The README's actor resolver, read from the request's headers through each framework's own
  // request object (the transport's `getActor`).
  const actor = (header: (name: string) => string | undefined): Actor | undefined => {
    const name = header("x-actor");
    if (name === undefined || name === "") return undefined;
    const grants = header("x-grants");
    return { name, grants: grants !== undefined && grants !== "" ? grants.split(",").map((g) => g.trim()) : [] };
  };

  const served = await serveApi(lane, tmp, dbMod.db, async () => {
    throw new Error("the rules corpus runs on the service lanes only");
  }, { deps, actor });
  const baseUrl = served.baseUrl;

  return {
    baseUrl,
    applySeed: async (seed: RulesSeed) => {
      await executeSql(connectionUri, `TRUNCATE TABLE "purchase_requests", "audit_entries" RESTART IDENTITY;`);
      for (const r of seed.purchaseRequests) {
        await executeSql(
          connectionUri,
          `INSERT INTO "purchase_requests" ("id","title","amount_cents","limit_cents","status") VALUES (${r.id}, ${str(r.title)}, ${r.amountCents}, ${
            r.limitCents === null ? "NULL" : r.limitCents
          }, ${str(r.status)})`,
        );
      }
      await executeSql(connectionUri, `SELECT setval(pg_get_serial_sequence('purchase_requests','id'), (SELECT MAX("id") FROM "purchase_requests"));`);
    },
    close: async () => {
      await served.close();
      await dbMod.pool.end();
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

function str(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

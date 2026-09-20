// api-contract-m2m-generated-server.ts — boots the GENERATED M:N routes (the
// deployed artifact) over HTTP and drives them against the FR-018 M:N corpus.
//
// Mirrors api-contract-generated-server.ts (the single-entity Author lane) but
// for the multi-entity M:N model (Post/Tag/PostTag + Person/Follow/Friendship),
// PLUS FW-8 (FR-018 x FR-017 — M:N traversal inside a TPH hierarchy) over the
// Account discriminator base (@discriminator "kind", subtypes MemberAccount /
// GuestAccount, abstract mid level ScopedAccount). It:
//   1. runs the real codegen (runGen from @metaobjectsdev/codegen-ts) over the
//      M:N meta into a temp dir, emitting each entity's Drizzle table + Zod +
//      allowlists AND each <Entity>.routes.ts — which, for an entity with a M:N
//      relationship, now mounts `mountM2mRoute(...)` traversals alongside CRUD.
//      For the TPH base this is the SINGLE Account.routes.ts file: it carries
//      the polymorphic + per-subtype CRUD set AND every M:N reachable anywhere
//      in the hierarchy (base-declared, abstract-mid-declared, subtype-declared)
//      — see `renderTphRoutesFile` in codegen-ts;
//   2. provisions the eleven tables (six vanilla + accounts + its four junctions);
//   3. imports the EMITTED Post.routes.ts + Person.routes.ts + Account.routes.ts
//      unmodified and mounts them on a Fastify instance backed by a real
//      Drizzle(node-postgres) connection to the per-run testcontainer.
//
// This proves the GENERATED M:N traversal route — not a stand-in — implements
// the cross-port contract over HTTP, including the TPH source/target narrowing.

import Fastify, { type FastifyInstance } from "fastify";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runGen, defineConfig } from "@metaobjectsdev/codegen-ts";
import { entityFile, routesFile } from "@metaobjectsdev/test-generators";
import pg from "pg";
import { executeSql } from "./postgres-sql.ts";
import { loadMetadataFile } from "./load-metadata.ts";

export interface M2mSeed {
  posts: Array<{ id: number; title: string }>;
  tags: Array<{ id: number; name: string }>;
  post_tags: Array<{ postId: number; tagId: number }>;
  people: Array<{ id: number; name: string }>;
  follows: Array<{ followerId: number; followeeId: number }>;
  friendships: Array<{ personAId: number; personBId: number }>;
  // FW-8 — the TPH discriminator base (Account) + its junction tables.
  accounts: Array<{ id: number; kind: string; handle: string; karma: number | null; invitedBy: string | null }>;
  account_tags: Array<{ accountId: number; tagId: number }>;
  scoped_account_tags: Array<{ accountId: number; tagId: number }>;
  member_account_tags: Array<{ accountId: number; tagId: number }>;
  post_reviewers: Array<{ postId: number; accountId: number }>;
  // Route-spelling gate only (no relationship) — see m2m/README.md.
  blog_categories: Array<{ id: number; name: string }>;
}

export interface GeneratedM2mServerHandle {
  baseUrl: string;
  applySeed(seed: M2mSeed): Promise<void>;
  close(): Promise<void>;
}

export async function startGeneratedM2mServer(
  connectionUri: string,
  metaPath: string,
): Promise<GeneratedM2mServerHandle> {
  const here = dirname(fileURLToPath(import.meta.url));
  const genTmpRoot = join(here, "..", ".gen-tmp");
  mkdirSync(genTmpRoot, { recursive: true });
  const tmp = mkdtempSync(join(genTmpRoot, "api-contract-m2m-"));

  // 1. Emit the real artifacts for every entity in the M:N model.
  const root = await loadMetadataFile(metaPath);
  const lr = await runGen({
    config: defineConfig({
      outDir: tmp,
      extStyle: "none",
      dbImport: "./db",
      dialect: "postgres",
      apiPrefix: "/api",
      generators: [entityFile(), routesFile()],
    }),
    metadata: root,
  });
  if (lr.warnings.length > 0) {
    throw new Error(`codegen produced warnings: ${lr.warnings.join("; ")}`);
  }

  // 2. db module the emitted routes import (`import { db } from "./db"`).
  const bigintTypesImport = pathToFileURL(join(here, "pg-bigint-number-types.ts")).href;
  const dbModule = `
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { bigintAsNumberTypes } from ${JSON.stringify(bigintTypesImport)};
export const pool = new pg.Pool({ connectionString: ${JSON.stringify(connectionUri)}, types: bigintAsNumberTypes });
export const db = drizzle(pool);
`;
  writeFileSync(join(tmp, "db.ts"), dbModule, "utf8");

  // 3. Provision the schema to match the EMITTED Drizzle tables (snake_case).
  //    "accounts" is the TPH discriminator base's SINGLE shared table — karma
  //    (Member-only) and invited_by (Guest-only) are nullable since a row of
  //    the other subtype never sets them.
  await executeSql(connectionUri, `
    CREATE TABLE IF NOT EXISTS "posts"  ("id" bigserial PRIMARY KEY, "title" varchar(200) NOT NULL);
    CREATE TABLE IF NOT EXISTS "tags"   ("id" bigserial PRIMARY KEY, "name" varchar(80) NOT NULL);
    CREATE TABLE IF NOT EXISTS "post_tags"   ("post_id" bigint NOT NULL, "tag_id" bigint NOT NULL, PRIMARY KEY ("post_id","tag_id"));
    CREATE TABLE IF NOT EXISTS "people" ("id" bigserial PRIMARY KEY, "name" varchar(80) NOT NULL);
    CREATE TABLE IF NOT EXISTS "follows" ("follower_id" bigint NOT NULL, "followee_id" bigint NOT NULL, PRIMARY KEY ("follower_id","followee_id"));
    CREATE TABLE IF NOT EXISTS "friendships" ("person_a_id" bigint NOT NULL, "person_b_id" bigint NOT NULL, PRIMARY KEY ("person_a_id","person_b_id"));
    CREATE TABLE IF NOT EXISTS "accounts" ("id" bigserial PRIMARY KEY, "kind" varchar(20) NOT NULL, "handle" varchar(80) NOT NULL, "karma" integer, "invited_by" varchar(80));
    CREATE TABLE IF NOT EXISTS "account_tags" ("account_id" bigint NOT NULL, "tag_id" bigint NOT NULL, PRIMARY KEY ("account_id","tag_id"));
    CREATE TABLE IF NOT EXISTS "scoped_account_tags" ("account_id" bigint NOT NULL, "tag_id" bigint NOT NULL, PRIMARY KEY ("account_id","tag_id"));
    CREATE TABLE IF NOT EXISTS "member_account_tags" ("account_id" bigint NOT NULL, "tag_id" bigint NOT NULL, PRIMARY KEY ("account_id","tag_id"));
    CREATE TABLE IF NOT EXISTS "post_reviewers" ("post_id" bigint NOT NULL, "account_id" bigint NOT NULL, PRIMARY KEY ("post_id","account_id"));
    CREATE TABLE IF NOT EXISTS "blog_categories" ("id" bigserial PRIMARY KEY, "name" varchar(80) NOT NULL);
  `);

  // 4. Import the EMITTED route files unmodified and mount them.
  const postRoutes = (await import(pathToFileURL(join(tmp, "Post.routes.ts")).href)) as {
    postRoutes: (f: FastifyInstance) => Promise<void>;
  };
  const personRoutes = (await import(pathToFileURL(join(tmp, "Person.routes.ts")).href)) as {
    personRoutes: (f: FastifyInstance) => Promise<void>;
  };
  // FW-8: the TPH discriminator base's routes file carries the polymorphic base
  // path AND every per-subtype path (incl. subtype-scoped M:N mounts) in one module.
  const accountRoutes = (await import(pathToFileURL(join(tmp, "Account.routes.ts")).href)) as {
    accountRoutes: (f: FastifyInstance) => Promise<void>;
  };
  // PostCategory takes part in no relationship; it is mounted so the corpus can
  // gate the COLLECTION-URL spelling of a multi-word, y-ending entity name.
  const postCategoryRoutes = (await import(pathToFileURL(join(tmp, "PostCategory.routes.ts")).href)) as {
    postCategoryRoutes: (f: FastifyInstance) => Promise<void>;
  };
  const dbMod = (await import(pathToFileURL(join(tmp, "db.ts")).href)) as { pool: pg.Pool };

  const fastify = Fastify();
  await fastify.register(postRoutes.postRoutes);
  await fastify.register(personRoutes.personRoutes);
  await fastify.register(accountRoutes.accountRoutes);
  await fastify.register(postCategoryRoutes.postCategoryRoutes);
  await fastify.ready();
  const baseUrl = await fastify.listen({ host: "127.0.0.1", port: 0 });

  return {
    baseUrl,
    applySeed: async (seed: M2mSeed) => {
      await seedM2m(connectionUri, seed);
    },
    close: async () => {
      await fastify.close();
      await dbMod.pool.end();
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

/** Truncate + insert the M:N corpus seed (shared by both lanes). */
export async function seedM2m(connectionUri: string, seed: M2mSeed): Promise<void> {
  await executeSql(connectionUri, `
    TRUNCATE TABLE "posts","tags","post_tags","people","follows","friendships",
      "accounts","account_tags","scoped_account_tags","member_account_tags","post_reviewers",
      "blog_categories"
      RESTART IDENTITY;
  `);
  for (const p of seed.posts)
    await executeSql(connectionUri, `INSERT INTO "posts" ("id","title") VALUES (${p.id}, ${str(p.title)})`);
  for (const t of seed.tags)
    await executeSql(connectionUri, `INSERT INTO "tags" ("id","name") VALUES (${t.id}, ${str(t.name)})`);
  for (const pt of seed.post_tags)
    await executeSql(connectionUri, `INSERT INTO "post_tags" ("post_id","tag_id") VALUES (${pt.postId}, ${pt.tagId})`);
  for (const pe of seed.people)
    await executeSql(connectionUri, `INSERT INTO "people" ("id","name") VALUES (${pe.id}, ${str(pe.name)})`);
  for (const f of seed.follows)
    await executeSql(connectionUri, `INSERT INTO "follows" ("follower_id","followee_id") VALUES (${f.followerId}, ${f.followeeId})`);
  for (const fr of seed.friendships)
    await executeSql(connectionUri, `INSERT INTO "friendships" ("person_a_id","person_b_id") VALUES (${fr.personAId}, ${fr.personBId})`);
  // FW-8 — accounts before its junctions; post_reviewers needs both posts and
  // accounts already present.
  for (const a of seed.accounts)
    await executeSql(
      connectionUri,
      `INSERT INTO "accounts" ("id","kind","handle","karma","invited_by") VALUES (${a.id}, ${str(a.kind)}, ${str(a.handle)}, ${numOrNull(a.karma)}, ${strOrNull(a.invitedBy)})`,
    );
  for (const at of seed.account_tags)
    await executeSql(connectionUri, `INSERT INTO "account_tags" ("account_id","tag_id") VALUES (${at.accountId}, ${at.tagId})`);
  for (const st of seed.scoped_account_tags)
    await executeSql(connectionUri, `INSERT INTO "scoped_account_tags" ("account_id","tag_id") VALUES (${st.accountId}, ${st.tagId})`);
  for (const mt of seed.member_account_tags)
    await executeSql(connectionUri, `INSERT INTO "member_account_tags" ("account_id","tag_id") VALUES (${mt.accountId}, ${mt.tagId})`);
  for (const pr of seed.post_reviewers)
    await executeSql(connectionUri, `INSERT INTO "post_reviewers" ("post_id","account_id") VALUES (${pr.postId}, ${pr.accountId})`);
  for (const bc of seed.blog_categories)
    await executeSql(connectionUri, `INSERT INTO "blog_categories" ("id","name") VALUES (${bc.id}, ${str(bc.name)})`);
}

function str(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

function strOrNull(v: string | null): string {
  return v === null ? "NULL" : str(v);
}

function numOrNull(v: number | null): string {
  return v === null ? "NULL" : String(v);
}

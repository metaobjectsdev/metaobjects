// api-contract-m2m-server.ts — the HAND-ROLLED reference lane for the FR-018
// M:N traversal contract. Unlike the generated lane, the Drizzle tables + route
// wiring here are declared by hand (not emitted by codegen), so the two lanes
// are independent witnesses of the same contract. Both mount the shared
// `mountM2mRoute` runtime helper — that helper IS the cross-port resolver
// semantics, exercised here directly.
//
// FW-8 (FR-018 x FR-017 — M:N traversal inside a TPH hierarchy) adds the
// `accounts` discriminator base (`kind`: Member | Guest, abstract mid level
// ScopedAccount, concrete MemberAccount / GuestAccount):
//   GET /api/accounts/:id/badges            base-declared, UNGATED (rule a) —
//                                            every row of the shared table is a
//                                            legitimate source.
//   GET /api/accounts/member/:id/badges     the SAME relationship, ALSO mounted
//                                            under the subtype segment (rule b)
//                                            — gated via sourceDiscriminator.
//   GET /api/accounts/member/:id/scopes     declared on the ABSTRACT mid level
//                                            ScopedAccount — served only under
//                                            its one concrete descendant (rule d).
//   GET /api/accounts/member/:id/interests  declared on the CONCRETE subtype
//                                            MemberAccount itself (rule b).
//   GET /api/posts/:id/reviewers            a non-TPH source (Post) whose
//                                            relationship TARGET is a TPH
//                                            subtype (MemberAccount) — gated via
//                                            targetDiscriminator so a sibling
//                                            subtype's row (a Guest) never leaks.
// There is no /api/accounts/guest/* route wired here: no scenario in the shared
// corpus exercises the Guest segment.

import Fastify, { type FastifyInstance } from "fastify";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { pgTable, bigint, integer, varchar, bigserial, primaryKey } from "drizzle-orm/pg-core";
import { mountM2mRoute } from "@metaobjectsdev/runtime-ts/drizzle-fastify";
import { bigintAsNumberTypes } from "./pg-bigint-number-types.ts";
import { seedM2m, type M2mSeed } from "./api-contract-m2m-generated-server.ts";

export interface M2mServerHandle {
  baseUrl: string;
  applySeed(seed: M2mSeed): Promise<void>;
  close(): Promise<void>;
}

// Hand-declared Drizzle tables (the reference, not the emitted ones).
const posts = pgTable("posts", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  title: varchar("title", { length: 200 }).notNull(),
});
const tags = pgTable("tags", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  name: varchar("name", { length: 80 }).notNull(),
});
const postTags = pgTable("post_tags", {
  postId: bigint("post_id", { mode: "number" }).notNull(),
  tagId: bigint("tag_id", { mode: "number" }).notNull(),
}, (t) => [primaryKey({ columns: [t.postId, t.tagId] })]);
const people = pgTable("people", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  name: varchar("name", { length: 80 }).notNull(),
});
const follows = pgTable("follows", {
  followerId: bigint("follower_id", { mode: "number" }).notNull(),
  followeeId: bigint("followee_id", { mode: "number" }).notNull(),
}, (t) => [primaryKey({ columns: [t.followerId, t.followeeId] })]);
const friendships = pgTable("friendships", {
  personAId: bigint("person_a_id", { mode: "number" }).notNull(),
  personBId: bigint("person_b_id", { mode: "number" }).notNull(),
}, (t) => [primaryKey({ columns: [t.personAId, t.personBId] })]);
// FW-8 — the TPH discriminator base's SINGLE shared table. karma (Member-only)
// and invitedBy (Guest-only) are nullable since a row of the other subtype
// never sets them.
const accounts = pgTable("accounts", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  kind: varchar("kind", { length: 20 }).notNull(),
  handle: varchar("handle", { length: 80 }).notNull(),
  karma: integer("karma"),
  invitedBy: varchar("invited_by", { length: 80 }),
});
const accountTags = pgTable("account_tags", {
  accountId: bigint("account_id", { mode: "number" }).notNull(),
  tagId: bigint("tag_id", { mode: "number" }).notNull(),
}, (t) => [primaryKey({ columns: [t.accountId, t.tagId] })]);
const scopedAccountTags = pgTable("scoped_account_tags", {
  accountId: bigint("account_id", { mode: "number" }).notNull(),
  tagId: bigint("tag_id", { mode: "number" }).notNull(),
}, (t) => [primaryKey({ columns: [t.accountId, t.tagId] })]);
const memberAccountTags = pgTable("member_account_tags", {
  accountId: bigint("account_id", { mode: "number" }).notNull(),
  tagId: bigint("tag_id", { mode: "number" }).notNull(),
}, (t) => [primaryKey({ columns: [t.accountId, t.tagId] })]);
const postReviewers = pgTable("post_reviewers", {
  postId: bigint("post_id", { mode: "number" }).notNull(),
  accountId: bigint("account_id", { mode: "number" }).notNull(),
}, (t) => [primaryKey({ columns: [t.postId, t.accountId] })]);

export async function startM2mServer(connectionUri: string): Promise<M2mServerHandle> {
  const pool = new pg.Pool({ connectionString: connectionUri, types: bigintAsNumberTypes });
  const db = drizzle(pool);

  await pool.query(`CREATE TABLE IF NOT EXISTS "posts"  ("id" bigserial PRIMARY KEY, "title" varchar(200) NOT NULL)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS "tags"   ("id" bigserial PRIMARY KEY, "name" varchar(80) NOT NULL)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS "post_tags"   ("post_id" bigint NOT NULL, "tag_id" bigint NOT NULL, PRIMARY KEY ("post_id","tag_id"))`);
  await pool.query(`CREATE TABLE IF NOT EXISTS "people" ("id" bigserial PRIMARY KEY, "name" varchar(80) NOT NULL)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS "follows" ("follower_id" bigint NOT NULL, "followee_id" bigint NOT NULL, PRIMARY KEY ("follower_id","followee_id"))`);
  await pool.query(`CREATE TABLE IF NOT EXISTS "friendships" ("person_a_id" bigint NOT NULL, "person_b_id" bigint NOT NULL, PRIMARY KEY ("person_a_id","person_b_id"))`);
  await pool.query(`CREATE TABLE IF NOT EXISTS "accounts" ("id" bigserial PRIMARY KEY, "kind" varchar(20) NOT NULL, "handle" varchar(80) NOT NULL, "karma" integer, "invited_by" varchar(80))`);
  await pool.query(`CREATE TABLE IF NOT EXISTS "account_tags" ("account_id" bigint NOT NULL, "tag_id" bigint NOT NULL, PRIMARY KEY ("account_id","tag_id"))`);
  await pool.query(`CREATE TABLE IF NOT EXISTS "scoped_account_tags" ("account_id" bigint NOT NULL, "tag_id" bigint NOT NULL, PRIMARY KEY ("account_id","tag_id"))`);
  await pool.query(`CREATE TABLE IF NOT EXISTS "member_account_tags" ("account_id" bigint NOT NULL, "tag_id" bigint NOT NULL, PRIMARY KEY ("account_id","tag_id"))`);
  await pool.query(`CREATE TABLE IF NOT EXISTS "post_reviewers" ("post_id" bigint NOT NULL, "account_id" bigint NOT NULL, PRIMARY KEY ("post_id","account_id"))`);

  const fastify = Fastify();
  await fastify.register(async (instance) => {
    mountM2mRoute({ fastify: instance, path: "/posts", relationName: "tags", db,
      junctionTable: postTags, targetTable: tags, sourceColumn: "post_id", targetColumn: "tag_id", targetPkColumn: "id", symmetric: false });
    mountM2mRoute({ fastify: instance, path: "/persons", relationName: "following", db,
      junctionTable: follows, targetTable: people, sourceColumn: "follower_id", targetColumn: "followee_id", targetPkColumn: "id", symmetric: false });
    mountM2mRoute({ fastify: instance, path: "/persons", relationName: "friends", db,
      junctionTable: friendships, targetTable: people, sourceColumn: "person_a_id", targetColumn: "person_b_id", targetPkColumn: "id", symmetric: true });

    // FW-8 rule (a): base-declared, UNGATED — every row of the shared `accounts`
    // table (Member or Guest) is a legitimate source here.
    mountM2mRoute({ fastify: instance, path: "/accounts", relationName: "badges", db,
      junctionTable: accountTags, targetTable: tags, sourceColumn: "account_id", targetColumn: "tag_id", targetPkColumn: "id", symmetric: false });
    // FW-8 rule (b): the SAME relationship, ALSO mounted under the subtype
    // segment — the overlap with the base route above is deliberate. Rule (c):
    // sourceDiscriminator gates it, so a non-Member id answers [] rather than
    // reaching the junction (which addresses the shared base table either way).
    mountM2mRoute({ fastify: instance, path: "/accounts/member", relationName: "badges", db,
      junctionTable: accountTags, targetTable: tags, sourceColumn: "account_id", targetColumn: "tag_id", targetPkColumn: "id", symmetric: false,
      sourceDiscriminator: { table: accounts, pkColumn: "id", column: "kind", value: "Member" } });
    // FW-8 rule (d): declared on the ABSTRACT mid level ScopedAccount — no path
    // of its own, served only under its one concrete descendant (MemberAccount).
    mountM2mRoute({ fastify: instance, path: "/accounts/member", relationName: "scopes", db,
      junctionTable: scopedAccountTags, targetTable: tags, sourceColumn: "account_id", targetColumn: "tag_id", targetPkColumn: "id", symmetric: false,
      sourceDiscriminator: { table: accounts, pkColumn: "id", column: "kind", value: "Member" } });
    // FW-8 rule (b): declared on the CONCRETE subtype MemberAccount itself.
    mountM2mRoute({ fastify: instance, path: "/accounts/member", relationName: "interests", db,
      junctionTable: memberAccountTags, targetTable: tags, sourceColumn: "account_id", targetColumn: "tag_id", targetPkColumn: "id", symmetric: false,
      sourceDiscriminator: { table: accounts, pkColumn: "id", column: "kind", value: "Member" } });
    // FW-8 target side: Post is NOT TPH, but its `reviewers` relationship targets
    // MemberAccount — a TPH subtype whose rows live in the shared `accounts`
    // table. targetDiscriminator narrows the joined rows to "Member" so a Guest
    // co-tenant (post 2 → account 2, deliberately seeded) never leaks through.
    mountM2mRoute({ fastify: instance, path: "/posts", relationName: "reviewers", db,
      junctionTable: postReviewers, targetTable: accounts, sourceColumn: "post_id", targetColumn: "account_id", targetPkColumn: "id", symmetric: false,
      targetDiscriminator: { column: "kind", value: "Member" } });
  }, { prefix: "/api" });
  await fastify.ready();
  const baseUrl = await fastify.listen({ host: "127.0.0.1", port: 0 });

  return {
    baseUrl,
    applySeed: async (seed: M2mSeed) => { await seedM2m(connectionUri, seed); },
    close: async () => { await fastify.close(); await pool.end(); },
  };
}

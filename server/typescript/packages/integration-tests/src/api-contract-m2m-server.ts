// api-contract-m2m-server.ts — the HAND-ROLLED reference lane for the FR-018
// M:N traversal contract. Unlike the generated lane, the Drizzle tables + route
// wiring here are declared by hand (not emitted by codegen), so the two lanes
// are independent witnesses of the same contract. Both mount the shared
// `mountM2mRoute` runtime helper — that helper IS the cross-port resolver
// semantics, exercised here directly.

import Fastify, { type FastifyInstance } from "fastify";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { pgTable, bigint, varchar, bigserial, primaryKey } from "drizzle-orm/pg-core";
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

export async function startM2mServer(connectionUri: string): Promise<M2mServerHandle> {
  const pool = new pg.Pool({ connectionString: connectionUri, types: bigintAsNumberTypes });
  const db = drizzle(pool);

  await pool.query(`CREATE TABLE IF NOT EXISTS "posts"  ("id" bigserial PRIMARY KEY, "title" varchar(200) NOT NULL)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS "tags"   ("id" bigserial PRIMARY KEY, "name" varchar(80) NOT NULL)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS "post_tags"   ("post_id" bigint NOT NULL, "tag_id" bigint NOT NULL, PRIMARY KEY ("post_id","tag_id"))`);
  await pool.query(`CREATE TABLE IF NOT EXISTS "people" ("id" bigserial PRIMARY KEY, "name" varchar(80) NOT NULL)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS "follows" ("follower_id" bigint NOT NULL, "followee_id" bigint NOT NULL, PRIMARY KEY ("follower_id","followee_id"))`);
  await pool.query(`CREATE TABLE IF NOT EXISTS "friendships" ("person_a_id" bigint NOT NULL, "person_b_id" bigint NOT NULL, PRIMARY KEY ("person_a_id","person_b_id"))`);

  const fastify = Fastify();
  await fastify.register(async (instance) => {
    mountM2mRoute({ fastify: instance, path: "/posts", relationName: "tags", db,
      junctionTable: postTags, targetTable: tags, sourceColumn: "post_id", targetColumn: "tag_id", targetPkColumn: "id", symmetric: false });
    mountM2mRoute({ fastify: instance, path: "/persons", relationName: "following", db,
      junctionTable: follows, targetTable: people, sourceColumn: "follower_id", targetColumn: "followee_id", targetPkColumn: "id", symmetric: false });
    mountM2mRoute({ fastify: instance, path: "/persons", relationName: "friends", db,
      junctionTable: friendships, targetTable: people, sourceColumn: "person_a_id", targetColumn: "person_b_id", targetPkColumn: "id", symmetric: true });
  }, { prefix: "/api" });
  await fastify.ready();
  const baseUrl = await fastify.listen({ host: "127.0.0.1", port: 0 });

  return {
    baseUrl,
    applySeed: async (seed: M2mSeed) => { await seedM2m(connectionUri, seed); },
    close: async () => { await fastify.close(); await pool.end(); },
  };
}

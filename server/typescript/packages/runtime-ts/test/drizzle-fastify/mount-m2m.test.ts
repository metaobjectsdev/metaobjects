// M:N traversal route helper — exercises all three FR-018 modes (hetero,
// directed self-join, symmetric union-on-read) over a real Drizzle (libsql)
// connection + Fastify. The helper does a metadata-derived two-stage join:
//   1. junction WHERE sourceCol (=|IN) :id   (symmetric → OR targetCol)
//   2. target   WHERE pk IN (related ids)
// driven entirely off the static descriptor codegen emits.

import { describe, test, expect, beforeAll } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core";
import { mountM2mRoute } from "../../src/drizzle-fastify/index.js";

// --- hetero: Post —tags→ Tag via PostTag ---
const posts = sqliteTable("posts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
});
const tags = sqliteTable("tags", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
});
const postTags = sqliteTable("post_tags", {
  postId: integer("post_id").notNull(),
  tagId: integer("tag_id").notNull(),
});

// --- self-join: Person follows/friends Person ---
const people = sqliteTable("people", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
});
const follows = sqliteTable("follows", {
  followerId: integer("follower_id").notNull(),
  followeeId: integer("followee_id").notNull(),
});
const friendships = sqliteTable("friendships", {
  personAId: integer("person_a_id").notNull(),
  personBId: integer("person_b_id").notNull(),
});

let app: FastifyInstance;

beforeAll(async () => {
  const client = createClient({ url: ":memory:" });
  await client.execute(`CREATE TABLE posts (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL)`);
  await client.execute(`CREATE TABLE tags (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)`);
  await client.execute(`CREATE TABLE post_tags (post_id INTEGER NOT NULL, tag_id INTEGER NOT NULL)`);
  await client.execute(`CREATE TABLE people (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)`);
  await client.execute(`CREATE TABLE follows (follower_id INTEGER NOT NULL, followee_id INTEGER NOT NULL)`);
  await client.execute(`CREATE TABLE friendships (person_a_id INTEGER NOT NULL, person_b_id INTEGER NOT NULL)`);

  await client.execute(`INSERT INTO posts (id, title) VALUES (1,'Hello'),(2,'World'),(3,'Orphan')`);
  await client.execute(`INSERT INTO tags (id, name) VALUES (10,'red'),(20,'green'),(30,'blue')`);
  await client.execute(`INSERT INTO post_tags (post_id, tag_id) VALUES (1,10),(1,20),(2,30)`);

  await client.execute(`INSERT INTO people (id, name) VALUES (1,'Alice'),(2,'Bob'),(3,'Carol'),(4,'Dave')`);
  await client.execute(`INSERT INTO follows (follower_id, followee_id) VALUES (1,2),(1,3),(2,1)`);
  await client.execute(`INSERT INTO friendships (person_a_id, person_b_id) VALUES (1,2),(3,1),(2,4)`);

  const db = drizzle(client);
  app = Fastify();

  mountM2mRoute({
    fastify: app, path: "/posts", relationName: "tags", db,
    junctionTable: postTags, targetTable: tags,
    sourceColumn: "post_id", targetColumn: "tag_id", targetPkColumn: "id",
    symmetric: false,
  });
  mountM2mRoute({
    fastify: app, path: "/people", relationName: "following", db,
    junctionTable: follows, targetTable: people,
    sourceColumn: "follower_id", targetColumn: "followee_id", targetPkColumn: "id",
    symmetric: false,
  });
  mountM2mRoute({
    fastify: app, path: "/people", relationName: "friends", db,
    junctionTable: friendships, targetTable: people,
    sourceColumn: "person_a_id", targetColumn: "person_b_id", targetPkColumn: "id",
    symmetric: true,
  });
  await app.ready();
});

describe("mountM2mRoute — hetero (Post.tags via PostTag)", () => {
  test("post 1 has red + green", async () => {
    const r = await app.inject({ method: "GET", url: "/posts/1/tags" });
    expect(r.statusCode).toBe(200);
    const rows = JSON.parse(r.body) as Array<{ id: number; name: string }>;
    expect(rows.map((x) => x.name).sort()).toEqual(["green", "red"]);
  });
  test("post 2 has blue", async () => {
    const r = await app.inject({ method: "GET", url: "/posts/2/tags" });
    expect(JSON.parse(r.body).map((x: { name: string }) => x.name)).toEqual(["blue"]);
  });
  test("post 3 (orphan) has no tags → empty array", async () => {
    const r = await app.inject({ method: "GET", url: "/posts/3/tags" });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body)).toEqual([]);
  });
});

describe("mountM2mRoute — directed self-join (Person.following via Follow)", () => {
  test("alice follows bob + carol", async () => {
    const r = await app.inject({ method: "GET", url: "/people/1/following" });
    expect(JSON.parse(r.body).map((x: { name: string }) => x.name).sort()).toEqual(["Bob", "Carol"]);
  });
  test("bob follows only alice (direction matters)", async () => {
    const r = await app.inject({ method: "GET", url: "/people/2/following" });
    expect(JSON.parse(r.body).map((x: { name: string }) => x.name)).toEqual(["Alice"]);
  });
  test("carol follows nobody", async () => {
    const r = await app.inject({ method: "GET", url: "/people/3/following" });
    expect(JSON.parse(r.body)).toEqual([]);
  });
});

describe("mountM2mRoute — symmetric self-join (Person.friends via Friendship)", () => {
  test("alice friends both directions (stored 1,2 and 3,1)", async () => {
    const r = await app.inject({ method: "GET", url: "/people/1/friends" });
    expect(JSON.parse(r.body).map((x: { name: string }) => x.name).sort()).toEqual(["Bob", "Carol"]);
  });
  test("bob friends union (stored 1,2 reverse and 2,4 forward)", async () => {
    const r = await app.inject({ method: "GET", url: "/people/2/friends" });
    expect(JSON.parse(r.body).map((x: { name: string }) => x.name).sort()).toEqual(["Alice", "Dave"]);
  });
  test("dave single friend", async () => {
    const r = await app.inject({ method: "GET", url: "/people/4/friends" });
    expect(JSON.parse(r.body).map((x: { name: string }) => x.name)).toEqual(["Bob"]);
  });
});

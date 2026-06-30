// ADR-0038 — reverse-relationship navigation via explicit FK finders.
//
// Each FK an entity holds (`identity.reference`) yields a finder pair on that
// entity's queries surface — `find<Plural>By<FkField>(value)` (single, indexed
// `WHERE fk = ?`) and `find<Plural>By<FkField>In(values)` (batched, anti-N+1,
// `WHERE fk IN (…)`). FK field names are unique within an entity, so the SAME-PAIR
// case (an entity with 3 FKs to one target) yields 3 DISTINCT finders — no
// collision. This is the cross-port naming contract the other four ports replicate.

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MetaDataLoader, InMemoryStringSource, type MetaRoot } from "@metaobjectsdev/metadata";
import { makeRenderContext } from "../../src/render-context.js";
import { buildPkMap } from "../../src/pk-resolver.js";
import { buildRelationMap } from "../../src/relation-resolver.js";
import { renderQueriesFile } from "../../src/templates/queries-file.js";
import { renderDrizzleSchema } from "../../src/templates/drizzle-schema.js";
import {
  reverseFinderFnName,
  reverseFinderInFnName,
  reverseFinderFkSegment,
} from "../../src/naming.js";

// The shared cross-port fixture: GameSession has THREE FKs to Scene (same-pair)
// plus one to Player.
const FIXTURE = join(
  import.meta.dir,
  "../../../../../../fixtures/conformance/reverse-finders-same-pair/input/meta.game.json",
);

async function loadRoot(): Promise<MetaRoot> {
  const input = readFileSync(FIXTURE, "utf8");
  const res = await new MetaDataLoader().load([
    new InMemoryStringSource(input, { id: "meta.game.json", format: "json" }),
  ]);
  expect(res.errors).toEqual([]);
  return res.root;
}

function ctxFor(root: MetaRoot, dialect: "postgres" | "sqlite" = "postgres") {
  return makeRenderContext({
    dialect,
    loadedRoot: root,
    outDir: "/x",
    dbImport: "./db",
    pkMap: buildPkMap(root),
    relationMap: buildRelationMap(root),
  });
}

describe("ADR-0038 reverse-finder naming convention", () => {
  test("FK segment PascalCases and drops a trailing Id", () => {
    expect(reverseFinderFkSegment("currentSceneId")).toBe("CurrentScene");
    expect(reverseFinderFkSegment("authorId")).toBe("Author");
    expect(reverseFinderFkSegment("scene")).toBe("Scene"); // no trailing Id
    expect(reverseFinderFkSegment("Id")).toBe("Id"); // bare Id is not stripped to ""
  });

  test("the same-pair case resolves to 3 distinct finder names", () => {
    const names = [
      reverseFinderFnName("GameSession", "currentSceneId"),
      reverseFinderFnName("GameSession", "lastOpeningNarrativeSceneId"),
      reverseFinderFnName("GameSession", "transitioningFromSceneId"),
    ];
    expect(names).toEqual([
      "findGameSessionsByCurrentScene",
      "findGameSessionsByLastOpeningNarrativeScene",
      "findGameSessionsByTransitioningFromScene",
    ]);
    expect(new Set(names).size).toBe(3); // all distinct
  });

  test("batched finder appends In to the single finder name", () => {
    expect(reverseFinderInFnName("GameSession", "currentSceneId")).toBe(
      "findGameSessionsByCurrentSceneIn",
    );
  });
});

describe("ADR-0038 reverse-finder codegen (same-pair fixture)", () => {
  test("GameSession emits all 3 same-pair finder pairs + the Player FK pair", async () => {
    const root = await loadRoot();
    const ctx = ctxFor(root);
    const out = renderQueriesFile(root.findObject("GameSession")!, ctx);

    // Three Scene FKs → three distinct single + batched pairs.
    for (const seg of [
      "CurrentScene",
      "LastOpeningNarrativeScene",
      "TransitioningFromScene",
    ]) {
      expect(out).toContain(`export async function findGameSessionsBy${seg}(`);
      expect(out).toContain(`export async function findGameSessionsBy${seg}In(`);
    }
    // The Player FK (different target, string PK).
    expect(out).toContain("export async function findGameSessionsByPlayer(");
    expect(out).toContain("export async function findGameSessionsByPlayerIn(");
  });

  test("single finder is one indexed equality query returning an array", async () => {
    const root = await loadRoot();
    const out = renderQueriesFile(root.findObject("GameSession")!, ctxFor(root));
    expect(out).toContain(
      "export async function findGameSessionsByCurrentScene(db: Db, currentSceneId: number): Promise<GameSession[]>",
    );
    expect(out).toContain(
      "return db.select().from(gameSessions).where(eq(gameSessions.currentSceneId, currentSceneId));",
    );
  });

  test("batched finder uses inArray and short-circuits on empty input", async () => {
    const root = await loadRoot();
    const out = renderQueriesFile(root.findObject("GameSession")!, ctxFor(root));
    expect(out).toContain(
      "export async function findGameSessionsByCurrentSceneIn(db: Db, currentSceneIds: number[]): Promise<GameSession[]>",
    );
    expect(out).toContain("if (currentSceneIds.length === 0)");
    expect(out).toContain(
      "inArray(gameSessions.currentSceneId, currentSceneIds)",
    );
  });

  test("FK value type follows the TARGET pk type (Player.id is string → string FK)", async () => {
    const root = await loadRoot();
    const out = renderQueriesFile(root.findObject("GameSession")!, ctxFor(root));
    expect(out).toContain(
      "export async function findGameSessionsByPlayer(db: Db, playerId: string): Promise<GameSession[]>",
    );
  });

  test("an entity with no incoming-FK declarations (Scene) emits NO reverse finders", async () => {
    const root = await loadRoot();
    const out = renderQueriesFile(root.findObject("Scene")!, ctxFor(root));
    expect(out).not.toContain("findScenesBy");
  });

  test("no duplicate relations() reverse many() keys — the collision is gone", async () => {
    const root = await loadRoot();
    const ctx = ctxFor(root);
    // The Drizzle schema (which embeds relations() blocks) must not declare two
    // members with the same key for GameSession's reverse side. Before ADR-0038
    // the three Scene FKs each pushed a `gameSessions: many(...)` entry onto Scene,
    // silently overwriting. Now there are no reverse many() entries at all.
    const schema = renderDrizzleSchema(root.findObject("Scene")!, ctx).toString();
    const reverseManyCount = (schema.match(/gameSessions:\s*many\(/g) ?? []).length;
    expect(reverseManyCount).toBe(0);
  });
});

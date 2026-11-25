import { describe, expect, test } from "bun:test";
import { isMetaObject, type MetaObject } from "@metaobjectsdev/metadata";
import { RailwayModelError, pickProject, readRailway } from "../src/index.js";
import { fixtureSources, loadModels } from "./model.js";

type Json = { "metadata.root": { package: string; children: Record<string, Record<string, unknown>>[] } };

/** The one-service fixture, changed by `edit`. */
function oneService(edit: (children: Record<string, Record<string, unknown>>[]) => void): string {
  const model = JSON.parse(fixtureSources("railway-emit-one-service")[0]!.json) as Json;
  edit(model["metadata.root"].children);
  return JSON.stringify(model);
}

function deployment(children: Record<string, Record<string, unknown>>[]): Record<string, unknown> {
  return children.find((c) => "deployment.railway" in c)!["deployment.railway"]!;
}

async function problems(json: string): Promise<string[]> {
  const root = await loadModels([{ id: "meta.game.json", json }]);
  const objects = root.children().filter(isMetaObject) as MetaObject[];
  try {
    pickProject(readRailway(root, objects));
  } catch (e) {
    if (e instanceof RailwayModelError) return [...e.problems];
    throw e;
  }
  return [];
}

describe("readRailway refuses what Railway cannot do", () => {
  test("the fixture as written has no problems", async () => {
    expect(await problems(oneService(() => {}))).toEqual([]);
  });

  test("a deployment with no source: a plan would disconnect the service", async () => {
    const p = await problems(oneService((c) => delete deployment(c)["@repo"]));
    expect(p.join("\n")).toContain("declare @repo or @image");
  });

  test("both @repo and @image", async () => {
    const p = await problems(oneService((c) => (deployment(c)["@image"] = "ghcr.io/acme/game:1")));
    expect(p.join("\n")).toContain("both @repo and @image");
  });

  test("secret settings with no vault named", async () => {
    const p = await problems(oneService((c) => delete deployment(c)["@secrets"]));
    expect(p.join("\n")).toContain("LLM_API_KEY");
    expect(p.join("\n")).toContain("set @secrets");
  });

  test("a vault with no scope for the environment", async () => {
    const p = await problems(oneService((c) => (deployment(c)["@environment"] = "staging", c.push({ "environment.standing": { name: "staging" } }))));
    expect(p.join("\n")).toContain('no scope.env named "staging"');
  });

  test("a value node for a secret setting", async () => {
    const p = await problems(
      oneService((c) => (deployment(c)["children"] = [{ "value.literal": { name: "k", "@setting": "Llm.apiKey", "@literal": "x" } }])),
    );
    expect(p.join("\n")).toContain("is @secret");
  });

  test("a value node for a setting nobody declared", async () => {
    const p = await problems(
      oneService((c) => (deployment(c)["children"] = [{ "value.literal": { name: "k", "@setting": "Nope.thing", "@literal": "x" } }])),
    );
    expect(p.join("\n")).toContain('"Nope.thing" names no setting');
  });

  test("@path on an output that is not a URL", async () => {
    const p = await problems(
      oneService(
        (c) => (deployment(c)["children"] = [{ "value.ref": { name: "h", "@setting": "Database.url", "@producedBy": "Game.db", "@output": "host", "@path": "/x" } }]),
      ),
    );
    expect(p.join("\n")).toContain("@path is appended to a URL");
  });

  test("an output the engine does not supply", async () => {
    const p = await problems(
      oneService((c) => {
        const game = c.find((x) => "system.internal" in x)!["system.internal"]!["children"] as Record<string, Record<string, unknown>>[];
        game.push({ "resource.bucket": { name: "files", "@engine": "r2", "@managedBy": "external" } });
        deployment(c)["children"] = [{ "value.ref": { name: "f", "@setting": "Database.url", "@producedBy": "Game.files", "@output": "url" } }];
      }),
    );
    expect(p.join("\n")).toContain("managed outside Railway");
  });

  test("an @settings group that is not in the model", async () => {
    const p = await problems(
      oneService((c) => {
        const game = c.find((x) => "system.internal" in x)!["system.internal"]!["children"] as Record<string, Record<string, unknown>>[];
        (game[0]!["app.service"] as Record<string, unknown>)["@settings"] = ["Database", "Missing"];
      }),
    );
    expect(p.join("\n")).toContain('"Missing", which is no object.settings');
  });

  test("a value node makes the file manage variables, and the values resolve", async () => {
    const json = oneService(
      (c) => (deployment(c)["children"] = [{ "value.ref": { name: "db", "@setting": "Database.url", "@producedBy": "Game.db", "@output": "url" } }]),
    );
    const root = await loadModels([{ id: "meta.game.json", json }]);
    const p = pickProject(readRailway(root, root.children().filter(isMetaObject) as MetaObject[]))!;
    expect(p.manageVariables).toBe(true);
    expect(p.deployments[0]!.variables.map((v) => [v.name, v.kind, v.value])).toEqual([
      ["DATABASE_URL", "literal", "${{db.DATABASE_URL}}"],
      ["LLM_API_KEY", "preserve", undefined],
      ["LLM_MODEL", "literal", "small"],
      ["REDIS_URL", "preserve", undefined],
    ]);
  });

  test("two Railway projects need { project }", async () => {
    const json = oneService((c) => {
      c.push({ "environment.standing": { name: "staging" } });
      c.push({ "vault.infisical": { name: "keys2", children: [{ "scope.env": { name: "staging", "@project": "acme-game" } }] } });
      c.push({ "deployment.railway": { ...deployment(c), name: "server-staging", "@environment": "staging", "@project": "other", "@secrets": "keys2" } });
    });
    const root = await loadModels([{ id: "meta.game.json", json }]);
    const objects = root.children().filter(isMetaObject) as MetaObject[];
    expect(() => pickProject(readRailway(root, objects))).toThrow("pass { project }");
    expect(pickProject(readRailway(root, objects, () => true, { project: "other" }))!.name).toBe("other");
  });

  test("a partial name Railway refuses", async () => {
    const p = await problems(oneService((c) => (deployment(c)["@service"] = "game server")));
    expect(p.join("\n")).toContain("partial name");
  });
});

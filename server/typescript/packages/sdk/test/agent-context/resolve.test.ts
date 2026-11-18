import { test, expect, describe } from "bun:test";
import { makeStack, detectStack, type ProjectProbe } from "../../src/agent-context/resolve.js";

const probe = (deps: string[], files: string[]): ProjectProbe => ({
  hasDep: (name) => deps.includes(name),
  hasFileMatching: (re) => files.some((f) => re.test(f)),
});

describe("makeStack", () => {
  test("dedupes, orders, and computes tokens incl. migration", () => {
    const s = makeStack(["java", "typescript", "java"], ["tanstack", "react"]);
    expect(s.servers).toEqual(["typescript", "java"]);   // SERVER_LANGS order
    expect(s.clients).toEqual(["react", "tanstack"]);     // CLIENT_FRAMEWORKS order
    expect([...s.tokens].sort()).toEqual(["java", "migration", "react", "tanstack", "typescript"]);
  });
  test("empty stack still carries the migration token", () => {
    expect([...makeStack([], []).tokens]).toEqual(["migration"]);
  });
});

describe("detectStack", () => {
  test("detects a TS server + react/tanstack clients from deps", () => {
    const r = detectStack(probe(["@metaobjectsdev/cli", "@metaobjectsdev/react", "@metaobjectsdev/tanstack"], ["package.json"]));
    expect(r.servers).toEqual(["typescript"]);
    expect(r.clients.sort()).toEqual(["react", "tanstack"]);
  });
  test("detects a Java server + react client (the polyglot case)", () => {
    const r = detectStack(probe(["@metaobjectsdev/react"], ["pom.xml"]));
    expect(r.servers).toEqual(["java"]);
    expect(r.clients).toEqual(["react"]);
  });
  test("detects kotlin via gradle, csharp via csproj, python via pyproject", () => {
    expect(detectStack(probe([], ["build.gradle.kts"])).servers).toEqual(["kotlin"]);
    expect(detectStack(probe([], ["Api.csproj"])).servers).toEqual(["csharp"]);
    expect(detectStack(probe([], ["pyproject.toml"])).servers).toEqual(["python"]);
  });
});

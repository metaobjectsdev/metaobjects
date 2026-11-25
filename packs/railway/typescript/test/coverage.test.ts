// The emitter's acceptance bar: the generated `.railway/railway.ts` carries every fact the
// adopters' hand-written Railway configuration carries, checked fact by fact. The references
// below are those facts with the adopters' names replaced by the fixtures' placeholders: a
// hand-migrated `.railway/railway.ts` for the one-service shape, and two `railway.json` files
// (watch patterns; the Dockerfile path came from a service variable) for the two-service shape.
// The generated file is evaluated through a recording stand-in for `railway/iac`, so the
// check reads what the file declares, not how it is laid out. More facts than these (domains,
// health checks, variables) are allowed: that is where the generated file does better.
import { describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

mock.module("railway/iac", () => ({
  defineRailway: (fn: unknown) => fn,
  project: (name: string, o: object) => ({ name, ...o }),
  service: (name: string, o: object) => ({ name, ...o }),
  github: (repo: string, o: object = {}) => ({ type: "github", repo, ...o }),
  image: (ref: string) => ({ type: "image", image: ref }),
  preserve: () => ({ preserve: true }),
}));

const GOLDEN = join(import.meta.dir, "golden");

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** Every fact of `expected` (a leaf, by its path) that `actual` lacks or holds differently. */
function missing(expected: Json, actual: unknown, path = ""): string[] {
  if (expected === null || typeof expected !== "object") {
    return Object.is(expected, actual) ? [] : [`${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`];
  }
  if (Array.isArray(expected)) {
    // A list is one fact: watch patterns are ordered (a later exclusion wins).
    return JSON.stringify(expected) === JSON.stringify(actual) ? [] : [`${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`];
  }
  if (actual === null || typeof actual !== "object") return [`${path}: missing`];
  return Object.entries(expected).flatMap(([k, v]) => missing(v, (actual as Record<string, unknown>)[k], `${path}.${k}`));
}

async function evaluate(scenario: string, environment: string): Promise<{ partial: string; project: Record<string, unknown> }> {
  // The golden file, imported from a copy so "railway/iac" resolves to the stand-in.
  const dir = mkdtempSync(join(process.env.DEV_SCRATCH ?? tmpdir(), "railway-coverage-"));
  try {
    const file = join(dir, "railway.ts");
    writeFileSync(file, await Bun.file(join(GOLDEN, scenario, ".railway/railway.ts")).text());
    const m = (await import(file)) as { partial: string; default: (ctx: { environment: string }) => Record<string, unknown> };
    return { partial: m.partial, project: m.default({ environment }) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function serviceNamed(project: Record<string, unknown>, name: string): unknown {
  return (project["resources"] as { name: string }[]).find((s) => s.name === name);
}

describe("the generated file carries every fact of the hand-written configuration", () => {
  test("one service: the hand-migrated .railway/railway.ts", async () => {
    const { partial, project } = await evaluate("railway-emit-one-service", "production");
    expect(partial).toBe("game");
    expect(missing({ name: "game", variables: { managed: false } }, project)).toEqual([]);
    expect(
      missing(
        {
          source: { type: "github", repo: "acme/game", branch: "main", checkSuites: false },
          build: {
            watchPatterns: ["**", "!/.archive/**", "!/.claude/**", "!/.docs/**", "!/.github/**", "!/.githooks/**", "!/.metaobjects/*.md", "!/.metaobjects/.agent-context.json", "!/.specify/**", "!/.test-prompts/**", "!/assets/**", "!/docs/**", "!/e2e-tests/**", "!/scripts/**", "!/*.md", "!/TODOs"],
          },
          deploy: { healthcheckPath: "/actuator/health/container", healthcheckTimeout: 300, restartPolicyType: "ON_FAILURE", drainingSeconds: 180 },
        },
        serviceNamed(project, "game"),
      ),
    ).toEqual([]);
  });

  test("two services: each railway.json, and the Dockerfile path its service variable held", async () => {
    const { project } = await evaluate("railway-emit-two-services", "production");
    expect(missing({ build: { watchPatterns: ["arena/**", "!arena/tests/**", "!metaobjects/**"], dockerfilePath: "arena/Dockerfile" } }, serviceNamed(project, "arena"))).toEqual([]);
    expect(missing({ build: { watchPatterns: ["java/**", "poker/**", "framework/**"], dockerfilePath: "java/Dockerfile" } }, serviceNamed(project, "java"))).toEqual([]);
  });

  test("an environment the model does not deploy to is refused, not given a guess", async () => {
    await expect(evaluate("railway-emit-one-service", "staging")).rejects.toThrow('deploys nothing to environment "staging"');
  });
});

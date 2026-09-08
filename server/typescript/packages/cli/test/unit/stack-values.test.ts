// A stack value that names nothing is REFUSED, not dropped.
//
// `--server node` — the CLI's own help example — exited 0 with no warning and recorded
// `"servers": []`. The missing four reference fragments were the small half. The large half is
// that a NON-EMPTY override array suppresses both the prior manifest's stack AND detection, so
// the scaffolded agent context then declared "Stack: no server, no client" and told the agent
// this project has no `metaobjects.config.ts` — about a project with a Fastify server, a React
// client, and the very config file the same CLI had just read to run `meta gen`. One silently
// dropped flag value made three statements false in the artifact whose whole job is to orient
// an agent correctly.
import { describe, test, expect } from "bun:test";
import { assertKnownStackValues, resolveStack } from "../../src/lib/detect-stack.js";

describe("stack value validation", () => {
  test("an unknown --server is refused, and the message names the vocabulary", () => {
    expect(() => assertKnownStackValues({ servers: ["klingon"], clients: [] }))
      .toThrow(/unknown stack value.*--server klingon.*typescript, java, kotlin, csharp, python/s);
  });

  test("an unknown --client is refused too", () => {
    expect(() => assertKnownStackValues({ servers: [], clients: ["vue"] }))
      .toThrow(/--client vue.*react, tanstack, angular/s);
  });

  test("`node` is ACCEPTED as an alias for typescript — the help text's own example", () => {
    expect(() => assertKnownStackValues({ servers: ["node"], clients: [] })).not.toThrow();
  });

  test("canonical values pass unchanged", () => {
    expect(() => assertKnownStackValues({
      servers: ["typescript", "java", "kotlin", "csharp", "python"],
      clients: ["react", "tanstack", "angular"],
    })).not.toThrow();
  });

  test("case and surrounding space do not decide whether a value is known", () => {
    expect(() => assertKnownStackValues({ servers: [" Node ", "TypeScript"], clients: [] }))
      .not.toThrow();
  });

  test("...and the alias resolves to the canonical language, not to nothing", async () => {
    // The half that actually cost the estate its four reference fragments: being accepted is
    // not the same as being RESOLVED. `node` must land as `typescript`.
    const stack = await resolveStack(process.cwd(), { servers: ["node"], clients: [] });
    expect(stack.servers).toContain("typescript");
  });
});

// The guard has to sit in the SHARED function, not at one CLI entry point.
//
// It was at `initCommand`'s arg parse only, and `meta agent-docs` calls `init()` directly:
// `meta init --docs-only --server klingon` exited 2 with the message, while
// `meta agent-docs --server klingon` exited 0, reported "Scaffolded … (11 files)" and
// wrote `"servers": []` into the manifest. That is the worse door to miss — index.ts
// labels `agent-docs` the "canonical redirect target for all language ports", so the four
// non-TS ports were the ones using the unguarded one.
describe("every door refuses an unknown stack value", () => {
  test("init() itself refuses, so a programmatic caller cannot bypass it", async () => {
    const { init } = await import("../../src/commands/init.js");
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "stack-guard-"));
    try {
      await expect(init({ cwd: dir, servers: ["klingon"], docsOnly: true })).rejects.toThrow(/klingon/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test("meta agent-docs refuses it too, and writes nothing", async () => {
    const { run } = await import("../../src/index.js");
    const { mkdtemp, rm, readdir } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "stack-guard-cli-"));
    const orig = console.error;
    const lines: string[] = [];
    console.error = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
    try {
      const exit = await run(["agent-docs", "--server", "klingon", "--out", dir]);
      expect(exit).not.toBe(0);
      expect(lines.join("\n")).toContain("klingon");
      // Nothing scaffolded: the refusal lands before any write, as it does for init.
      expect(await readdir(dir)).toEqual([]);
    } finally {
      console.error = orig;
      await rm(dir, { recursive: true, force: true });
    }
  });
});

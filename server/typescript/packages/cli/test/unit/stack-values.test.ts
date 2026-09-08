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

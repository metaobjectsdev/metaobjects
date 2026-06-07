import { test, expect, describe } from "bun:test";
import { parseInitArgs } from "../../src/lib/args.js";

describe("parseInitArgs — stack flags", () => {
  test("repeatable --server / --client and --no-skills", () => {
    const f = parseInitArgs(["--server", "java", "--server", "kotlin", "--client", "react", "--client", "tanstack", "--no-skills"]);
    expect(f.servers).toEqual(["java", "kotlin"]);
    expect(f.clients).toEqual(["react", "tanstack"]);
    expect(f.noSkills).toBe(true);
    expect(f.wireRoot).toBe(true);
  });
  test("defaults: empty server/client overrides, skills on, root wiring on", () => {
    const f = parseInitArgs([]);
    expect(f.servers).toEqual([]);
    expect(f.clients).toEqual([]);
    expect(f.noSkills).toBe(false);
    expect(f.wireRoot).toBe(true);
  });
  test("--no-wire-root opts out of root wiring", () => {
    expect(parseInitArgs(["--no-wire-root"]).wireRoot).toBe(false);
  });
});

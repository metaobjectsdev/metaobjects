// #357 — `meta types` is the vocabulary search the generated `.metaobjects/AGENTS.md` and
// the `metaobjects-authoring` skill both make STEP 1 of the authoring procedure, on the
// reasoning that you must search the vocabulary before concluding something cannot be
// expressed. It under-reported the registry two ways at once, so following the documented
// procedure produced a confidently wrong answer:
//
//   1. It read `buildRegistryManifest`, whose job is the byte-gated FIVE-PORT contract.
//      That deliberately carves out the 13 TS-web-presentation `view.*` controls (B-2),
//      which stay REGISTERED in TypeScript. So 9 of 10 authorable view subtypes reported
//      exactly as a genuine typo does: `meta types view.text` → "No vocabulary matches".
//   2. It composed the registry with `registerCoreTypes` alone rather than
//      `composeRegistry(coreProviders)`, so every attr the db / ui-web / documentation
//      providers register was invisible — `field.string` with 6 attrs instead of 16, and
//      NO commonAttrs at all, which is why `meta types title` found nothing for the very
//      attr #353 should have been answered with.
//
// These assert the tool's ANSWER, not its internals: each is a question an author asks.

import { describe, test, expect, spyOn } from "bun:test";
import { typesCommand } from "../src/commands/types.js";

/** Run `meta types ...`, expecting a non-zero exit, and return what it printed to stderr. */
async function runExpectingUsageError(args: string[]): Promise<number> {
  const spy = spyOn(console, "error").mockImplementation(() => {});
  try {
    return await typesCommand(args);
  } finally {
    spy.mockRestore();
  }
}

/** Run `meta types ...` and return everything it printed to stdout. */
async function run(args: string[]): Promise<string> {
  const lines: string[] = [];
  const spy = spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    lines.push(a.map(String).join(" "));
  });
  try {
    expect(await typesCommand(args)).toBe(0);
  } finally {
    spy.mockRestore();
  }
  return lines.join("\n");
}

describe("#357 every registered view subtype is findable", () => {
  test("a named lookup of a TS-only control resolves", async () => {
    // The issue's headline repro: this printed "No vocabulary matches \"view.text\"".
    const out = await run(["view.text"]);
    expect(out).toContain("view.text");
    expect(out).not.toContain("No vocabulary matches");
  });

  test("listing the type reports all 15 registered subtypes, not 2", async () => {
    const out = await run(["--type", "view", "--kind", "subtype", "--limit", "0"]);
    for (const sub of [
      "base", "text", "textarea", "date", "month", "hotlink", "dropdown", "radio",
      "checkbox", "number", "password", "hidden", "web", "currency", "image",
    ]) {
      expect(out).toContain(`view.${sub}`);
    }
    expect(out).toContain("15 matches.");
  });

  test("a control the loader rejects is still reported missing", async () => {
    // The fix must not make the tool answer "yes" to everything: an unregistered
    // subtype has to stay indistinguishable from a typo, because it IS one.
    expect(await run(["view.bogusxyz"])).toContain("No vocabulary matches");
  });

  test("TS-only vocabulary is marked rather than hidden", async () => {
    const out = await run(["--type", "view", "--kind", "subtype", "--limit", "0"]);
    // `view.currency` is in the cross-port contract; `view.text` is not.
    expect(out).toMatch(/view\.text .*\[ts-only\]/);
    expect(out).not.toMatch(/view\.currency .*\[ts-only\]/);
    expect(out).toContain("cross-port metamodel contract does not carry it");
  });

  test("a type's shared root is marked, so the concrete list is not mistaken for it", async () => {
    expect(await run(["--type", "view", "--kind", "subtype", "--limit", "0"]))
      .toMatch(/view\.base .*\[base\]/);
  });
});

describe("#357 the registry is COMPOSED, so attrs are not missing", () => {
  test("a db-provider attr on a core type is findable", async () => {
    // @filterable/@column are registered by the db provider onto field.*; with only
    // registerCoreTypes they did not exist as far as this command was concerned.
    const out = await run(["field.string", "--limit", "0"]);
    expect(out).toContain("@filterable");
    expect(out).toContain("@column");
    expect(out).toContain("@dbColumnType");
  });

  test("a ui-web-provider attr is findable", async () => {
    expect(await run(["view.textarea", "--limit", "0"])).toContain("@rows");
  });

  test("@title — the attr #353 should have found — is findable by name", async () => {
    const out = await run(["title"]);
    expect(out).toContain("@title");
    expect(out).not.toContain("No vocabulary matches");
  });

  test("a common attr is not hidden by a --type scope", async () => {
    // @title is accepted on every node, so scoping to one type must not exclude it.
    expect(await run(["--type", "view", "title"])).toContain("@title");
  });

  test("reserved structural keys are NOT offered as attrs", async () => {
    // `isArray`/`extends` are bare structural keys; `@`-prefixing one is ERR_RESERVED_ATTR,
    // so listing them would teach metadata the loader rejects.
    const out = await run(["--kind", "attr", "--limit", "0", "isArray"]);
    expect(out).toContain("No vocabulary matches");
  });
});

describe("the help describes flags the CLI actually accepts", () => {
  test("--json is neither advertised nor accepted", async () => {
    // It was advertised twice while the CLI refused it: `--format` is validated once,
    // globally, and a bare `--json` is rejected before a command sees its args, so the
    // branch behind the flag was unreachable and the help described a usage error.
    const help = await run(["--help"]);
    expect(help).not.toContain("--json");
    expect(await runExpectingUsageError(["--json"])).toBe(2);
  });

  test("every flag the help lists is accepted", async () => {
    const help = await run(["--help"]);
    const advertised = [...help.matchAll(/^ {2}(--[a-z-]+)/gm)].map((m) => m[1] as string);
    expect(advertised.length).toBeGreaterThan(4);
    for (const flag of advertised) {
      // Each value-taking flag gets a valid value of its own kind; `--limit 1` also keeps
      // this from dumping the whole registry to stdout on every run.
      const value = flag === "--limit" ? "1" : flag === "--type" ? "view" : "subtype";
      const args = ["--kind", "--type", "--limit"].includes(flag) ? [flag, value] : [flag];
      expect(await typesCommand(flag === "--help" ? ["--help"] : args)).toBe(0);
    }
  });
});

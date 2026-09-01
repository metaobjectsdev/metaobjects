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
import { decode } from "@toon-format/toon";

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

// `meta types` is the vocabulary search an agent is told to run FIRST, and it printed only
// human text — so the one caller the command was designed for had to scrape padded columns,
// a legend and an "N of M shown" footer to find out whether `@intValueMap` exists. It now
// honors the global `--format`, and the contract that makes that worth anything is stdout
// PURITY: one document, nothing else, or `| jq` dies on the sentence in front of it.
describe("meta types --format", () => {
  /** Every console.log call `meta types` made, as separate entries. */
  async function stdoutCalls(args: string[], fmt?: "json" | "toon" | "text"): Promise<string[]> {
    const calls: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      calls.push(a.map(String).join(" "));
    });
    try {
      expect(await typesCommand(args, fmt)).toBe(0);
    } finally {
      spy.mockRestore();
    }
    return calls;
  }

  async function json(args: string[]): Promise<any> {
    const calls = await stdoutCalls(args, "json");
    // ONE document. A legend line, a count footer or a "no matches" hint alongside it is
    // the defect: each is a second thing on stdout, and none of them is JSON.
    expect(calls).toHaveLength(1);
    return JSON.parse(calls[0] as string);
  }

  test("the default is TEXT, not the TTY-aware global default", async () => {
    // Deliberately unlike gen/verify/migrate, which default to TOON off a TTY. This
    // command's text output is ALREADY the agent-tuned rendering, and every existing
    // scripted caller pipes it — flipping the default would silently break all of them.
    const calls = await stdoutCalls(["view.text"]);
    expect(calls.join("\n")).toContain("view.text");
    expect(() => JSON.parse(calls.join("\n"))).toThrow();
  });

  test("json emits one document whose matches carry the whole record", async () => {
    const doc = await json(["view.textarea", "--limit", "0"]);
    expect(doc.total).toBeGreaterThan(0);
    const subtype = doc.matches.find((m: any) => m.name === "view.textarea");
    expect(subtype.kind).toBe("subtype");
    expect(subtype.description.length).toBeGreaterThan(0);
    // @rows is registered by the ui-web provider; its presence is what proves the
    // COMPOSED registry (#357) reaches the structured payload too.
    expect(subtype.attrs.map((a: any) => a.name)).toContain("rows");
  });

  test("the legend's markers become FIELDS, not text appended to a name", async () => {
    const doc = await json(["--type", "view", "--kind", "subtype", "--limit", "0"]);
    const byName = (n: string) => doc.matches.find((m: any) => m.name === n);
    expect(byName("view.text").tsOnly).toBe(true);
    expect(byName("view.currency").tsOnly).toBe(false);
    expect(byName("view.base").sharedRoot).toBe(true);
    // And no row smuggles the text rendering's markers into its name.
    for (const m of doc.matches) expect(m.name).not.toContain("[ts-only]");
  });

  test("a closed-enum attr carries its allowed values", async () => {
    // The single most useful thing a structured answer can carry and a terse line cannot:
    // not just "@generation exists" but which values the loader accepts.
    const doc = await json(["identity.primary", "--limit", "0"]);
    const gen = doc.matches.find((m: any) => m.name === "identity.primary @generation");
    expect(gen.allowedValues).toContain("increment");
  });

  test("no match is an empty document, never a prose hint", async () => {
    const doc = await json(["view.bogusxyz"]);
    expect(doc.total).toBe(0);
    expect(doc.matches).toEqual([]);
  });

  test("--limit is a TEXT display cap and never truncates the payload", async () => {
    // The global --help promises exactly this for gen; it has to be true here too.
    const doc = await json(["--type", "view", "--kind", "subtype", "--limit", "2"]);
    expect(doc.total).toBe(15);
    expect(doc.matches).toHaveLength(15);
  });

  test("--detail is a TEXT flag too: the payload always carries the full record", async () => {
    const terse = await json(["view.month"]);
    const detail = await json(["view.month", "--detail"]);
    expect(terse).toEqual(detail);
  });

  test("--no-headers is a TEXT flag: it cannot change the document", async () => {
    expect(await json(["view.month"])).toEqual(await json(["view.month", "--no-headers"]));
  });

  test("toon emits one decodable document with the same content", async () => {
    const calls = await stdoutCalls(["view.month"], "toon");
    expect(calls).toHaveLength(1);
    const doc = decode(calls[0] as string) as any;
    expect(doc.total).toBe(1);
  });

  test("a usage error is a structured refusal, not an empty stdout", async () => {
    const calls: string[] = [];
    const outSpy = spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      calls.push(a.map(String).join(" "));
    });
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await typesCommand(["--nope"], "json")).toBe(2);
    } finally {
      outSpy.mockRestore();
      errSpy.mockRestore();
    }
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0] as string).error).toContain("--nope");
  });

  test("--help stays human text in every format", async () => {
    // Help is prose by definition; rendering it as a JSON string would help nobody.
    const calls = await stdoutCalls(["--help"], "json");
    expect(calls.join("\n")).toContain("meta types [QUERY]");
  });
});

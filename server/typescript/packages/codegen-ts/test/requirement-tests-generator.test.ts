// FR-038 §5/§6 — the generator, and the seams that keep policy in the app.
//
// The rule these tests encode: if an application can hit a decision and cannot
// change it, that decision becomes a bug report against this package. Every
// default below has an override, and each override is pinned here.

import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { requirementTests } from "../src/generators/requirement-tests.js";
import type { RequirementTestsOpts } from "../src/generators/requirement-tests.js";
import type { EmittedFile, GenContext } from "../src/generator.js";
import type { RequirementTestArgs } from "../src/templates/requirement-test.js";

const MODEL = {
  "metadata.root": {
    package: "acme::probe",
    children: [
      {
        "object.entity": {
          name: "Council",
          children: [
            { "field.long": { name: "id" } },
            {
              "field.string": {
                name: "slug",
                children: [{ "view.text": { name: "display" } }],
              },
            },
            { "source.rdb": { "@table": "councils" } },
            { "identity.primary": { name: "pk", "@fields": ["id"] } },
          ],
        },
      },
      {
        "requirement.functional": {
          name: "links",
          "@level": 3,
          "@status": "live",
          "@statement": "Links are shareable.",
          "@counterexample": "an opaque id in the URL",
          children: [
            {
              "requirement.functional": {
                name: "slugField",
                "@level": 4,
                "@status": "live",
                "@statement": "A council has a human-readable slug.",
                "@counterexample": "a council with no slug",
                "@implementedBy": ["Council", "Council.slug", "Council.slug.display"],
              },
            },
          ],
        },
      },
    ],
  },
};

async function emit(
  opts: RequirementTestsOpts = {},
  warn: (m: string) => void = () => {},
): Promise<EmittedFile[]> {
  const r = await new MetaDataLoader().load([
    new InMemoryStringSource(JSON.stringify(MODEL)),
  ]);
  if (r.errors.length > 0) {
    throw new Error(`Loader errors:\n${r.errors.map((e) => e.message).join("\n")}`);
  }
  const ctx = {
    entities: [],
    loadedRoot: r.root,
    matches: () => true,
    config: {},
    warn,
  } as unknown as GenContext;
  return (await requirementTests(opts).generate(ctx)) as EmittedFile[];
}

describe("requirementTests — fan-out", () => {
  test("emits one file per distinct concern, not one per target", async () => {
    const files = await emit();
    expect(files.map((f) => f.path).sort()).toEqual([
      "requirements/links.slugField.field.string.test.ts",
      "requirements/links.slugField.object.entity.test.ts",
      "requirements/links.slugField.view.text.test.ts",
    ]);
  });
});

describe("requirementTests — policy belongs to the app", () => {
  test("the DEFAULT filter excludes L3, which is below the link floor", async () => {
    const files = await emit();
    expect(files.some((f) => f.path.startsWith("requirements/links.test"))).toBe(false);
  });

  test("a widened filter covers L3 as a single no-concern stub", async () => {
    // The owner's case: an app may want L3 tested. L3 cannot carry @implementedBy,
    // so without the no-target degradation this would silently emit nothing.
    const files = await emit({ filter: () => true });
    expect(files.some((f) => f.path === "requirements/links.test.ts")).toBe(true);
  });

  test("a filter matching nothing emits nothing — 'no tests' is a legal policy", async () => {
    expect(await emit({ filter: () => false })).toEqual([]);
  });
});

describe("requirementTests — override seams", () => {
  test("an exact-concern renderer wins over the default", async () => {
    const files = await emit({ renderers: { "object.entity": () => "CUSTOM" } });
    expect(files.find((f) => f.path.includes("object.entity"))?.content).toBe("CUSTOM");
  });

  test("a wildcard renderer matches by type", async () => {
    const files = await emit({ renderers: { "view.*": () => "WILDCARD" } });
    expect(files.find((f) => f.path.includes("view.text"))?.content).toBe("WILDCARD");
  });

  test("exact beats wildcard", async () => {
    const files = await emit({
      renderers: { "view.*": () => "WILDCARD", "view.text": () => "EXACT" },
    });
    expect(files.find((f) => f.path.includes("view.text"))?.content).toBe("EXACT");
  });

  test("a resolver fn beats the map — key on anything, not just type.subType", async () => {
    const files = await emit({
      renderers: { "object.entity": () => "MAP" },
      resolveRenderer: () => () => "RESOLVER",
    });
    expect(files.every((f) => f.content === "RESOLVER")).toBe(true);
  });

  test("a custom path fn wins", async () => {
    const files = await emit({ path: (v, c) => `t/${v.path}__${c}.spec.ts` });
    expect(files.every((f) => f.path.startsWith("t/"))).toBe(true);
  });

  test("the generator name and target are the app's", async () => {
    const gen = requirementTests({ name: "req-api", target: "api-tests" });
    expect(gen.name).toBe("req-api");
    expect(gen.target).toBe("api-tests");
  });
});

describe("requirementTests — uncovered warning", () => {
  test("warns ONCE, naming requirements no filter covered", async () => {
    const seen: string[] = [];
    await emit({}, (m) => seen.push(m));
    expect(seen.length).toBe(1);
    expect(seen[0]).toContain("links");
  });

  test("the warning is suppressible", async () => {
    const seen: string[] = [];
    await emit({ warnUncovered: false }, (m) => seen.push(m));
    expect(seen).toEqual([]);
  });

  test("nothing uncovered means no warning at all", async () => {
    const seen: string[] = [];
    await emit({ filter: () => true }, (m) => seen.push(m));
    expect(seen).toEqual([]);
  });
});

describe("requirementTests — grain", () => {
  test('grain: "member" emits one file per reference', async () => {
    const files = await emit({ grain: "member" });
    // The last segment is the MANGLED reference, so a qualified reference can never
    // put "::" (or a path separator) into a filename.
    expect(files.map((f) => f.path).sort()).toEqual([
      "requirements/links.slugField.Council.test.ts",
      "requirements/links.slugField.Council_slug.test.ts",
      "requirements/links.slugField.Council_slug_display.test.ts",
    ]);
  });

  test("under member grain each stub is named for, and lists, its one reference", async () => {
    const files = await emit({ grain: "member" });
    const slug = files.find((f) => f.path.endsWith(".Council_slug.test.ts"))?.content ?? "";
    expect(slug).toContain('test("links.slugField [Council.slug]"');
    expect(slug).toContain(" *   - Council.slug  (field.string)");
    expect(slug).not.toContain("Council.slug.display");
  });

  test("a type-keyed renderer still applies under member grain", async () => {
    // The renderer map is keyed by what the reference RESOLVES to, in both grains —
    // otherwise switching grain would silently retire every renderer an app registered.
    const files = await emit({ grain: "member", renderers: { "field.*": () => "FIELD" } });
    expect(files.filter((f) => f.content === "FIELD").map((f) => f.path)).toEqual([
      "requirements/links.slugField.Council_slug.test.ts",
    ]);
  });

  test("the renderer receives the test identity, digest and witnessKey", async () => {
    const seen: RequirementTestArgs[] = [];
    const capture = (a: RequirementTestArgs): string => {
      seen.push(a);
      return "";
    };
    await emit({ grain: "member", renderers: { "*": capture } });
    const slug = seen.find((a) => a.unit === "Council.slug");
    expect(slug?.package).toBe("acme::probe");
    expect(slug?.id).toBe("acme::probe::links.slugField [Council.slug]");
    expect(slug?.witnessKey).toBe("req_acme_probe_links_slugField__Council_slug");
    expect(slug?.skip).toBeNull();
    expect(slug?.digest).toMatch(/^[0-9a-f]{64}$/);
    // One claim, so one digest: every test of a requirement carries the same one.
    expect(new Set(seen.map((a) => a.digest)).size).toBe(1);
  });

  test("the default grain hands the renderer the same record, keyed by concern", async () => {
    const seen: RequirementTestArgs[] = [];
    await emit({
      renderers: { "*": (a) => (seen.push(a), "") },
    });
    expect(seen.map((a) => [a.unit, a.concern, a.id, a.witnessKey])).toEqual([
      [
        "object.entity",
        "object.entity",
        "acme::probe::links.slugField [object.entity]",
        "req_acme_probe_links_slugField__object_entity",
      ],
      [
        "field.string",
        "field.string",
        "acme::probe::links.slugField [field.string]",
        "req_acme_probe_links_slugField__field_string",
      ],
      [
        "view.text",
        "view.text",
        "acme::probe::links.slugField [view.text]",
        "req_acme_probe_links_slugField__view_text",
      ],
    ]);
  });
});

describe("requirementTests — an unknown grain", () => {
  test("is refused when the generator is built, before anything is generated", () => {
    // `metaobjects.config.ts` is loaded without a typecheck. A typo used to take the
    // member grouping and the concern paths at once.
    const typo = { grain: "members" } as unknown as RequirementTestsOpts;
    expect(() => requirementTests(typo)).toThrow(
      'unknown requirement-test grain "members": expected "concern" or "member".',
    );
  });

  test("an absent grain is the default, not an error", async () => {
    expect((await emit({})).length).toBe(3);
  });
});

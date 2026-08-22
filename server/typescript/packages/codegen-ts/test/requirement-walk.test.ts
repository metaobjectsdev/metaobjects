// FR-038 — the requirement walk and its projected filter view.
//
// The projection is what downstream filters bind to. Handing over the raw node
// would export the ADR-0039 own-vs-resolving accessor trap to every adopter.

import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import type { MetaData } from "@metaobjectsdev/metadata";
import {
  walkRequirements,
  concernOf,
  groupByConcern,
  NO_CONCERN,
} from "../src/requirement-walk.js";

// The claimed nodes deliberately span THREE distinct types. A model whose targets
// are all one type cannot tell the per-type fan-out rule from the per-node rule
// apart — the same blindness that let the case-aligned `like` corpus pass for
// several releases.
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

async function load(): Promise<MetaData> {
  const r = await new MetaDataLoader().load([
    new InMemoryStringSource(JSON.stringify(MODEL)),
  ]);
  if (r.errors.length > 0) {
    throw new Error(`Loader errors:\n${r.errors.map((e) => e.message).join("\n")}`);
  }
  return r.root;
}

describe("walkRequirements", () => {
  test("walks nested requirements and builds dotted paths", async () => {
    const walked = walkRequirements(await load());
    expect(walked.map((w) => w.view.path)).toEqual(["links", "links.slugField"]);
  });

  test("projects subType, level and status", async () => {
    const walked = walkRequirements(await load());
    const child = walked.find((w) => w.view.path === "links.slugField");
    expect(child?.view.level).toBe(4);
    expect(child?.view.status).toBe("live");
    expect(child?.view.subType).toBe("functional");
  });

  test("resolves each target to its node and labels it with its concern", async () => {
    const walked = walkRequirements(await load());
    const child = walked.find((w) => w.view.path === "links.slugField");
    expect(child?.targets.map((t) => t.concern).sort()).toEqual([
      "field.string",
      "object.entity",
      "view.text",
    ]);
  });

  test("implementedByTypes is DISTINCT concerns, not one entry per target", async () => {
    const walked = walkRequirements(await load());
    const child = walked.find((w) => w.view.path === "links.slugField");
    expect([...(child?.view.implementedByTypes ?? [])].sort()).toEqual([
      "field.string",
      "object.entity",
      "view.text",
    ]);
  });

  test("an L3 requirement carries no targets — the link floor forbids them", async () => {
    const walked = walkRequirements(await load());
    expect(walked.find((w) => w.view.path === "links")?.targets).toEqual([]);
  });

  test("concernOf keys on type.subType", async () => {
    const root = await load();
    const council = root.children().find((c) => c.name === "Council");
    expect(concernOf(council as MetaData)).toBe("object.entity");
  });
});

describe("groupByConcern — the fan-out unit", () => {
  test("groups by DISTINCT concern, so three targets of three types give three groups", async () => {
    const walked = walkRequirements(await load());
    const child = walked.find((w) => w.view.path === "links.slugField");
    const groups = groupByConcern(child!);
    expect([...groups.keys()].sort()).toEqual([
      "field.string",
      "object.entity",
      "view.text",
    ]);
  });

  test("a requirement with no targets still yields exactly one group", async () => {
    // The link floor forbids @implementedBy below L4, so every L1-L3 requirement
    // resolves nothing. Emitting zero stubs there would make "cover L3" silently
    // impossible — the app's filter is the policy, not the target count.
    const walked = walkRequirements(await load());
    const groups = groupByConcern(walked.find((w) => w.view.path === "links")!);
    expect([...groups.keys()]).toEqual([NO_CONCERN]);
    expect(groups.get(NO_CONCERN)).toEqual([]);
  });

  test("targets sharing a concern collapse into one group, not one each", async () => {
    // Guards the per-TYPE rule against silently becoming per-NODE: two fields must
    // produce ONE field.string group carrying both.
    const root = await load();
    const walked = walkRequirements(root);
    const child = walked.find((w) => w.view.path === "links.slugField")!;
    const twoFields = {
      ...child,
      targets: [
        child.targets.find((t) => t.concern === "field.string")!,
        { ...child.targets.find((t) => t.concern === "field.string")!, ref: "Council.id" },
      ],
    };
    const groups = groupByConcern(twoFields);
    expect([...groups.keys()]).toEqual(["field.string"]);
    expect(groups.get("field.string")?.length).toBe(2);
  });
});

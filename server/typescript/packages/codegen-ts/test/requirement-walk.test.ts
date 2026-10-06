// FR-038 — the requirement walk and its projected filter view.
//
// The projection is what downstream filters bind to. Handing over the raw node
// would export the ADR-0039 own-vs-resolving accessor trap to every adopter.

import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import type { MetaData, MetaRequirement } from "@metaobjectsdev/metadata";
import {
  walkRequirements,
  concernOf,
  groupByConcern,
  NO_CONCERN,
  requirementDigest,
  witnessKeyOf,
  requirementTestUnits,
  requirementTestIdentities,
  witnessKeyCollisions,
} from "../src/requirement-walk.js";
import type { RequirementTestGrain } from "../src/requirement-walk.js";

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

// ---------------------------------------------------------------------------
// Test identity, digest and grain — the records the other four ports copy.
// ---------------------------------------------------------------------------

const ORDER = {
  "object.entity": {
    name: "Order",
    children: [
      { "field.long": { name: "id" } },
      { "field.currency": { name: "total" } },
      { "source.rdb": { "@table": "orders" } },
      { "identity.primary": { name: "pk", "@fields": ["id"] } },
    ],
  },
};

type Json = Record<string, unknown>;

const functional = (name: string, attrs: Json, children: Json[] = []): Json => ({
  "requirement.functional": {
    name,
    "@statement": "s",
    "@counterexample": "c",
    ...attrs,
    ...(children.length > 0 ? { children } : {}),
  },
});

/** The worked example of the plan's contract tables, exactly. */
const RECORDED = functional("Recorded", {
  "@level": 4,
  "@status": "live",
  "@statement": "An order is recorded when it is placed.",
  "@counterexample": "A placed order has no row.",
  "@implementedBy": ["Order"],
});
const REFUNDED = functional("Refunded", {
  "@level": 4,
  "@status": "planned",
  "@statement": "A refund is recorded against its order.",
  "@counterexample": "A refund with no order.",
});
const RECORDED_DIGEST = "2714aa3925a47959aa5e48ae39d80ed203fd4e2caa046a90aab9e04691d9881a";
const REFUNDED_DIGEST = "4ddcd781ccc2fe462bc316711d5cedb88b803af1727a0df19fe3a69487aa6f86";

const shop = (...requirements: Json[]): Json => ({
  "metadata.root": { package: "acme::shop", children: [ORDER, ...requirements] },
});

const WORKED_EXAMPLE = shop(
  functional("Orders", { "@level": 3, "@status": "live" }, [RECORDED, REFUNDED]),
);

async function loadDocs(...docs: Json[]): Promise<MetaData> {
  const r = await new MetaDataLoader().load(
    docs.map((d) => new InMemoryStringSource(JSON.stringify(d))),
  );
  if (r.errors.length > 0) {
    throw new Error(`Loader errors:\n${r.errors.map((e) => e.message).join("\n")}`);
  }
  return r.root;
}

async function requirementAt(doc: Json, path: string): Promise<MetaRequirement> {
  const found = walkRequirements(await loadDocs(doc)).find((w) => w.view.path === path);
  if (found === undefined) throw new Error(`no requirement at ${path}`);
  return found.node;
}

describe("requirementDigest — did the claim change", () => {
  test("the digest of the worked example is pinned", async () => {
    // functional, level 4, live, one ref "Order" — Table G
    const recorded = await requirementAt(WORKED_EXAMPLE, "Orders.Recorded");
    expect(requirementDigest(recorded)).toBe(
      "2714aa3925a47959aa5e48ae39d80ed203fd4e2caa046a90aab9e04691d9881a",
    );
  });

  test("a requirement with no links hashes an empty reference list", async () => {
    const refunded = await requirementAt(WORKED_EXAMPLE, "Orders.Refunded");
    expect(requirementDigest(refunded)).toBe(REFUNDED_DIGEST);
  });

  test("the digest ignores title, notes, disposition and trackedBy", async () => {
    const plain = functional("Gap", { "@level": 4, "@status": "partial" });
    const annotated = functional("Gap", {
      "@level": 4,
      "@status": "partial",
      "@title": "A title",
      "@notes": "Some notes.",
      "@disposition": "deferred",
      "@trackedBy": ["#42"],
    });
    const reworded = functional("Gap", {
      "@level": 4,
      "@status": "partial",
      "@statement": "a different claim",
    });
    const base = requirementDigest(await requirementAt(shop(plain), "Gap"));
    expect(requirementDigest(await requirementAt(shop(annotated), "Gap"))).toBe(base);
    // …and the comparison is not vacuous: a changed claim does move it.
    expect(requirementDigest(await requirementAt(shop(reworded), "Gap"))).not.toBe(base);
  });

  test("lengths in the digest are UTF-8 BYTE lengths, not character counts", async () => {
    // Every other digest in this file hashes ASCII, where the two agree. Here the
    // statement is 36 characters and 44 bytes, the counterexample 23 and 26.
    //
    // The expected value was computed without this code, in a shell:
    //   printf 'requirement-digest/v1\nsubType 10\nfunctional\nlevel 1\n4\nstatus 4\nlive\n
    //           statement 44\n<statement>\ncounterexample 26\n<counterexample>\n
    //           implementedBy 1\nref 5\nOrder\n' | sha256sum
    // with 44 and 26 taken from `printf %s "<value>" | wc -c`. The same recipe over the
    // worked example's text reproduces its pinned digest.
    const accented = functional("Exact", {
      "@level": 4,
      "@status": "live",
      "@statement": "Le total est exact — à l’euro près ✓",
      "@counterexample": "Un total arrondi à 10 €",
      "@implementedBy": ["Order"],
    });
    expect(requirementDigest(await requirementAt(shop(accented), "Exact"))).toBe(
      "ba64ffbaad8827f7c4692b49c083bfc8edc754d65690280f20f2257f3377a813",
    );
  });

  test("the digest normalises CRLF", async () => {
    const withBreak = (br: string): Json =>
      functional("Gap", {
        "@level": 4,
        "@status": "live",
        "@statement": `first${br}second`,
        "@counterexample": `one${br}two`,
      });
    const lf = requirementDigest(await requirementAt(shop(withBreak("\n")), "Gap"));
    expect(requirementDigest(await requirementAt(shop(withBreak("\r\n")), "Gap"))).toBe(lf);
    expect(requirementDigest(await requirementAt(shop(withBreak("\r")), "Gap"))).toBe(lf);
  });
});

describe("witnessKeyOf", () => {
  test("witness keys follow Table F", () => {
    expect(witnessKeyOf("acme::shop::Orders.Recorded", "object.entity"))
      .toBe("req_acme_shop_Orders_Recorded__object_entity");
    expect(witnessKeyOf("acme::shop::Orders.Recorded", "Order.total"))
      .toBe("req_acme_shop_Orders_Recorded__Order_total");
    expect(witnessKeyOf("acme::shop::Orders.Recorded", "*"))
      .toBe("req_acme_shop_Orders_Recorded");
  });

  test("a letter outside ASCII is replaced, not kept", () => {
    // The kept class is ASCII [A-Za-z0-9] and nothing else. A language's own notion of
    // a letter (`\w`, isalnum, isLetterOrDigit) keeps "é" and gives a different key in
    // each port. Every port carries this test with this value; the shared corpus cannot,
    // because the loaders are not known to agree on a name outside ASCII.
    //
    // "é" is written as the one code point U+00E9, so the result does not depend on how
    // this file was normalised. Run by run:
    //   acme  "::"->_  shop  "::"->_  Caf  "é."->_  R  "é"->_  gl  "é"->_
    // "é." is ONE run, so one underscore, and the final "é" leaves a trailing one. The
    // unit is "*", so there is no unit suffix.
    expect(witnessKeyOf("acme::shop::Café.Réglé", "*")).toBe("req_acme_shop_Caf_R_gl_");
  });
});

describe("the requirement view's package", () => {
  test("the view carries the effective package", async () => {
    // One requirement takes the file's default package, one declares its own.
    const root = await loadDocs(
      shop(
        functional("Local", { "@level": 4, "@status": "live" }),
        {
          "requirement.functional": {
            name: "Elsewhere",
            package: "acme::billing",
            "@level": 4,
            "@status": "live",
            "@statement": "s",
            "@counterexample": "c",
          },
        },
      ),
    );
    const packages = Object.fromEntries(
      walkRequirements(root).map((w) => [w.view.path, w.view.package]),
    );
    expect(packages).toEqual({ Local: "acme::shop", Elsewhere: "acme::billing" });
  });

  test("an unpackaged requirement has the empty package and a bare address", async () => {
    const root = await loadDocs({
      "metadata.root": {
        children: [functional("Bare", { "@level": 4, "@status": "live" })],
      },
    });
    expect(walkRequirements(root)[0]?.view.package).toBe("");
    const [only] = requirementTestIdentities(root);
    expect(only?.id).toBe("Bare [*]");
    expect(only?.witnessKey).toBe("req_Bare");
  });
});

describe("requirementTestIdentities — one record per generated test", () => {
  test("the worked example yields the records of Table F", async () => {
    expect(requirementTestIdentities(await loadDocs(WORKED_EXAMPLE))).toEqual([
      {
        package: "acme::shop",
        path: "Orders.Recorded",
        unit: "object.entity",
        id: "acme::shop::Orders.Recorded [object.entity]",
        witnessKey: "req_acme_shop_Orders_Recorded__object_entity",
        status: "live",
        skip: null,
        digest: RECORDED_DIGEST,
      },
      {
        package: "acme::shop",
        path: "Orders.Refunded",
        unit: "*",
        id: "acme::shop::Orders.Refunded [*]",
        witnessKey: "req_acme_shop_Orders_Refunded",
        status: "planned",
        skip: "planned",
        digest: REFUNDED_DIGEST,
      },
    ]);
  });

  // "Missing" does not resolve; "Order" is repeated; the qualified spelling names the
  // same entity as the bare one and is still a different reference AS AUTHORED.
  const MEMBERS = shop(
    functional("Recorded", {
      "@level": 4,
      "@status": "live",
      "@implementedBy": ["Order", "acme::shop::Order", "Order", "Missing", "Order.total"],
    }),
  );

  test("member grain yields one identity per distinct resolving reference", async () => {
    const tests = requirementTestIdentities(await loadDocs(MEMBERS), { grain: "member" });
    // Sorted by id, and in code units "." sorts before "]".
    expect(tests.map((t) => t.unit)).toEqual(["Order.total", "Order", "acme::shop::Order"]);
    expect(tests.map((t) => t.witnessKey)).toEqual([
      "req_acme_shop_Recorded__Order_total",
      "req_acme_shop_Recorded__Order",
      "req_acme_shop_Recorded__acme_shop_Order",
    ]);
    // The default grain fans the same requirement out by concern instead.
    expect(requirementTestIdentities(await loadDocs(MEMBERS)).map((t) => t.unit)).toEqual([
      "field.currency",
      "object.entity",
    ]);
  });

  test("a requirement with no resolved target yields unit *", async () => {
    // Nothing declared, and a planned requirement naming only nodes that do not exist.
    const root = await loadDocs(
      shop(
        functional("Unlinked", { "@level": 4, "@status": "live" }),
        functional("Ahead", { "@level": 4, "@status": "planned", "@implementedBy": ["NotYet"] }),
      ),
    );
    for (const grain of ["concern", "member"] as const) {
      expect(requirementTestIdentities(root, { grain }).map((t) => t.id)).toEqual([
        "acme::shop::Ahead [*]",
        "acme::shop::Unlinked [*]",
      ]);
    }
  });

  test("skip is derived from the status lists", async () => {
    const root = await loadDocs(
      shop(
        functional("A", { "@level": 4, "@status": "planned" }),
        functional("B", { "@level": 4, "@status": "live" }),
        functional("C", { "@level": 4, "@status": "partial" }),
        functional("D", { "@level": 4, "@status": "retired" }),
      ),
    );
    expect(requirementTestIdentities(root).map((t) => [t.path, t.status, t.skip])).toEqual([
      ["A", "planned", "planned"],
      ["B", "live", null],
      ["C", "partial", null],
      ["D", "retired", "retired"],
    ]);
  });

  test("identities come back sorted by id", async () => {
    // Declared out of order, and mixed-case on purpose: a code-unit comparison puts
    // every capital before every lower-case letter, where a locale collation would
    // interleave them — and a collation differs between machines and between ports.
    const root = await loadDocs(
      shop(
        functional("beta", { "@level": 4, "@status": "live" }),
        functional("Zeta", { "@level": 4, "@status": "live" }),
        functional("alpha", { "@level": 4, "@status": "live" }),
        functional("Beta", { "@level": 4, "@status": "live" }),
      ),
    );
    expect(requirementTestIdentities(root).map((t) => t.path)).toEqual([
      "Beta",
      "Zeta",
      "alpha",
      "beta",
    ]);
  });

  test("a filter replaces the default and its view carries the effective package", async () => {
    const root = await loadDocs(
      shop(functional("Orders", { "@level": 3, "@status": "live" }, [RECORDED])),
      {
        "metadata.root": {
          package: "acme::billing",
          children: [functional("Invoiced", { "@level": 4, "@status": "live" })],
        },
      },
    );
    const tests = requirementTestIdentities(root, {
      filter: (r) => r.package === "acme::shop",
    });
    // The L3 parent is IN — the default would have dropped it, so the predicate
    // replaced the default rather than narrowing it — and the other package is out.
    expect(tests.map((t) => t.id)).toEqual([
      "acme::shop::Orders [*]",
      "acme::shop::Orders.Recorded [object.entity]",
    ]);
  });
});

describe("an unknown grain is refused", () => {
  // A config file is loaded without a typecheck, so a typo reaches this code as a
  // plain string. Falling through to either grain would generate SOMETHING and say
  // nothing; half of each (one grain's grouping, the other's paths) is worse.
  const typo = "members" as unknown as RequirementTestGrain;
  const refusal = 'unknown requirement-test grain "members": expected "concern" or "member".';

  test("by requirementTestIdentities, even when the ledger is empty", async () => {
    const empty = await loadDocs(shop());
    expect(walkRequirements(empty)).toEqual([]);
    expect(() => requirementTestIdentities(empty, { grain: typo })).toThrow(refusal);
    const root = await loadDocs(WORKED_EXAMPLE);
    expect(() => requirementTestIdentities(root, { grain: typo })).toThrow(refusal);
  });

  test("by requirementTestUnits", async () => {
    const [first] = walkRequirements(await loadDocs(WORKED_EXAMPLE));
    expect(() => requirementTestUnits(first!, typo)).toThrow(refusal);
  });

  test("and a value of the wrong type is named as it was given", async () => {
    const root = await loadDocs(WORKED_EXAMPLE);
    expect(() =>
      requirementTestIdentities(root, { grain: 5 as unknown as RequirementTestGrain }),
    ).toThrow('unknown requirement-test grain 5: expected "concern" or "member".');
  });
});

describe("witnessKeyCollisions", () => {
  test("two addresses that mangle alike are reported as a collision", async () => {
    const root = await loadDocs(
      shop(
        functional("Orders_Recorded", { "@level": 4, "@status": "live", "@implementedBy": ["Order"] }),
        functional("Orders", { "@level": 3, "@status": "live" }, [RECORDED]),
      ),
    );
    const tests = requirementTestIdentities(root);
    expect(witnessKeyCollisions(tests)).toEqual([
      [
        "acme::shop::Orders.Recorded [object.entity]",
        "acme::shop::Orders_Recorded [object.entity]",
      ],
    ]);
  });

  test("distinct keys report nothing", async () => {
    const tests = requirementTestIdentities(await loadDocs(WORKED_EXAMPLE));
    expect(witnessKeyCollisions(tests)).toEqual([]);
  });
});

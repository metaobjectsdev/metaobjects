// `@implementedBy` — WHAT KIND OF NODE MAY BE CLAIMED.
//
// `implementedBy` is documented as "FQN references to the model nodes realising this
// requirement", and it resolved through the OBJECT resolver only. So a requirement could
// claim an entity, a value or a projection — and could not claim a `template.prompt`,
// even though a declared prompt is a model node realising a capability in exactly the
// same sense, and is arguably the node most in need of a status: a prompt that was
// retired, or replaced by a different one, is invisible in the model otherwise.
//
// Naming one produced ERR_REQUIREMENT_DANGLING_REF -- "the model moved and the
// requirement is stale" -- for a template sitting in the loaded tree.
//
// L4 therefore means "a declared top-level model node", not "an object". L5 still means
// a member of one. Coverage is untouched and stays entity-grain: claiming a template
// must not silence the unclaimed-entity warning.

import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDirectory } from "@metaobjectsdev/metadata";
import { checkRequirements } from "../src/lib/requirement-check.js";

/** A project with one value object, one prompt template, and the given requirement. */
function project(requirement: Record<string, unknown>, subType = "functional"): string {
  const dir = mkdtempSync(join(tmpdir(), "rtref-"));
  mkdirSync(join(dir, "metaobjects"), { recursive: true });
  writeFileSync(
    join(dir, "metaobjects", "meta.shop.json"),
    JSON.stringify({
      "metadata.root": {
        package: "acme::shop",
        children: [
          {
            "object.entity": {
              name: "Order",
              children: [
                { "field.uuid": { name: "id" } },
                {
                  "field.currency": {
                    name: "priceCents",
                    "@currency": "USD",
                    children: [
                      { "view.currency": { name: "display", "@locale": "en-US" } },
                      { "validator.length": { name: "bounded", "@min": 1, "@max": 12 } },
                    ],
                  },
                },
                { "identity.primary": { name: "pk", "@fields": ["id"] } },
              ],
            },
          },
          { "object.value": { name: "GreetPayload", children: [{ "field.string": { name: "who" } }] } },
          {
            "template.prompt": {
              name: "greeting",
              "@payloadRef": "acme::shop::GreetPayload",
              "@textRef": "greeting.md",
            },
          },
          { [`requirement.${subType}`]: requirement },
        ],
      },
    }),
  );
  return dir;
}

async function check(dir: string) {
  const res = await loadDirectory(join(dir, "metaobjects"));
  return checkRequirements(res.root);
}

const L4 = {
  name: "greets",
  "@level": 4,
  "@status": "live",
  "@statement": "The assistant greets the user by name.",
  "@violation": "A greeting addressed to nobody.",
};

describe("@implementedBy — templates are claimable model nodes", () => {
  test("a functional L4 may claim a template.prompt by FQN", async () => {
    const diags = await check(project({ ...L4, "@implementedBy": ["acme::shop::greeting"] }));
    expect(diags.filter((d) => d.severity === "error")).toEqual([]);
  });

  test("a bare reference binds package-locally, as it does for objects", async () => {
    const diags = await check(project({ ...L4, "@implementedBy": ["greeting"] }));
    expect(diags.filter((d) => d.severity === "error")).toEqual([]);
  });

  test("an architectural requirement may claim templates too", async () => {
    const diags = await check(
      project(
        {
          name: "promptsDeclareTheirPayload",
          "@status": "live",
          "@statement": "Every declared prompt names the payload it renders.",
          "@violation": "A prompt whose fields nobody can diff.",
          "@implementedBy": ["acme::shop::greeting"],
        },
        "architectural",
      ),
    );
    expect(diags.filter((d) => d.severity === "error")).toEqual([]);
  });

  test("a template that does NOT exist still dangles", async () => {
    const diags = await check(project({ ...L4, "@implementedBy": ["acme::shop::farewell"] }));
    expect(diags.filter((d) => d.severity === "error")).toHaveLength(1);
  });

  // Coverage is entity grain by design. If claiming a template counted, a project could
  // clear its unclaimed-entity warning without ever claiming an entity.
  test("claiming a template does not count toward entity coverage", async () => {
    const diags = await check(project({ ...L4, "@implementedBy": ["acme::shop::greeting"] }));
    const warns = diags.filter((d) => d.severity === "warn");
    expect(warns.some((d) => d.message.includes("Order"))).toBe(true);
  });
});

// L5 is documented as "a field, view or identity". A requirement about a specific
// FIELD ("money is stored in minor units"), a specific VIEW ("the grid renders this
// as currency"), or a specific VALIDATOR ("this is bounded") is the grain most claims
// about behaviour actually live at, so each is asserted here rather than assumed from
// the resolver walking child names generically.
const L5 = {
  name: "priceIsMoney",
  "@level": 5,
  "@status": "live",
  "@statement": "The order price is money and says so.",
  "@violation": "A price summed with a price of another currency.",
};

describe("@implementedBy — L5 member grains", () => {
  const cases: Array<[string, string]> = [
    ["a field", "acme::shop::Order.priceCents"],
    ["a view under a field", "acme::shop::Order.priceCents.display"],
    ["a validator under a field", "acme::shop::Order.priceCents.bounded"],
    ["an identity", "acme::shop::Order.pk"],
  ];
  for (const [label, ref] of cases) {
    test(`L5 may claim ${label}`, async () => {
      const diags = await check(project({ ...L5, "@implementedBy": [ref] }));
      expect(diags.filter((d) => d.severity === "error")).toEqual([]);
    });
  }

  test("a member that does not exist still dangles", async () => {
    const diags = await check(project({ ...L5, "@implementedBy": ["acme::shop::Order.nope"] }));
    expect(diags.filter((d) => d.severity === "error")).toHaveLength(1);
  });

  test("a member of a TEMPLATE resolves too", async () => {
    const diags = await check(project({ ...L5, "@implementedBy": ["acme::shop::greeting.tone"] }));
    expect(diags.filter((d) => d.severity === "error")).toHaveLength(1); // no such child yet
  });
});

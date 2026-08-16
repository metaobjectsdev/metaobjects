// `@verifiedBy` — WHAT COUNTS AS A TEST FILE.
//
// The scan used to carry one closed regex list of test-file conventions for the five
// ported ecosystems, and nothing could extend it. That list is a guess about someone
// else's project, and it was wrong on a mainstream case immediately: Maven Failsafe
// names integration tests `FooIT.java` / `FooIT.kt`, which matched nothing. Because the
// scan only fails OPEN when it sees ZERO test files, a JVM project with unit tests
// (matched) plus integration tests (unmatched) got a confident
// ERR_REQUIREMENT_TEST_MISSING — "the claim was never true" — for a test sitting in the
// repo.
//
// Two things are asserted here, and they are different claims:
//   1. the built-in defaults cover the conventions we ship support for, Failsafe included;
//   2. a project can DECLARE its own convention, because test naming is project-specific
//      and no built-in list can be authoritative about it.
//
// And the third, which is the real fix: when a named test cannot be found, the scan must
// distinguish "this name is nowhere" (a broken claim — error) from "this name is in a
// file I did not classify as a test" (an unknown convention — warn, and say so). Asserting
// the first when the second is true is the failure this file exists to prevent.

import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDirectory } from "@metaobjectsdev/metadata";
import {
  checkVerifiedBy,
  ERR_REQUIREMENT_TEST_MISSING,
  WARN_REQUIREMENT_TEST_UNCLASSIFIED,
} from "../src/lib/verified-by-scan.js";

const ENTITIES = JSON.stringify({
  "metadata.root": {
    package: "acme::shop",
    children: [
      {
        "object.entity": {
          name: "Order",
          children: [
            { "field.uuid": { name: "id" } },
            { "identity.primary": { name: "pk", "@fields": ["id"] } },
          ],
        },
      },
    ],
  },
});

const requirements = (verifiedBy: string[]) =>
  JSON.stringify({
    "metadata.root": {
      package: "acme::shop",
      children: [
        {
          "requirement.functional": {
            name: "orderRecord",
            "@level": 4,
            "@status": "live",
            "@statement": "An order is a durable record.",
            "@violation": "An order vanishes on restart.",
            "@implementedBy": ["Order"],
            "@verifiedBy": verifiedBy,
          },
        },
      ],
    },
  });

/** A project holding the given files, plus one requirement naming `verifiedBy`. */
function project(verifiedBy: string[], files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "vby-"));
  mkdirSync(join(dir, "metaobjects"), { recursive: true });
  writeFileSync(join(dir, "metaobjects", "meta.shop.json"), ENTITIES);
  writeFileSync(join(dir, "metaobjects", "meta.req.json"), requirements(verifiedBy));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body);
  }
  return dir;
}

async function scan(dir: string, testFiles?: string[]) {
  const res = await loadDirectory(join(dir, "metaobjects"));
  return checkVerifiedBy(res.root, dir, testFiles);
}

// A unit test that DOES match the built-in patterns, so the corpus is never empty and
// the fail-open-on-zero path is not what is being exercised.
const UNIT_TEST = "class PlacesOrderTest { void placesOrder() {} }";

describe("@verifiedBy — built-in conventions", () => {
  test("Maven Failsafe *IT.java counts as a test file", async () => {
    const dir = project(["OrderFlowIT"], {
      "src/test/java/OrderTest.java": UNIT_TEST,
      "src/test/java/OrderFlowIT.java": "class OrderFlowIT { void endToEnd() {} }",
    });
    expect(await scan(dir)).toEqual([]);
  });

  test("Maven Failsafe *IT.kt counts as a test file", async () => {
    const dir = project(["OrderFlowIT"], {
      "src/test/kotlin/OrderTest.kt": UNIT_TEST,
      "src/test/kotlin/OrderFlowIT.kt": "class OrderFlowIT { fun endToEnd() {} }",
    });
    expect(await scan(dir)).toEqual([]);
  });

  test("Failsafe *ITCase.java counts as a test file", async () => {
    const dir = project(["OrderFlowITCase"], {
      "src/test/java/OrderTest.java": UNIT_TEST,
      "src/test/java/OrderFlowITCase.java": "class OrderFlowITCase {}",
    });
    expect(await scan(dir)).toEqual([]);
  });

  test("a name that exists NOWHERE is still an error", async () => {
    const dir = project(["NoSuchTest"], { "src/test/java/OrderTest.java": UNIT_TEST });
    const diags = await scan(dir);
    expect(diags).toHaveLength(1);
    expect(diags[0]?.code).toBe(ERR_REQUIREMENT_TEST_MISSING);
  });
});

describe("@verifiedBy — project-declared conventions", () => {
  test("a project can declare a convention the built-ins do not know", async () => {
    const dir = project(["order_behaviour"], {
      "src/test/java/OrderTest.java": UNIT_TEST,
      // Nothing built-in matches this. The project says what its tests look like.
      "spec/order_behaviour.feature": "Scenario: order_behaviour",
    });
    expect(await scan(dir, ["**/*.feature"])).toEqual([]);
  });

  test("a declared convention ADDS to the built-ins rather than replacing them", async () => {
    const dir = project(["PlacesOrderTest"], {
      "src/test/java/PlacesOrderTest.java": UNIT_TEST,
      "spec/x.feature": "Scenario: unrelated",
    });
    expect(await scan(dir, ["**/*.feature"])).toEqual([]);
  });
});

describe("@verifiedBy — an unknown convention is not a broken claim", () => {
  // THE POINT OF THE WHOLE FILE. The name is right there in the repo. Reporting
  // "the claim was never true" is the tool being confidently wrong about a project
  // whose conventions it was never told.
  test("a name found in an unclassified file warns, and does not error", async () => {
    const dir = project(["OrderBehaviourSuite"], {
      "src/test/java/OrderTest.java": UNIT_TEST,
      "src/test/java/OrderBehaviourSuite.java": "class OrderBehaviourSuite { void placesOrder() {} }",
    });
    const diags = await scan(dir);
    expect(diags).toHaveLength(1);
    expect(diags[0]?.code).toBe(WARN_REQUIREMENT_TEST_UNCLASSIFIED);
    expect(diags[0]?.severity).toBe("warn");
  });

  test("the warning names the file it found, so the fix is obvious", async () => {
    const dir = project(["OrderBehaviourSuite"], {
      "src/test/java/OrderTest.java": UNIT_TEST,
      "src/test/java/OrderBehaviourSuite.java": "class OrderBehaviourSuite {}",
    });
    const [diag] = await scan(dir);
    expect(diag?.message).toContain("src/test/java/OrderBehaviourSuite.java");
  });

  test("declaring the convention clears the warning entirely", async () => {
    const dir = project(["OrderBehaviourSuite"], {
      "src/test/java/OrderTest.java": UNIT_TEST,
      "src/test/java/OrderBehaviourSuite.java": "class OrderBehaviourSuite {}",
    });
    expect(await scan(dir, ["**/*Suite.java"])).toEqual([]);
  });
});

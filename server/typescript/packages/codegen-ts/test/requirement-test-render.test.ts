// FR-038 §4 — red-stub semantics.
//
// The load-bearing rule: an empty generated stub must NOT pass. A `live` entry
// claims the capability works, so an empty green test asserts the opposite of the
// claim and recreates the original defect in a new place.

import { describe, test, expect } from "bun:test";
import { renderRequirementTest } from "../src/templates/requirement-test.js";
import type { RequirementTestArgs } from "../src/templates/requirement-test.js";

const base: RequirementTestArgs = {
  view: {
    subType: "functional",
    level: 4,
    status: "live",
    path: "links.slugField",
    implementedByTypes: [],
  },
  concern: "object.entity",
  statement: "A council has a human-readable slug.",
  violation: "a council with no slug",
  targets: [],
};

describe("renderRequirementTest", () => {
  test("a LIVE stub emits a failing assertion, never an empty body", () => {
    const src = renderRequirementTest(base);
    expect(src).toContain("expect.unreachable");
    expect(src).not.toContain("test.skip");
  });

  test("a PLANNED stub is skipped — a red build for something deliberately unbuilt is noise", () => {
    const src = renderRequirementTest({
      ...base,
      view: { ...base.view, status: "planned" },
    });
    expect(src).toContain("test.skip");
    expect(src).not.toContain("expect.unreachable");
  });

  test("a PARTIAL stub fails like live, and carries its disposition and tracking", () => {
    const src = renderRequirementTest({
      ...base,
      view: { ...base.view, status: "partial" },
      disposition: "deferred",
      trackedBy: ["#123"],
    });
    expect(src).toContain("expect.unreachable");
    expect(src).toContain("deferred");
    expect(src).toContain("#123");
  });

  test("the statement and the violation are both in the doc comment", () => {
    const src = renderRequirementTest(base);
    expect(src).toContain("A council has a human-readable slug.");
    expect(src).toContain("a council with no slug");
  });

  test("claimed refs are listed with their concerns", () => {
    const src = renderRequirementTest({
      ...base,
      targets: [
        { ref: "Council", concern: "object.entity", node: {} as never },
        { ref: "Council.slug", concern: "field.string", node: {} as never },
      ],
    });
    expect(src).toContain("Council.slug");
    expect(src).toContain("field.string");
  });

  test("says the body is hand-written — this file is NOT 'do not edit'", () => {
    // The identity is generated; the assertions are the author's and survive
    // regeneration through the three-way merge. A DO-NOT-EDIT header would tell
    // the one person who must edit it not to.
    const src = renderRequirementTest(base);
    expect(src).toContain("@generated");
    expect(src).not.toContain("DO NOT EDIT");
  });

  test("the test name carries both the requirement path and the concern", () => {
    const src = renderRequirementTest(base);
    expect(src).toContain("links.slugField");
    expect(src).toContain("object.entity");
  });
});

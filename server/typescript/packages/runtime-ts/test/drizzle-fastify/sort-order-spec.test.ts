// The precedence rule both fastify mounts share.
//
// Two mounts parse `?sort=` — the drizzle-fastify one and the plain ObjectManager one —
// and when @sortableDefaultOrder's read side first landed it landed in only the former,
// so one query string against one generated allowlist returned rows in different orders
// depending on which mount a project mounted. `sortOrderSpec` is now the single place
// that answers "which direction", so the two cannot drift.
//
// What this file pins hardest is the part that is easy to get wrong while fixing the
// above: the helper returns a RAW string, not a tidy `"asc" | "desc"`. A total-typed
// helper is the natural refactor, and it would silently accept `?sort=name:bogus` as
// ascending — turning a 400 both mounts emit today into a wrong-but-plausible page of
// results. Validation therefore stays with the callers, and these tests assert the raw
// passthrough that makes that possible.

import { describe, test, expect } from "bun:test";
import { sortOrderSpec, type SortAllowlist } from "../../src/drizzle-fastify/filter-allowlist.js";

const allowlist: SortAllowlist = {
  createdAt: { defaultOrder: "desc" },
  name: {},
};

describe("sortOrderSpec — caller order > declared @sortableDefaultOrder > asc", () => {
  test("an explicit order beats the declaration", () => {
    // The declaration fills in a MISSING direction; it never fights a present one.
    expect(sortOrderSpec(allowlist, "createdAt", "asc")).toBe("asc");
    expect(sortOrderSpec(allowlist, "createdAt", "desc")).toBe("desc");
  });

  test("no order supplied takes the declared one", () => {
    expect(sortOrderSpec(allowlist, "createdAt", undefined)).toBe("desc");
  });

  test("an undeclared field falls back to asc", () => {
    // And the fallback lives ONLY here, at the read — the allowlist artifact carries
    // declarations and nothing else, so `name` is `{}` rather than `{ defaultOrder:
    // "asc" }`. Spelling it in both places is how a port bakes in a different default.
    expect(sortOrderSpec(allowlist, "name", undefined)).toBe("asc");
    expect(allowlist.name).toEqual({});
  });

  test("a field absent from the allowlist entirely still answers asc", () => {
    // Callers gate on allowlist membership before asking for a direction; this is the
    // no-throw floor behind that gate, not a second permission check.
    expect(sortOrderSpec(allowlist, "notAllowlisted", undefined)).toBe("asc");
  });

  test("a MALFORMED supplied order passes through UNCHANGED so the caller can reject it", () => {
    // The regression this test exists to prevent: returning `"asc"` here would be
    // type-clean and total, and would quietly answer `?sort=name:sideways` with
    // ascending rows instead of the 400 both mounts are contracted to emit.
    expect(sortOrderSpec(allowlist, "createdAt", "sideways")).toBe("sideways");
    expect(sortOrderSpec(allowlist, "name", "DESC")).toBe("DESC");
    // Which is why both callers still normalize + validate after this call:
    expect(["asc", "desc"].includes(sortOrderSpec(allowlist, "createdAt", "sideways").toLowerCase())).toBe(false);
  });

  test("the declaration itself is not re-validated here", () => {
    // An allowlist is generated from `@sortableDefaultOrder`, whose registry entry is a
    // closed asc|desc enum enforced at LOAD time in all five ports. Re-checking it at the
    // read would be a second door over the same rule; a hand-built allowlist holding a
    // junk value passes through for the caller's validation to reject.
    expect(sortOrderSpec({ weird: { defaultOrder: "sideways" as never } }, "weird", undefined)).toBe("sideways");
  });
});

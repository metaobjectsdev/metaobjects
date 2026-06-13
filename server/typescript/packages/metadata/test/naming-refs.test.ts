// naming-refs.test.ts
//
// FR-026 (ADR-0032): unit tests for expandRef() — the single ref-expansion
// primitive used by the YAML desugar to lower an authored reference to its
// fully-qualified canonical form, and by isRelativeRef() (the JSON-input guard).
//
// expandRef implements the deterministic §2.1 rules — NO root fallback:
//   bare `Name`        → `<P>::Name`              (current package, only)
//   qualified `p::Name` → unchanged               (absolute from root)
//   `::Rest`           → strip the leading `::`    (absolute from root)
//   `..::Rest`         → drop one segment from P per `..::`, then resolve Rest
//                        (bare/qualified) against the reduced package
// A trailing FR-024 dotted child suffix (`.child`/`.child.grand`) on the ref is
// PRESERVED verbatim — only the OWNER part (before the first `.` of the final
// `::`-segment) is expanded.

import { describe, it, expect } from "bun:test";
import { expandRef, isRelativeRef } from "../src/naming-refs.js";

// ---------------------------------------------------------------------------
// bare name → current package
// ---------------------------------------------------------------------------

describe("expandRef — bare name → current package", () => {
  it("bare name in a packaged context", () => {
    expect(expandRef("Apple", "acme::fruit")).toBe("acme::fruit::Apple");
  });

  it("bare name in a single-segment package", () => {
    expect(expandRef("Target", "mypkg")).toBe("mypkg::Target");
  });

  it("bare name with empty package stays bare (root-level)", () => {
    expect(expandRef("Thing", "")).toBe("Thing");
  });
});

// ---------------------------------------------------------------------------
// qualified pkg::Name → absolute (unchanged)
// ---------------------------------------------------------------------------

describe("expandRef — qualified (contains '::') → absolute, unchanged", () => {
  it("a fully-qualified ref is returned verbatim", () => {
    expect(expandRef("acme::common::Base", "acme::fruit")).toBe("acme::common::Base");
  });

  it("a two-segment qualified ref is unchanged regardless of context", () => {
    expect(expandRef("other::X", "acme::fruit")).toBe("other::X");
  });

  it("a qualified ref with empty context is unchanged", () => {
    expect(expandRef("pkg::Name", "")).toBe("pkg::Name");
  });
});

// ---------------------------------------------------------------------------
// leading `::` → strip; remainder is absolute from root
// ---------------------------------------------------------------------------

describe("expandRef — leading '::' → strip to root", () => {
  it("::a::b::C ≡ a::b::C", () => {
    expect(expandRef("::a::b::C", "acme::fruit")).toBe("a::b::C");
  });

  it("::Apple → root-level Apple (bare, no package)", () => {
    expect(expandRef("::Apple", "acme::fruit")).toBe("Apple");
  });

  it("::other::X strips to other::X", () => {
    expect(expandRef("::other::X", "")).toBe("other::X");
  });
});

// ---------------------------------------------------------------------------
// `..::Rest` → reduce package, then resolve Rest
// ---------------------------------------------------------------------------

describe("expandRef — '..::' parent-relative", () => {
  it("..::veg::Carrot from acme::fruit → acme::veg::Carrot (qualified remainder is absolute under reduced pkg? no — qualified is absolute)", () => {
    // Per §2.1: drop one segment from P (acme::fruit → acme), then resolve the
    // remainder `veg::Carrot`. The remainder is itself qualified, so it appends
    // to the reduced package context as a bare-in-that-package resolution.
    expect(expandRef("..::veg::Carrot", "acme::fruit")).toBe("acme::veg::Carrot");
  });

  it("..::Shared from top::sub → top::Shared (bare remainder in reduced pkg)", () => {
    expect(expandRef("..::Shared", "top::sub")).toBe("top::Shared");
  });

  it("..::Base from a::b::c → a::b::Base (drop one)", () => {
    expect(expandRef("..::Base", "a::b::c")).toBe("a::b::Base");
  });

  it("..::common::id from demo::fruitbasket → demo::common::id", () => {
    expect(expandRef("..::common::id", "demo::fruitbasket")).toBe("demo::common::id");
  });

  it("two-level ..::..::shared::User from a::b::c → a::shared::User", () => {
    expect(expandRef("..::..::shared::User", "a::b::c")).toBe("a::shared::User");
  });

  it("two-level ..::..::Base from a::b::c → a::Base", () => {
    expect(expandRef("..::..::Base", "a::b::c")).toBe("a::Base");
  });

  it("three-level ..::..::..::Root from a::b::c::d → a::Root", () => {
    expect(expandRef("..::..::..::Root", "a::b::c::d")).toBe("a::Root");
  });

  it("drop ALL segments: ..::User from top → User (root-level after reducing the only segment)", () => {
    expect(expandRef("..::User", "top")).toBe("User");
  });

  it("over-drop (more '..::' than segments) → throws", () => {
    expect(() => expandRef("..::..::Anything", "singlelevel")).toThrow();
  });

  it("over-drop from empty package → throws", () => {
    expect(() => expandRef("..::Anything", "")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// dotted FR-024 child suffix preserved — only the owner part is expanded
// ---------------------------------------------------------------------------

describe("expandRef — dotted child suffix preserved", () => {
  it("bare owner with a child suffix: Customer.id → acme::sales::Customer.id", () => {
    expect(expandRef("Customer.id", "acme::sales")).toBe("acme::sales::Customer.id");
  });

  it("qualified owner with a child suffix is unchanged: acme::sales::Customer.id", () => {
    expect(expandRef("acme::sales::Customer.id", "acme::api")).toBe("acme::sales::Customer.id");
  });

  it("leading-:: owner with a child suffix strips: ::acme::sales::Customer.id → acme::sales::Customer.id", () => {
    expect(expandRef("::acme::sales::Customer.id", "x::y")).toBe("acme::sales::Customer.id");
  });

  it("grandchild suffix preserved: Customer.priceCents.display → demo::Customer.priceCents.display", () => {
    expect(expandRef("Customer.priceCents.display", "demo")).toBe("demo::Customer.priceCents.display");
  });

  it("parent-relative owner with a child suffix: ..::sales::Customer.id from acme::api → acme::sales::Customer.id", () => {
    expect(expandRef("..::sales::Customer.id", "acme::api")).toBe("acme::sales::Customer.id");
  });

  it("dotted relationship path head (@via): Program.weeks → demo::Program.weeks (head expanded, tail preserved)", () => {
    expect(expandRef("Program.weeks", "demo")).toBe("demo::Program.weeks");
  });
});

// ---------------------------------------------------------------------------
// isRelativeRef — leading `::` or `..::`
// ---------------------------------------------------------------------------

describe("isRelativeRef", () => {
  it("leading '::' is relative", () => {
    expect(isRelativeRef("::Apple")).toBe(true);
    expect(isRelativeRef("::a::b::C")).toBe(true);
  });

  it("leading '..::' is relative", () => {
    expect(isRelativeRef("..::Base")).toBe(true);
    expect(isRelativeRef("..::..::shared::User")).toBe(true);
  });

  it("bare and qualified are NOT relative", () => {
    expect(isRelativeRef("Apple")).toBe(false);
    expect(isRelativeRef("acme::common::Base")).toBe(false);
    expect(isRelativeRef("Customer.id")).toBe(false);
    expect(isRelativeRef("acme::sales::Customer.id")).toBe(false);
  });
});

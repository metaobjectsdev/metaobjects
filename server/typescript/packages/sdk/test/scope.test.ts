import { describe, test, expect } from "bun:test";
import { compileScope, matchesScope, type Scope } from "../src/scope.js";
import { errorCode } from "./support/error-code.js";

const match = (fqn: string, scope: Scope) => matchesScope(fqn, compileScope(scope));

describe("compileScope / matchesScope", () => {
  test("empty include matches everything", () => {
    expect(match("acme::commerce::Order", {})).toBe(true);
  });

  test("* matches exactly one segment", () => {
    const s: Scope = { include: ["acme::*"] };
    expect(match("acme::Order", s)).toBe(true);
    expect(match("acme::commerce::Order", s)).toBe(false);
  });

  test("** matches one or more segments", () => {
    const s: Scope = { include: ["acme::**"] };
    expect(match("acme::Order", s)).toBe(true);
    expect(match("acme::commerce::Order", s)).toBe(true);
    expect(match("acme", s)).toBe(false);
    expect(match("other::Order", s)).toBe(false);
  });

  test("* within a segment matches a partial name but never crosses ::", () => {
    const s: Scope = { include: ["acme::Order*"] };
    expect(match("acme::OrderLine", s)).toBe(true);
    expect(match("acme::Order", s)).toBe(true);
    expect(match("acme::deep::OrderLine", s)).toBe(false);
  });

  test("exclude is applied after include", () => {
    const s: Scope = { include: ["acme::**"], exclude: ["acme::internal::**"] };
    expect(match("acme::commerce::Order", s)).toBe(true);
    expect(match("acme::internal::Secret", s)).toBe(false);
  });

  test("exclude alone narrows the implicit match-everything", () => {
    const s: Scope = { exclude: ["acme::internal::**"] };
    expect(match("acme::commerce::Order", s)).toBe(true);
    expect(match("acme::internal::Secret", s)).toBe(false);
  });

  test("a bare name with no package is matchable", () => {
    expect(match("Order", { include: ["Order"] })).toBe(true);
    expect(match("Order", { include: ["*"] })).toBe(true);
  });

  test("regex metacharacters in a pattern are literal", () => {
    expect(match("acme::Order.v2", { include: ["acme::Order.v2"] })).toBe(true);
    expect(match("acme::OrderXv2", { include: ["acme::Order.v2"] })).toBe(false);
  });

  test("an empty pattern is ERR_SCOPE_PATTERN_INVALID", () => {
    let caught: unknown;
    try {
      compileScope({ include: [""] });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(errorCode(caught)).toBe("ERR_SCOPE_PATTERN_INVALID");
  });

  test("an empty segment is ERR_SCOPE_PATTERN_INVALID", () => {
    let caught: unknown;
    try {
      compileScope({ include: ["acme::::Order"] });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(errorCode(caught)).toBe("ERR_SCOPE_PATTERN_INVALID");
  });

  test("an odd colon run (malformed separator) is ERR_SCOPE_PATTERN_INVALID, not a silently-unmatchable pattern", () => {
    // "acme:::Order".split("::") => ["acme", ":Order"] — the leftover ":"
    // used to compile as a literal character into `^acme:::Order$`, a
    // regex no legal "::"-joined name can ever match. A typo'd include
    // pattern therefore silently scoped out EVERYTHING instead of failing
    // to load.
    let caught: unknown;
    try {
      compileScope({ include: ["acme:::Order"] });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(errorCode(caught)).toBe("ERR_SCOPE_PATTERN_INVALID");
  });

  test("a single stray colon (not the :: separator) is also ERR_SCOPE_PATTERN_INVALID", () => {
    let caught: unknown;
    try {
      compileScope({ include: ["acme:Order"] });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(errorCode(caught)).toBe("ERR_SCOPE_PATTERN_INVALID");
  });
});

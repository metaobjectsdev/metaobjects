import { describe, test, expect } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../../../../..");
const CHECKLIST = join(ROOT, "agent-context/skills/metaobjects-audit/references/capability-checklist.md");
const AUDIT_SKILL_ROOT = join(ROOT, "agent-context/skills/metaobjects-audit");
const REGISTRY = join(ROOT, "fixtures/registry-conformance/expected-registry.json");

// Subtypes the checklist may name as illustrative-but-cut/TS-only/planned — exempt from
// the "must be in the cross-port registry" rule (the checklist explicitly flags them).
const EXEMPT_SUBTYPES = new Set<string>([
  // cut stubs (named only to say "do NOT audit for them")
  "field.byte", "field.short", "field.class",
  // TS-only view widgets (not in the cross-port registry; flagged TS-only)
  "view.text", "view.textarea", "view.date", "view.month", "view.hotlink", "view.dropdown",
  "view.radio", "view.checkbox", "view.number", "view.password", "view.hidden", "view.web",
  // planned, not yet registered (flagged "not yet in the registry")
  "api.base", "api.operational", "operation.query", "operation.command", "binding.rest",
]);

// Tokens the audit skill deliberately names because they are anti-patterns it hunts.
// These are RETIRED or CUT forms — they appear in the audit skill's SKILL.md and
// references precisely so the auditor knows what bad patterns to look for in adopter code.
// They are NOT in the cross-port registry (they were renamed or removed).
const DELIBERATELY_NAMED_RETIRED_OR_CUT = new Set<string>([
  // retired pre-v2 source subtype (the audit skill names it as the anti-pattern;
  // the correct form is source.rdb + @kind — ADR-0007)
  "source.dbTable",
  // cut non-functional field stubs (same tokens as EXEMPT_SUBTYPES — listed here too
  // so the audit-skill-files scan can find them; the calibration note says "do NOT audit for them")
  "field.byte", "field.short", "field.class",
  // retired @attrs (pre-v2 renamed forms; the audit skill names them as what to grep for)
  "@dbColumn",  // renamed to @column (ADR-0007)
  "@name",      // pre-v2 source physical name; now @table on source.rdb
  // FR-038 (0.24.0) — retired requirement.* vocabulary. Named for a different reason than
  // the rows above: not "grep adopter code for this bad pattern" but "an estate carrying it
  // does not LOAD, so meta verify never runs and the whole requirements audit is blocked
  // until `meta upgrade` clears it". The audit skill's E2 item states that precondition, so
  // it must be able to name what triggers it.
  "@violation",     // renamed to @counterexample
  "@verifiedBy",    // dropped — it proved a NAME existed, never that the test verified the claim
  "@supersededBy",  // dropped — a requirement is prescriptive, never a journal
  // FR-040 (0.25.0) — the @emit* family. Named for the same reason as the requirement rows
  // above, one step further: these were never REGISTERED AT ALL. They were read off metadata
  // by the TS generators and documented as the per-entity opt-out, so they passed `meta gen`
  // (open load) and failed `meta verify` (strict). The audit skill names all five so an
  // auditor never recommends one — a project carrying one is a finding, not an opt-out.
  //
  // These two lines are also the reason ATTR_IN_CODE_SPAN was widened: while the skill wrote
  // them as `@emitRoutes: false`, this very gate could not see them.
  "@emitRoutes", "@emitTanstack", "@emitForm", "@emitGrid", "@emitAngular",
  // (Wave 4 — ADR-0038 reverse navigation — shipped as explicit generated FK finders with
  // NO metamodel attribute: the finder name derives from source + FK field, unique by
  // construction. The predicted-but-never-built @reverseName is therefore NOT named by the
  // skills and needs no exemption. Wave 3 — @stringFormat + field.uri/field.inet — and
  // Wave 2 — @localTime — are now REGISTERED, so those tokens pass grounding as real vocab.)
]);

/**
 * Every `@attr` named inside a code span.
 *
 * THE TRAILING TERMINATOR IS THE WHOLE POINT. This was `` /`@(\w+)`/g `` — a backtick
 * required IMMEDIATELY after the name — so it saw `` `@column` `` and was blind to
 * `` `@emitRoutes: false` ``, which is the more natural way to write an attribute example
 * because it shows the value too. That blindness is not hypothetical: measured against the
 * commit before FR-040, the old form missed exactly two tokens in the audit skill, and BOTH
 * were unregistered vocabulary — `@emitRoutes` and `@emitTanstack`. The gate whose job is
 * "the audit skill must not name an attribute nothing registers" could not see the only two
 * that qualified, purely because of how they were quoted. It is how a shipped skill came to
 * instruct agents to author metadata our own loader rejects.
 *
 * The leading backtick stays: it is the proxy for "inside a code span", without which every
 * `@mention` in prose would be scanned as vocabulary.
 */
const ATTR_IN_CODE_SPAN = /`@([a-zA-Z][a-zA-Z0-9]*)(?=[`:\s])/g;

// Code-level identifiers that the @attr regex (`@word`) extracts from the audit skill's
// prose but that are NOT MetaObjects metamodel attributes.  The skill's port-specific
// reference files naturally mention Java/Kotlin annotations and the codegen file-header
// marker inside prose or code examples.
const CODE_IDENTIFIERS_NOT_METAMODEL_ATTRS = new Set<string>([
  "@generated",       // codegen file header (// @generated by @metaobjectsdev/…)
  "@RestController",  // Spring annotation mentioned in Java/Kotlin port prose
  "@Serializable",    // Kotlin annotation mentioned in Kotlin port prose
]);

// The real expected-registry.json manifest is a flat LIST of type-definition records
// ({ type, subType, attrs: [{ name }], children }), with `commonAttrs` likewise a list of
// { name } records — NOT the nested `types: Record<..., { subTypes }>` shape. Parse accordingly.
function registryTokens(): { subtypes: Set<string>; attrs: Set<string> } {
  const reg = JSON.parse(readFileSync(REGISTRY, "utf8")) as {
    types: Array<{ type: string; subType: string; attrs?: Array<{ name: string }> }>;
    commonAttrs?: Array<{ name: string }>;
  };
  const subtypes = new Set<string>();
  const attrs = new Set<string>((reg.commonAttrs ?? []).map((a) => a.name));
  for (const def of reg.types) {
    subtypes.add(`${def.type}.${def.subType}`);
    for (const a of def.attrs ?? []) attrs.add(a.name);
  }
  return { subtypes, attrs };
}

// Collect SKILL.md + all references/*.md for the audit skill (includes capability-checklist.md).
function auditSkillFiles(): Array<{ path: string; text: string }> {
  const result: Array<{ path: string; text: string }> = [];
  const skillMd = join(AUDIT_SKILL_ROOT, "SKILL.md");
  result.push({ path: skillMd, text: readFileSync(skillMd, "utf8") });
  const refsDir = join(AUDIT_SKILL_ROOT, "references");
  for (const name of readdirSync(refsDir)) {
    const p = join(refsDir, name);
    if (!statSync(p).isFile() || !name.endsWith(".md")) continue;
    result.push({ path: p, text: readFileSync(p, "utf8") });
  }
  return result;
}

// The extraction rule needs its own pin. Every audit-skill file now happens to write the
// bare `@attr` form, which the OLD regex also matched — so narrowing ATTR_IN_CODE_SPAN back
// again would leave every assertion above green while restoring the exact blind spot that
// let `@emitRoutes: false` ship in a skill for two releases. A gate that only fails on
// content nobody currently writes has stopped being a gate.
describe("the @attr extraction rule itself", () => {
  const extract = (text: string): string[] =>
    [...text.matchAll(new RegExp(ATTR_IN_CODE_SPAN.source, "g"))].map((m) => m[1]!);

  test("sees an attribute quoted WITH its value — the form that was invisible", () => {
    expect(extract("the opt-out is `@emitRoutes: false` on the entity")).toEqual(["emitRoutes"]);
  });

  test("still sees the bare form, and a value with no space after the colon", () => {
    expect(extract("`@column` and `@table`")).toEqual(["column", "table"]);
    expect(extract("`@kind:table`")).toEqual(["kind"]);
  });

  test("stays inside code spans — a bare @mention in prose is not vocabulary", () => {
    // The leading backtick is the only thing separating "an attribute this skill names"
    // from "an email address, a Java annotation in prose, a handle".
    expect(extract("ask @someone about the @column attr")).toEqual([]);
  });
});

describe("capability checklist is registry-grounded", () => {
  const text = readFileSync(CHECKLIST, "utf8");
  const { subtypes, attrs } = registryTokens();

  test("every `type.subtype` named exists in the registry (or is an explicit exemption)", () => {
    const named = new Set(
      [...text.matchAll(/\b(object|field|source|relationship|identity|origin|index|validator|view|layout|template|attr|api|operation|binding)\.([a-zA-Z][a-zA-Z0-9]*)\b/g)]
        .map((m) => `${m[1]}.${m[2]}`),
    );
    const unknown = [...named].filter((t) => !subtypes.has(t) && !EXEMPT_SUBTYPES.has(t));
    expect(unknown).toEqual([]);
  });

  test("every @attr named exists in the registry", () => {
    const named = new Set([...text.matchAll(ATTR_IN_CODE_SPAN)].map((m) => m[1]!));
    const unknown = [...named].filter((a) => !attrs.has(a));
    // Allow doc-only/config attrs not in the metamodel registry (apiPrefix etc. aren't @attrs anyway).
    expect(unknown).toEqual([]);
  });
});

// The metaobjects-audit skill directory is exempt from the general agent-context
// vocabulary-drift scan (drift.test.ts) because the audit skill deliberately names
// retired/cut vocabulary it hunts.  This describe block provides the compensating
// guard: it scans SKILL.md AND all references/*.md (including capability-checklist.md)
// and asserts every extracted token either exists in the registry OR is in a
// principled, documented exemption set.
describe("audit skill files (SKILL.md + references) are registry-grounded", () => {
  const files = auditSkillFiles();
  const { subtypes, attrs } = registryTokens();

  test("there are skill files to check", () => {
    // SKILL.md + 5 references/*.md = 6 files minimum
    expect(files.length).toBeGreaterThanOrEqual(6);
  });

  test("every `type.subtype` named exists in the registry or is a principled exemption", () => {
    const bad: string[] = [];
    for (const { path, text } of files) {
      for (const m of text.matchAll(
        /\b(object|field|source|relationship|identity|origin|index|validator|view|layout|template|attr|api|operation|binding)\.([a-zA-Z][a-zA-Z0-9]*)\b/g,
      )) {
        const token = `${m[1]}.${m[2]}`;
        if (
          !subtypes.has(token) &&
          !EXEMPT_SUBTYPES.has(token) &&
          !DELIBERATELY_NAMED_RETIRED_OR_CUT.has(token)
        ) {
          bad.push(`${path}: ${token}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  test("every @attr named exists in the registry or is a principled exemption", () => {
    const bad: string[] = [];
    for (const { path, text } of files) {
      for (const m of text.matchAll(ATTR_IN_CODE_SPAN)) {
        const attrName = m[1]!;
        const token = `@${attrName}`;
        if (
          !attrs.has(attrName) &&
          !DELIBERATELY_NAMED_RETIRED_OR_CUT.has(token) &&
          !CODE_IDENTIFIERS_NOT_METAMODEL_ATTRS.has(token)
        ) {
          bad.push(`${path}: ${token}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });
});

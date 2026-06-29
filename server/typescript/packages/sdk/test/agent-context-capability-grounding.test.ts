import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../../../../..");
const CHECKLIST = join(ROOT, "agent-context/skills/metaobjects-audit/references/capability-checklist.md");
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

describe("capability checklist is registry-grounded", () => {
  const text = readFileSync(CHECKLIST, "utf8");
  const { subtypes, attrs } = registryTokens();

  test("every `type.subtype` named exists in the registry (or is an explicit exemption)", () => {
    const named = new Set(
      [...text.matchAll(/\b(object|field|source|relationship|identity|origin|validator|view|layout|template|attr)\.([a-zA-Z][a-zA-Z0-9]*)\b/g)]
        .map((m) => `${m[1]}.${m[2]}`),
    );
    const unknown = [...named].filter((t) => !subtypes.has(t) && !EXEMPT_SUBTYPES.has(t));
    expect(unknown).toEqual([]);
  });

  test("every @attr named exists in the registry", () => {
    const named = new Set([...text.matchAll(/`@([a-zA-Z][a-zA-Z0-9]*)`/g)].map((m) => m[1]!));
    const unknown = [...named].filter((a) => !attrs.has(a));
    // Allow doc-only/config attrs not in the metamodel registry (apiPrefix etc. aren't @attrs anyway).
    expect(unknown).toEqual([]);
  });
});

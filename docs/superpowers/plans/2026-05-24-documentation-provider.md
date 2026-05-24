# Documentation Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the Documentation Provider — 7 universal doc common attrs (`description` / `title` / `notes` / `deprecated` / `replacedBy` / `seeAlso` / `aliases`) registered through a new `commonAttrs` registry hook, across TS / C# / Java / Python — plus TS+C# doc-gen consumption (in-code comments, Postgres `COMMENT ON`, and a TS-side Mermaid ER diagram).

**Architecture:** A new generic `commonAttrs` hook on each port's `TypeRegistry` lets any provider register attrs accepted on every metatype (validation merges common + per-type attrs; collisions throw `ERR_PROVIDER_ATTR_CONFLICT`). A dedicated `DocumentationProvider` per port is the first consumer of the hook, registering the seven doc attrs. Codegen consumers (TS+C#) read those attrs and emit per-language doc comments + Postgres `COMMENT ON` statements; a TS-only Mermaid generator emits `docs/model.md`.

**Tech Stack:** TypeScript (Bun + `@metaobjectsdev/metadata` + `codegen-ts` + `migrate-ts`), C# (.NET 8, EF Core 8, `MetaObjects.*`), Java (Maven, `com.metaobjects`, SPI via `ServiceLoader`), Python (pytest, `metaobjects`), Mermaid `erDiagram`, Markdown.

**Design spec:** `docs/superpowers/specs/2026-05-24-documentation-provider-design.md`

---

## Conventions for this plan

- **TDD throughout:** failing test → run-fails → minimal impl → run-passes → commit.
- **Paths are repo-relative** from the repo root.
- **Commit trailer** every commit:
  `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`
- **Named constants for all metamodel strings.** No inlined `"description"` / `"title"` etc. — always import the constant.
- **Bare attr names in constants and schemas; `@`-prefix is added by the serializer** (per ADR-0006). Authoring is sigil-free in YAML; canonical JSON has the `@`-prefix on output.
- **Public-repo hygiene:** no private project names; no absolute local paths in any committed file. All paths repo-relative.
- **Test runners:**
  - TS: `cd server/typescript && bun test` (full suite); scoped via `-t "doc"` or `--filter`.
  - C#: `cd server/csharp && dotnet test`.
  - Python: `cd server/python && uv run --extra dev pytest`.
  - Java: `cd server/java && mvn -pl metadata test`.

---

## Phase 1 — Shared conformance fixtures + TS substrate

The contract first (TS will fail until the substrate lands), then the TS implementation that turns them green.

### Task 1.1 — Author the 4 shared conformance fixtures

**Files:**
- Create: `fixtures/conformance/doc-common-attrs-basic/input/meta.acme.json`
- Create: `fixtures/conformance/doc-common-attrs-basic/expected.json`
- Create: `fixtures/conformance/doc-common-attrs-multiline/input/meta.acme.json`
- Create: `fixtures/conformance/doc-common-attrs-multiline/expected.json`
- Create: `fixtures/conformance/doc-common-attrs-on-all-types/input/meta.acme.json`
- Create: `fixtures/conformance/doc-common-attrs-on-all-types/expected.json`
- Create: `fixtures/conformance/doc-common-attrs-stringarray-shapes/input/meta.acme.json`
- Create: `fixtures/conformance/doc-common-attrs-stringarray-shapes/expected.json`

- [ ] **Step 1: Write `doc-common-attrs-basic/input/meta.acme.json`**

```json
{
  "metadata.root": {
    "package": "acme",
    "children": [
      {
        "object.entity": {
          "name": "User",
          "@description": "A registered account holder.",
          "@title": "User",
          "@aliases": ["Account", "Member"],
          "children": [
            {
              "field.long": {
                "name": "id"
              }
            },
            {
              "field.string": {
                "name": "email",
                "@description": "User's primary email address.",
                "@title": "Email",
                "@deprecated": "Use contactEmail instead.",
                "@replacedBy": "User.contactEmail",
                "@seeAlso": ["https://acme.com/docs/email"],
                "@aliases": ["emailAddress", "userEmail"]
              }
            },
            {
              "field.string": {
                "name": "contactEmail",
                "@description": "Replacement contact email."
              }
            },
            {
              "identity.primary": {
                "@fields": ["id"]
              }
            }
          ]
        }
      }
    ]
  }
}
```

- [ ] **Step 2: Write `doc-common-attrs-basic/expected.json`**

Canonical form per the wire-format rules (key order: `name` → `package` → `extends` → `abstract` → `overlay` → `isArray` → `@`-attrs alphabetical → `children`; `@fields` scalar→array; 2-space indent; trailing newline). This is the same metadata canonicalized — copy `input/meta.acme.json` and verify the only change is `@`-attr alphabetical ordering within each node. Reference shape: `fixtures/conformance/identity-primary-and-secondary/expected.json`.

```json
{
  "metadata.root": {
    "package": "acme",
    "children": [
      {
        "object.entity": {
          "name": "User",
          "@aliases": [
            "Account",
            "Member"
          ],
          "@description": "A registered account holder.",
          "@title": "User",
          "children": [
            {
              "field.long": {
                "name": "id"
              }
            },
            {
              "field.string": {
                "name": "email",
                "@aliases": [
                  "emailAddress",
                  "userEmail"
                ],
                "@deprecated": "Use contactEmail instead.",
                "@description": "User's primary email address.",
                "@replacedBy": "User.contactEmail",
                "@seeAlso": [
                  "https://acme.com/docs/email"
                ],
                "@title": "Email"
              }
            },
            {
              "field.string": {
                "name": "contactEmail",
                "@description": "Replacement contact email."
              }
            },
            {
              "identity.primary": {
                "@fields": [
                  "id"
                ]
              }
            }
          ]
        }
      }
    ]
  }
}
```

- [ ] **Step 3: Write `doc-common-attrs-multiline/input/meta.acme.json`** — verify YAML `|` multi-line preserves newlines through canonical JSON.

```json
{
  "metadata.root": {
    "package": "acme",
    "children": [
      {
        "object.entity": {
          "name": "Order",
          "@description": "An order placed by a User.\n\nLifecycle: DRAFT → PUBLISHED → ARCHIVED.\nMultiple lines preserved via canonical serialization.",
          "@notes": "Internal rationale:\n- We chose status as an enum because external integrations require canonical states.\n- Don't surface this in API docs.",
          "children": [
            {
              "field.long": {
                "name": "id"
              }
            },
            {
              "identity.primary": {
                "@fields": ["id"]
              }
            }
          ]
        }
      }
    ]
  }
}
```

- [ ] **Step 4: Write `doc-common-attrs-multiline/expected.json`** — identical, but with `@`-attrs alphabetically ordered:

```json
{
  "metadata.root": {
    "package": "acme",
    "children": [
      {
        "object.entity": {
          "name": "Order",
          "@description": "An order placed by a User.\n\nLifecycle: DRAFT → PUBLISHED → ARCHIVED.\nMultiple lines preserved via canonical serialization.",
          "@notes": "Internal rationale:\n- We chose status as an enum because external integrations require canonical states.\n- Don't surface this in API docs.",
          "children": [
            {
              "field.long": {
                "name": "id"
              }
            },
            {
              "identity.primary": {
                "@fields": [
                  "id"
                ]
              }
            }
          ]
        }
      }
    ]
  }
}
```

- [ ] **Step 5: Write `doc-common-attrs-on-all-types/input/meta.acme.json`** — confirms permissive scope (D2). Attrs on `object.entity`, `field.string`, `identity.primary`, `source.rdb`, and a `validator.required` child.

```json
{
  "metadata.root": {
    "package": "acme",
    "children": [
      {
        "object.entity": {
          "name": "Subscriber",
          "@description": "Entity-level doc.",
          "children": [
            {
              "source.rdb": {
                "@kind": "table",
                "@table": "subscribers",
                "@description": "Source-level doc."
              }
            },
            {
              "field.long": {
                "name": "id"
              }
            },
            {
              "field.string": {
                "name": "email",
                "@description": "Field-level doc.",
                "children": [
                  {
                    "validator.required": {
                      "@description": "Validator-level doc."
                    }
                  }
                ]
              }
            },
            {
              "identity.primary": {
                "@fields": ["id"],
                "@description": "Identity-level doc."
              }
            }
          ]
        }
      }
    ]
  }
}
```

- [ ] **Step 6: Write `doc-common-attrs-on-all-types/expected.json`** — canonical version (`@`-attrs alphabetical; `@fields` scalar→array already done).

Same content as `input/` but with `@`-attrs in alphabetical order within each node. For nodes with one `@`-attr no reorder needed; multi-attr nodes (e.g. `source.rdb` has `@description`, `@kind`, `@table` — alphabetical is `@description`, `@kind`, `@table`).

```json
{
  "metadata.root": {
    "package": "acme",
    "children": [
      {
        "object.entity": {
          "name": "Subscriber",
          "@description": "Entity-level doc.",
          "children": [
            {
              "source.rdb": {
                "@description": "Source-level doc.",
                "@kind": "table",
                "@table": "subscribers"
              }
            },
            {
              "field.long": {
                "name": "id"
              }
            },
            {
              "field.string": {
                "name": "email",
                "@description": "Field-level doc.",
                "children": [
                  {
                    "validator.required": {
                      "@description": "Validator-level doc."
                    }
                  }
                ]
              }
            },
            {
              "identity.primary": {
                "@description": "Identity-level doc.",
                "@fields": [
                  "id"
                ]
              }
            }
          ]
        }
      }
    ]
  }
}
```

- [ ] **Step 7: Write `doc-common-attrs-stringarray-shapes/input/meta.acme.json`** — exercises scalar-shorthand → array desugar on `@seeAlso` and `@aliases`.

```json
{
  "metadata.root": {
    "package": "acme",
    "children": [
      {
        "object.entity": {
          "name": "Product",
          "children": [
            {
              "field.long": {
                "name": "id"
              }
            },
            {
              "field.string": {
                "name": "sku",
                "@seeAlso": "https://acme.com/docs/sku",
                "@aliases": "productCode"
              }
            },
            {
              "identity.primary": {
                "@fields": ["id"]
              }
            }
          ]
        }
      }
    ]
  }
}
```

- [ ] **Step 8: Write `doc-common-attrs-stringarray-shapes/expected.json`** — scalar shorthand desugared to single-element array:

```json
{
  "metadata.root": {
    "package": "acme",
    "children": [
      {
        "object.entity": {
          "name": "Product",
          "children": [
            {
              "field.long": {
                "name": "id"
              }
            },
            {
              "field.string": {
                "name": "sku",
                "@aliases": [
                  "productCode"
                ],
                "@seeAlso": [
                  "https://acme.com/docs/sku"
                ]
              }
            },
            {
              "identity.primary": {
                "@fields": [
                  "id"
                ]
              }
            }
          ]
        }
      }
    ]
  }
}
```

- [ ] **Step 9: Run TS conformance to confirm all 4 fixtures FAIL (red)**

Run: `cd server/typescript && bun test packages/metadata/test/conformance.test.ts -t "doc-common-attrs"`
Expected: 4 FAILures with `ERR_UNKNOWN_ATTR` (or similar) because the seven doc attrs aren't registered yet.

- [ ] **Step 10: Commit**

```bash
git add fixtures/conformance/doc-common-attrs-basic fixtures/conformance/doc-common-attrs-multiline fixtures/conformance/doc-common-attrs-on-all-types fixtures/conformance/doc-common-attrs-stringarray-shapes
git commit -m "test(conformance): add doc common attrs fixtures (red)

4 happy-path fixtures pinning the Documentation Provider contract:
basic, multiline (YAML | preservation), on-all-types (permissive
scope), stringarray-shapes (scalar→array desugar).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 1.2 — TS: add `commonAttrs` hook to TypeRegistry

**Files:**
- Modify: `server/typescript/packages/metadata/src/registry.ts`
- Test: `server/typescript/packages/metadata/test/registry-common-attrs.test.ts` (create)

- [ ] **Step 1: Write the failing test**

`server/typescript/packages/metadata/test/registry-common-attrs.test.ts`:
```typescript
import { describe, expect, it } from "bun:test";
import { TypeRegistry, type AttrSchema, ATTR_SUBTYPE_STRING } from "../src/registry.js";

describe("TypeRegistry.registerCommonAttrs", () => {
  it("registers a common attr accessible on getCommonAttrs()", () => {
    const r = new TypeRegistry();
    const attrs: AttrSchema[] = [
      { name: "description", valueType: ATTR_SUBTYPE_STRING, required: false, description: "Free-form description." },
    ];
    r.registerCommonAttrs(attrs);
    expect(r.getCommonAttrs().map(a => a.name)).toContain("description");
  });

  it("dedupes repeated registration of the same name", () => {
    const r = new TypeRegistry();
    const attr: AttrSchema = { name: "title", valueType: ATTR_SUBTYPE_STRING, required: false, description: "" };
    r.registerCommonAttrs([attr]);
    r.registerCommonAttrs([attr]);
    expect(r.getCommonAttrs().filter(a => a.name === "title")).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to confirm FAIL**

Run: `cd server/typescript && bun test packages/metadata/test/registry-common-attrs.test.ts`
Expected: FAIL — `registerCommonAttrs is not a function`.

- [ ] **Step 3: Add `commonAttrs` field + method to `TypeRegistry`**

In `server/typescript/packages/metadata/src/registry.ts`, find the `TypeRegistry` class definition. Add:

```typescript
// inside class TypeRegistry { ... }
private _commonAttrs: AttrSchema[] = [];

registerCommonAttrs(attrs: AttrSchema[]): void {
  for (const attr of attrs) {
    if (this._commonAttrs.some(existing => existing.name === attr.name)) {
      continue; // dedupe same-name re-registration; conflict-with-per-type-attr is checked at validation time
    }
    this._commonAttrs.push(attr);
  }
}

getCommonAttrs(): readonly AttrSchema[] {
  return this._commonAttrs;
}
```

- [ ] **Step 4: Run test to confirm PASS**

Run: `cd server/typescript && bun test packages/metadata/test/registry-common-attrs.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add server/typescript/packages/metadata/src/registry.ts server/typescript/packages/metadata/test/registry-common-attrs.test.ts
git commit -m "feat(metadata): add commonAttrs hook to TypeRegistry

New registry mechanism: registerCommonAttrs(attrs) + getCommonAttrs()
to declare attrs accepted on every metatype. The validation pass merges
common + per-type before checking node attrs (next commit).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 1.3 — TS: add ERR_PROVIDER_ATTR_CONFLICT detection at validation time

**Files:**
- Modify: `server/typescript/packages/metadata/src/attr-schema-validate.ts` (the validation pass that checks node attrs against per-type schemas)
- Test: extend `server/typescript/packages/metadata/test/registry-common-attrs.test.ts`

- [ ] **Step 1: Find the per-type attr-validation site**

Run: `grep -n "ERR_UNKNOWN_ATTR\|attr.*allowed" server/typescript/packages/metadata/src/attr-schema-validate.ts | head -20`. Locate the section that, given a node, looks up the per-type attr schemas and validates each `@`-attr on the node against them.

- [ ] **Step 2: Add the failing test for conflict detection**

Append to `server/typescript/packages/metadata/test/registry-common-attrs.test.ts`:
```typescript
it("validation throws ERR_PROVIDER_ATTR_CONFLICT when per-type attr collides with common attr", async () => {
  // This test confirms the validation pass surfaces the conflict.
  // Load metadata where a per-type attr name (e.g. an attr we register on a specific type)
  // collides with a common attr registered via registerCommonAttrs.
  // Concrete shape depends on the test harness for attr-schema-validate; mirror the pattern
  // already used by other attr-schema-validate tests in this directory.
});
```

> *Implementer note:* this is a stub that the implementer should fill in by mirroring the existing `attr-schema-validate.test.ts` pattern. Read that file first; the test should call the validation pass directly with a registry where: (a) a `commonAttr` named `description` is registered, AND (b) `field.string` has `description` declared as a per-type attr in its schema. Expect the validation to surface `ERR_PROVIDER_ATTR_CONFLICT` either at load time or schema-check time depending on where the existing pass invokes it.

- [ ] **Step 3: In `attr-schema-validate.ts`, merge `registry.getCommonAttrs()` into the per-type attr lookup**

For each node visited by the validation pass, the per-type attr schema lookup currently looks up `(type, subType) → attrs[]`. Modify that to additionally consider `registry.getCommonAttrs()` for the same check (so a node's `@description` doesn't trigger `ERR_UNKNOWN_ATTR`). When merging, if a per-type attr name collides with a common attr name, push a `ERR_PROVIDER_ATTR_CONFLICT` to the errors list (use the existing error-construction helper in the file).

```typescript
// inside the validation loop in attr-schema-validate.ts
const perTypeAttrs = registry.getTypeDef(type, subType)?.attrs ?? [];
const commonAttrs = registry.getCommonAttrs();
for (const ca of commonAttrs) {
  if (perTypeAttrs.some(pa => pa.name === ca.name)) {
    errors.push(new ValidationError(
      `Common attr '${ca.name}' conflicts with per-type attr on ${type}.${subType}`,
      { code: "ERR_PROVIDER_ATTR_CONFLICT", path: nodePath(node) }
    ));
  }
}
const effectiveAttrs = [...perTypeAttrs, ...commonAttrs.filter(ca => !perTypeAttrs.some(pa => pa.name === ca.name))];
// then validate the node's @-attrs against effectiveAttrs as before
```

- [ ] **Step 4: Run tests**

Run: `cd server/typescript && bun test packages/metadata`
Expected: all previous metadata tests still pass; the new conflict test passes.

- [ ] **Step 5: Commit**

```bash
git add server/typescript/packages/metadata/src/attr-schema-validate.ts server/typescript/packages/metadata/test/registry-common-attrs.test.ts
git commit -m "feat(metadata): merge commonAttrs into per-type validation; ERR_PROVIDER_ATTR_CONFLICT

Validation pass now accepts attrs registered via registerCommonAttrs
on any metatype. Per-type attr name collision with a common attr surfaces
ERR_PROVIDER_ATTR_CONFLICT (existing error code).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 1.4 — TS: doc constants + schema + provider modules

**Files:**
- Create: `server/typescript/packages/metadata/src/core/documentation/doc-constants.ts`
- Create: `server/typescript/packages/metadata/src/core/documentation/doc-schema.ts`
- Create: `server/typescript/packages/metadata/src/core/documentation/doc-provider.ts`

- [ ] **Step 1: Write `doc-constants.ts`**

```typescript
// Documentation common-attr constants. Bare names — the @-prefix is added by
// the serializer per ADR-0006.

export const DOC_ATTR_DESCRIPTION = "description";
export const DOC_ATTR_TITLE = "title";
export const DOC_ATTR_NOTES = "notes";
export const DOC_ATTR_DEPRECATED = "deprecated";
export const DOC_ATTR_REPLACED_BY = "replacedBy";
export const DOC_ATTR_SEE_ALSO = "seeAlso";
export const DOC_ATTR_ALIASES = "aliases";

/** All 7 documentation common-attr names in declaration order. */
export const DOC_ATTR_NAMES = [
  DOC_ATTR_DESCRIPTION,
  DOC_ATTR_TITLE,
  DOC_ATTR_NOTES,
  DOC_ATTR_DEPRECATED,
  DOC_ATTR_REPLACED_BY,
  DOC_ATTR_SEE_ALSO,
  DOC_ATTR_ALIASES,
] as const;
export type DocAttrName = (typeof DOC_ATTR_NAMES)[number];
```

- [ ] **Step 2: Write `doc-schema.ts`**

```typescript
import {
  ATTR_SUBTYPE_STRING,
  ATTR_SUBTYPE_STRINGARRAY,
  type AttrSchema,
} from "../../registry.js";
import {
  DOC_ATTR_ALIASES,
  DOC_ATTR_DEPRECATED,
  DOC_ATTR_DESCRIPTION,
  DOC_ATTR_NOTES,
  DOC_ATTR_REPLACED_BY,
  DOC_ATTR_SEE_ALSO,
  DOC_ATTR_TITLE,
} from "./doc-constants.js";

/**
 * The 7 universal documentation common attrs. Registered via the
 * registry.registerCommonAttrs() hook by the documentation provider.
 * Per ADR-0006, attr names are bare here; the serializer prefixes with @.
 */
export const commonDocAttrs: AttrSchema[] = [
  {
    name: DOC_ATTR_DESCRIPTION,
    valueType: ATTR_SUBTYPE_STRING,
    required: false,
    description: "Free-form user-facing prose. Markdown allowed, multi-line via YAML '|' block scalar. Flows into doc-gen surfaces (JSDoc / XML-doc / Postgres COMMENT / Mermaid prose).",
  },
  {
    name: DOC_ATTR_TITLE,
    valueType: ATTR_SUBTYPE_STRING,
    required: false,
    description: "Short single-line human label (e.g. 'Email' for a `field.string email`). Optional supplement to description.",
  },
  {
    name: DOC_ATTR_NOTES,
    valueType: ATTR_SUBTYPE_STRING,
    required: false,
    description: "Internal-only rationale. Stays in metadata; never emitted to user-facing docs.",
  },
  {
    name: DOC_ATTR_DEPRECATED,
    valueType: ATTR_SUBTYPE_STRING,
    required: false,
    description: "Text reason for deprecation. Presence ⇒ deprecated. Codegen emits @deprecated / [Obsolete] with this reason.",
  },
  {
    name: DOC_ATTR_REPLACED_BY,
    valueType: ATTR_SUBTYPE_STRING,
    required: false,
    description: "FQN reference to the replacement element. Only meaningful with `deprecated`. Codegen appends 'Replaced by <ref>' to deprecation messages.",
  },
  {
    name: DOC_ATTR_SEE_ALSO,
    valueType: ATTR_SUBTYPE_STRINGARRAY,
    required: false,
    description: "External documentation URLs. Codegen emits @see / <seealso href=...>.",
  },
  {
    name: DOC_ATTR_ALIASES,
    valueType: ATTR_SUBTYPE_STRINGARRAY,
    required: false,
    description: "Alternate names for this element. Aids AI authoring disambiguation, search, migration.",
  },
];
```

- [ ] **Step 3: Write `doc-provider.ts`**

```typescript
import type { MetaDataTypeProvider, TypeRegistry } from "../../registry.js";
import { commonDocAttrs } from "./doc-schema.js";

export const docProvider: MetaDataTypeProvider = {
  id: "metaobjects-documentation",
  dependencies: ["metaobjects-core-types"],
  registerTypes(registry: TypeRegistry): void {
    registry.registerCommonAttrs(commonDocAttrs);
  },
};
```

- [ ] **Step 4: Commit**

```bash
git add server/typescript/packages/metadata/src/core/documentation/
git commit -m "feat(metadata): documentation provider — constants, schema, provider

7 universal doc common attrs (description / title / notes / deprecated /
replacedBy / seeAlso / aliases) declared as commonDocAttrs; docProvider
registers them via registry.registerCommonAttrs() with dependency on
metaobjects-core-types per ADR-0004.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 1.5 — TS: wire `docProvider` into core-types; conformance fixtures pass

**Files:**
- Modify: `server/typescript/packages/metadata/src/core-types.ts`

- [ ] **Step 1: Register `docProvider`**

In `server/typescript/packages/metadata/src/core-types.ts`, find where `coreTypesProvider` is composed/registered. Add `docProvider` to the composition (it depends on core-types, so it lands after). Add the import:

```typescript
import { docProvider } from "./core/documentation/doc-provider.js";
```

And include it in the providers list passed to `composeRegistry` (or the equivalent registration site).

- [ ] **Step 2: Run conformance — the 4 doc-attrs fixtures should now PASS**

Run: `cd server/typescript && bun test packages/metadata/test/conformance.test.ts -t "doc-common-attrs"`
Expected: 4 PASSes (previously 4 fails).

- [ ] **Step 3: Run the full metadata suite — no regressions**

Run: `cd server/typescript && bun test packages/metadata`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add server/typescript/packages/metadata/src/core-types.ts
git commit -m "feat(metadata): wire docProvider into core-types registration

Conformance fixtures doc-common-attrs-* turn green: substrate now
accepts the 7 universal doc attrs on every metatype.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 2 — TS doc-gen Tier 1 (in-code doc comments)

### Task 2.1 — Shared JSDoc emission helper

**Files:**
- Create: `server/typescript/packages/codegen-ts/src/templates/jsdoc.ts`
- Test: `server/typescript/packages/codegen-ts/test/templates/jsdoc.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "bun:test";
import { renderJsDocBlock } from "../../src/templates/jsdoc.js";

describe("renderJsDocBlock", () => {
  it("returns empty string when no doc attrs present", () => {
    expect(renderJsDocBlock({})).toBe("");
  });

  it("renders single-line description as one-liner /** desc */", () => {
    expect(renderJsDocBlock({ description: "Hello." })).toBe("/** Hello. */");
  });

  it("renders multi-line description as JSDoc block", () => {
    const out = renderJsDocBlock({ description: "Line one.\nLine two." });
    expect(out).toContain("/**");
    expect(out).toContain(" * Line one.");
    expect(out).toContain(" * Line two.");
    expect(out).toContain(" */");
  });

  it("emits @deprecated with reason and appended replacedBy", () => {
    const out = renderJsDocBlock({
      description: "Old field.",
      deprecated: "Use newField.",
      replacedBy: "Foo.newField",
    });
    expect(out).toContain("@deprecated Use newField. Replaced by Foo.newField.");
  });

  it("emits @see per seeAlso URL", () => {
    const out = renderJsDocBlock({
      description: "x",
      seeAlso: ["https://a", "https://b"],
    });
    expect(out).toContain("@see https://a");
    expect(out).toContain("@see https://b");
  });

  it("emits @alias per alias", () => {
    const out = renderJsDocBlock({ description: "x", aliases: ["a", "b"] });
    expect(out).toContain("@alias a");
    expect(out).toContain("@alias b");
  });

  it("does NOT emit notes content (D5 internal-only contract)", () => {
    const out = renderJsDocBlock({
      description: "Public.",
      notes: "INTERNAL_SECRET_MARKER",
    });
    expect(out).not.toContain("INTERNAL_SECRET_MARKER");
  });
});
```

- [ ] **Step 2: Run to confirm FAIL**

Run: `cd server/typescript && bun test packages/codegen-ts/test/templates/jsdoc.test.ts`
Expected: FAIL — `Cannot find module .../jsdoc.js`.

- [ ] **Step 3: Implement `jsdoc.ts`**

```typescript
import {
  DOC_ATTR_ALIASES,
  DOC_ATTR_DEPRECATED,
  DOC_ATTR_DESCRIPTION,
  DOC_ATTR_REPLACED_BY,
  DOC_ATTR_SEE_ALSO,
  DOC_ATTR_TITLE,
} from "@metaobjectsdev/metadata";

export interface DocAttrs {
  description?: string;
  title?: string;
  /** Internal-only; NEVER emitted by this helper (D5 contract). */
  notes?: string;
  deprecated?: string;
  replacedBy?: string;
  seeAlso?: string[];
  aliases?: string[];
}

/**
 * Render the seven doc common attrs as a JSDoc block. Returns "" if no
 * relevant attrs are set. `notes` is intentionally NEVER emitted — it is
 * the internal-only rationale slot per the Documentation Provider design
 * (D5).
 */
export function renderJsDocBlock(attrs: DocAttrs): string {
  const bodyLines: string[] = [];

  // Description (primary text), falling back to title-only if no description.
  if (attrs.description) {
    bodyLines.push(...attrs.description.split("\n"));
  } else if (attrs.title) {
    bodyLines.push(attrs.title);
  }

  // Tags
  const tagLines: string[] = [];
  if (attrs.deprecated !== undefined) {
    const replaced = attrs.replacedBy ? ` Replaced by ${attrs.replacedBy}.` : "";
    tagLines.push(`@deprecated ${attrs.deprecated}${replaced}`);
  }
  for (const url of attrs.seeAlso ?? []) tagLines.push(`@see ${url}`);
  for (const alias of attrs.aliases ?? []) tagLines.push(`@alias ${alias}`);

  if (bodyLines.length === 0 && tagLines.length === 0) return "";

  // One-line shorthand: single body line + no tags
  if (bodyLines.length === 1 && tagLines.length === 0) {
    return `/** ${bodyLines[0]} */`;
  }

  const out: string[] = ["/**"];
  for (const line of bodyLines) out.push(line === "" ? " *" : ` * ${line}`);
  if (bodyLines.length > 0 && tagLines.length > 0) out.push(" *");
  for (const line of tagLines) out.push(` * ${line}`);
  out.push(" */");
  return out.join("\n");
}

/** Read the seven doc attrs from a MetaData node's `.attrs()` (effective). */
export function readDocAttrs(node: { attr: (n: string) => unknown }): DocAttrs {
  const str = (v: unknown): string | undefined =>
    typeof v === "string" ? v : undefined;
  const arr = (v: unknown): string[] | undefined =>
    Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : undefined;

  const description = str(node.attr(DOC_ATTR_DESCRIPTION));
  const title = str(node.attr(DOC_ATTR_TITLE));
  const deprecated = str(node.attr(DOC_ATTR_DEPRECATED));
  const replacedBy = str(node.attr(DOC_ATTR_REPLACED_BY));
  const seeAlso = arr(node.attr(DOC_ATTR_SEE_ALSO));
  const aliases = arr(node.attr(DOC_ATTR_ALIASES));
  // notes intentionally NOT read here — codegen consumers should never receive it
  return { description, title, deprecated, replacedBy, seeAlso, aliases };
}
```

- [ ] **Step 4: Run test to confirm PASS**

Run: `cd server/typescript && bun test packages/codegen-ts/test/templates/jsdoc.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add server/typescript/packages/codegen-ts/src/templates/jsdoc.ts server/typescript/packages/codegen-ts/test/templates/jsdoc.test.ts
git commit -m "feat(codegen-ts): shared JSDoc helper for doc common attrs

renderJsDocBlock(attrs) emits a JSDoc block from the 7 doc attrs.
readDocAttrs(node) reads them from a MetaData node. The 'notes' attr
is intentionally NEVER emitted — internal-only per D5.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 2.2 — Emit JSDoc on entity types (codegen-ts entity-file)

**Files:**
- Modify: `server/typescript/packages/codegen-ts/src/templates/entity-file.ts`
- Test: extend `server/typescript/packages/codegen-ts/test/templates/entity-file.test.ts`

- [ ] **Step 1: Add failing test**

In `server/typescript/packages/codegen-ts/test/templates/entity-file.test.ts`, add:
```typescript
it("emits JSDoc above entity type from description / deprecated / seeAlso", () => {
  const root = loadMetadata({
    "object.entity": {
      name: "Order",
      "@description": "An order placed by a User.",
      "@deprecated": "Use OrderV2.",
      "@replacedBy": "OrderV2",
      "@seeAlso": ["https://acme.com/docs/order"],
      children: [
        { "field.long": { name: "id" } },
        { "identity.primary": { "@fields": ["id"] } },
      ],
    },
  });
  const src = renderEntityFile(root.objects()[0], ctx());
  expect(src).toContain("/**");
  expect(src).toContain("An order placed by a User.");
  expect(src).toContain("@deprecated Use OrderV2. Replaced by OrderV2.");
  expect(src).toContain("@see https://acme.com/docs/order");
});

it("emits JSDoc above a field property from description", () => {
  const root = loadMetadata({
    "object.entity": {
      name: "User",
      children: [
        { "field.long": { name: "id" } },
        {
          "field.string": {
            name: "email",
            "@description": "Primary email address.",
          },
        },
        { "identity.primary": { "@fields": ["id"] } },
      ],
    },
  });
  const src = renderEntityFile(root.objects()[0], ctx());
  expect(src).toMatch(/\/\*\* Primary email address\. \*\/\s*email:/);
});

it("does NOT emit `notes` content in JSDoc", () => {
  const root = loadMetadata({
    "object.entity": {
      name: "User",
      "@description": "Public.",
      "@notes": "INTERNAL_SECRET",
      children: [
        { "field.long": { name: "id" } },
        { "identity.primary": { "@fields": ["id"] } },
      ],
    },
  });
  const src = renderEntityFile(root.objects()[0], ctx());
  expect(src).not.toContain("INTERNAL_SECRET");
});
```

> *Implementer note:* if `loadMetadata` / `ctx()` helpers don't exist with those exact names in the existing test file, mirror whatever helper pattern that file already uses (likely `Load()` + `Ctx()` from a sibling).

- [ ] **Step 2: Run tests to confirm FAIL**

Run: `cd server/typescript && bun test packages/codegen-ts/test/templates/entity-file.test.ts -t "JSDoc"`
Expected: 3 FAILs.

- [ ] **Step 3: Wire JSDoc into entity-file rendering**

In `server/typescript/packages/codegen-ts/src/templates/entity-file.ts`:

```typescript
import { readDocAttrs, renderJsDocBlock } from "./jsdoc.js";
```

Find the function that renders the entity's type/interface. Above the emitted type declaration, render the JSDoc:

```typescript
const docs = renderJsDocBlock(readDocAttrs(entity));
const typeDecl = `export type ${entity.name} = …`;
return docs ? `${docs}\n${typeDecl}` : typeDecl;
```

Find the inner loop that renders each field as a property. Above each property, emit JSDoc for that field:

```typescript
for (const field of entity.fields()) {
  const fieldDocs = renderJsDocBlock(readDocAttrs(field));
  const propLine = `${field.name}${optional ? "?" : ""}: ${tsType};`;
  members.push(fieldDocs ? `  ${fieldDocs.replace(/\n/g, "\n  ")}\n  ${propLine}` : `  ${propLine}`);
}
```

- [ ] **Step 4: Run tests to confirm PASS**

Run: `cd server/typescript && bun test packages/codegen-ts/test/templates/entity-file.test.ts`
Expected: all PASS, including the 3 new JSDoc tests.

- [ ] **Step 5: Commit**

```bash
git add server/typescript/packages/codegen-ts/src/templates/entity-file.ts server/typescript/packages/codegen-ts/test/templates/entity-file.test.ts
git commit -m "feat(codegen-ts): emit JSDoc on entity types and field properties

Reads the 7 doc common attrs (sans 'notes') from each entity/field and
emits a JSDoc block above the generated TypeScript construct.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 2.3 — Emit JSDoc on Zod schema vars (codegen-ts zod-validators)

**Files:**
- Modify: `server/typescript/packages/codegen-ts/src/templates/zod-validators.ts`
- Test: extend `server/typescript/packages/codegen-ts/test/templates/zod-validators.test.ts`

- [ ] **Step 1: Add failing test**

In `server/typescript/packages/codegen-ts/test/templates/zod-validators.test.ts`:
```typescript
it("emits JSDoc above the exported Zod schema constant from entity description", () => {
  const root = loadMetadata({
    "object.entity": {
      name: "User",
      "@description": "A registered account holder.",
      children: [
        { "field.long": { name: "id" } },
        { "identity.primary": { "@fields": ["id"] } },
      ],
    },
  });
  const src = renderZodValidators(root.objects()[0]);
  expect(src).toContain("/** A registered account holder. */");
  expect(src).toContain("export const UserSchema");
});
```

- [ ] **Step 2: Run to confirm FAIL.** Then implement: above the `export const <Name>Schema = z.object({…})` line, emit `renderJsDocBlock(readDocAttrs(entity))` if non-empty.

- [ ] **Step 3: Run to confirm PASS. Commit.**

```bash
git add server/typescript/packages/codegen-ts/src/templates/zod-validators.ts server/typescript/packages/codegen-ts/test/templates/zod-validators.test.ts
git commit -m "feat(codegen-ts): emit JSDoc above Zod schema constants

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 2.4 — Negative-emission test for `notes` (D5 contract enforcement)

**Files:**
- Test: create `server/typescript/packages/codegen-ts/test/templates/notes-never-emitted.test.ts`

- [ ] **Step 1: Write the test that confirms `notes` content NEVER appears in any TS codegen output**

```typescript
import { describe, expect, it } from "bun:test";
import { renderEntityFile } from "../../src/templates/entity-file.js";
import { renderZodValidators } from "../../src/templates/zod-validators.js";
// import { loadMetadata, ctx } as the existing tests do

const NOTES_MARKER = "__INTERNAL_NOTES_MARKER__";

describe("D5: `notes` content NEVER reaches user-facing codegen output", () => {
  const rootJson = {
    "object.entity": {
      name: "U",
      "@description": "Public.",
      "@notes": NOTES_MARKER,
      children: [
        { "field.long": { name: "id", "@notes": NOTES_MARKER } },
        { "identity.primary": { "@fields": ["id"], "@notes": NOTES_MARKER } },
      ],
    },
  };

  it("renderEntityFile output does not contain notes content", () => {
    const root = loadMetadata(rootJson);
    expect(renderEntityFile(root.objects()[0], ctx())).not.toContain(NOTES_MARKER);
  });

  it("renderZodValidators output does not contain notes content", () => {
    const root = loadMetadata(rootJson);
    expect(renderZodValidators(root.objects()[0])).not.toContain(NOTES_MARKER);
  });
});
```

- [ ] **Step 2: Run. Expected: PASS** (because Task 2.1's `readDocAttrs` already excludes `notes`).

- [ ] **Step 3: Commit**

```bash
git add server/typescript/packages/codegen-ts/test/templates/notes-never-emitted.test.ts
git commit -m "test(codegen-ts): D5 — notes never reaches user-facing codegen output

Cross-template negative-emission guard: even if D5's intent is reflected
in readDocAttrs(), this test makes the contract surface in CI.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 3 — TS doc-gen Tier 2 (Postgres COMMENT ON)

### Task 3.1 — `migrate-ts` emits `COMMENT ON TABLE` / `COMMENT ON COLUMN`

**Files:**
- Modify: `server/typescript/packages/migrate-ts/src/emit/postgres.ts`
- Test: extend `server/typescript/packages/migrate-ts/test/emit/postgres.test.ts`

- [ ] **Step 1: Add failing test**

```typescript
it("emits COMMENT ON TABLE from entity @description", () => {
  const root = loadMetadata({
    "object.entity": {
      name: "User",
      "@description": "A registered account holder.",
      children: [
        { "source.rdb": { "@kind": "table", "@table": "users" } },
        { "field.long": { name: "id" } },
        { "identity.primary": { "@fields": ["id"] } },
      ],
    },
  });
  const sql = emitPostgresDdl(root);
  expect(sql).toContain("COMMENT ON TABLE users IS 'A registered account holder.';");
});

it("emits COMMENT ON COLUMN from field @description; escapes single quotes", () => {
  const root = loadMetadata({
    "object.entity": {
      name: "User",
      children: [
        { "source.rdb": { "@kind": "table", "@table": "users" } },
        { "field.long": { name: "id" } },
        {
          "field.string": {
            name: "email",
            "@description": "User's email.",
          },
        },
        { "identity.primary": { "@fields": ["id"] } },
      ],
    },
  });
  const sql = emitPostgresDdl(root);
  expect(sql).toContain("COMMENT ON COLUMN users.email IS 'User''s email.';");
});

it("does NOT emit COMMENT ON when description is absent", () => {
  const root = loadMetadata({
    "object.entity": {
      name: "User",
      children: [
        { "source.rdb": { "@kind": "table", "@table": "users" } },
        { "field.long": { name: "id" } },
        { "identity.primary": { "@fields": ["id"] } },
      ],
    },
  });
  expect(emitPostgresDdl(root)).not.toContain("COMMENT ON");
});
```

- [ ] **Step 2: Run to confirm FAIL.**

Run: `cd server/typescript && bun test packages/migrate-ts/test/emit/postgres.test.ts -t "COMMENT"`

- [ ] **Step 3: Implement COMMENT emission in `postgres.ts`**

After the `CREATE TABLE …;` block for an entity, append:

```typescript
import { DOC_ATTR_DESCRIPTION } from "@metaobjectsdev/metadata";

function pgEscape(s: string): string {
  return s.replace(/'/g, "''");
}

function emitCommentsForEntity(entity: MetaObject, tableName: string, out: string[]): void {
  const entityDesc = entity.attr(DOC_ATTR_DESCRIPTION);
  if (typeof entityDesc === "string" && entityDesc.length > 0) {
    out.push(`COMMENT ON TABLE ${tableName} IS '${pgEscape(entityDesc)}';`);
  }
  for (const field of entity.fields()) {
    const fieldDesc = field.attr(DOC_ATTR_DESCRIPTION);
    if (typeof fieldDesc === "string" && fieldDesc.length > 0) {
      const colName = resolveColumnName(field);
      out.push(`COMMENT ON COLUMN ${tableName}.${colName} IS '${pgEscape(fieldDesc)}';`);
    }
  }
}
```

Call `emitCommentsForEntity` from the main DDL-emission loop right after the table's `CREATE TABLE` block.

- [ ] **Step 4: Run to confirm PASS.**

Run: `cd server/typescript && bun test packages/migrate-ts`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add server/typescript/packages/migrate-ts/src/emit/postgres.ts server/typescript/packages/migrate-ts/test/emit/postgres.test.ts
git commit -m "feat(migrate-ts): Postgres COMMENT ON TABLE/COLUMN from @description

Single-quote escaping via pgEscape(). Emitted only when @description is
present; multi-line descriptions emitted as multi-line strings.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 4 — TS doc-gen Tier 3 (Mermaid ER diagram)

### Task 4.1 — Mermaid ER renderer

**Files:**
- Create: `server/typescript/packages/codegen-ts/src/templates/mermaid-er.ts`
- Test: `server/typescript/packages/codegen-ts/test/templates/mermaid-er.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "bun:test";
import { renderMermaidModel } from "../../src/templates/mermaid-er.js";

describe("renderMermaidModel", () => {
  it("emits an `erDiagram` block plus entity prose sections", () => {
    const root = loadMetadata({
      "object.entity": {
        name: "User",
        "@description": "A registered account holder.",
        children: [
          { "field.long": { name: "id" } },
          {
            "field.string": {
              name: "email",
              "@description": "Primary email.",
            },
          },
          { "identity.primary": { "@fields": ["id"] } },
        ],
      },
    });
    const md = renderMermaidModel(root);
    expect(md).toContain("```mermaid\nerDiagram");
    expect(md).toContain("User {");
    expect(md).toContain("long id PK");
    expect(md).toContain('string email "Primary email."');
    expect(md).toContain("## User");
    expect(md).toContain("A registered account holder.");
  });

  it("emits FK relationship line for identity.reference", () => {
    const root = loadMetadata({
      "object.entity": {
        name: "Order",
        children: [
          { "source.rdb": { "@kind": "table", "@table": "orders" } },
          { "field.long": { name: "id" } },
          { "field.long": { name: "userId" } },
          { "identity.primary": { "@fields": ["id"] } },
          {
            "identity.reference": {
              "@fields": ["userId"],
              "@references": "User",
            },
          },
        ],
      },
    });
    const md = renderMermaidModel(root);
    expect(md).toMatch(/User .* Order/); // a relationship line connecting them
    expect(md).toContain("long userId FK");
  });
});
```

- [ ] **Step 2: Run to confirm FAIL.**

- [ ] **Step 3: Implement `mermaid-er.ts`**

```typescript
import type { MetaObject, MetaRoot, MetaField } from "@metaobjectsdev/metadata";
import {
  DOC_ATTR_ALIASES,
  DOC_ATTR_DEPRECATED,
  DOC_ATTR_DESCRIPTION,
  DOC_ATTR_REPLACED_BY,
  DOC_ATTR_SEE_ALSO,
  DOC_ATTR_TITLE,
} from "@metaobjectsdev/metadata";

/**
 * Render a `docs/model.md` body containing a Mermaid ER diagram plus a
 * per-entity prose section.
 */
export function renderMermaidModel(root: MetaRoot): string {
  const entities = root.objects().filter(o => o.isEntity());
  const parts: string[] = [];

  parts.push("# Data Model\n");
  parts.push("```mermaid");
  parts.push("erDiagram");
  parts.push(...renderRelationships(entities).map(l => `    ${l}`));
  parts.push("");
  for (const e of entities) {
    parts.push(...renderEntityBlock(e).map(l => `    ${l}`));
    parts.push("");
  }
  parts.push("```");
  parts.push("");

  for (const e of entities) {
    parts.push(...renderEntityProse(e));
    parts.push("");
  }

  return parts.join("\n");
}

function renderRelationships(entities: MetaObject[]): string[] {
  const lines: string[] = [];
  for (const e of entities) {
    for (const id of e.identities()) {
      if (id.subType !== "reference") continue;
      const refTo = id.attr("references") as string | undefined;
      if (!refTo) continue;
      // One-to-many by default; refine with cardinality when available.
      lines.push(`${refTo} ||--o{ ${e.name} : "references"`);
    }
  }
  return lines;
}

function renderEntityBlock(e: MetaObject): string[] {
  const out: string[] = [`${e.name} {`];
  const pkFields = pkFieldNames(e);
  const fkFields = fkFieldNames(e);
  for (const f of e.fields()) {
    const marker = pkFields.has(f.name) ? " PK" : fkFields.has(f.name) ? " FK" : "";
    const desc = f.attr(DOC_ATTR_DESCRIPTION);
    const comment = typeof desc === "string" && desc.length > 0
      ? ` "${desc.replace(/"/g, '\\"').split("\n")[0]}"`
      : "";
    out.push(`    ${mermaidType(f)} ${f.name}${marker}${comment}`);
  }
  out.push("}");
  return out;
}

function pkFieldNames(e: MetaObject): Set<string> {
  const out = new Set<string>();
  for (const id of e.identities()) {
    if (id.subType !== "primary") continue;
    for (const fn of (id.attr("fields") as string[] | undefined) ?? []) out.add(fn);
  }
  return out;
}

function fkFieldNames(e: MetaObject): Set<string> {
  const out = new Set<string>();
  for (const id of e.identities()) {
    if (id.subType !== "reference") continue;
    for (const fn of (id.attr("fields") as string[] | undefined) ?? []) out.add(fn);
  }
  return out;
}

function mermaidType(f: MetaField): string {
  // Mermaid is loose about types; pass the metaobjects subtype through.
  return f.subType;
}

function renderEntityProse(e: MetaObject): string[] {
  const out: string[] = [];
  const title = (e.attr(DOC_ATTR_TITLE) as string | undefined) ?? e.name;
  out.push(`## ${title}`);
  const desc = e.attr(DOC_ATTR_DESCRIPTION) as string | undefined;
  if (desc) out.push("", desc);
  const aliases = e.attr(DOC_ATTR_ALIASES) as string[] | undefined;
  if (aliases?.length) out.push("", `*Aliases:* ${aliases.join(", ")}`);
  const deprecated = e.attr(DOC_ATTR_DEPRECATED) as string | undefined;
  if (deprecated !== undefined) {
    const replaced = e.attr(DOC_ATTR_REPLACED_BY) as string | undefined;
    out.push("", `> ⚠️ **Deprecated:** ${deprecated}${replaced ? ` Replaced by **${replaced}**.` : ""}`);
  }
  const seeAlso = e.attr(DOC_ATTR_SEE_ALSO) as string[] | undefined;
  if (seeAlso?.length) {
    out.push("", "**See also:**");
    for (const url of seeAlso) out.push(`- <${url}>`);
  }
  // notes intentionally NOT emitted
  return out;
}
```

- [ ] **Step 4: Run to confirm PASS.**

Run: `cd server/typescript && bun test packages/codegen-ts/test/templates/mermaid-er.test.ts`
Expected: 2 PASSes.

- [ ] **Step 5: Commit**

```bash
git add server/typescript/packages/codegen-ts/src/templates/mermaid-er.ts server/typescript/packages/codegen-ts/test/templates/mermaid-er.test.ts
git commit -m "feat(codegen-ts): Mermaid ER diagram renderer for docs/model.md

renderMermaidModel(root) emits a Markdown file with a top-level Mermaid
erDiagram (entities + PK/FK markers + relationships derived from
identity.reference) plus per-entity prose sections. notes intentionally
NOT emitted (D5).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 4.2 — Wire `mermaidErDiagram()` into the codegen-ts generators registry

**Files:**
- Modify: `server/typescript/packages/codegen-ts/src/generators.ts` (or wherever generator factories are exported — check the file referenced by the CLAUDE.md "codegen-ts/generators" import path)
- Test: `server/typescript/packages/codegen-ts/test/mermaid-er-generator.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "bun:test";
import { mermaidErDiagram } from "../src/generators.js";

describe("mermaidErDiagram() generator factory", () => {
  it("returns a Generator that emits one file at the configured outFile", () => {
    const gen = mermaidErDiagram({ outFile: "docs/model.md" });
    const root = loadMetadataWithSomeEntities();
    const files = gen.generate({ Root: root, Entities: root.objects() } as any);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("docs/model.md");
    expect(files[0].content).toContain("```mermaid");
  });

  it("defaults outFile to docs/model.md when not specified", () => {
    const gen = mermaidErDiagram();
    const files = gen.generate({ Root: loadMetadataWithSomeEntities(), Entities: [] } as any);
    expect(files[0].path).toBe("docs/model.md");
  });
});
```

- [ ] **Step 2: Run to confirm FAIL.**

- [ ] **Step 3: Implement `mermaidErDiagram` factory**

In `server/typescript/packages/codegen-ts/src/generators.ts`, add:

```typescript
import { oncePerRun, type Generator } from "./generator-base.js"; // mirror existing factories
import { renderMermaidModel } from "./templates/mermaid-er.js";

export interface MermaidErOptions {
  /** Output path relative to the target's outDir. Defaults to "docs/model.md". */
  outFile?: string;
}

export function mermaidErDiagram(opts: MermaidErOptions = {}): Generator {
  const outFile = opts.outFile ?? "docs/model.md";
  return oncePerRun({
    name: "mermaid-er-diagram",
    generate(ctx) {
      return [{ path: outFile, content: renderMermaidModel(ctx.Root) }];
    },
  });
}
```

> *Implementer note:* the exact `oncePerRun` import path may differ — mirror the import other generator factories in the same file use (e.g. `entityFile`, `queriesFile`).

- [ ] **Step 4: Run to confirm PASS. Commit.**

```bash
git add server/typescript/packages/codegen-ts/src/generators.ts server/typescript/packages/codegen-ts/test/mermaid-er-generator.test.ts
git commit -m "feat(codegen-ts): mermaidErDiagram() generator factory

Wires renderMermaidModel into a Generator users add to their
metaobjects.config.ts generators list. Default outFile = docs/model.md.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 5 — C# substrate

### Task 5.1 — C#: `RegisterCommonAttributes` on TypeRegistry + conflict detection

**Files:**
- Modify: `server/csharp/MetaObjects/Registry/TypeRegistry.cs`
- Modify: `server/csharp/MetaObjects/Loader/ValidationPasses.cs`
- Test: `server/csharp/MetaObjects.Tests/Registry/CommonAttrsTests.cs` (create)

- [ ] **Step 1: Write the failing test**

```csharp
using MetaObjects.Registry;
using Xunit;

public class CommonAttrsTests {
    [Fact]
    public void RegisterCommonAttributes_adds_to_GetCommonAttributes() {
        var r = new TypeRegistry();
        r.RegisterCommonAttributes(new[] {
            new AttrSchema(Name: "description", ValueType: AttrConstants.ATTR_SUBTYPE_STRING, Required: false, Description: "")
        });
        Assert.Contains("description", r.GetCommonAttributes().Select(a => a.Name));
    }

    [Fact]
    public void RegisterCommonAttributes_is_idempotent_for_same_name() {
        var r = new TypeRegistry();
        var attr = new AttrSchema(Name: "title", ValueType: AttrConstants.ATTR_SUBTYPE_STRING, Required: false, Description: "");
        r.RegisterCommonAttributes(new[] { attr });
        r.RegisterCommonAttributes(new[] { attr });
        Assert.Equal(1, r.GetCommonAttributes().Count(a => a.Name == "title"));
    }
}
```

- [ ] **Step 2: Run to confirm FAIL.**

Run: `cd server/csharp && dotnet test --filter CommonAttrsTests`

- [ ] **Step 3: Add `CommonAttributes` storage + methods to TypeRegistry**

In `server/csharp/MetaObjects/Registry/TypeRegistry.cs`:
```csharp
private readonly List<AttrSchema> _commonAttributes = new();

public void RegisterCommonAttributes(IEnumerable<AttrSchema> attrs) {
    foreach (var a in attrs) {
        if (_commonAttributes.Any(existing => existing.Name == a.Name)) continue;
        _commonAttributes.Add(a);
    }
}

public IReadOnlyList<AttrSchema> GetCommonAttributes() => _commonAttributes;
```

- [ ] **Step 4: Merge common attrs in ValidationPasses.ValidateAttrSchema**

In `server/csharp/MetaObjects/Loader/ValidationPasses.cs`, the `ValidateAttrSchema` pass looks up per-type attrs. Modify the merge:
```csharp
var perType = registry.GetTypeDef(node.Type, node.SubType)?.Attrs ?? new List<AttrSchema>();
var common = registry.GetCommonAttributes();
foreach (var ca in common) {
    if (perType.Any(pa => pa.Name == ca.Name)) {
        errors.Add(new MetaError(
            $"Common attr '{ca.Name}' conflicts with per-type attr on {node.Type}.{node.SubType}",
            ErrorCode.ERR_PROVIDER_ATTR_CONFLICT));
    }
}
var effective = perType.Concat(common.Where(ca => !perType.Any(pa => pa.Name == ca.Name))).ToList();
// validate node attrs against `effective` as before
```

- [ ] **Step 5: Run tests to confirm PASS. Commit.**

```bash
git add server/csharp/MetaObjects/Registry/TypeRegistry.cs server/csharp/MetaObjects/Loader/ValidationPasses.cs server/csharp/MetaObjects.Tests/Registry/CommonAttrsTests.cs
git commit -m "feat(csharp): RegisterCommonAttributes on TypeRegistry + validation merge

Validation pass merges common + per-type attrs; ERR_PROVIDER_ATTR_CONFLICT
on name collision.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 5.2 — C#: Documentation constants + schema + provider

**Files:**
- Create: `server/csharp/MetaObjects/Core/Documentation/DocumentationConstants.cs`
- Create: `server/csharp/MetaObjects/Core/Documentation/DocumentationSchema.cs`
- Create: `server/csharp/MetaObjects/Core/Documentation/DocumentationTypes.cs`

- [ ] **Step 1: `DocumentationConstants.cs`**

```csharp
namespace MetaObjects.Core.Documentation;

public static class DocumentationConstants {
    public const string DOC_ATTR_DESCRIPTION = "description";
    public const string DOC_ATTR_TITLE = "title";
    public const string DOC_ATTR_NOTES = "notes";
    public const string DOC_ATTR_DEPRECATED = "deprecated";
    public const string DOC_ATTR_REPLACED_BY = "replacedBy";
    public const string DOC_ATTR_SEE_ALSO = "seeAlso";
    public const string DOC_ATTR_ALIASES = "aliases";

    public static readonly IReadOnlyList<string> DOC_ATTR_NAMES = new[] {
        DOC_ATTR_DESCRIPTION,
        DOC_ATTR_TITLE,
        DOC_ATTR_NOTES,
        DOC_ATTR_DEPRECATED,
        DOC_ATTR_REPLACED_BY,
        DOC_ATTR_SEE_ALSO,
        DOC_ATTR_ALIASES,
    };
}
```

- [ ] **Step 2: `DocumentationSchema.cs`** — mirror `commonDocAttrs` shape:

```csharp
using MetaObjects.Core.Attr;
using MetaObjects.Registry;

namespace MetaObjects.Core.Documentation;

public static class DocumentationSchema {
    public static readonly IReadOnlyList<AttrSchema> CommonDocAttrs = new AttrSchema[] {
        new(Name: DocumentationConstants.DOC_ATTR_DESCRIPTION, ValueType: AttrConstants.ATTR_SUBTYPE_STRING, Required: false, Description: "Free-form user-facing prose."),
        new(Name: DocumentationConstants.DOC_ATTR_TITLE, ValueType: AttrConstants.ATTR_SUBTYPE_STRING, Required: false, Description: "Short single-line human label."),
        new(Name: DocumentationConstants.DOC_ATTR_NOTES, ValueType: AttrConstants.ATTR_SUBTYPE_STRING, Required: false, Description: "Internal-only rationale; never emitted to user-facing docs."),
        new(Name: DocumentationConstants.DOC_ATTR_DEPRECATED, ValueType: AttrConstants.ATTR_SUBTYPE_STRING, Required: false, Description: "Text deprecation reason; presence ⇒ deprecated."),
        new(Name: DocumentationConstants.DOC_ATTR_REPLACED_BY, ValueType: AttrConstants.ATTR_SUBTYPE_STRING, Required: false, Description: "FQN reference to the replacement."),
        new(Name: DocumentationConstants.DOC_ATTR_SEE_ALSO, ValueType: AttrConstants.ATTR_SUBTYPE_STRINGARRAY, Required: false, Description: "External documentation URLs."),
        new(Name: DocumentationConstants.DOC_ATTR_ALIASES, ValueType: AttrConstants.ATTR_SUBTYPE_STRINGARRAY, Required: false, Description: "Alternate names."),
    };
}
```

- [ ] **Step 3: `DocumentationTypes.cs`** — provider:

```csharp
using MetaObjects.Registry;

namespace MetaObjects.Core.Documentation;

public static class DocumentationTypes {
    public static IMetaDataTypeProvider DocTypesProvider { get; } = new Provider(
        id: "metaobjects-documentation",
        dependencies: new[] { "metaobjects-core-types" },
        registerTypes: (registry) => registry.RegisterCommonAttributes(DocumentationSchema.CommonDocAttrs)
    );
}
```

> *Implementer note:* if `Provider` is a record/class with a different constructor shape in your codebase, adapt accordingly. Mirror the shape of other static `XTypesProvider` definitions (e.g. `FieldTypes.FieldTypesProvider`).

- [ ] **Step 4: Wire into `CoreTypes.cs`**

Find where providers are composed in `server/csharp/MetaObjects/CoreTypes.cs`. Add:
```csharp
Provider.ComposeRegistry(new[] {
    CoreTypes.CoreTypesProvider,
    DocumentationTypes.DocTypesProvider,
});
```

- [ ] **Step 5: Run conformance to confirm the 4 doc-attrs fixtures pass in C#**

Run: `cd server/csharp && dotnet test --filter Conformance`
Expected: the 4 fixtures pass (the test runner auto-discovers them).

- [ ] **Step 6: Commit**

```bash
git add server/csharp/MetaObjects/Core/Documentation/ server/csharp/MetaObjects/CoreTypes.cs
git commit -m "feat(csharp): documentation provider — constants, schema, provider, wiring

DocumentationProvider registers the 7 common doc attrs via the
RegisterCommonAttributes hook; wired into CoreTypes composition.
Conformance fixtures doc-common-attrs-* pass in C#.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 6 — C# doc-gen Tier 1 (XML doc + `[Obsolete]`)

### Task 6.1 — Shared XML-doc helper + emission on entity classes

**Files:**
- Create: `server/csharp/MetaObjects.Codegen/Docs/XmlDocBuilder.cs`
- Modify: `server/csharp/MetaObjects.Codegen/Generators/EntityGenerator.cs`
- Test: `server/csharp/MetaObjects.Codegen.Tests/DocCommentEmissionTests.cs`

- [ ] **Step 1: Write the failing test**

```csharp
[Fact]
public void Entity_class_emits_summary_remarks_from_description() {
    var src = GenerateEntity(MetaJson(@"{
      ""object.entity"": {
        ""name"": ""User"",
        ""@description"": ""A registered account holder."",
        ""children"": [
          { ""field.long"": { ""name"": ""id"" } },
          { ""identity.primary"": { ""@fields"": [""id""] } }
        ]
      }
    }"));
    Assert.Contains("/// <summary>A registered account holder.</summary>", src);
    Assert.Contains("public class User", src);
}

[Fact]
public void Field_property_emits_summary_and_Obsolete_with_replacedBy() {
    var src = GenerateEntity(MetaJson(@"{
      ""object.entity"": {
        ""name"": ""User"",
        ""children"": [
          { ""field.long"": { ""name"": ""id"" } },
          { ""field.string"": {
              ""name"": ""email"",
              ""@description"": ""Primary email."",
              ""@deprecated"": ""Use contactEmail."",
              ""@replacedBy"": ""User.contactEmail""
          }},
          { ""identity.primary"": { ""@fields"": [""id""] } }
        ]
      }
    }"));
    Assert.Contains("/// <summary>Primary email.</summary>", src);
    Assert.Contains("[Obsolete(\"Use contactEmail. Replaced by User.contactEmail.\")]", src);
}

[Fact]
public void Notes_content_NEVER_appears_in_emitted_source() {
    var src = GenerateEntity(MetaJson(@"{
      ""object.entity"": {
        ""name"": ""U"",
        ""@description"": ""Public."",
        ""@notes"": ""__INTERNAL_MARKER__"",
        ""children"": [
          { ""field.long"": { ""name"": ""id"" } },
          { ""identity.primary"": { ""@fields"": [""id""] } }
        ]
      }
    }"));
    Assert.DoesNotContain("__INTERNAL_MARKER__", src);
}
```

- [ ] **Step 2: Run to confirm FAIL.**

- [ ] **Step 3: `XmlDocBuilder.cs`**

```csharp
using MetaObjects.Core.Documentation;
using MetaObjects.Meta;
using System.Text;

namespace MetaObjects.Codegen.Docs;

public static class XmlDocBuilder {
    /// <summary>Render an XML-doc block + optional [Obsolete] for a MetaData node. Returns ("", null) when no doc attrs are set. notes is intentionally NEVER emitted (D5).</summary>
    public static (string XmlDoc, string? ObsoleteAttribute) Render(MetaData node) {
        var sb = new StringBuilder();
        var desc = node.OwnAttr(DocumentationConstants.DOC_ATTR_DESCRIPTION) as string;
        var title = node.OwnAttr(DocumentationConstants.DOC_ATTR_TITLE) as string;
        var aliases = node.OwnAttr(DocumentationConstants.DOC_ATTR_ALIASES) as IReadOnlyList<string>;
        var seeAlso = node.OwnAttr(DocumentationConstants.DOC_ATTR_SEE_ALSO) as IReadOnlyList<string>;
        var deprecated = node.OwnAttr(DocumentationConstants.DOC_ATTR_DEPRECATED) as string;
        var replacedBy = node.OwnAttr(DocumentationConstants.DOC_ATTR_REPLACED_BY) as string;

        if (desc != null) {
            var (summary, remainder) = SplitSummary(desc);
            sb.AppendLine($"/// <summary>{EscapeXml(summary)}</summary>");
            if (remainder != null) {
                sb.AppendLine("/// <remarks>");
                foreach (var line in remainder.Split('\n')) sb.AppendLine($"/// {EscapeXml(line)}");
                if (aliases?.Count > 0) sb.AppendLine($"/// <para>Aliases: {string.Join(", ", aliases.Select(EscapeXml))}.</para>");
                sb.AppendLine("/// </remarks>");
            } else if (aliases?.Count > 0) {
                sb.AppendLine($"/// <remarks><para>Aliases: {string.Join(", ", aliases.Select(EscapeXml))}.</para></remarks>");
            }
        } else if (title != null) {
            sb.AppendLine($"/// <summary>{EscapeXml(title)}</summary>");
        }
        if (seeAlso != null) {
            foreach (var url in seeAlso) sb.AppendLine($"/// <seealso href=\"{EscapeXml(url)}\"/>");
        }

        string? obsolete = null;
        if (deprecated != null) {
            var msg = replacedBy != null ? $"{deprecated} Replaced by {replacedBy}." : deprecated;
            obsolete = $"[Obsolete(\"{EscapeCsString(msg)}\")]";
        }

        return (sb.ToString().TrimEnd(), obsolete);
    }

    private static (string Summary, string? Remainder) SplitSummary(string s) {
        var idx = s.IndexOf('\n');
        if (idx < 0) return (s, null);
        return (s.Substring(0, idx), s.Substring(idx + 1));
    }

    private static string EscapeXml(string s) =>
        s.Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;");

    private static string EscapeCsString(string s) =>
        s.Replace("\\", "\\\\").Replace("\"", "\\\"");
}
```

- [ ] **Step 4: In `EntityGenerator.cs`, emit `XmlDocBuilder.Render(entity)` above each `public class` line and `XmlDocBuilder.Render(field)` above each property.**

```csharp
var (entityDoc, entityObs) = XmlDocBuilder.Render(entity);
if (!string.IsNullOrEmpty(entityDoc)) sb.AppendLine(entityDoc);
if (entityObs != null) sb.AppendLine(entityObs);
sb.AppendLine($"public class {entity.Name} {{");

foreach (var f in entity.Fields()) {
    var (fieldDoc, fieldObs) = XmlDocBuilder.Render(f);
    if (!string.IsNullOrEmpty(fieldDoc)) sb.AppendLine(Indent(fieldDoc, "    "));
    if (fieldObs != null) sb.AppendLine($"    {fieldObs}");
    sb.AppendLine($"    public {csType} {prop} {{ get; set; }}");
}
```

- [ ] **Step 5: Run tests to confirm PASS. Commit.**

```bash
git add server/csharp/MetaObjects.Codegen/Docs/XmlDocBuilder.cs server/csharp/MetaObjects.Codegen/Generators/EntityGenerator.cs server/csharp/MetaObjects.Codegen.Tests/DocCommentEmissionTests.cs
git commit -m "feat(csharp): emit XML doc + [Obsolete] on entity classes + properties

XmlDocBuilder.Render() reads the 7 doc attrs (sans notes) and produces
/// <summary> / <remarks> / <seealso>, plus [Obsolete] from
deprecated + replacedBy. notes intentionally never emitted (D5).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 6.2 — XML doc on DbSet properties (DbContextGenerator)

**Files:**
- Modify: `server/csharp/MetaObjects.Codegen/Generators/DbContextGenerator.cs`
- Test: extend `DbContextGeneratorTests`

- [ ] **Step 1: Failing test** — entity with `@description` produces XML doc above its `DbSet<>` property in the generated `AppDbContext`.

- [ ] **Step 2: Implement** — above each `public DbSet<User> Users { get; set; }`, render `XmlDocBuilder.Render(entity)` (the same one; just reused on the entity node).

- [ ] **Step 3: Run + commit.**

```bash
git add server/csharp/MetaObjects.Codegen/Generators/DbContextGenerator.cs server/csharp/MetaObjects.Codegen.Tests/DbContextGeneratorTests.cs
git commit -m "feat(csharp): emit XML doc on DbSet properties

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 7 — C# doc-gen Tier 2 (Postgres COMMENT ON)

### Task 7.1 — `PostgresSchema.cs` emits COMMENT ON TABLE / COLUMN

**Files:**
- Modify: `server/csharp/MetaObjects.Codegen/Schema/PostgresSchema.cs`
- Test: extend `PostgresSchemaTests`

- [ ] **Step 1: Failing test mirroring the TS migrate-ts test** — entity with `@description` → `COMMENT ON TABLE` line; field with `@description` → `COMMENT ON COLUMN`; single-quote escaping; no COMMENT when description absent.

- [ ] **Step 2: Implement** — after each `CREATE TABLE` block, iterate the entity + fields and append `COMMENT ON …` lines reading `DocumentationConstants.DOC_ATTR_DESCRIPTION` from each node. Use the existing column-name resolution (`CSharpNaming.Column(field)`). Escape single quotes (`s.Replace("'", "''")`).

- [ ] **Step 3: Run + commit.**

```bash
git add server/csharp/MetaObjects.Codegen/Schema/PostgresSchema.cs server/csharp/MetaObjects.Codegen.Tests/PostgresSchemaTests.cs
git commit -m "feat(csharp): Postgres COMMENT ON TABLE/COLUMN from @description in DDL

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 8 — Java substrate

### Task 8.1 — Java: `registerCommonAttribute` on MetaDataRegistry + constraint-enforcer merge

**Files:**
- Modify: `server/java/metadata/src/main/java/com/metaobjects/registry/MetaDataRegistry.java`
- Modify: the constraint enforcer that today flags unknown attrs (locate via grep for `ERR_UNKNOWN_ATTR` in the Java source)
- Test: `server/java/metadata/src/test/java/com/metaobjects/registry/CommonAttrsTest.java`

- [ ] **Step 1: Failing JUnit test**

```java
package com.metaobjects.registry;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

public class CommonAttrsTest {
    @Test
    public void registerCommonAttribute_isVisibleViaGetter() {
        MetaDataRegistry r = new MetaDataRegistry();
        r.registerCommonAttribute("description", "string", false);
        assertTrue(r.getCommonAttributes().stream().anyMatch(a -> "description".equals(a.name())));
    }

    @Test
    public void registerCommonAttribute_isIdempotentForSameName() {
        MetaDataRegistry r = new MetaDataRegistry();
        r.registerCommonAttribute("title", "string", false);
        r.registerCommonAttribute("title", "string", false);
        assertEquals(1, r.getCommonAttributes().stream().filter(a -> "title".equals(a.name())).count());
    }
}
```

- [ ] **Step 2: Run to confirm FAIL.**

Run: `cd server/java && mvn -pl metadata test -Dtest=CommonAttrsTest`

- [ ] **Step 3: Add the API to MetaDataRegistry** — a `List<CommonAttribute>` field + `registerCommonAttribute(name, type, required)` + `getCommonAttributes()`. Mirror the existing per-type attr-registration idioms in `MetaDataRegistry.java`.

- [ ] **Step 4: In the constraint enforcer** (the class that today raises an unknown-attr error), modify the per-node attr-lookup to first consult `registry.getCommonAttributes()` and treat them as allowed on any type. On per-type collision, raise the equivalent of `ERR_PROVIDER_ATTR_CONFLICT` (using Java's `ErrorCode.ERR_PROVIDER_ATTR_CONFLICT`).

- [ ] **Step 5: Run + commit.**

```bash
git add server/java/metadata/src/main/java/com/metaobjects/registry/MetaDataRegistry.java server/java/metadata/src/main/java/com/metaobjects/...constraint-enforcer-file... server/java/metadata/src/test/java/com/metaobjects/registry/CommonAttrsTest.java
git commit -m "feat(java): registerCommonAttribute on MetaDataRegistry + enforcer merge

Mirrors the TS/C# commonAttrs hook. Constraint enforcer now consults the
common-attrs list; per-type collision raises ERR_PROVIDER_ATTR_CONFLICT.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 8.2 — Java: Documentation constants + schema + provider class

**Files:**
- Create: `server/java/metadata/src/main/java/com/metaobjects/documentation/DocumentationConstants.java`
- Create: `server/java/metadata/src/main/java/com/metaobjects/documentation/DocumentationSchema.java`
- Create: `server/java/metadata/src/main/java/com/metaobjects/documentation/DocumentationMetaDataProvider.java`
- Modify: `server/java/metadata/src/main/resources/META-INF/services/com.metaobjects.registry.MetaDataTypeProvider`

- [ ] **Step 1: `DocumentationConstants.java`** — same 7 names, identical strings to TS/C#.

```java
package com.metaobjects.documentation;

public final class DocumentationConstants {
    private DocumentationConstants() {}
    public static final String DOC_ATTR_DESCRIPTION = "description";
    public static final String DOC_ATTR_TITLE       = "title";
    public static final String DOC_ATTR_NOTES       = "notes";
    public static final String DOC_ATTR_DEPRECATED  = "deprecated";
    public static final String DOC_ATTR_REPLACED_BY = "replacedBy";
    public static final String DOC_ATTR_SEE_ALSO    = "seeAlso";
    public static final String DOC_ATTR_ALIASES     = "aliases";
}
```

- [ ] **Step 2: `DocumentationSchema.java`** — define a record (or simple POJO) per common attr; use the project's existing `AttrSchema` or equivalent. Mirror the C# `CommonDocAttrs` shape.

- [ ] **Step 3: `DocumentationMetaDataProvider.java`**

```java
package com.metaobjects.documentation;

import com.metaobjects.registry.MetaDataRegistry;
import com.metaobjects.registry.MetaDataTypeProvider;
import java.util.List;

public class DocumentationMetaDataProvider implements MetaDataTypeProvider {
    @Override public String getProviderId() { return "metaobjects-documentation"; }
    @Override public List<String> getDependencies() { return List.of("core-base-types"); }
    @Override public void registerTypes(MetaDataRegistry registry) {
        for (var attr : DocumentationSchema.COMMON_DOC_ATTRS) {
            registry.registerCommonAttribute(attr.name(), attr.type(), attr.required());
        }
    }
}
```

- [ ] **Step 4: SPI registration** — append `com.metaobjects.documentation.DocumentationMetaDataProvider` to `server/java/metadata/src/main/resources/META-INF/services/com.metaobjects.registry.MetaDataTypeProvider`. If the file doesn't exist, create it.

- [ ] **Step 5: Run conformance** — the 4 fixtures pass in Java (or run via the existing Java test mechanism; if no conformance harness exists yet for the metadata module, write a minimal load-and-canonicalize unit test that exercises each fixture).

- [ ] **Step 6: Commit.**

```bash
git add server/java/metadata/src/main/java/com/metaobjects/documentation/ server/java/metadata/src/main/resources/META-INF/services/com.metaobjects.registry.MetaDataTypeProvider
git commit -m "feat(java): documentation provider — constants, schema, provider, SPI

DocumentationMetaDataProvider registers the 7 common doc attrs via
registerCommonAttribute. SPI-registered via META-INF/services. Conformance
fixtures doc-common-attrs-* pass in Java.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 9 — Python substrate

### Task 9.1 — Python: `register_common_attrs` on the registry

**Files:**
- Modify: `server/python/src/metaobjects/registry.py` (or wherever the registry/provider lives — locate via grep for `class Registry` or `provider.register`)
- Test: `server/python/tests/unit/test_common_attrs.py`

- [ ] **Step 1: Failing pytest**

```python
def test_register_common_attrs_adds_to_get_common_attrs():
    from metaobjects.registry import Registry, AttrSchema, ATTR_SUBTYPE_STRING
    r = Registry()
    r.register_common_attrs([AttrSchema(name="description", value_type=ATTR_SUBTYPE_STRING, required=False)])
    assert any(a.name == "description" for a in r.get_common_attrs())

def test_register_common_attrs_is_idempotent_for_same_name():
    from metaobjects.registry import Registry, AttrSchema, ATTR_SUBTYPE_STRING
    r = Registry()
    a = AttrSchema(name="title", value_type=ATTR_SUBTYPE_STRING, required=False)
    r.register_common_attrs([a])
    r.register_common_attrs([a])
    assert len([x for x in r.get_common_attrs() if x.name == "title"]) == 1
```

- [ ] **Step 2: Run to confirm FAIL.**

Run: `cd server/python && uv run --extra dev pytest tests/unit/test_common_attrs.py -v`

- [ ] **Step 3: Add `common_attrs` + `register_common_attrs` + `get_common_attrs` to the Python registry.**

Python is already lenient about unknown attrs (per prior research), so the registration here is largely declarative. Still, formalize the API so the cross-port contract holds.

- [ ] **Step 4: Run + commit.**

```bash
git add server/python/src/metaobjects/registry.py server/python/tests/unit/test_common_attrs.py
git commit -m "feat(python): register_common_attrs on Registry

Mirrors TS/C#/Java commonAttrs hook. Python's lenient attr handling
means runtime behavior is largely unchanged; the registration formalizes
the cross-port contract.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 9.2 — Python: documentation constants + schema + provider

**Files:**
- Create: `server/python/src/metaobjects/meta/documentation/__init__.py` (empty)
- Create: `server/python/src/metaobjects/meta/documentation/doc_constants.py`
- Create: `server/python/src/metaobjects/meta/documentation/doc_schema.py`
- Create: `server/python/src/metaobjects/meta/documentation/doc_provider.py`
- Modify: `server/python/src/metaobjects/core_types.py`

- [ ] **Step 1: `doc_constants.py`**

```python
DOC_ATTR_DESCRIPTION = "description"
DOC_ATTR_TITLE       = "title"
DOC_ATTR_NOTES       = "notes"
DOC_ATTR_DEPRECATED  = "deprecated"
DOC_ATTR_REPLACED_BY = "replacedBy"
DOC_ATTR_SEE_ALSO    = "seeAlso"
DOC_ATTR_ALIASES     = "aliases"

DOC_ATTR_NAMES = (
    DOC_ATTR_DESCRIPTION,
    DOC_ATTR_TITLE,
    DOC_ATTR_NOTES,
    DOC_ATTR_DEPRECATED,
    DOC_ATTR_REPLACED_BY,
    DOC_ATTR_SEE_ALSO,
    DOC_ATTR_ALIASES,
)
```

- [ ] **Step 2: `doc_schema.py`**

```python
from metaobjects.registry import AttrSchema, ATTR_SUBTYPE_STRING, ATTR_SUBTYPE_STRINGARRAY
from .doc_constants import (
    DOC_ATTR_DESCRIPTION, DOC_ATTR_TITLE, DOC_ATTR_NOTES, DOC_ATTR_DEPRECATED,
    DOC_ATTR_REPLACED_BY, DOC_ATTR_SEE_ALSO, DOC_ATTR_ALIASES,
)

common_doc_attrs = [
    AttrSchema(name=DOC_ATTR_DESCRIPTION, value_type=ATTR_SUBTYPE_STRING, required=False, description="Free-form user-facing prose."),
    AttrSchema(name=DOC_ATTR_TITLE, value_type=ATTR_SUBTYPE_STRING, required=False, description="Short single-line human label."),
    AttrSchema(name=DOC_ATTR_NOTES, value_type=ATTR_SUBTYPE_STRING, required=False, description="Internal-only rationale; never emitted to user-facing docs."),
    AttrSchema(name=DOC_ATTR_DEPRECATED, value_type=ATTR_SUBTYPE_STRING, required=False, description="Text deprecation reason."),
    AttrSchema(name=DOC_ATTR_REPLACED_BY, value_type=ATTR_SUBTYPE_STRING, required=False, description="FQN reference to the replacement."),
    AttrSchema(name=DOC_ATTR_SEE_ALSO, value_type=ATTR_SUBTYPE_STRINGARRAY, required=False, description="External documentation URLs."),
    AttrSchema(name=DOC_ATTR_ALIASES, value_type=ATTR_SUBTYPE_STRINGARRAY, required=False, description="Alternate names."),
]
```

- [ ] **Step 3: `doc_provider.py`**

```python
from metaobjects.provider import Provider
from .doc_schema import common_doc_attrs

doc_provider = Provider("metaobjects-documentation", dependencies=("metaobjects-core-types",))

@doc_provider.register
def _register_doc_types(registry):
    registry.register_common_attrs(common_doc_attrs)
```

- [ ] **Step 4: Wire in `core_types.py`** — import `doc_provider` and include it in the `compose_registry(...)` call alongside the existing `core_provider`.

- [ ] **Step 5: Run conformance to confirm the 4 fixtures pass in Python**

Run: `cd server/python && uv run --extra dev pytest tests/conformance -k doc-common-attrs -v`
Expected: 4 PASS.

- [ ] **Step 6: Commit**

```bash
git add server/python/src/metaobjects/meta/documentation/ server/python/src/metaobjects/core_types.py
git commit -m "feat(python): documentation provider — constants, schema, provider, wiring

Conformance fixtures doc-common-attrs-* pass in Python.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 10 — Cross-language verification + status docs

### Task 10.1 — Verify all four ports green

- [ ] **Step 1: TS**

```bash
cd server/typescript && bun test
```
Expected: all green; full suite count up by the new metadata + codegen + migrate tests; conformance corpus runs the 4 new fixtures.

- [ ] **Step 2: C#**

```bash
cd server/csharp && dotnet test
```
Expected: all green; conformance test project picks up the 4 new fixtures; codegen tests cover XML-doc + `[Obsolete]` + Postgres `COMMENT ON`.

- [ ] **Step 3: Python**

```bash
cd server/python && uv run --extra dev pytest
```
Expected: all green; conformance test class picks up the 4 new fixtures.

- [ ] **Step 4: Java**

```bash
cd server/java && mvn -pl metadata test
```
Expected: all green except the known pre-existing `corpusSpotCheck_*` env errors (not introduced by this work).

---

### Task 10.2 — Update CLAUDE.md cross-language vocabularies

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add an entry to the "Metamodel subtype vocabularies (must be identical across languages)" list**

After the existing vocabularies, add:

```markdown
- Documentation common attrs (any node): `description`, `title`, `notes`, `deprecated`, `replacedBy`, `seeAlso`, `aliases`. Registered via the cross-language `commonAttrs` registry hook (`registerCommonAttrs` / `RegisterCommonAttributes` / `registerCommonAttribute` / `register_common_attrs`). `notes` is the internal-only rationale slot — never emitted to user-facing doc-gen. See `docs/superpowers/specs/2026-05-24-documentation-provider-design.md`.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude-md): document the doc common-attrs cross-language vocabulary

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 10.3 — Mark the spec implemented

**Files:**
- Modify: `docs/superpowers/specs/2026-05-24-documentation-provider-design.md`

- [ ] **Step 1: Flip status header**

Change the second line from:
```
**Status:** Approved (design)
```
to:
```
**Status:** Implemented across TS, C#, Java, Python (YYYY-MM-DD)
```

(Use the actual implementation-merge date.)

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/2026-05-24-documentation-provider-design.md
git commit -m "docs(documentation-provider): mark spec implemented across all four ports

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Self-review notes

- **Spec coverage:** All Section D1–D10 decisions are implemented: D1 (7 attrs) in Phases 1/5/8/9; D2 (commonAttrs hook) in Tasks 1.2/5.1/8.1/9.1; D3 (conflict policy) in Tasks 1.3/5.1/8.1; D4 (DocumentationProvider per port) in Tasks 1.4/5.2/8.2/9.2; D5 (notes internal-only) in Tasks 2.1/2.4/6.1; D6 (behavior derivation) is a contract documented in the spec — no code changes needed since the rules are read by future codegen consumers; D7 (3 tiers TS, 2 tiers C#) in Phases 2/3/4/6/7; D8 (Mermaid TS-only) in Phase 4; D9 (defer examples / annotations / writeOnly) honored by their absence; D10 (Spec 1 of 2) — no code change. Conformance fixtures from Section "Conformance fixtures" in the spec are all in Task 1.1. The behavior-derivation table (D6) is captured in the spec and consumed by codegen authors when needed.
- **Naming consistency:** `description` / `title` / `notes` / `deprecated` / `replacedBy` / `seeAlso` / `aliases` used identically across all four ports' constants + schemas + tests + fixtures.
- **Bare names per ADR-0006:** All constants use bare names; the `@`-prefix is added by the serializer on canonical-JSON output. Fixtures use `@`-prefixed canonical-JSON form.
- **Deferred items deliberately untouched:** `examples`, `annotations`, `writeOnly`, governance, behavior-hint attrs as authored — none added; the `documentation` family is not introduced at all (universal common attrs only).

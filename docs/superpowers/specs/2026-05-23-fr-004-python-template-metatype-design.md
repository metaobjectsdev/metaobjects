# Python port: the `template.*` metatype (FR-004)

- **Date:** 2026-05-23
- **Status:** ⏸️ **PINNED (2026-05-23)** — see banner below. This metatype-only slice is superseded by a full-pillar intent that is on hold pending the Python codegen + persistence foundation.
- **Scope (as written):** Metadata type only (loader/serializer/conformance). No render engine, no `verify`, no typed accessors, no load-time reference resolution.
- **References:**
  - TS commit `f707fac` — `refactor(metadata): generalize prompt.* → template.{prompt,output} + @format [FR-004]`
  - **C# commit `23d8dcb` — `feat(csharp/metadata): port the template (fourth-pillar) metatype (FR-004)`** — the direct, shipped, green reference for this exact port.

## ⏸️ Pin note (2026-05-23) — read this first

Work on Python FR-004 is **paused**. During design we established that the *full* Python
prompt-construction pillar (render engine + `verify` + typed payload/handle codegen) sits on
top of two foundations Python does **not** have yet: **codegen** and **database persistence /
runtime**. Python is currently loader + conformance only. Building FR-004 now would be roofing
before the walls are up. Decision: **finish the Python codegen + persistence foundation first,
then resume FR-004.**

Decisions captured for the resume (do not re-litigate):

- **Full-pillar scope** (not just this metatype slice): metatype (Plan 1) + `origin.collection`
  + load-time validation (Plan 3A) + render engine (Plan 2, a new isolated `metaobjects_render`
  package over **pystache**, partials **pre-expanded** by recursive inlining for byte-identical
  whitespace, format-keyed escaper registry incl. OWASP CSV/spreadsheet injection guard, cycle
  guard MAX_DEPTH 32) + `verify` (Plan 3C). Mirror the shipped TS `packages/render/` and the
  in-progress C# `MetaObjects.Render/`.
- **`@payloadRef` / `@requiredSlots` resolution is LOAD-TIME** (matches TS `validateTemplatePayloadRefs`
  → `ERR_INVALID_TEMPLATE`, and the shared `ERROR-CODES.json` description). Consequences:
  (1) the `template-prompt-simple` and `template-output-and-prompt` fixtures **must be fixed** to
  define the `NpcPromptPayload` `object.value`; (2) **C# must add** the load-time check it currently
  defers (`CoreTypes.cs` comment says render-time — that becomes the outlier to reconcile). This
  reverses the earlier "document, don't touch corpus" call, which was made under the metatype-only
  scope. The §7/§8 sections below are therefore **superseded** by this decision.
- **Phase B codegen (typed payload VO + render handle) was the trigger for the pin** — it needs a
  Python codegen substrate that doesn't exist. It comes back *after* the foundation work.

Shared test data is the cross-language contract: the same `fixtures/conformance/` (metadata) and
`fixtures/render-conformance/` (templates) drive TS, C#, and Python. Coordinate corpus changes
(the `NpcPromptPayload` fixture fix; new load-time error fixtures) with the parallel C# build.

The body below is the original metatype-only design, preserved for provenance.

---

## 1. Context & goal

FR-004 (the fourth pillar — cross-language prompt construction) introduces a new base
metatype `template`: a renderable text artifact bound to a typed payload. TypeScript and
C# have both shipped the **metadata layer** of this type:

- Base type `template` with two subtypes by audience/structure (not by format):
  - `template.prompt` — LLM-targeted; carries the prompt-overlay attrs.
  - `template.output` — every other rendered artifact (email, export, docs, config).
- Format is the closed-enum `@format` **attribute**, never a subtype, so a new format
  costs one escaper + one enum value, not a new subtype + cross-language port.
- A single `MetaTemplate` class backs both subtypes (mirrors `MetaSource`); per-subtype
  attribute schemas drive validation.
- **Reference resolution (`@payloadRef`) is render-time `verify` scope, NOT load-time** —
  stated in both the TS `template-schema.ts` and C# `TemplateSchema.cs` / `CoreTypes.cs`
  comments. The metadata layer treats `@payloadRef` / `@textRef` as plain strings.

This port brings that metadata layer to Python so the Python loader parses, validates, and
round-trips `template.*` nodes identically to TS and C#.

**The oracle** is the conformance corpus. Three fixtures exercise this type (all currently
in Python's expected-failures ledger as known gaps):

| Fixture | Kind | Asserts |
|---|---|---|
| `template-prompt-simple` | round-trip | a `template.prompt` round-trips clean |
| `template-output-and-prompt` | round-trip | both subtypes round-trip clean |
| `error-template-prompt-missing-payload-ref` | error | `template.prompt` without `@payloadRef` → `ERR_MISSING_REQUIRED_ATTR` |

**Success** = all three classify `pass` and are removed from the Python ledger, with the
full Python unit + conformance suite green. **The shared corpus is not modified**, so
TS / C# / Java conformance is unaffected by definition.

## 2. Reference implementation — mirror C#, don't re-derive

Per the cross-language-porting principle "study reference implementations; don't re-derive
from spec," C# (`23d8dcb`) is the model to follow. It is structurally identical to what this
design proposes, it ships green with an **empty conformance ledger** (passes all three
template fixtures as written), and it makes the same scope cut: no load-time payloadRef
resolution. The C# layout maps 1:1 to Python:

| C# (`server/csharp/MetaObjects/`) | Python (`server/python/src/metaobjects/`) |
|---|---|
| `Template/TemplateConstants.cs` | `meta/template/template_constants.py` |
| `Template/TemplateSchema.cs` (`TemplateAttrsMap`) | inline in `core_types.py` (Python convention) |
| `Meta/MetaTemplate.cs` | `meta/template/meta_template.py` |
| `CoreTypes.cs` registration loop + `Wildcard(TYPE_TEMPLATE)` on root | `core_types.py` loop + `ChildRule(TYPE_TEMPLATE, "*")` on root |

The only intentional layout difference: C# colocates the attr schemas in a `TemplateSchema`
class; Python's established convention puts all attr schemas inline in `core_types.py`
(there are no `*_schema.py` modules — source/origin/identity/layout schemas all live there).

## 3. Governing decisions

There is no dedicated "template" ADR. The governing documents are:

- **FR-004 design spec** (`docs/superpowers/specs/2026-05-22-fr-004-cross-language-prompt-construction-design.md`, revision R1/R2/R7) — defines the type, subtypes, the `@format` closed enum, and the per-subtype attr split.
- **ADR-0002 (open-closed typed nodes)** — `MetaTemplate` is a single class for both
  subtypes; the loader dispatches by subtype and per-subtype attr schemas drive validation.
- **ADR-0004 (provider-based type registration)** — the type enters the registry via the
  core provider's composable registration, not a hardcoded switch.
- **ADR-0003 (metamodel-constants colocation)** — subtype/attr-name constants live with the
  type, in a `template_constants.py` colocated in the new `meta/template/` package.

## 4. Tier classification (cross-language-porting)

- **Tier 1 — invariant, copy exactly:** type name `template`; subtypes `prompt` / `output`
  / `base`; reserved attr names (`payloadRef`, `textRef`, `format`, `maxChars`, `owner`,
  `since`, `maxTokens`, `requiredSlots`, `model`); the closed `@format` enum
  (`text, html, xml, csv, json, markdown, spreadsheet`); `@payloadRef` + `@textRef`
  required on both concrete subtypes; the LLM-overlay attrs belong to `prompt` only;
  error code `ERR_MISSING_REQUIRED_ATTR`.
- **Tier 3 — idiomatic/free:** file layout (a `meta/template/` peer package), and defining
  the attr schemas inline in `core_types.py`.

## 5. Design — Python changes

### 5.1 New package `server/python/src/metaobjects/meta/template/`

A peer to `meta/core/`, `meta/persistence/`, `meta/presentation/` (mirrors TS `src/template/`
and C# `Template/`).

**`__init__.py`** — empty package marker (matches siblings).

**`template_constants.py`** — mirrors TS `template-constants.ts` / C# `TemplateConstants.cs`:

```python
"""template.* subtype vocabulary + reserved attribute names (FR-004, R1)."""
from ...shared.base_types import SUBTYPE_BASE  # 3 dots: meta/template is one level shallower than meta/persistence/source

TEMPLATE_SUBTYPE_PROMPT = "prompt"
TEMPLATE_SUBTYPE_OUTPUT = "output"
TEMPLATE_SUBTYPES = (SUBTYPE_BASE, TEMPLATE_SUBTYPE_PROMPT, TEMPLATE_SUBTYPE_OUTPUT)

# Generic reserved attrs (both subtypes). The "@" is applied at wire time.
TEMPLATE_ATTR_PAYLOAD_REF = "payloadRef"
TEMPLATE_ATTR_TEXT_REF = "textRef"
TEMPLATE_ATTR_FORMAT = "format"
TEMPLATE_ATTR_MAX_CHARS = "maxChars"
TEMPLATE_ATTR_OWNER = "owner"
TEMPLATE_ATTR_SINCE = "since"

# Prompt-overlay attrs (template.prompt only).
TEMPLATE_ATTR_MAX_TOKENS = "maxTokens"
TEMPLATE_ATTR_REQUIRED_SLOTS = "requiredSlots"
TEMPLATE_ATTR_MODEL = "model"

# Closed format set — the render engine keys its escaper off this (FR-004 R7).
TEMPLATE_FORMAT_DEFAULT = "text"
TEMPLATE_FORMATS = ("text", "html", "xml", "csv", "json", "markdown", "spreadsheet")
```

**`meta_template.py`** — exact mirror of `MetaSource`:

```python
"""MetaTemplate — template.prompt / template.output node."""
from __future__ import annotations

from ..meta_data import MetaData  # 2 dots: meta/template/meta_template.py -> meta/meta_data.py


class MetaTemplate(MetaData):
    pass
```

### 5.2 `shared/base_types.py` — add the type name

```python
TYPE_TEMPLATE = "template"
```

Python keeps no `BASE_TYPES` tuple (unlike TS), so this is the only change here.

### 5.3 `core_types.py` — register the three subtypes

Template's attrs differ per subtype (base=`[]`, output=generic, prompt=generic+overlay), so
the shared `_register_subtypes` helper (same attrs for all subtypes) does not fit — template
uses an explicit loop, exactly as `layout` does for its dataGrid-vs-base split and as C#'s
`TemplateAttrsMap` loop does:

```python
_template_generic_attrs = [
    AttrSchema(TEMPLATE_ATTR_PAYLOAD_REF, ATTR_SUBTYPE_STRING, required=True),
    AttrSchema(TEMPLATE_ATTR_TEXT_REF,    ATTR_SUBTYPE_STRING, required=True),
    AttrSchema(TEMPLATE_ATTR_FORMAT,      ATTR_SUBTYPE_STRING,
               allowed_values=TEMPLATE_FORMATS, default=TEMPLATE_FORMAT_DEFAULT),
    AttrSchema(TEMPLATE_ATTR_MAX_CHARS,   ATTR_SUBTYPE_INT),
    AttrSchema(TEMPLATE_ATTR_OWNER,       ATTR_SUBTYPE_STRING),
    AttrSchema(TEMPLATE_ATTR_SINCE,       ATTR_SUBTYPE_STRING),
]
_template_prompt_attrs = _template_generic_attrs + [
    AttrSchema(TEMPLATE_ATTR_MAX_TOKENS,     ATTR_SUBTYPE_INT),
    AttrSchema(TEMPLATE_ATTR_REQUIRED_SLOTS, ATTR_SUBTYPE_STRINGARRAY),
    AttrSchema(TEMPLATE_ATTR_MODEL,          ATTR_SUBTYPE_STRING),
]
for _sub in TEMPLATE_SUBTYPES:
    _attrs = (
        _template_prompt_attrs if _sub == TEMPLATE_SUBTYPE_PROMPT
        else _template_generic_attrs if _sub == TEMPLATE_SUBTYPE_OUTPUT
        else []
    )
    core_provider.add(
        TypeDefinition(
            type=TYPE_TEMPLATE,
            sub_type=_sub,
            factory=MetaTemplate,
            attrs=list(_attrs),
            child_rules=[ChildRule(TYPE_ATTR, "*")],
        )
    )
```

Plus add `ChildRule(TYPE_TEMPLATE, "*")` to the existing `metadata.root` registration.

> **Note — child rules are data-parity only in Python.** The Python parser rejects only
> unknown type / unknown subtype (`ERR_UNKNOWN_TYPE` / `ERR_UNKNOWN_SUBTYPE`); it does not
> enforce child-rule membership (no `ERR_INVALID_SUBTYPE_CHILD`). So template nodes parse at
> root the instant `(template, prompt|output|base)` are registered. The `metadata.root`
> child-rule addition mirrors TS/C# for registry-data fidelity and future-proofing, not as a
> functional gate.

`default=TEMPLATE_FORMAT_DEFAULT` on `@format` is included for schema parity with TS/C# but
is **inert** in Python — `AttrSchema.default` is never materialized into the tree (verified:
zero readers). It is also moot for the corpus, since no fixture omits `@format`.

### 5.4 `tests/unit/test_registry_completeness.py` — extend coverage

Add `(TYPE_TEMPLATE, TEMPLATE_SUBTYPES)` to the hardcoded `_EXPECTED` list (plus the matching
imports). This test only asserts that *listed* types resolve, so it would not fail without
the addition — but coverage of the new type requires it.

### 5.5 `tests/conformance/conformance-expected-failures.json` — de-list

Remove the three template fixtures, leaving only `origin-collection-simple`.

## 6. Why this is all that is needed

- **Validation is free.** `_validate_attr_schema` in `loader/validation_passes.py` walks
  every node, reads `registry.attrs_of(type, subtype)`, and enforces required + type +
  allowed-values generically. Registering the schemas is the entire validation story — the
  error fixture's `ERR_MISSING_REQUIRED_ATTR` falls out automatically, and a bad `@format`
  would yield `ERR_BAD_ATTR_VALUE` for free.
- **Serialization is free.** The serializer emits `{f"{type}.{subtype}": body}` with
  alphabetized attrs and authored child order — no per-type code. The two round-trip fixtures
  pass once the nodes parse.
- **No load-time reference resolution.** Matching C# exactly: `@payloadRef` / `@textRef` are
  plain strings at load time; resolution is render-time `verify` scope (out of scope here).
- **The prompt-overlay attrs ship now** (even though the render engine is later) because
  metamodel vocabulary is a Tier-1 invariant that must be identical across languages — exactly
  as TS and C# shipped them.

## 7. Corpus: unchanged

The shared `fixtures/conformance/` corpus is **not modified** by this port.

The two round-trip fixtures reference a payload (`@payloadRef: "NpcPromptPayload"`) that is
not defined in the fixture. This is **correct for the metadata layer**: a template may
reference a payload that is resolved later, at render time. C# proves this — it ships green
with an empty ledger and passes both fixtures unmodified, precisely because it does no
load-time payloadRef resolution. The Python port behaves identically.

## 8. Cross-language observations (follow-up escalations — not blocking)

Investigating the corpus surfaced two pre-existing inconsistencies in **TypeScript** that
this port deliberately does **not** replicate. Both are recorded here for a future owner;
neither blocks this port and neither requires a corpus change.

1. **TS resolves `@payloadRef` at load time, against the documented design.** TS's loader
   runs `validateTemplatePayloadRefs` (FR-004 Plan #3), which resolves `@payloadRef` to a
   known object and emits `ERR_INVALID_TEMPLATE` when it fails — at *load* time. This
   contradicts the design intent stated in TS's own `template-schema.ts` and in C#
   (`CoreTypes.cs`): reference resolution is render-time `verify` scope, NOT load-time. As a
   result the TS loader emits a spurious error on `template-prompt-simple`.

2. **The TS conformance harness is more lenient than Python's.** TS's `runner.ts` compares
   the serialized tree and asserts no *warnings* for round-trip fixtures, but never asserts
   the error list is empty — so the spurious error from (1) goes unnoticed. Python's
   `test_conformance.py` blocks tree comparison on *any* loader error
   (`tree_blocked = codes and not has_expected_errors and has_expected`). The two harnesses
   should be reconciled (most likely: have the TS harness also assert no unexpected errors on
   round-trip fixtures) so the corpus cannot encode a model one language considers invalid
   and another silently accepts.

Because this port adds no load-time payloadRef pass (mirroring C#), neither inconsistency
affects Python conformance. They matter only if/when a load-time payloadRef-resolution pass
is ported — which, per the documented design, should not happen at load time at all.

## 9. Testing plan (TDD)

**New `tests/unit/test_template.py`** — mirrors TS `template.test.ts`:
- `template` registers; subtype constants are `prompt` / `output`.
- Load `template.prompt` + `template.output` → no errors.
- Round-trip a `template.prompt` through the canonical serializer (attrs alphabetized).
- `template.prompt` missing `@payloadRef` → error; `template.output` missing `@textRef` → error.
- `@format` outside the enum → error.
- Unknown subtype `template.bogus` → error (`ERR_UNKNOWN_SUBTYPE`).

**Conformance** — the runner auto-discovers the three de-listed fixtures; each must classify
`pass` (not `fixed-but-listed`).

**Registry completeness** — the parametrized `template.*` cases resolve in the composed
registry.

## 10. Verification

```
cd server/python
.venv/bin/pytest -q                                  # full unit + conformance suite green
.venv/bin/pytest -q tests/unit/test_template.py      # new unit tests
.venv/bin/pytest -q tests/conformance                # 3 template fixtures classify pass
```

No TS / C# / Java re-verification is required — the shared corpus is untouched.

Done when: the three template fixtures classify `pass`, the Python ledger lists only
`origin-collection-simple`, and the full Python suite is green.

## 11. Out of scope

- The render engine and `verify` step (FR-004 Plan #2/#3) — including any load-time or
  render-time `@payloadRef` resolution and `@requiredSlots` checking.
- Typed accessors on `MetaTemplate` (attrs read generically via the base node API).
- Modifying the shared conformance corpus.
- Reconciling the TS load-time payloadRef pass and the TS/Python harness asymmetry (§8) —
  tracked as follow-ups for a future owner.

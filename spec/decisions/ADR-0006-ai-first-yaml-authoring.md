# ADR-0006 — AI-first YAML authoring (sigil-free YAML; JSON stays canonical)

**Status:** Accepted (2026-05-24) — TypeScript implementation shipped.

**Related:** ADR-0004 (per-subtype attr schemas), ADR-0007 (source v2), the enum datatype design
(`docs/superpowers/specs/2026-05-23-enum-datatype-design.md`, which defers its YAML spelling here).

## Context

MetaObjects has an optional **YAML authoring front-end** that lowers to canonical JSON metadata
(`parser-yaml.ts` → `yaml-desugar.ts` → the shared `buildTree`). **Canonical JSON is the
cross-language interchange + conformance form** and is *unchanged* by this ADR: reserved
structural keys are bare; inline attributes are `@`-prefixed.

Configs are **AI-first** — Claude generates this metadata — so the authoring format must minimize
silent footguns and "multiple ways to say the same thing." Four problems with YAML today:

1. **`@` is a YAML reserved indicator.** `@dbColumn:` is a hard parse failure; you must write
   `"@dbColumn":`. A frequent AI mistake.
2. **YAML 1.2 core-schema coercion.** Unquoted `true/false`, `null/~`, and numeric tokens coerce
   to bool/null/number; the original text is unrecoverable after parse — dangerous for domain data
   (enum members, codes, names).
3. **Too many equivalent forms** (bare-type defaults, scalar-vs-map body, scalar-vs-array values)
   raise AI error rate.
4. **YAML is not conformance-tested**, and only the TS `FileMetaDataLoader` loads it.

## Decision

- **D1 — Sigil-free YAML authoring.** A **closed set of structural keys** (`name`, `package`,
  `extends`, `abstract`, `overlay`, `isArray`, `children`, `value`, plus the single
  `type.subType` wrapper). **Any other body key is an attribute**; the desugar re-adds the `@`
  when lowering to canonical JSON. **Canonical JSON is unchanged** — it keeps reserved-bare +
  `@`-attributes. This removes the `@`-quoting footgun entirely. *(Corollary for the JSON path:
  in canonical JSON, `@`-prefixing a reserved word — e.g. `@isArray` — is invalid →
  `ERR_RESERVED_ATTR`. Mostly a hand-edited-JSON guard; humans author YAML.)*
- **D2 — Type-coercion guard.** (a) House rule: quote domain-data string scalars. (b)
  Deterministic backstop: when the schema declares a value's type, the loader **rejects** a value
  that parsed as a different JS type (bool/number/null) with a clear, located "quote this value"
  error. Never silently accept a coerced value. (Schema-guided parsing where feasible.)
- **D3 — Reduce degrees of freedom.** Define the single AI **house style** Claude always emits:
  explicit `type.subType`; one consistent body form; quoted string values. The desugar may still
  *accept* human shorthand; optionally lint-warn toward house style.
- **D4 — First-class + conformance-tested, TS-only scope.** YAML stays a **TS-only authoring
  front-end**; **canonical JSON remains the sole cross-language interchange** (only TS has a YAML
  loader). Add YAML conformance fixtures exercising sigil-free attributes + the coercion guard.

## Consequences

- Changes are **TS-only** (`core/parser-yaml.ts`, `core/yaml-desugar.ts`, the schema-validation
  pass for D2, constants, tests + new YAML fixtures). **Canonical JSON, the other ports, and the
  conformance oracle are unchanged.**
- **Enum coordination:** `field.enum`'s `values:` (YAML) / `@values` (canonical JSON) follows D1.
- **Sequencing:** built **last** in the source-v2 rollout — YAML authoring desugars to the
  canonical vocabulary, so source v2 + the persistence attrs must be final first.
- Low blast radius: YAML is optional + currently unexercised; the canonical form doesn't move.

## Alternatives considered

- **Purge `@` from canonical JSON too** (bare everywhere). Maximally uniform, but migrates 4
  serializers + every `expected.json` for a cosmetic win, and removes the explicit attribute
  marker from the wire/oracle form. The canonical form staying stable + marked is worth more.
  Rejected — sigil-free *authoring* (YAML) achieves the AI-ergonomics goal without touching the
  canonical contract.
- **Keep `@` in YAML (quoted).** The footgun being removed. Rejected.
- **`_`-prefix on reserved words.** YAML-safe but marks the *frequent* set (`name`/`children`)
  and uglifies the canonical form. Rejected.

## Realization status

- **Spec:** `spec/wire-format.md` (canonical key model, unchanged), this ADR (YAML layer), and
  `spec/yaml-house-style.md` (D3 author-facing rules).
- **TypeScript:** D1 + D2 + D3 + D4 shipped — `core/yaml-desugar.ts` (sigil-free attrs +
  type-coercion guard via `ERR_YAML_COERCION`), `spec/yaml-house-style.md`, and a TS-only YAML
  conformance corpus under `server/typescript/packages/metadata/test/fixtures/yaml-conformance/`.
  **Other ports: out of scope** (canonical JSON is the cross-language interchange).

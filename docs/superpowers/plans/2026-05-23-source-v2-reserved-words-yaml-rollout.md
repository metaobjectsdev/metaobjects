# Rollout — source v2 + persistence attrs + reserved-word enforcement + AI-first YAML

> **Master sequencing plan.** This is the roadmap; each stage gets its own detailed TDD plan
> (via `superpowers:writing-plans`) when it starts. Execute stages in isolated worktrees off the
> latest `main`; per-unit `review + simplify` then merge forward + push (the standing gate).

**Goal:** land the reconciled metamodel design — `source` v2, the consolidated persistence
attributes (incl. explicit referential actions), the canonical reserved-word enforcement, and
sigil-free AI-first YAML — across the language ports.

**Authoritative design docs (read first):**
- `spec/decisions/ADR-0006-ai-first-yaml-authoring.md` — sigil-free YAML; canonical JSON keeps `@`.
- `spec/decisions/ADR-0007-source-v2-paradigm-subtypes-multisource.md` — source paradigm subtypes.
- `docs/superpowers/specs/2026-05-23-source-v2-paradigm-subtypes-multisource-design.md`
- `docs/superpowers/specs/2026-05-23-persistence-attributes-cross-language-design.md`
- `spec/wire-format.md` (canonical key model), `spec/conformance-tests.md` (corpus contract).

## Decided defaults (open forks — ratified; override before the relevant stage if desired)
- **`@onDelete` defaults from relationship subtype:** composition→`cascade`, aggregation→`set-null` (relation must be optional), association→`restrict`. `@onUpdate` default `cascade`. Value set = the existing `FkAction` union `cascade|set-null|restrict|no-action` (no `setDefault`).
- **`@softDelete`:** object-level (a `deletedAt` timestamp mode + read-filter); cascade-soft-delete deferred.
- **`@version`:** field-level `@version: true` (optimistic lock).
- **Gating:** referential actions + `@storage` round-trip in the shared conformance corpus; physical-type escape hatch (`@columnType`) is codegen-only (golden tests).

## Order & rationale
Canonical form first (source v2 + persistence + enforcement), TS-first; sigil-free YAML **last**
(it desugars to the canonical vocab, so that vocab must be final). There is **no canonical
`@`-purge** — canonical JSON keeps `@`; the only `@` work is (a) `ERR_RESERVED_ATTR` enforcement,
which rides source v2 because `@name`→`@table` is its prerequisite, and (b) the YAML sigil-drop
(last). **C# is held** (gated in its conformance ledger) per decision; do TS → Java → Python.

---

## Stage 1 — Source v2 + persistence in TypeScript (the reference). The backbone.

**1a · Shared corpus migration** (language-agnostic; the contract).
- Migrate every `source.*` fixture: `source.dbTable`→`source.rdb` (kind defaults to `table`);
  `source.dbView`→`source.rdb` + `@kind: view`; `@name`→`@table`; field `@dbColumn`→`@column`.
- Add fixtures: a reserved-word error (`@isArray` → `ERR_RESERVED_ATTR`); a referential-action
  fixture (relationship `@onDelete`/`@onUpdate`); a multi-source `@role` fixture; the no-primary /
  multiple-primary error fixtures.
- Regenerate every affected `expected.json` from canonical output. Gate the new/changed fixtures
  in the **Java/Python/C#** expected-failures ledgers until each port implements the stage.

**1b · TS loader.** Register `source.rdb` (+ `@kind`/`@role`/`@table`/`@schema` schemas), drop
`dbTable`/`dbView`; multi-source validation (exactly one `primary`); add `@onDelete`/`@onUpdate`
to the relationship schema (`allowedValues = FkAction`); land `ERR_RESERVED_ATTR` (the parser
check is already drafted; safe once `@name` is gone). Conformance green.

**1c · TS codegen/runtime/migrate consumers.** Read-only off `@kind` (not the subtype); source
name off `@table`, field off `@column`; **route by `@role`** (primary = CRUD; index/cache/publish
derived — degrade gracefully when absent). Golden/contract tests green.

**1d · Referential actions (low-effort, high-value).** Thread the relationship `@onDelete`/
`@onUpdate` into the existing `migrate-ts` `FkDescriptor` (the `FkAction` union, `emit/{postgres,
sqlite}.ts`, introspect, diff already exist). Round-trip fixture green.

Each sub-stage: TDD, then `review + simplify`, then merge + push.

## Stage 2 — Java
Loader: `source.rdb` + `@kind`/`@role`/`@table`/`@column`, multi-source validation,
`ERR_RESERVED_ATTR`, `@onDelete`/`@onUpdate`. Normalize the legacy `db*`/`jpa*` vocabulary toward
the spec where it intersects. ObjectManagerDB/migration consumers: read-only via `@kind`, name via
`@table`/`@column`, referential actions into the FK DDL. Un-gate the Stage-1 fixtures. Conformance green.

## Stage 3 — Python
Loader: same source v2 + enforcement + referential schema. Codegen (the `metaobjects.codegen`
package from sub-project A): read-only via `@kind`, field via `@column`. Un-gate the fixtures.
Conformance green. (Python codegen/runtime/persistence is its own larger track — see the Python
foundation roadmap; source v2 lands in its loader + codegen here.)

## Stage 4 — AI-first YAML (ADR-0006 D1–D4), TS-first then ported to Python/Java/C#, LAST.
`parser-yaml` + `yaml-desugar`: sigil-free authoring (closed structural-key set; desugar re-adds
`@` for the now-final source-v2/persistence vocab). D2 type-coercion guard in the schema-validation
pass (reject schema-type-mismatched coerced values; located "quote this" error). D3 house style
(+ optional lint warnings). D4 YAML conformance fixtures (sigil-free attrs + coercion guard);
YAML loaders ship per port; corpus shared at `fixtures/yaml-conformance/`. TDD on
parser-yaml/yaml-desugar/parser-equivalence/validation.

## Stage 5 — Enum datatype (separate; coordinate spelling).
`field.enum` per its design doc; `values:` (YAML) / `@values` (canonical JSON) per ADR-0006 D1.

## C# (held)
Stays on `dbTable`/`dbView` + the legacy vocabulary; the Stage-1 fixtures are gated in its
ledger. Migrate to source v2 as its own effort once the user resumes C#.

## Cross-cutting
TDD throughout; named constants for all metamodel strings (no inline literals); no `any`
(narrow `unknown`); public-repo hygiene (no private names / local paths in committed files);
conformance-gated per port; per-unit `review + simplify` before merge; push to origin for durability.

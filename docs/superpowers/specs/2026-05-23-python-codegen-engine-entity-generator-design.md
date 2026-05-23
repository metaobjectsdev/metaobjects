# Sub-project A — Python codegen engine + Pydantic entity generator

- **Date:** 2026-05-23
- **Status:** Design — approved; implement TDD.
- **Part of:** the Python codegen + persistence foundation (decomposition roadmap `2026-05-23-python-codegen-persistence-foundation-roadmap.md`). This is the first sub-project (A); it unblocks B–E and the pinned FR-004 Phase B.
- **Reference implementation:** `server/typescript/packages/codegen-ts/` (`generator.ts`, `runner.ts`, `render-context.ts`, `overwrite-policy.ts`, `generators/entity-file.ts`, `column-mapper.ts`). Mirror its orchestration; emit is idiomatic Python.

## Goal

Stand up the Python codegen substrate (the plugin engine) plus the first generator —
`object.entity` → a **Pydantic v2 model** — so that `run_gen(config, metadata)` produces a
formatted, `@generated`-headed Python module per entity. Engine orchestration mirrors TS;
output is idiomatic Python validated by per-language golden tests (codegen is
idiomatic-divergent, NOT byte-identical-cross-language — so it is **not** added to the shared
`fixtures/conformance/` corpus).

## Scope

**In:** the engine (`Generator` protocol, `GenContext`/`RenderContext`, `per_entity`/
`once_per_run`, `run_gen`, `@generated`-header overwrite/refuse write policy, naming + output-path
+ field→type-mapping helpers) and one generator emitting a Pydantic v2 model per entity.

**Out (deferred):** SQLAlchemy table emit (→ sub-project C); `git merge-file --diff3` three-way
merge (later enhancement; baseline is header overwrite/refuse); multi-target output dirs;
projection/dbView read-only path; queries/routes/barrel generators (→ B); FR-004 payload codegen
(pinned).

## Package layout

A new subpackage in the existing distribution (Python idiom — fewer distributions, subpackages):

```
server/python/src/metaobjects/codegen/
├── __init__.py
├── generator.py        # Generator protocol, EmittedFile, GenContext, per_entity/once_per_run
├── render_context.py   # precomputed shared render state (packages, pk map, relation map)
├── config.py           # GenConfig (out_dir, output_layout, ...) — the run_gen config surface
├── naming.py           # module/class/field name helpers + output-path resolution
├── type_map.py         # field-subtype → Python/Pydantic type (the mapping table)
├── overwrite_policy.py # decide_and_write: @generated-header overwrite/refuse
├── runner.py           # run_gen orchestration
├── format.py           # ruff-format pass over emitted source
└── generators/
    ├── __init__.py
    └── entity_model.py # object.entity → Pydantic v2 model
```

Tests: `server/python/tests/codegen/` (unit + golden). Golden fixtures:
`server/python/tests/codegen/golden/<case>/{meta.json, expected/*.py}`.

## The engine (mirrors TS, idiomatic Python)

```python
@dataclass
class EmittedFile:
    path: str            # relative to config.out_dir
    content: str         # final, formatted Python source
    generated_by: str = ""   # set by the runner from Generator.name

@dataclass
class GenContext:
    entities: list[MetaObject]
    loaded_root: MetaData
    matches: Callable[[MetaObject], bool]
    config: GenConfig
    render_context: RenderContext
    warn: Callable[[str], None]

class Generator(Protocol):
    name: str                                  # kebab-case; surfaces in diagnostics
    def generate(self, ctx: GenContext) -> list[EmittedFile]: ...
    # optional: filter(entity) -> bool ; emits_entity_module: bool
```

- `per_entity(fn)` / `once_per_run(fn)` — convenience wrappers (filter via `ctx.matches`).
- `run_gen(config, metadata, entity_filter=None, merge_strategy="overwrite")`:
  1. validate `metadata` is a loaded `MetaRoot`;
  2. resolve entities (apply `entity_filter`; **safe-name guard** `^[A-Za-z_]\w*$` — skip + warn on unsafe names, matching the TS guard against filesystem traversal from untrusted metadata);
  3. build shared render state once (`RenderContext`: packages-by-name, pk map, relation map — only the parts the entity generator needs this slice);
  4. run each generator, collecting `EmittedFile`s with full paths; **error on output-path collisions**;
  5. write phase via `decide_and_write`.
- `decide_and_write(path, content, strategy)`: new → write (`"new"`); existing **with** `@generated` header → overwrite (or `"skipped"` under `skip-existing`); existing **without** header → **`"refused"`** (never clobber hand-written code). Mirrors `overwrite-policy.ts`.
- `@generated` header constant (line 1 of every emitted file) + a `<Entity>_extra.py` customization-convention pointer (the Python analog of `.extra.ts`).

## The entity generator → Pydantic v2 model

Per `object.entity`, emit a `@generated`-headed module with a `BaseModel` subclass:

- **Inheritance:** `extends`/`BaseEntity` → the Pydantic model subclasses the base model (import from the base's module); the generator emits only the entity's **own** fields, inheriting the rest. Effective-field walks use the loader's typed accessors.
- **Abstract:** `@isAbstract` entities emit a base model intended for subclassing (still a `BaseModel`).
- **Fields:** each `field.*` → a typed attribute. Required (`@required` / `validator.required`) → a plain typed field; not required → `T | None = None`. `@maxLength` → `Field(max_length=N)`.
- **Nested objects:** `field.object` with `@objectRef` → the referenced model type; `@isArray: true` → `list[<T>]`.

### Field-subtype → Python type mapping (`type_map.py`)

| field subtype | Python type | notes |
|---|---|---|
| `string` | `str` | `@maxLength` → `Field(max_length=N)` |
| `int` / `long` | `int` | |
| `double` / `float` | `float` | |
| `decimal` | `decimal.Decimal` | |
| `currency` | `int` | **integer minor units** — preserves the wire contract |
| `boolean` | `bool` | |
| `date` / `time` / `timestamp` | `datetime.date` / `datetime.time` / `datetime.datetime` | |
| `object` (`@objectRef`) | referenced model type | nested import |
| `class` | `str` | fallback + a leading comment noting the fallback |
| `@isArray: true` | `list[<base>]` | wraps the base type |
| not required | `<T> | None = None` | Optional with default |

## Substrate

- **Emit:** plain string building (f-strings / small helpers) — controllable + byte-stable for
  greenfield; no ts-poet/ts-morph equivalent needed. Imports collected and emitted deterministically
  (sorted).
- **Format:** a `ruff format` pass over the emitted source (subprocess; `ruff` added as a dev
  dependency). Keeps output canonical and stable across runs.
- **Merge:** baseline is the header overwrite/refuse policy; three-way merge is a later enhancement.

## Validation (TDD)

- **Engine unit tests:** `per_entity`/`once_per_run` selection; `run_gen` safe-name skip+warn;
  path-collision error; `decide_and_write` new/overwrite/refused/skipped matrix.
- **Type-map unit tests:** every field subtype → expected Python type; `isArray`; optional;
  `@maxLength`; currency → `int`.
- **Golden tests:** a small set of `meta.json` inputs (a vanilla entity; a `BaseEntity` + `extends`
  child; an entity with a nested `field.object` array; optional/required mix) → committed expected
  `.py`. Assert emitted == golden, and that the golden is **`ruff`-clean and imports without error**
  (so generated code is valid Python, not just a string match).
- **Determinism:** generating twice yields identical bytes.

## Verification

```
cd server/python
uv run pytest -q                       # full suite green (211 existing + new codegen tests)
uv run pytest -q tests/codegen         # the new sub-project A tests
uv run ruff format --check <golden>    # generated goldens are canonical
```

Done when: `run_gen` emits a formatted, `@generated`-headed Pydantic model per entity; the engine +
type-map + golden tests are green; generated goldens import cleanly and are `ruff`-clean; the full
Python suite stays green.

## Review follow-ups

Addressed before merge (code review): generated output is now isort-clean (a `ruff check
--select I --fix` pass precedes `ruff format` in `format.py`); the `@generated` header shows
the effective FQN (resolved from the nearest ancestor package); `run_gen` warns when there are
no entities; added a `scalars` golden (datetime/decimal/currency + nested ref) that locks import
ordering, plus refused-write and no-entities runner tests.

Deferred (Minor, tracked): the `class`-subtype fallback maps to `str` without a leading
explanatory comment (spec table mentioned one — emitting per-field comments adds emitter
complexity for little value; revisit if `field.class` usage grows). Separately, a metadata-layer
observation surfaced in review — `@isArray` JSON input loads as an attr while the canonical
serializer emits the `is_array` *node property*, so `@isArray` may not round-trip through
canonical serialization; codegen's dual-form `field_is_array` papers over it correctly, but the
metadata layer should confirm/repair this independently (out of scope here).

## Open items resolved here

- **Package layout:** subpackage `metaobjects.codegen` (not a separate distribution).
- **Emitter substrate:** plain string emit + `ruff format`.
- **Field→Python-type table:** defined above (the long-standing CLAUDE.md open question, Python flavor).
- **Write policy:** `@generated`-header overwrite/refuse (three-way merge deferred).

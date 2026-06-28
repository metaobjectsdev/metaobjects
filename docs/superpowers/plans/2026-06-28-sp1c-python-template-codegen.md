# SP-1c — Python declarative Mustache template-codegen — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Bring the declarative Mustache template generator (`scope` ∈ perEntity/perPackage/perModel + `outputPattern`, no walk code) to the Python port, expose it through a `--template-spec` JSON surface on `metaobjects gen` (the CLI-port contract shared with C#), and gate byte-identical against the same `fixtures/template-codegen-conformance/` corpus the TS + JVM ports pass.

**Architecture:** Mirror the TS/JVM ports in `server/python/src/metaobjects/codegen/template_codegen/` — a dict-based neutral data-dict builder + an output-pattern expander + built-in scope walks wired into the existing `template_generator`. Add a JSON template-spec parser and the `--template-spec` CLI flag. The Python Mustache render engine is already byte-equal (`fixtures/render-conformance/`), so only the data dict + scope + pattern are new.

**Tech Stack:** Python 3.11+, the `metaobjects` package (MetaObject/MetaField via `MetaDataLoader.from_directory`), the `metaobjects.render` engine + `FilesystemProvider`, pytest, the `.venv` interpreter (`server/python/.venv/bin/python`).

## Global Constraints

- **Neutral data-dict keys are the byte-gated cross-port contract** — identical to TS/JVM: `name`, `package`, `fields[]` (`name`,`type`,`required`,`isArray`,`maxLength?`,`enumValues?`), `identities[]` (`kind`,`fields`), `relationships[]` (`name`,`cardinality`,`targetRef`). Use plain `dict`/`list`; OMIT optional keys (`maxLength`/`enumValues`) when absent. `type` = `field.sub_type` (neutral subtype), arrayness via `isArray` only.
- **Own-vs-effective attr discipline (the JVM-review lesson, baked in from the start):** `is_abstract` per-node; `@required` attr + `maxLength` read via `own_attrs()` (own-only, matching TS `ownAttr`); the required-**validator** branch effective; enum `values` via `attrs()` (effective). `o.name` is already bare; effective package = `o.package or o.file_default_package or ""`.
- **Scope names**: `perEntity`/`perPackage`/`perModel`. Output-pattern grammar: `{name}`/`{Name}`(PascalCase)/`{package}`(`::`→`/`); empty package collapses slash; unknown placeholder → raise.
- **TS is the byte-equality oracle** (`fixtures/template-codegen-conformance/expected/`). Python only READS it.
- **Run tests:** `cd server/python && .venv/bin/python -m pytest tests/... -q`.
- **Public-repo hygiene**; **commit trailers** on every commit:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` / `Claude-Session: https://claude.ai/code/session_01LuZWKnWzYGVnESijL7uuky`.

## File Structure

- `codegen/generator.py` — **modify**: add `per_package(fn)` + `per_model = once_per_run`.
- `codegen/template_codegen/__init__.py` — **create** (package).
- `codegen/template_codegen/output_pattern.py` — **create**: `expand_output_pattern`.
- `codegen/template_codegen/template_data.py` — **create**: data-dict builders.
- `codegen/template_codegen/template_spec.py` — **create**: `parse_template_spec`, `template_spec_to_generators`.
- `codegen/generators/template_generator.py` — **modify**: add `scope` + `output_pattern` (built-in walk; mutually exclusive with `walk`).
- `cli.py` — **modify**: add `--template-spec <path>` (+ `--templates <dir>` default `templates`) to `gen`.
- Tests under `server/python/tests/`: `test_output_pattern.py`, `test_template_data.py`, `test_template_spec.py`, `conformance/test_template_codegen_conformance.py`.

---

## Task 1: `per_package` + `per_model`

**Files:** modify `codegen/generator.py`; test `tests/codegen/test_scope_helpers.py`.

- [ ] **Test:** `per_package(fn)` groups matched entities by effective package (ascending), runs `fn(pkg, ents, ctx)` once per package; `per_model is once_per_run`.
- [ ] **Implement:** add `per_package` (group by `template_data.package_of`, sorted keys) and `per_model = once_per_run`. (Import `package_of` lazily to avoid a cycle, or inline the `o.package or o.file_default_package or ""` rule.)
- [ ] **Run** `.venv/bin/python -m pytest tests/codegen/test_scope_helpers.py -q` → PASS. **Commit.**

---

## Task 2: Output-pattern expander

**Files:** create `template_codegen/output_pattern.py`; test `tests/codegen/test_output_pattern.py`.

- [ ] **Test** (mirror the TS/JVM cases): `{package}/{name}Service.py` + `order`/`acme::sales` → `acme/sales/orderService.py`; `{Name}.py` + `order_line` → `OrderLine.py`; literal passthrough; empty package collapses; unknown placeholder raises `ValueError`; `{name}` with no name raises.
- [ ] **Implement** `expand_output_pattern(pattern: str, name: str | None, package: str | None) -> str` using `re.sub` over `\{(\w+)\}`; pascal-case via split on non-alnum; collapse leading/duplicate `/` when package empty.
- [ ] **Run** → PASS. **Commit.**

---

## Task 3: Neutral data-dict builder

**Files:** create `template_codegen/template_data.py`; test `tests/codegen/test_template_data.py`.

**Interfaces:**
```python
def bare_name(o) -> str            # o.name is already bare; returned as-is
def package_of(o) -> str           # o.package or o.file_default_package or ""
def is_concrete(o) -> bool         # not o.is_abstract (per-node)
def build_entity_template_data(o) -> dict
def build_package_template_data(pkg: str, entities: list) -> dict
def build_model_template_data(objects: list) -> dict   # concrete-only, pkgs sorted
```
Field dict (insertion order = contract order): `name`, `type`(`f.sub_type`), `required`, `isArray`(`f.is_array`), then `maxLength` (int, only if in `own_attrs()`), `enumValues` (only if `sub_type == "enum"` and `values` in `attrs()`). `required = bool(f.own_attrs().get("required")) or any(v.sub_type == "required" for v in f.children() if v.type == "validator")`. Identities/relationships from `o.children()` filtered by `.type`: identity → `{kind: sub_type, fields: attrs()["fields"]}`; relationship → `{name, cardinality: attrs().get("cardinality",""), targetRef: attrs().get("objectRef","")}`.

- [ ] **Test** (load corpus via `MetaDataLoader.from_directory(corpus/"metadata")`, objects = `[c for c in root.children() if isinstance(c, MetaObject)]`): Product dict `name=="Product"`, `package=="shop"`, `name` field `type=="string"`/`required is True`/`maxLength==120`, `status` `enumValues==["ACTIVE","ARCHIVED"]`, `id` has NO `maxLength`/`enumValues` keys; Order relationship `{name:"product",cardinality:"one",targetRef:"Product"}`; model has one package `shop` with 2 entities.
- [ ] **Implement.** **Run** → PASS. **Commit.**

---

## Task 4: Scope walks in `template_generator`

**Files:** modify `codegen/generators/template_generator.py`; test `tests/codegen/test_template_scope_walk.py`.

**Interface:** add keyword-only `scope: str | None = None`, `output_pattern: str | None = None` to `template_generator(...)`; make `walk` optional. Validate exactly-one of (`walk`) / (`scope`+`output_pattern`) → raise `ValueError` otherwise. When `scope` given, build the walk internally:
- `perEntity`: concrete → `{"data": build_entity_template_data(o), "output_path": expand_output_pattern(pattern, bare_name(o), package_of(o))}`.
- `perPackage`: group concrete by `package_of` (sorted) → `{"data": build_package_template_data(pkg, ents), "output_path": expand_output_pattern(pattern, None, pkg)}`.
- `perModel`: `{"data": build_model_template_data(objects), "output_path": expand_output_pattern(pattern, None, None)}`.
  (objects = `[c for c in root.children() if isinstance(c, MetaObject)]`.)

- [ ] **Test:** `template_generator(scope="perEntity", output_pattern="{name}.txt", walk=...)` raises; neither raises; a `perEntity` run over the corpus emits one file per concrete entity. **Implement. Run → PASS. Commit.**

---

## Task 5: JSON template-spec + CLI `--template-spec`

**Files:** create `template_codegen/template_spec.py`; modify `cli.py`; tests `tests/codegen/test_template_spec.py` + a CLI test.

**Interfaces:**
```python
def parse_template_spec(obj: object) -> dict      # {"generators":[{name,template,scope,outputPattern,format?,target?}]}
def template_spec_to_generators(spec: dict, provider: Provider) -> list[Generator]
```
Validation mirrors `template-spec.ts`: require `generators` list; each entry requires non-empty `name`/`template`/`scope`/`outputPattern`; `scope` ∈ the three; `format` (if present) ∈ the RenderFormat set. `template_spec_to_generators` maps each entry → `template_generator(name=…, template=…, scope=…, output_pattern=…, provider=provider, format=…)`. The provider is supplied by the caller (the CLI builds a `FilesystemProvider`).

CLI: `metaobjects gen <dir> --template-spec <path> [--templates <dir>]`. Reads + `json.loads` the spec, builds `FilesystemProvider(templates_dir or "templates")`, appends `template_spec_to_generators(...)` to the generator suite passed to `run_gen`.

- [ ] **Test** `parse_template_spec`: valid spec; unknown scope raises; missing `outputPattern` raises; non-dict raises. `template_spec_to_generators` yields generators named per entry.
- [ ] **Test (CLI):** a temp project (corpus metadata copied + `templates/` copied + a spec.json) run through the `gen` command emits the expected files. (Or assert at the `argparse`/dispatch level if a full CLI harness is heavy — a direct `run_gen` with `template_spec_to_generators` is acceptable and is what Task 6 gates.)
- [ ] **Implement. Run → PASS. Commit.**

---

## Task 6: Conformance gate (shared corpus)

**Files:** create `tests/conformance/test_template_codegen_conformance.py`.

- [ ] **Test:** load `spec.json`; `MetaDataLoader.from_directory(corpus/"metadata")`; `provider = FilesystemProvider(corpus/"templates")`; `gens = template_spec_to_generators(parse_template_spec(spec), provider)`; run each via `run_gen` (or call `gen.generate(ctx)` directly with a `GenContext`) into a temp dir; assert the emitted tree is byte-identical to `expected/`. Repo root via `Path(__file__).resolve().parents[N]` walking up to the dir containing `fixtures/`.
- [ ] **Run** `.venv/bin/python -m pytest tests/conformance/test_template_codegen_conformance.py -q`. If bytes differ, fix the data dict/pattern (NEVER edit `expected/` — it is the TS oracle).
- [ ] **Run → PASS. Commit.**

---

## Task 7: Final verification

- [ ] `cd server/python && .venv/bin/python -m pytest -q` — full suite green (new tests + no regression).
- [ ] `git status` clean except the new sources/tests; `fixtures/template-codegen-conformance/expected/` untouched.
- [ ] no-mistakes gate in an isolated worktree under the developer's home (NOT a shared temp dir). All changes are under `server/python/`, so the TS pre-push gate is skipped — but run `bun install` up front anyway so the gate can run if the no-mistakes internal repo lags origin (the SP-1b lesson). `--skip=ci`; admin-merge after local green.

## Self-Review (against spec §3–§5)

- §3.1 scopes / §3.2 dict / §3.3 pattern / §3.4 provider / §3.5 corpus → Tasks 1–4, 6 (own-vs-effective discipline pre-applied per the JVM review).
- §4 Python wiring → Task 4 (scope in `template_generator`) + Task 5 (the `--template-spec` JSON surface, shared C#/Python contract).
- §5 increment SP-1c → Python over the shared render engine, corpus-gated byte-identical to the TS oracle. Covered. Out of scope: SP-1d C#, SP-2, SP-3.

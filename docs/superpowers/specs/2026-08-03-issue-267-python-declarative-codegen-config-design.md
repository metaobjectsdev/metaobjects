# #267 — Python declarative codegen config (targets registry): design

_Date: 2026-08-03 · Issue: [#267](https://github.com/metaobjectsdev/metaobjects/issues/267) · Scope: **Python port only** (additive; no metamodel/vocabulary change; NO coordinated release) · Status: designed (Fable cross-port config investigation)_

## Problem

The Python port's codegen is **flags-only** (`server/python/src/metaobjects/cli.py`): output dir, generator selection, entity allowlist, and provider module all pass on the command line, so per-gate they live in **CI shell scripts** where they go stale (an adopter shipped a committed generated dir several emitter versions stale because nothing re-derived it). The `--provider module:symbol` path additionally requires `PYTHONPATH=` to make the provider importable, and the entity list gets duplicated into every gate (local script + CI workflows) so a new entity is silently ungated. `codegen/KNOWN_GAPS.md` already anticipates a targets registry.

## Decision (Fable-investigated)

Ship a **declarative `metaobjects.config.yaml`** for Python — NOT a `.py` executable config. Rationale: Python's entire config surface is *data* (targets, stable generator-names, entity lists, `module:symbol` provider strings). Unlike TS's `metaobjects.config.ts`, which **must** be executable because ADR-0034 scaffold-and-own means the consumer config imports its *owned local generator implementations* and passes live `MetaDataTypeProvider` objects, Python's config only needs the provider **string reference** (the code stays in the provider module, per #158). YAML costs zero new deps (PyYAML ≥6.0 is already required by ADR-0006's authoring front-end) and is inspectable by non-Python tooling; a `.py` config would add arbitrary code-exec at gen/verify time for expressiveness Python doesn't use.

**Cross-port doctrine (answers the maintainer's "does it matter if it differs per language?"):** the **file surface** may differ per port; the **schema (vocabulary) must not**. This is the position the repo already took three times — ADR-0021 D3 (stable generator-name selection, `generator-registry-conformance`), FR-025 milestone-1.1 (*"per-port file naming is at each port's discretion; the shape is locked across ports"*), and the template-spec JSON (one shape + JSON Schema, read by TS/C#/Python). So #267 does NOT introduce a single physical cross-port YAML (that would force TS to dual-support/break scaffold-and-own for zero gain, and split Java's config away from its pom idiom). It ships Python's YAML using **schema keys identical to TS's** so a polyglot adopter learns one vocabulary.

## Schema (align names with TS — `outDir`, `generators`, `entities`; NOT `out`)

```yaml
metadata: ./metaobjects            # optional; default ./metaobjects
providers: ["my_provider:provider"]  # module:symbol, resolved CONFIG-RELATIVE
targets:                            # named map (like TS `targets`), not a list
  models:
    outDir: pkg/models/generated
    generators: [entity]           # stable names via GENERATOR_REGISTRY (ADR-0021 D3)
    entities: [Aaa, Bbb]           # optional allowlist; omit = all entities
  other:
    outDir: pkg/other/generated
    generators: [entity]
    entities: [Ccc, Ddd]
```

- Publish a **JSON Schema** beside the loader (the template-spec precedent — `template-spec.schema.json`) for editor autocomplete + non-Python validation.
- One deliberate reconciliation: TS `targets` are *output destinations* (a generator picks a target via a `target?` option; `TargetConfig` carries no `generators`/`entities`), while #267's targets are *run-specs* (each carries its own `generators` + `entities`). Reconcilable — a run-spec target is a destination **plus** a selection — and the shared keys (`outDir`/`generators`/`entities`) stay identical; document that TS attaches selection to generators while the declarative ports attach it to targets.

## Behavior

- **Provider resolution:** prepend the **config file's directory** to `sys.path` before the existing `_resolve_providers` importlib path — removes the `PYTHONPATH=` requirement; `module:symbol` strings unchanged. Optional later: a `pythonPath: [./tools]` key for providers living elsewhere (don't block on it).
- **`metaobjects gen` (no positional dir / no `--out`)** → load config, load metadata **once**, run **every** target (per-target generators/entities into its `outDir`). Add a **cross-target duplicate-output-path guard** (TS's runner errors on duplicate full paths; Python's `run_gen` guard is per-pass only). Add `--target <name>` to scope to one target.
- **`metaobjects verify --codegen` (no args)** → one whole-selection regen into a temp tree (the exact `gen` pipeline, including the cross-target duplicate-output-path guard), then a diff per **unique outDir** — the union of co-resident targets' regen vs the shared committed dir — so two targets sharing an outDir are verified *together* (no false `extra` drift). `--target <name>` widens to the outDir-sharing closure (an outDir is verified as a unit).
- **Config lookup:** `--config <path>` else `./metaobjects.config.yaml` in cwd. (Optional secondary `pyproject.toml [tool.metaobjects]` location later — don't block on it.)
- **Back-compat (load-bearing):** an explicit positional `metadata_dir` + `--out` keeps today's flag path **byte-identical** — flags present ⇒ legacy path, config not consulted (simplest, least-surprising rule). Purely additive; existing CI keeps working.

## Interaction with #265 (note, not a blocker)

A config-declared provider that `registry.extend()`s a core subtype still hits the strict-scoping prune that **#265** (PR #268, landing) fixes — until #265 merges, such a provider forces `--lax` on strict verify, so the config's "one command, strict gate" promise is hollow for exactly those adopters. #267's own code + tests do NOT depend on #265 (a #267 test provider can register a fresh subtype, or use no provider). Build #267 on a branch off main; the two compose once both land.

## Non-goals

- No `.py` executable config; no single physical cross-port config file; no change to the existing flags; no metamodel/vocabulary change; no coordinated release. TS/Java/C# unchanged (the cross-port *schema* convergence is a separate, later, additive step per FR-025 — optionally recorded as an ADR).

## Testing

- Config loader unit tests (parse YAML → typed config; missing/invalid → clear error; defaults).
- `gen` no-arg runs all targets into their `outDir`s with the right generators/entities (temp-dir integration); duplicate-output-path guard fires on a colliding config.
- `verify --codegen` no-arg one whole-selection regen + diff per unique outDir, aggregate exit; a stale target fails, a fresh tree passes; a shared outDir with disjoint entities verifies clean, and real drift/extra is still detected under sharing.
- Provider resolved config-relative WITHOUT `PYTHONPATH=` (a provider module beside the config).
- `--target <name>` scopes gen + verify.
- Back-compat: the existing positional+`--out` flag path is byte-identical (config ignored).
- No new metamodel conformance fixtures needed (Python-only ergonomics; not a cross-port vocabulary change).

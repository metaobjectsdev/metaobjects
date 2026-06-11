# FR-023 — Metadata packages: cross-repo distribution + reuse (design)

_Status: PROPOSED (design sketch — needs brainstorming + plan before implementation)._
_Date: 2026-06-11._

## Problem

The core polyglot workflow is: a **shared base model** (common entities, abstracts,
enums, validation) maintained once, consumed by many downstream apps **in different
languages and different repos**, each augmenting it locally via `extends` and overlays.

The loader mechanics for this already ship — `MetaDataSource` composition
(directory/file/URI/in-memory) and overlay merge by `package`+`name` with per-node
source attribution work across arbitrarily many sources. What's missing is the
**convention**: how a shared model is packaged, versioned, published, resolved, and
declared by a consumer in each language ecosystem. Today it's hand-wired glue (point a
source at a checked-out path); it should be a one-liner.

## Design direction

### 1. The metadata package artifact

A metadata package is a **code-free artifact** containing:

```
metaobjects/                  # the standard tree (canonical JSON and/or YAML)
  meta.common.json
  meta.commerce.json
metaobjects.pkg.json          # manifest: name, version, exported metamodel packages,
                              # provider requirements (custom types it depends on)
```

Published through each ecosystem's normal registry — npm / Maven Central / PyPI / NuGet
— as an ordinary versioned dependency. No runtime code inside; it is data. (One
artifact CAN be published to multiple registries from one source repo — recipe, not
mechanism.)

### 2. Consumer declaration (per-port resolution, one shared semantic)

`.metaobjects/config.json` (the JSON config, parseable by all tooling) gains:

```jsonc
{ "metadataDependencies": [
    { "package": "@acme/common-model", "version": "^2.1.0" }   // resolved per ecosystem
]}
```

- **TS/Node**: resolve via `node_modules/<pkg>/metaobjects/`.
- **Java/Kotlin**: a Maven/Gradle dependency whose jar carries `metaobjects/` as a
  classpath resource; the Maven plugin resolves and feeds it to the loader (classpath
  resource loading is the JVM-native path).
- **Python**: package-data path via `importlib.resources`.
- **C#**: NuGet `contentFiles` path.
- The loader composes: dependency sources first (in declared order), local
  `metaobjects/**` last — so local overlays win last-writer-wins attr conflicts,
  matching existing overlay semantics. Provenance attribution records the contributing
  package+version on every node (extends FR-5c attribution).

### 3. Semantics + guardrails

- `extends` and overlays work across package boundaries exactly as across files
  (existing behavior — conformance-gated with new cross-package fixtures).
- **Same-package-name collision** between two dependencies → load error
  (`ERR_DUPLICATE_DECLARATION` escalated from warn when sources are different
  dependencies and the merge is not a declared overlay) — settle exact rule in
  brainstorming.
- Custom-type requirements: the manifest names required providers; loading a package
  without its providers registered fails with the existing provider error codes
  (ADR-0023 strictness preserved — a metadata package cannot smuggle vocabulary in).
- Version conflicts (two apps want different shared-model versions) are the consuming
  ecosystem's resolver problem (npm/Maven semantics), not re-solved here; the manifest
  version is recorded in attribution for drift forensics.
- `meta verify` reports per-dependency provenance (which package contributed what) so
  a shared-model upgrade that changes downstream codegen is attributable.

### 4. What this is NOT

- Not a hosted registry or remote-fetch protocol — resolution rides each language's
  package manager; the loader still only reads local files/resources at build time.
- Not runtime schema distribution — this FR is about build-time model reuse. (Runtime
  loading from other sources already exists via `MetaDataSource`; conventions for that
  are out of scope here.)

## Conformance

- New cross-package fixtures in `fixtures/conformance/`: dependency-then-local overlay
  merge order, cross-package `extends`, collision errors, provider-requirement errors,
  attribution shape. All 5 ports load the same fixture "packages" (as plain dirs in the
  corpus) — the per-ecosystem resolution is port-specific glue tested per port.

## Open questions

1. Manifest shape + name (`metaobjects.pkg.json`?) and whether the manifest is required
   (lean: required for dependencies, absent for apps).
2. Exact collision/override rules between two dependencies (vs dependency→local, which
   is settled: local wins).
3. Lockfile story: rely on ecosystem lockfiles only, or record resolved versions in
   `.metaobjects/` state for cross-tool reproducibility?
4. YAML vs canonical JSON inside published packages (lean: canonical JSON only —
   interchange form, no desugar variance).
5. `meta init` scaffold for *authoring* a metadata package (publish workflows per
   registry).

## Dependencies / consumers

- Consumes: `MetaDataSource` composition + overlay/extends + FR-5c attribution (all
  shipped).
- Consumed by: every multi-repo adopter; future organization-level tooling can build on
  the same manifest.

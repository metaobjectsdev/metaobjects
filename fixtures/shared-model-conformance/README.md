# shared-model-conformance

Pins what a publisher writes for FR-023: the shared-model **artifact** and the **manifest** that
pins it (`metaobjects.pkg.json`), byte for byte, and the refusals a publisher raises instead of
writing a model a consumer could not use. Every port's publisher reads THIS file; there is no
per-port fixture.

A consumer's `meta deps sync` accepts whatever bytes a publisher wrote, as long as the manifest
hashes them. So differing bytes between ports would not break a consumer; they would show up as a
spurious `drifted` when a project changes the port that publishes, and as a `verify --codegen`
that disagrees between ports. This corpus is what keeps that from happening.

## Shape

```
cases.json     # { cases: [ { name, input, expectArtifact + expectManifest | expectRefusal } ] }
source/        # the publisher's own metadata files; a case's `files` name these
expected/      # the pinned manifest (and, where new, artifact) for each publish case
```

```jsonc
{ "name": "…",                          // kebab-case, the contract
  "input": {
    "name": "acme-common",              // the dependency key; the artifact is <name>.metaobjects.json
    "files": ["source/meta.base.json"], // which of the sources may contribute, corpus-relative
    "include": ["acme::common::**"],    // the scope grammar of scope-conformance/
    "exclude": ["acme::common::Secret"],// OPTIONAL, applied after include
    "version": "1.0.0",                 // fixed, so the manifest bytes are fixed
    "providers": ["secret-handling"]    // OPTIONAL: named test providers, see below
  },
  "expectArtifact": "expected/<set>/<name>.metaobjects.json",
  "expectManifest": "expected/<set>/metaobjects.pkg.json",
  "expectRefusal": { "reason": "…", "pairs": [ { "referrer": "…", "target": "…" } ] } }
```

Exactly one of `expectArtifact` + `expectManifest`, `expectRefusal` is present per case.

- **`expectArtifact`** — corpus-relative path to the exact bytes of the canonical-JSON
  `metadata.root` document. `publishes-the-pinned-acme-common-artifact` points at
  `../dependency-conformance/artifacts/acme-common-v1.json`, the artifact that corpus pins by
  sha256, so the two corpora cannot disagree about it.
- **`expectManifest`** — the exact bytes of `metaobjects.pkg.json` (two-space JSON, trailing
  newline). The manifest records the toolchain's `metamodelVersion`; the golden carries the
  token `@@METAMODEL_VERSION@@` there and a runner substitutes its own constant before comparing.
  `packages` and `nodes` are sorted, and `integrity` is the sha256 of the artifact's bytes.
- **`expectRefusal.reason`** — one of:
  - `empty-selection` — `include` / `exclude` select no node (`requirement.*` and `template.*`
    never count).
  - `not-closed` — a selected node `extends` or references (any ref-bearing attribute) a node
    outside the selection. `pairs` is the EXHAUSTIVE list of `(referrer, target)` resolution
    keys, sorted by referrer then target, which the error must name.
  - `non-core-vocabulary` — the selection loads with the publisher's own providers but not with
    core vocabulary alone, which is how a consumer loads it.

  The message text is not the contract; the reason and the pairs are. A port classifies its own
  error into a reason.

## Rules the cases pin

- `requirement.*` and `template.*` top-level nodes are never published, whatever `include` says
  (`requirements-and-templates-are-always-dropped`).
- The order of `files` does not change the bytes (`the-order-of-files-does-not-change-the-bytes`).
- Nodes are sorted by resolution key; each carries its own `package`; `extends` is preserved, not
  flattened (`a-selection-spanning-two-packages-lists-both-sorted`).
- `files` narrows what may contribute before `include` / `exclude` select
  (`files-narrows-what-may-contribute`); `exclude` is applied after `include`
  (`exclude-is-applied-after-include`).

## Test providers

`secret-handling` registers one common string attribute, `secretHandling`, that no core provider
ships, standing in for vocabulary a consumer's provider adds. It is the one trigger for
`non-core-vocabulary`; a port implements it in its own test code (a provider that registers a common
attribute `secretHandling` of type string, not required).

## Which arms each port runs

- **TypeScript** — all of it: select, closure, serialize, core-vocabulary re-load, manifest, and
  every refusal (`codegen-ts/test/shared-model-conformance.test.ts`).
- **Python** — the **serializer arm** only: load `files`, take exactly the nodes the pinned
  manifest lists, and `serialize_shared_document` must reproduce the artifact byte for byte (and the
  manifest's sha256). Python has no publisher (`server/python/tests/conformance/test_shared_model_conformance.py`).
- **Java / Kotlin / C#** — Phase 2 publishing; each runs everything when it gains a publisher.

## Reference implementation

`server/typescript/packages/codegen-ts/src/shared-model/build-shared-model.ts`
(`buildSharedModel`, `renderSharedModelFiles`) and `serializeSharedDocument` in
`server/typescript/packages/metadata/src/serializer-json.ts`.

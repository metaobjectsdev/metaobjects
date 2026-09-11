# dependency-conformance

Pins how FR-023 metadata dependencies (declared in `.metaobjects/config.json`,
resolved via a manifest + lock + committed snapshot) resolve, govern codegen/
migrate, overlay, fail, and classify upstream changes — across every port.
Every port's runner reads THIS file; there is no per-port fixture.

## Shape

```
cases.json          # { cases: [ { name, tree, treeFiles?, config, lock?, localOverrides?,
                     #             resolveFrom?, expectFiles?, expectForeign?, expectGoverned?,
                     #             expectOverrides?, expectLoadError?, expectErrorFiles?,
                     #             expectError?, classify? } ] }
README.md
artifacts/           # pinned dependency artifacts, referenced by cases via `treeFiles`
  acme-common-v1.json
  acme-common-v1-widened.json
  acme-common-v2-email-removed.json
```

## Case schema

```jsonc
{ "cases": [ {
  "name": "…",                       // kebab-case, the contract
  "tree": { "<rel path>": "<content>" },          // materialized under a fresh temp root
  "treeFiles": { "<rel path>": "artifacts/<file>" },  // OPTIONAL: copied byte-for-byte from the corpus dir
  "config": { … } | null,            // written to <resolveFrom>/.metaobjects/config.json
  "lock": { … },                     // OPTIONAL: written to <resolveFrom>/.metaobjects/deps.lock.json
  "localOverrides": { … },           // OPTIONAL: written to <resolveFrom>/.metaobjects/deps.local.json
  "resolveFrom": ".",                // OPTIONAL
  "expectFiles": ["…"],              // unordered set, project-root-relative (resolution arm)
  "expectForeign": ["<fqn>"],        // OPTIONAL: FQNs with a foreign owner
  "expectGoverned": ["<fqn>"],       // OPTIONAL: FQNs governs() admits, over every loaded top-level object
  "expectOverrides": ["<name>"],     // OPTIONAL: dependencies read from a local override
  "expectLoadError": "ERR_*",        // OPTIONAL: the collection resolves, then LOADING it fails with this code
  "expectErrorFiles": ["dep:…"],     // OPTIONAL with expectLoadError: source.files[0] of the first error
  "expectError": "ERR_*",            // resolution itself fails with this code
  "classify": {                      // classifier arm (TS + Python only)
    "old": { … }, "new": { … },      // two artifact documents, inline
    "footprint": { "<fqn>": "whole" | "key" | "existence" },
    "expectChanges": [ { "fqn": "…", "path": "…", "kind": "breaking" | "compatible" | "info" } ] }
} ] }
```

Exactly one of `expectFiles`, `expectError`, `classify` is present per case; `expectLoadError`
rides with `expectFiles`.

- **`tree`** — a map of project-root-relative path → file content, materialized in a fresh
  temporary directory (same shape as `source-resolution-conformance`).
- **`treeFiles`** — OPTIONAL, a map of project-root-relative path → a path under this
  corpus directory (`artifacts/<file>`). A `treeFiles` entry copies a corpus file
  byte-for-byte so a pinned hash can never drift — it is never re-serialized or
  re-encoded on the way into the case's temp directory, unlike `tree`, which writes a
  JSON string value as text.
- **`config`** — written verbatim to `<resolveFrom>/.metaobjects/config.json`. `null` means
  no config file is created.
- **`lock`** — OPTIONAL, written verbatim to `<resolveFrom>/.metaobjects/deps.lock.json`.
- **`localOverrides`** — OPTIONAL, written verbatim to `<resolveFrom>/.metaobjects/deps.local.json`
  (D10 — local co-development override).
- **`resolveFrom`** — OPTIONAL, project-root-relative directory the resolver is invoked
  against; default `"."`.
- **`expectFiles`** — the resolution arm. Project-root-relative paths, compared as an
  unordered set (same contract as `source-resolution-conformance`).
- **`expectForeign`** — OPTIONAL, alongside `expectFiles`: FQNs for which
  `collection.foreignOwner(fqn) !== undefined`.
- **`expectGoverned`** — OPTIONAL, alongside `expectFiles`: the FQN set, over every loaded
  top-level object, for which `collection.governs(fqn)` is true.
- **`expectOverrides`** — OPTIONAL, alongside `expectFiles`: the dependency names
  `collection.overrides` reads from an active `deps.local.json`.
- **`expectLoadError`** — OPTIONAL, alongside `expectFiles`: the collection resolves
  cleanly, but LOADING it (parsing the resolved files into a metadata tree) fails with
  this code.
- **`expectErrorFiles`** — OPTIONAL, alongside `expectLoadError`: `source.files[0]` of the
  first load error — asserts the failure names the right file, e.g. a dependency artifact
  (`dep:<name>/<artifact>`) rather than a local one.
- **`expectError`** — the resolution-failure arm: `resolveCollection` itself must reject
  with this exact code.
- **`classify`** — the classifier arm (TS + Python only; see below). Two inline artifact
  documents (`old`/`new`), a footprint map, and the expected change list.

## Pinned artifacts

`artifacts/acme-common-v1.json` is the base publisher artifact (`acme::common::Address`,
`acme::common::Audited` [abstract], `acme::common::Customer` with an `email`
`field.string @maxLength: 120`). `acme-common-v1-widened.json` is identical except
`@maxLength: 200` (a compatible widening). `acme-common-v2-email-removed.json` is
identical except the whole `email` field child is absent (a breaking removal).

Verify the bytes from the repo root:

```bash
python3 -c 'import hashlib,sys; [print("sha256-"+hashlib.sha256(open(f,"rb").read()).hexdigest(), f) for f in sys.argv[1:]]' fixtures/dependency-conformance/artifacts/*.json
```

Expected, exactly:

```
sha256-10fbf886e22faceca32c56e5e647c3ff1c82f503e638cba3bd3aa9390f7c409d fixtures/dependency-conformance/artifacts/acme-common-v1.json
sha256-fa00b9f3c54a2c302cf269af051589afc0a3217999ac82c54c77e33494638c36 fixtures/dependency-conformance/artifacts/acme-common-v1-widened.json
sha256-c4ba364bff0071b164b127326c095d6d32915b57781271e0be64a7003c27ce7a fixtures/dependency-conformance/artifacts/acme-common-v2-email-removed.json
```

If a hash differs, fix the bytes (whitespace, trailing newline, CRLF) — never change the
pinned values; a hash change here is a change to what every port's `sync`/manifest test
asserts against.

## Which arms each port runs

- **TypeScript** — all arms (resolution/foreignness, overlays, load-time failure, lock/
  snapshot integrity, classification).
- **Python** — all arms.
- **Java / C# / Kotlin** — Phase 2 (out of scope for this plan; these ports do not read
  `dependencies` yet).

## Reference implementation

`server/typescript/packages/sdk/src/collection.ts` (`resolveCollection`) and
`server/typescript/packages/sdk/src/memory.ts` (`loadMemory`).

# dependency-conformance

Pins how FR-023 metadata dependencies (declared in `.metaobjects/config.json`,
resolved via a manifest + lock + committed snapshot) resolve, are excluded by
default from codegen/migrate selection unless explicitly included, overlay,
and fail — across every port. Every port's runner reads THIS file; there is
no per-port fixture.

## Shape

```
cases.json          # { cases: [ { name, tree, treeFiles?, config, lock?,
                     #             resolveFrom?, expectFiles?, expectImported?,
                     #             expectSelected?, expectMigrateGoverned?,
                     #             expectLoadError?, expectErrorFiles?, expectError? } ] }
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
  "resolveFrom": ".",                // OPTIONAL
  "expectFiles": ["…"],              // unordered set, project-root-relative (resolution arm)
  "expectImported": ["<fqn>"],       // OPTIONAL: the EXHAUSTIVE set, over every loaded top-level
                                     // object, for which collection.imported(fqn) is true
  "expectSelected": ["<fqn>"],       // OPTIONAL: the EXHAUSTIVE set, over every loaded top-level
                                     // object, for which collection.inScope(fqn) is true
  "expectMigrateGoverned": ["<fqn>"], // OPTIONAL: the EXHAUSTIVE set, over every loaded top-level
                                     // object, for which collection.inMigrateScope admits it
                                     // (undefined inMigrateScope admits everything)
  "expectLoadError": "ERR_*",        // OPTIONAL: the collection resolves, then LOADING it fails with this code
  "expectErrorFiles": ["dep:…"],     // OPTIONAL with expectLoadError: source.files[0] of the first error
  "expectError": "ERR_*"             // resolution itself fails with this code
} ] }
```

Exactly one of `expectFiles`, `expectError` is present per case; `expectLoadError` rides
with `expectFiles`.

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
- **`resolveFrom`** — OPTIONAL, project-root-relative directory the resolver is invoked
  against; default `"."`.
- **`expectFiles`** — the resolution arm. Project-root-relative paths, compared as an
  unordered set (same contract as `source-resolution-conformance`).
- **`expectImported`** — OPTIONAL, alongside `expectFiles`: the EXHAUSTIVE set, over every
  loaded top-level object, for which `collection.imported(fqn)` is true — a package a
  dependency owns (DESIGN §11.5: the exclusion key is package-keyed).
- **`expectSelected`** — OPTIONAL, alongside `expectFiles`: the EXHAUSTIVE set, over every
  loaded top-level object, for which `collection.inScope(fqn)` is true — the codegen/CLI
  selection predicate, composed from the declared scope and the default exclusion of
  imported metadata (DESIGN §11.1 item 2).
- **`expectMigrateGoverned`** — OPTIONAL, alongside `expectFiles`: the EXHAUSTIVE set, over
  every loaded top-level object, for which `collection.inMigrateScope` admits it — an
  `undefined` predicate (no `migrate.scope` declared and no dependencies) admits every
  object.
- **`expectLoadError`** — OPTIONAL, alongside `expectFiles`: the collection resolves
  cleanly, but LOADING it (parsing the resolved files into a metadata tree) fails with
  this code.
- **`expectErrorFiles`** — OPTIONAL, alongside `expectLoadError`: `source.files[0]` of the
  first load error — asserts the failure names the right file, e.g. a dependency artifact
  (`dep:<name>/<artifact>`) rather than a local one.
- **`expectError`** — the resolution-failure arm: `resolveCollection` itself must reject
  with this exact code.

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

## Load-time failure cases — the loader's existing errors are the first drift gate

DESIGN §2.5 says that once `meta deps sync` replaces a stale snapshot, a consumer construct
that pointed at something upstream removed or changed fails through the loader's *existing*
errors — no new machinery. The seven cases below exercise that table end-to-end: the
dependency's artifact loads first, the consumer's own file loads second and fails exactly
where §2.5 predicts.

| Upstream change / consumer construct | Case | Error (existing) |
|---|---|---|
| a node removed; local `overlay: true` targets it (field-level) | `an-overlay-whose-target-was-removed-fails` | `ERR_OVERLAY_NO_TARGET` |
| a whole object the artifact never exports; local `overlay: true` targets it | `an-overlay-of-a-whole-object-absent-from-the-artifact-fails` | `ERR_OVERLAY_NO_TARGET` |
| a node removed/never existed; local `extends` targets it | `an-extends-whose-target-was-removed-fails` | `ERR_UNRESOLVED_SUPER` |
| a node removed/never existed; local `field.object @objectRef` targets it | `a-reference-whose-target-was-removed-fails` | `ERR_UNRESOLVED_OBJECT_REF` |
| a member's subtype changed (v1 `Customer.email` is `field.string`); local dotted `extends: Customer.email` from a `field.int` | `a-dotted-extends-whose-member-changed-subtype-fails` | `ERR_EXTENDS_TARGET_MISMATCH` |
| an attr the consumer's overlay also sets is now set differently upstream (base `@maxLength: 120`, overlay `@maxLength: 80`) | `an-overlay-attr-the-base-now-sets-differently-conflicts` | `ERR_MERGE_CONFLICT` |
| the dependency's own artifact file fails to parse | `a-dependency-file-error-names-the-dependency` | `ERR_MALFORMED_JSON`, naming `dep:acme-common/acme-common.metaobjects.json` |

All seven pass with **no source change** (`sdk/test/dependency-conformance.test.ts`).
`an-overlay-whose-target-was-removed-fails` is the one case that rests on a genuine
upstream removal rather than "never existed" — it loads
`acme-common-v2-email-removed.json` (v1's `Customer` minus `email`) as the dependency
snapshot and pins that artifact's hash (`sha256-c4ba…ce7a`, printed above) in the case's
`lock`; every other case here loads the unmodified `acme-common-v1.json`.

**Ordering note (verified, not merely asserted).**
`an-overlay-of-a-whole-object-absent-from-the-artifact-fails` overlays a whole top-level
object (`Invoice`) into `acme::common` — a package the dependency owns but does not
export `Invoice` from. That input also matches the post-load ownership refusal
`ERR_DEPENDENCY_PACKAGE_NOT_OWNED` (§11.1 item 2, "a consumer may not declare a new
top-level node into a dependency's package"). `sdk/src/memory.ts`'s `loadMemory` throws
the loader's own errors (`result.errors`) BEFORE it runs the ownership walk
(`refuseUnownedPackages`) — confirmed by running this exact case, not merely read off the
source — so `ERR_OVERLAY_NO_TARGET` wins. If this case ever reports
`ERR_DEPENDENCY_PACKAGE_NOT_OWNED` instead, that is an ordering regression to fix, not a
corpus expectation to update.

## Which arms each port runs

- **TypeScript** — resolution, load-time failure, lock/snapshot integrity.
- **Python** — resolution, load-time failure, lock/snapshot integrity.
- **Java / C# / Kotlin** — Phase 2 (out of scope for this plan; these ports do not read
  `dependencies` yet).

## Reference implementation

`server/typescript/packages/sdk/src/collection.ts` (`resolveCollection`) and
`server/typescript/packages/sdk/src/memory.ts` (`loadMemory`).

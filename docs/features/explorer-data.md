# Explorer data: the inputs a docs build reads

A model explorer shows one project so a reader can see what it does and how it was designed:
the objects and how they connect, the prompts and what they send and get back, the requirement
tree and whether each claim holds, and which generated files each node produced. Every page of
it reads one document, the **docs view**, which the site ships as `explorer.json`. Its shape is
[docs-view.md](docs-view.md).

This page documents what the view is built from besides the model: the requirement gate's
ledger, the generated-file manifest, and the routes. The site that reads the view, built by
`docsSiteFile()`, is [explorer-site.md](explorer-site.md); that generator builds the view during
`meta gen`, so you only build it by hand to feed a tool of your own.

## What the view is built from

`buildDocsView` (in `@metaobjectsdev/metadata`) takes the model the port has already loaded,
plus three optional inputs:

| Input | Produced by | What it contributes |
| --- | --- | --- |
| The loaded model | the port's own loader | nodes, members, inheritance, every reference, every claim |
| The verify payload | `meta verify --format json` | the requirement ledger: each requirement's verdict, digest and findings, the counts, the findings about other nodes |
| The generated-file manifest | `.metaobjects/.gen-state/.hashes/`, written by `meta gen` | which generated files each node produced |
| The routes | the generators that mount them | which REST routes each node serves |

Only the model is required. The view reads the model the loader resolved, so it re-derives
nothing (no reference is matched by name, no inheritance is re-walked). An earlier version read
the effective canonical JSON from `meta export --effective` and rebuilt references from a fixed
list of attribute names; the view replaced it, and a provider's own vocabulary now gets its
links, on every attribute the loader resolves as a reference, with no change to the docs code.

### `meta export --effective`

```
meta export --effective [--out <file>]
```

`meta export` writes the loaded model as one canonical JSON document, with overlays merged.
By default each node holds only what it declares. With `--effective`, every field, child and
attribute a node inherits through `extends` is written onto that node as well. An entity that
extends `BaseEntity` then lists `id` and `createdAt` itself, and `extends` is still written,
as the canonical fully-qualified name. Reference attributes (`@references`, `@objectRef`,
`@payloadRef`, `@responseRef`) are written in their canonical form in both modes.

The effective document is for reading, not for loading back. A loader reading it would see
each inherited member twice, once on the base and once on the subtype. The docs view does not
read it.

### `meta verify --format json`: `requirementLedger`

When the model declares a requirement, the structured verify payload carries one
`requirementLedger` row per `requirement.*` node, in document order, beside `requirementCounts`.
The text output is unchanged. Each row states what the gate decided for that entry, so a reader
does not have to infer "checked and clean" from a path that no diagnostic mentions.

```json
{
  "path": "Shop.Checkout.Orders.Recorded.Quotable",
  "package": "acme::shop",
  "qualifiedPath": "acme::shop::Shop.Checkout.Orders.Recorded.Quotable",
  "subType": "functional",
  "level": 5,
  "status": "live",
  "digest": "<64 hex characters>",
  "implementedBy": [
    { "ref": "Order.reference", "resolves": true, "target": "acme::shop::Order.reference" }
  ],
  "diagnostics": [],
  "verdict": "clean"
}
```

| Field | Meaning |
| --- | --- |
| `path` | The dotted child-name address every diagnostic prints. |
| `package` | The requirement's effective package, `""` when it has none. |
| `qualifiedPath` | `<package>::<path>`. It is also the prefix of each generated requirement test's id, `<qualifiedPath> [<unit>]`. |
| `level`, `status`, `disposition` | As declared, and absent when not declared. |
| `digest` | The same SHA-256 over the claim that each generated requirement test carries ([requirements.md](requirements.md)). |
| `implementedBy` | Each link as written (`ref`), whether it resolves, and the node it resolves to (`target`): the object's resolution key, followed by `.<member path>` for a member. The gate's own resolver produces these values. |
| `supersededBy` | The same, for `@supersededBy`; its `target` is the replacement's `qualifiedPath`. |
| `diagnostics` | Every finding reported against this requirement, as `{ code, severity, source, message }`. `source` is `gate` when the finding can fail the build and `lint` when it cannot. Two packages may declare a requirement at the same `path`, so read a requirement's findings here rather than matching `requirements.rows` by path. |
| `verdict` | From gate findings only: `error`, `warn`, or `clean`. |

A finding that is not about a single requirement, such as an entity nobody claims, appears
in `requirements.rows` and in no ledger row. Each `requirements.rows` entry is `{ code, path,
node, severity, source, message }`. `path` is the requirement's dotted path, or `""` when the
subject is not a requirement. `node` names that other subject: a
`WARN_REQUIREMENT_OBJECT_UNCLAIMED` row carries the entity's resolution key there (for example
`"node": "acme::shop::AuditEntry"`, the entity's id in the docs view), and every other row
carries `""`. Read the subject from `path` and `node`, never from `message`, whose wording may
change. The docs view turns these rows into its `advisories`, and an entity's `unclaimed` flag
comes from the `node` field. The structured payload is TypeScript-only, as the rest of `--format json` is.

### Node provenance in the manifest

Each generated file now records the metadata node it was rendered from, in TypeScript, C#,
Java and Python. A per-object generator sets this automatically (TypeScript `perEntity`, C#
`PerEntityGenerator`, Python `per_entity`, and the shared writer the Java generators use). A
generated file can also name its node directly (`sourceNode` on a TypeScript `EmittedFile`,
`SourceNode` in C#, `source_node` in Python), as a node resolution key such as
`acme::shop::Order`. A write run then writes that file's manifest entry in object form:

```json
{
  "src/generated/acme/shop/Order.ts": {
    "hash": "<sha-256>",
    "generatedBy": "entity",
    "sourceNode": "acme::shop::Order"
  },
  "src/generated/index.ts": "<sha-256>"
}
```

A file rendered from the whole model or a whole package keeps the plain `"<path>": "<hash>"`
form, so a project that writes only such files has an unchanged manifest. Every port's
manifest reader takes `hash` from either form.

The provenance field is named `generatedBy`, not `generator`. In a Java or Kotlin module's
manifest, `generator` means that generator owns the file (ADR-0060), and the orphan sweep acts
on that ownership, so a JVM entry carries both: `{ "hash", "generator", "outputDir",
"generatedBy", "sourceNode" }`. Every port writes the same entry for the same records; the shared
vector `provenance` in
[`fixtures/codegen-skip-conformance/manifests.json`](../../fixtures/codegen-skip-conformance/manifests.json)
holds TypeScript, C#, Java and Python to it. Kotlin and Rust write no provenance yet.

## Building it by hand

```ts
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { MetaDataLoader, buildDocsView, serializeDocsView } from "@metaobjectsdev/metadata";

const read = (f: string) => JSON.parse(readFileSync(f, "utf8"));
// The manifest is one file per model package; the view wants their union.
const hashes = ".metaobjects/.gen-state/.hashes";
const manifest = Object.assign(
  {},
  ...readdirSync(hashes).filter((f) => f.endsWith(".json")).map((f) => read(`${hashes}/${f}`)),
);

const { root } = await MetaDataLoader.fromDirectory("metaobjects", { strict: true });
writeFileSync("explorer.json", serializeDocsView(buildDocsView({
  root,
  verify: read("verify.json"),                          // meta verify --format json > verify.json
  manifest,
})));
```

`routes` (optional) is a list of `{ node, method, path }`, one per REST route, with `node` a
resolution key and the project's `apiPrefix` in `path`; `docsSiteFile()` fills it from the
routes the run mounts. The manifest records files, not the routes inside them, so a hand build
that wants routes passes them here. A `verify`, `manifest` or `routes` that is missing or
malformed leaves its part of the view empty.

## Not built yet

- **`usage`**: which hand-written modules import a generated module. The design marks it
  optional, and nothing builds it yet.
- **Provenance from the Kotlin and Rust generators.** Their manifest entries have no
  `sourceNode` yet, so for those ports a node lists no files.
- **The docs view in the other ports.** TypeScript builds it today; the corpus is what the
  other ports will be held to.

## Verified by

- [`fixtures/explorer-conformance/`](../../fixtures/explorer-conformance/): the view of each
  case, byte for byte ([docs-view.md](docs-view.md)).
  `server/typescript/packages/cli/test/explorer-fixture.test.ts` checks that the gate still
  writes each case's committed `verify.json`, and checks the `requirementLedger` rows and
  `meta export --effective`.
- `server/typescript/packages/codegen-ts/test/generated-provenance.test.ts`: covers how
  `perEntity` stamps each file, the object and plain manifest forms, and that JVM owner fields
  are preserved.

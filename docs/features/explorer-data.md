# Explorer data: `explorer.json` and the three inputs it reads

A model explorer shows one project so a reader can see what it does and how it was designed:
the objects and how they connect, the prompts and what they send and get back, the requirement
tree and whether each claim holds, and which generated files each node produced. All of that
is read from one data file, `explorer.json`. This page documents that file and the three
inputs it is built from.

This page is the data layer. The site that reads it, built by `docsSiteFile()`, is
[explorer-site.md](explorer-site.md); that generator builds the file during `meta gen`, so
you only build it by hand to feed a tool of your own.

## The inputs are port-neutral

The builder (`buildExplorer` in `@metaobjectsdev/docs-site`) never loads metadata itself. It
reads three documents:

| Input | Produced by | What it contributes |
| --- | --- | --- |
| Effective canonical JSON | `meta export --effective` | nodes, inheritance, every model edge |
| The verify payload | `meta verify --format json` | the requirement ledger, and the `implementedBy` / `supersededBy` edges |
| The generated-file manifest | `.metaobjects/.gen-state/.hashes.json`, written by `meta gen` | which generated files each node produced |

Only the first is required. Without the verify payload there is no `ledger` and no requirement
claim edge; without the manifest there is no `generated` section.

Because the builder reads no loader and no provider, it does not depend on which port wrote
its inputs. Every port has a canonical serializer and writes the same manifest file.

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
each inherited member twice, once on the base and once on the subtype.

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
| `diagnostics` | Every finding reported against this requirement, as `{ code, severity, source }`. `source` is `gate` when the finding can fail the build and `lint` when it cannot. |
| `verdict` | From gate findings only: `error`, `warn`, or `clean`. |

A finding that is not about a single requirement, such as an entity nobody claims, appears
in `requirements.rows` and in no ledger row. The structured payload is TypeScript-only, as
the rest of `--format json` is.

### Node provenance in `.hashes.json`

Each generated file now records the metadata node it was rendered from. A generator built with
`perEntity` sets this automatically. An `EmittedFile` can also name its node directly with
`sourceNode`, which is a node resolution key such as `acme::shop::Order`. `meta gen` then
writes that file's manifest entry in object form:

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
on that ownership. TypeScript does not make that claim. TypeScript is the only port that writes
provenance today, and the JVM rewrites its manifest without these fields.

## The `explorer.json` shape

```ts
interface ExplorerJson {
  format: "metaobjects-explorer/1";
  nodes: ExplorerNode[];
  edges: ExplorerEdge[];
  ledger?: ExplorerLedger;        // absent without a verify payload with requirements
  generated?: ExplorerGenerated[]; // absent without a manifest
  api?: ExplorerRoute[];           // absent without a routes input
  slices: ExplorerSlice[];
}
```

The types are exported from `@metaobjectsdev/docs-site`. The `format` value changes when a field
changes meaning or is removed. Adding a field does not change it.

### `nodes`

The output has one node for each top-level node (object, prompt, requirement) and one for
each node nested inside one (field, identity, source, view, index, nested requirement).

| Field | Meaning |
| --- | --- |
| `id` | A top-level node's id is `<package>::<name>`. A nested node's id is its parent's id followed by `.<name>`, for example `acme::shop::Order.total`. A nested requirement's id equals its ledger row's `qualifiedPath`. A nested node with no name gets `#<index>` in place of `.<name>`. When siblings of different types share a name, the first one in the effective JSON keeps `.<name>`, because that is the node a dotted `@implementedBy` reference such as `Order.id` resolves to. Each later one adds its type, for example `acme::shop::AuditEntry.id[identity.primary]`. |
| `type`, `subType`, `name`, `package` | As in the model. `package` is the package of the top-level ancestor. |
| `parent` | The id of the node it is nested in. A top-level node has no `parent`. |
| `order` | Its position among its siblings in the effective tree, from 0: the declaration order, which the id sort does not keep. |
| `extends`, `abstract`, `isArray` | As in the effective JSON. |
| `inheritedFrom` | Set on a member that came from a super. It holds the id of the object the member is declared on, meaning the topmost ancestor that has a member with the same type, name and body. A member redeclared with a different body belongs to the node itself. |
| `attrs` | Every `@` attribute, without the `@`, with keys sorted. |

Two nodes that would still share an id are an error: two top-level nodes with one name in one package, or two siblings with the same type and name. The builder throws and names the id.

### `edges`

Each edge is typed. An edge is emitted only when both its ends are nodes in the file.

| `kind` | From → to | Source |
| --- | --- | --- |
| `extends` | node → its super | `extends` |
| `references` | object → referenced object, `via` the `identity.reference` | `@references` |
| `objectRef` | object → value or entity, `via` the `field.object` | `@objectRef` on a field |
| `association` | object → target, `via` the `relationship.*` | `@objectRef` on a relationship |
| `payload` | prompt → payload object | `@payloadRef` |
| `reply` | prompt → reply object | `@responseRef` |
| `contains` | requirement → nested requirement | nesting |
| `implementedBy` | requirement → object or member | a ledger row's resolved `target` |
| `supersededBy` | requirement → replacing requirement | a ledger row's resolved `target` |

An `implementedBy` edge exists only when the verify payload resolved that link. The builder
never matches names itself. A planned requirement that names a node that does not exist yet
has a ledger row whose link is `"resolves": false`, and it has no edge.

### `ledger`

`counts` is `requirementCounts`, copied as is. `rows` holds the `requirementLedger` rows, each
with a `node` id added. `diagnostics` is `requirements.rows`, copied as is: every gate and lint
finding, including those about something other than a single requirement.

### `generated`

The manifest entries that carry `sourceNode`, grouped by node: `{ node, files: [{ path,
generatedBy }] }`, sorted by node and then by path. A plain entry has no node and is left out.

### `api`

One row per REST route: `{ node, method, path }`, with the project's `apiPrefix` in the path,
sorted by node, then path, then method. Absent when no routes were passed.

### `slices`

Slices are named node sets that a view can open on. They are all derived from the model, so
none needs to be written by hand:

- `package:<package>`: the top-level nodes of one package.
- `requirement:<id>`: one for every requirement that has nested requirements. It holds the
  subtree, every node the subtree claims, and the object that owns each claimed member.
- `prompt:<id>`: one for every prompt. It holds the prompt, its payload and its reply.

The design report also proposes slices saved by hand. Those belong in tool configuration,
never in metadata, and are not built yet.

### Determinism

The same inputs always produce the same bytes. Nodes are sorted by id. Edges are sorted
by kind, then `from`, then `to`, then `via`, with duplicates removed. Slices are sorted by id,
and ledger rows stay in the verify payload's order. `serializeExplorer` writes JSON indented
two spaces, with one trailing newline. That makes the file safe to commit and diff.

## Building it

```ts
import { readFileSync, writeFileSync } from "node:fs";
import { buildExplorer, serializeExplorer } from "@metaobjectsdev/docs-site";

const read = (f: string) => JSON.parse(readFileSync(f, "utf8"));
writeFileSync("explorer.json", serializeExplorer(buildExplorer({
  model: read("effective.json"),                        // meta export --effective --out effective.json
  verify: read("verify.json"),                          // meta verify --format json > verify.json
  manifest: read(".metaobjects/.gen-state/.hashes.json"),
})));
```

`routes` (optional) is a list of `{ node, method, path }`, one per REST route, and becomes the
`api` section; `docsSiteFile()` fills it from the routes the run mounts. The manifest records
files, not the routes inside them, so a hand build that wants routes passes them here.

A `verify`, `manifest` or `routes` that is missing or malformed leaves its section out. A `model` that is
not canonical metadata JSON makes the builder throw.

## Not built yet

- **`usage`**: which hand-written modules import a generated module. The design marks it
  optional, and nothing builds it yet.
- **Provenance from the JVM, Python and C# generators.** Their manifests have no `sourceNode`
  yet, so for those ports `generated` is empty.

## Verified by

- [`fixtures/explorer-conformance/shop/`](../../fixtures/explorer-conformance/shop/): a small
  model with inheritance, a prompt, and a five-level requirement tree. Its `expected.json` is
  checked byte for byte. `server/typescript/packages/cli/test/explorer-fixture.test.ts` checks
  that the CLI still writes the committed `effective.json` and `verify.json`, and checks the
  `requirementLedger` rows.
- `server/typescript/packages/codegen-ts/test/generated-provenance.test.ts`: covers how
  `perEntity` stamps each file, the object and plain manifest forms, and that JVM owner fields
  are preserved.

# The docs view

Every documentation page about a model reads the same facts: which nodes there are, what each
holds, what it references and what references it, which requirement claims it, and which files
were generated from it. The **docs view** is one document per build that holds those facts and
nothing else. A port builds it from the model it has already loaded, and a page is then a
template that reads it.

The view holds facts only: no HTML, no Markdown and no sentences. Where a page must choose
(show a section or not, draw a badge or not) the view gives it a boolean or a count, so a
logic-less template such as Mustache can render it unaided. Every port that builds the view
writes the same bytes for the same model, and the shared corpus
[`fixtures/explorer-conformance/`](../../fixtures/explorer-conformance/) holds them to that.

TypeScript builds it today. `buildDocsView` and `serializeDocsView` are exported from
`@metaobjectsdev/metadata`, and `docsSiteFile()` writes the result as the site's
`explorer.json` (see [explorer-site.md](explorer-site.md)). The other ports build it as their
own step of the same plan. The explorer pages still render their HTML in TypeScript; moving that
into templates is a later step.

## What it is built from

| Input | Required | What it adds |
| --- | --- | --- |
| The loaded, resolved model | yes | every node, member, attribute, reference, inheritance and claim |
| The verify payload (`meta verify --format json`) | no | each requirement's verdict, digest and findings; the counts; the advisories; which entity nobody claims |
| The generation manifest (`.metaobjects/.gen-state/.hashes/`, merged) | no | which generated files each node produced |
| The routes the run mounts (`[{ node, method, path }]`) | no | each node's REST routes |

The builder re-derives nothing the loader already decided. Ids come from walking the
effective tree. Inheritance comes from where each effective child is declared, and references
come from the loader's own resolution of every attribute it treats as a reference. Claims are
resolved by the same resolver the requirement gate uses. A provider's vocabulary therefore
gets its members and its links with no change to the docs code. A link needs an attribute
the loader resolves as a reference (such as `@objectRef`); any other attribute stays text. The
corpus's `crm` case
declares a `page.list` and a `capability.module` in a data-driven provider, and both appear,
linked, with nothing in the builder that names them.

The verify payload, manifest and routes are optional. A missing or malformed one leaves its
part empty, and `sources` says which were read. Claims do not need the verify payload: they are
the model's own `@implementedBy`, so they hold without it.

The input formats are described in [explorer-data.md](explorer-data.md).

## Conventions

- **Every key is always present.** An absent fact is `""`, `false`, `0`, `[]` or `null`, never a
  missing key, so a template never tests for existence.
- **Key order is the order on disk**, as the types below list it.
- **Sorting is by code unit**, never by locale, so every runtime sorts alike.
- **`serializeDocsView`** writes the view as JSON indented by two spaces, with one trailing
  newline.
- **`format`** is `"metaobjects-docs-view/1"`. It changes when a field changes meaning or is
  removed, and not when a field is added.

### Links

A pointer to anything in the view is a link:

```ts
interface DocsViewLink {
  label: string;      // what a page prints
  id: string;         // the target's id; "" when unresolved
  path: string;       // site-relative page, with #<anchor> for a member; "" when unresolved
  kind: string;       // "<type>.<subType>"; "" when unresolved
  unresolved: boolean;
}
```

The `label` is a top-level node's name, a requirement's `@title` (else its name), or
`<owner name>.<member path>` for a member. An unresolved link keeps the text as written in its
`label`, so a page can print it without linking it. A link to an inherited member lands on the
node that declares it, because a reference to that member resolves there.

### Ids

- A top-level node is `<package>::<name>`, or just `<name>` with no package.
- When top-level nodes of different types share a package and a name (an entity `Lead` and an
  application's page `Lead`), the object keeps the plain id, since every model reference names an
  object. If none of them is an object, the first one declared keeps it. Each other one adds its
  type: `acme::crm::Lead[page.list]`.
- A member is its parent's id plus `.<name>`, or `#<index>` when it has no name. When siblings of
  different types share a name, the first one keeps `.<name>`, because that is the node a dotted
  `@implementedBy` such as `AuditEntry.id` resolves to. Each later one adds its type:
  `acme::shop::AuditEntry.id[identity.primary]`.
- Two nodes that would still share an id make the builder throw, naming the id.

### Pages and anchors

- A top-level node's page is `model/<package dir>/<stem>.html`. The package directory is the
  package with `::` turned into `/`, or `-root` for no package. The stem is the name, or
  `<name>.node` when the name is `index` (in any case), so it never takes the package's index
  page. A node whose id carries a type qualifier adds `.<type>-<subType>`:
  `Lead.page-list.html`.
- A requirement and everything inside it land on
  `requirements/<package dir>/<stem of its address>.html`.
- A direct member of a top-level node lands on its owner's page at `#<anchor>`. The anchor is
  `m-<name>` for a field, `m-<type>-<name>` for anything else, and `m-<type>-<order>` for a member
  with no name. A deeper member lands on the anchor of the direct member that holds it. A page
  must carry an element with every direct member's anchor, so that every link in the view lands.

## The document

```ts
interface DocsView {
  format: "metaobjects-docs-view/1";
  sources: { requirements: boolean; files: boolean; routes: boolean };
  counts: DocsViewCounts;
  packages: DocsViewPackage[];
  nodes: DocsViewNode[];            // every top-level node, sorted by id
  requirements: DocsViewRequirement[];
  advisories: DocsViewAdvisory[];
  slices: DocsViewSlice[];
}
```

The types are exported from `@metaobjectsdev/metadata`.

### `nodes`

One entry per top-level node of any type: objects, prompts, requirements, and any type a
provider registers.

| Field | Meaning |
| --- | --- |
| `id`, `name`, `package`, `type`, `subType` | As above. `package` is the effective package. |
| `order` | Its position among the top-level nodes in declaration order, which the id sort does not keep. |
| `path` | Its page. |
| `title`, `description`, `summary` | The documentation attributes, or `""`. |
| `abstract` | As declared. |
| `extends` | A link to its super, or `null`. |
| `attrs` | Every effective attribute (see below). |
| `memberGroups` | Its members, by type (see below). |
| `refs` | Every reference from the node or any of its members, in walk order. |
| `referencedBy` | Every reference into the node or any of its members, from another top-level node. |
| `claims` | Every requirement claim on the node or on anything in it. |
| `files` | `{ generatedBy, paths }`, one group per generator, sorted by generator, paths sorted. |
| `routes` | `{ method, path }`, method upper-case, sorted by path then method, duplicates removed. |
| `unclaimed` | The gate reported that no requirement claims this entity (`WARN_REQUIREMENT_OBJECT_UNCLAIMED`, matched on the finding's `node`, never its message). |
| `counts` | `members` (direct), `refs`, `referencedBy`, `claims`, `files`, `routes`. |

### Attributes

```ts
interface DocsViewAttr {
  name: string;           // without the @
  value: unknown;         // the effective value
  values: { text: string; link: DocsViewLink | null }[];
}
```

Attributes are the effective ones, inherited through `extends` included, sorted by name.
`value` is written as the canonical serializer writes it, with every object's keys in code-unit
order, so a map attribute such as `@intValueMap` reads the same from every port. A
string gives one value and a list of strings gives one value per element. Any other value gives
one, written as compact JSON. `link` is set only on an attribute the loader resolves as a
reference. It points at the member the value's dotted tail names when there is one, otherwise
at the node the loader bound. An attribute that merely spells a node's name is text: the view
never matches names itself.

### Members

```ts
interface DocsViewMemberGroup { type: string; count: number; members: DocsViewMember[] }
```

The members of one type (every subtype of it), in declaration order. Groups are ordered by their
first member. Grouping is by type alone, so a custom type's members group with no change to the
builder.

A member has `id`, `name`, `type`, `subType`, `order` (among its siblings in the effective tree),
`anchor` (`""` below a direct member), `path`, `abstract`, `isArray` (resolved through
`extends`), `extends`, `attrs`, `refs` (from its own attributes and `extends`), `claims` (on it or
anything in it), its own `memberGroups`, and:

- **`declaredOn`**: when the member is inherited through `extends`, a link to the node that
  declares it, otherwise `null`. An entity extending `BaseEntity` lists `id` among its own
  members, in its effective place, with `declaredOn` pointing at `BaseEntity`.

### References

```ts
interface DocsViewRef      { attr: string; via: DocsViewLink | null; target: DocsViewLink }
interface DocsViewReferrer { attr: string; from: DocsViewLink; via: DocsViewLink | null; target: DocsViewLink }
```

`attr` is the attribute without the `@`, or `extends`. `via` is the member that carries the
reference, or `null` when the node itself does. Only resolved references are listed. A
`referencedBy` entry is sorted by `from`, `attr`, `via` and target, with duplicates removed.
References within one top-level node are not listed as `referencedBy`.

### Claims

```ts
interface DocsViewClaim { requirement: DocsViewLink; member: string; status: string; level: number | null }
```

A claim is one resolved `@implementedBy` link. It is listed on the top-level node and on every
member down to the one it names. `member` is the dotted path below the top-level node, or `""`
when the claim is on the node itself.

### `requirements`

Every requirement at any depth, flat, in document order.

| Field | Meaning |
| --- | --- |
| `id`, `name`, `label`, `path` | As above. |
| `address` | The dotted path of requirement names that every `verify` diagnostic prints. |
| `package`, `qualifiedPath` | The effective requirement package, and `<package>::<address>`. |
| `subType`, `level`, `status`, `disposition` | As declared; `level` is `null` when not declared. |
| `statement`, `counterexample`, `title`, `description`, `trackedBy` | As declared. |
| `depth` | How many requirements are above it. |
| `parent`, `breadcrumbs`, `children` | Links: the requirement above, every one above (outermost first), the ones directly below. |
| `implementedBy` | `{ ref, resolves, target }` per link as authored. `target` is unresolved when `resolves` is false. |
| `supersededBy` | The same, as the gate resolved it; `null` without one or without a verify payload. |
| `inLedger`, `verdict`, `digest`, `diagnostics` | From the gate's ledger row (`verdict` is `clean`, `warn` or `error`); `false` / `""` / `[]` without one. A ledger row is matched by `qualifiedPath`, in order, so two requirements with one path keep their own rows. |
| `rollup`, `rollupTotal` | The declared statuses of the requirements below that name the model (level 4 or 5, or no level and an `@implementedBy`), as one `{ status, count }` per status in the fixed order `planned`, `live`, `partial`, `retired` (the order the status vocabulary declares). A requirement with none such below counts itself. |
| `belowCount`, `childCount` | Requirements anywhere below, and directly below. |
| `targets`, `targetCount` | The top-level nodes it and the requirements below it claim, sorted by id. |

### `packages`

One entry per package, sorted by name (`""` for nodes with no package): `{ name, count,
groups }`, where each group is `{ type, subType, count, nodes }`, sorted by `<type>.<subType>`.

### `counts`

`nodes`, `packages`, `requirements`, `functional`, `architectural`, `byStatus` (as `rollup`),
`claims` (resolved `@implementedBy` links), `files` (distinct paths), and `routes`. From the
verify payload: `undecided`, `coverageMeasured` (whether the gate measured entity coverage),
`entitiesClaimed` and `entitiesTotal`, each `0` or `false` without one.

### `advisories`

Every finding `meta verify` reported, in its order: `{ code, path, subject, severity, source,
message }`. `path` is the requirement's address, or `""` when the subject is not a requirement.
`subject` is a link to the node a non-requirement finding is about, or `null`. `source` is
`gate` for a finding that can fail the build and `lint` for one that never can.

### `slices`

Named node sets a map view opens on, all derived, each `{ id, kind, anchor, nodes }` with
`nodes` sorted, the list sorted by `id`:

- `package:<package>`: the package's top-level nodes.
- `requirement:<id>`: one per requirement with requirements below it. It holds the subtree,
  every node the subtree claims, and the top-level node holding each claimed member.
- `prompt:<id>`: one per template. It holds the template and what its own attributes reference
  (its payload and reply).

## Verified by

- [`fixtures/explorer-conformance/`](../../fixtures/explorer-conformance/): each case's
  `expected.json` is the view of its project and committed inputs, byte for byte.
  `server/typescript/packages/metadata/test/docs-view-conformance.test.ts` runs it, and also
  checks inheritance, references, the requirement list, custom vocabulary and a build without
  the optional inputs.
- `server/typescript/packages/cli/test/explorer-fixture.test.ts`: the committed `verify.json`
  files are what the gate writes today, and a fresh verify payload builds the committed
  `shop/expected.json`.
- `server/typescript/packages/docs-site/test/explorer-site.test.ts`: the explorer site built
  from the view passes its own link check, and ships the view as `explorer.json` unchanged.

# `<Node>Names` as a generic metadata-tree traversal

**Date:** 2026-09-06
**Status:** design approved, implementation pending
**Supersedes:** the `<Entity>Names` v2 shape landed but unreleased on `main`
(`4a9b259c8`, `8842ca7fa`, `5a9298d7b`, `f41c88a6f`)

## Problem

The `<Entity>Names` artifact exists to remove magic physical strings from generated
and hand-written code. The v2 restructure made each node carry its own
`type`/`subType`/`name` and moved physical names under kind-named keys, which fixed
the defect where one key held a table, a view and a stored procedure told apart only
by a sibling `kind`.

It did not make the artifact *generic*, and three consequences follow.

**1. The traversal is hard-coded to four collections.** `ObjectNames` declares
`sources`, `fields`, `identities`, `indexes` plus four `own*` twins, and
`resolveObjectNames` calls four named accessors. A child of any other registered
type contributes nothing — not because it is rejected, but because nothing looks for
it. A provider that registers a new type under an entity gets no names for it, ever,
without editing five generators.

**2. The artifact only exists for database-backed objects.**
`resolveObjectNames` opens with `primaryRdbSource(obj) === undefined → return
undefined`. So `object.value`, a sourceless `object.projection`, and a pure abstract
marker get no artifact at all. The artifact is scoped to persistence while being
named for metadata.

**3. Inheritance is by reference, and the reference is lossy.** A concrete node emits
`own*` members and spreads the super's constant. Inherited non-primary sources are
dropped from that spread (`names-decl.ts:141` gates on `inheritsSource` while the
resolved map is complete), so a caller emits `ChildNames.sources.replica.view` — a
key the `as const` does not declare, i.e. generated code that does not compile.

A fourth consequence is a shipped bug rather than a design flaw, and it is the
clearest evidence for the redesign: `callable-file.ts:140` still emits
`<Entity>Names.name` for a stored procedure, so every generated FR-015 callable
becomes `SELECT * FROM <ObjectName>(…)`. The file's own comments at lines 118 and 135
already say `sources.primary.proc`; the prose was converted and the code was not. The
C# and Kotlin siblings were both converted correctly. The gate cannot see it, because
`no-magic-physical-names` asserts a member appears in *some* consumer and the entity
file's `$table:` line satisfies that.

## Prior art

- **Protocol Buffers `descriptor.proto`** describes protobuf schemas in protobuf:
  `FileDescriptorProto` → `DescriptorProto` → `FieldDescriptorProto`, recursive, with
  a message's children as **named repeated fields per child kind** (`field`,
  `nested_type`, `enum_type`, `oneof_decl`). It also ships a wrapper layer
  (`FileDescriptor` wraps `FileDescriptorProto`) so consumers get an ergonomic API
  over the raw recursive document. This is the shape adopted below.
- **JPA static metamodel** (JSR-317 §6.2.1) generates `Entity_` per managed class and
  mirrors inheritance with *class* inheritance (`Child_ extends Parent_` over a
  `@MappedSuperclass`). That has a documented failure mode where the base's type
  parameters do not match the child's context — the same class of problem as the
  super-spread in consequence 3. Evidence for inlining, not for referencing.
- **jOOQ** generates typed objects rather than strings; `AUTHOR.FIRST_NAME` is a
  `TableField` dereferenced from the table, so a name is never a string at the use
  site. The strongest form of the goal, and out of reach for a cross-port constants
  artifact.
- **Ent (Go)** emits flat per-entity constants namespaced by *prefix* (`Label`,
  `Table`, `FieldID`, `EdgeTenant`) — what the four non-TS ports do today with
  `SOURCE_`/`IDENTITY_`/`INDEX_`.
- **Prisma** carries the cautionary tale: its DMMF is a full recursive JSON IR of the
  schema and was removed from the generated client to cut bundle size. The local
  version of that scar is 0.21.5's descriptor split, which took a browser bundle from
  716 KB to 215 KB.

## Design

### The artifact

`<Node>Names` is a generated typed mirror of a metadata node's name-bearing tree.
One artifact per named, **concrete** ROOT node:

- every concrete `object.*` — `entity`, `projection` **and** `value`
- every concrete `requirement.*`

An abstract root emits no artifact. Its contribution is inlined into every concrete
descendant, so nothing can reference it and nothing needs to.

The `primaryRdbSource` gate is removed. Database participation decides what
`migrate` and the persistence generators do; it does not decide whether a node's
names are spelled once.

### Node entry — one shape at every depth

Root and child use the same shape. This is what makes the traversal generic: the
emitter has one case, not one per type.

```
{
  type,                    // metamodel type — object | field | source | identity | index | view | requirement | …
  subType,
  name,                    // the metadata name, never a physical name
  <authored attrs inline>, // every attr actually authored, own or inherited from an abstract parent
  <resolved name attrs>,   // every name-bearing attr with a value, even when derived
  <collection per child type present>
}
```

Two rules decide the payload:

- **Authored attrs are inlined when set**, including when set on an abstract parent
  the node `extends`. Resolving accessors only (ADR-0039); an `own*` read here would
  drop exactly what inlining exists to capture.
- **Name-bearing attrs are inlined when they RESOLVE**, authored or not. A field's
  `column` usually comes from `columnNamingStrategy` and an index name from the
  shared resolver; omitting derived names would leave the most-referenced name in the
  artifact missing and send callers back to literals.

Attributes are inlined, never nodes. That is the one exception to "full recursion",
and it is what bounds the tree: recursion walks structural children only, so depth is
bounded by the model rather than by the metamodel.

### Child collections come from the registry

Children are grouped into a named collection per child TYPE — `fields`, `sources`,
`identities`, `indexes`, `views`, `validators`, `requirements` — keyed by the child's
metadata `name`.

**The collection key is declared on the type registration, not computed.** The
alternative is five ports each pluralizing `view` → `views` and agreeing forever;
one declared string that `expected-registry.json` byte-gates is the better bet. A
provider registering a new type declares its collection key and gets a collection for
free, which is what makes "supports any registered type" structural rather than
aspirational.

### Registry changes

Two new fields on each `(type, subType)` entry in the metamodel providers and
therefore in `expected-registry.json`:

| Field | Meaning |
|---|---|
| `collection` | The collection key children of this type are grouped under (`view` → `views`). A property of the type; every subType of a type declares the same value. |
| `nameAttrs` | The attrs of this subType that hold NAMES, as a list. |

`nameAttrs` is a **list**, which is what lets `source.rdb` work without any
kind-conditional logic in any generator: it declares all five aliases (`table`,
`view`, `materializedView`, `proc`, `function`), exactly one ever resolves for a
given source, and the emitter inlines whichever has a value. `PHYSICAL_NAME_ATTR_BY_KIND`
keys on `@kind` — an attr *value*, not a subType — so a per-subType scalar could not
express it. The map stays where it is as the loader's canonical-storage rule; the
generator stops consulting it.

`metamodelVersion` moves **`0.14` → `0.15`**. Per the standing rule a change to
`expected-registry.json` / `metamodelVersion` forces all four registries to publish,
changed product file or not.

### Abstracts: resolved-inline

A concrete node's artifact contains every member reachable through `extends`, with no
reference to a parent artifact and no `own*` twins in the emitted shape. Abstracts
emit nothing, so nothing can reference them.

This deletes the super-spread mechanism, and consequence 3 becomes unreachable by
construction rather than patched. Codegen that must not re-emit inherited members
keeps calling `ownFields()` **on the metadata** — ADR-0039's one sanctioned
own-accessor use — which is unaffected by this change.

### Per-port rendering

Nested types in every port:

| Port | Form |
|---|---|
| TypeScript | nested object literal + `as const` |
| C# | nested static classes |
| Java | nested static classes |
| Kotlin | nested objects |
| Python | nested classes |

The `SOURCE_`/`IDENTITY_`/`INDEX_` member prefixes are **removed**. They exist only
because flat member names collide — `identity.primary` auto-names itself `primary`
(`spec/metamodel/identity.json:10`), colliding with source role `primary` — and
nesting namespaces them properly. The three per-port tests pinning those prefixes are
rewritten deliberately as part of this change, not deleted.

### Requirements

`requirement.*` uses the same traversal: its own identity, its authored attrs, and a
`requirements` collection for nested children.

The payoff is a link that is a magic string with a warning label on it today. The
generated stub embeds the requirement name as a bare literal in the test name and its
claimed target as a literal comment, under a generated header reading *"Do not rename
the test — the name is the link."* Both become references.

## Also in this package

Resolved together because they are the same defect class or because they are already
open against this work.

| Item | Disposition |
|---|---|
| `callable-file.ts` emitting `.name` for a stored proc | Subsumed — the code path is rewritten. |
| Super-spread dropping inherited non-primary sources | Subsumed — unreachable by construction. |
| Same-role `sourcesOf` refusal hard-failing a model the loader accepts | **Open decision, below.** |
| Stale `KIND`/`NAME`/`SCHEMA`/`READ_ONLY` rows in the Java + Kotlin codegen skill references | Doc fix; needed either way. The other three ports' rows were already rewritten. |
| A TPH subtype's `$path` naming an endpoint that does not exist | Fixed: `$path` holds the address the object is SERVED at (`restPath`), set once at `buildEntityUiDescriptor`. This is a live 404 — `grid-hook-file.ts:141` builds its URL from `<Sub>.$path` with no TPH awareness, so an opted-in per-subtype grid requests `/api/cars` while routes mount `/api/vehicles/car`. |
| The agent context stating flatly *"The loader is STRICT"* | Fixed: name the command. An unregistered type/subType errors in both `gen` and `verify`; an undeclared `@attr` errors only under `verify`, because `loadMemory` defaults `strict` off and `gen` never opts in. |
| `{ prefix: "/api" }` as a literal in generated routes | **No change — withdrawn.** `apiPrefix` is not metadata (zero occurrences in `expected-registry.json`, none in any `spec/metamodel/*.json`); it originates as `config.apiPrefix` in `metaobjects.config.ts`. An application-level setting resolved at generation time and baked into generated server code is the correct form. Routing it through a metadata-derived constant would launder app config through the metamodel. |

The last row leaves a related observation on the record without acting on it:
`$apiPrefix` is already a member of every generated `<Entity>` const and is read by
~20 sites across the TanStack and Angular templates. Under the same principle that
member is the anomaly — one application setting stamped into every entity's
constants file. The coherent alternative is for the browser to take the base URL from
the app-supplied `EntityFetcherProvider` fetcher. Deferred: it is a breaking
client-tier API change deserving its own design pass, and nothing is broken today.

## Gates

- **`registry-conformance`** covers `collection` and `nameAttrs` in all five ports —
  the manifest is byte-matched, so a port that forgets a field fails its own lane.
- **`no-magic-physical-names` must get stricter as part of this change, not after.**
  Today it asserts a member appears in *some* consumer, which is why it passed while
  the callable referenced the wrong member. It must assert per-consumer.
- **Cross-port names corpus** in `fixtures/codegen-conformance/`, which is a live
  cross-port home. Cases must include: a value object (no source), a sourceless
  projection, an abstract parent contributing fields and attrs, a write-through
  entity with a replica view, a stored-proc projection, a TPH hierarchy, a
  provider-registered custom child type, and a requirement with nested children.
- Every port's own suites plus a full `scripts/ci-local.sh`.

## Versioning and release

- Breaking artifact-shape change. Pre-1.0 a breaking change moves the MINOR:
  npm/PyPI/NuGet `0.25.0`, Maven `7.25.0`.
- `metamodelVersion` `0.14` → `0.15`, set with
  `node scripts/check-metamodel-version.mjs --set 0.15`, which writes the manifest and
  all four port constants together.
- All four registries publish, forced by the manifest change.
- The v2 shape is **unreleased**, so adopters take ONE breaking change to
  `<Entity>Names`, not two. This is the reason to do it now rather than after a cut.

## Open decisions

**The same-role refusal.** `sourcesOf` now throws whenever two sources in one role
disagree on a physical name. `validateSourceRoles` constrains only the *primary*
count, so two `@role: replica` children are legal and load with zero errors — meaning
codegen refuses a model the loader accepts. A model that previously generated (the
second replica simply unused) now aborts `meta gen` in all five ports. Either the
loader gains a matching rule and a migration note, or the artifact keys the extra
source rather than refusing. Secondary: TypeScript throws a bare `Error` here while
the sibling refusal in `primaryRdbSource` throws `MetaModelError`, so a caller that
classifies model errors will not classify this one.

## Non-goals

- Typed name *objects* in the jOOQ sense. A cross-port constants artifact cannot
  carry them, and the five-port byte-identical contract is worth more.
- A depth cap. Attributes are inlined rather than treated as nodes, so the recursion
  walks structural children only and is bounded by the model.
- Putting the names artifact in the browser-bound descriptor. It stays a separate
  `<Entity>.names.ts` module, tree-shakeable and distinct from `<Entity>.meta.ts`.

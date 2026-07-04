# Docs Site — Phase 2 Design: Consolidate the Graph onto the Shared Relationship IR

**Status:** approved · **Date:** 2026-07-04 · **Branch:** `feat/docs-site`
**Predecessor:** [Phase 1 — port as `meta docs --site`](2026-07-04-docs-site-design.md) (shipped)

## Problem

The docs-site's diagram edges come from a hand-rolled graph, `LinkGraph`
(`docs-site/src/link-graph.ts`), whose relationship edges are a shallow
`relationship.attr("objectRef") + cardinality` walk. It is blind to what the
metamodel actually models: M:N-through-junction (`@through`), belongs-to vs
has-many direction, directed (`@sourceRefField`) and symmetric (`@symmetric`)
self-joins, `@onDelete`, and the relationship subtype. A junction table shows
only as a plain entity with two FK edges — the logical M:N between its two ends
is invisible. And where an entity declares both a belongs-to `relationship` and
its underlying `identity.reference` FK, the graph emits **two parallel edges**
for the same physical link.

(Inheritance is **not** a gap: the structural walks already go through
`childrenOfType` → `children()`, which resolves the `extends` chain, so
inherited FKs/fields/relationships already appear. The gaps are relationship
*semantics* and edge *de-duplication*.)

## Goal / Non-goals

**Goal:** re-source the site's *relationship* edges from the shared derivation
SSOT so the diagrams cover every relationship the metamodel supports (M:N through
junction, belongs-to direction, directed + symmetric self-joins, `@onDelete`),
and de-duplicate the relationship-vs-bare-FK double edge — while keeping the
presentation layer (templates, assets, mermaid theming, kind-shape/domain-color
doctrine, page structure) and the neutral raw-metadata reads (fields, indexes,
validators, identities) intact. Preserve the determinism + link-check + golden
gates.

**Non-goals:** no template/asset redesign; no change to the markdown
`--model`/`--api`/`--metamodel` surfaces or `mermaid-er`; no new page kinds; no
runtime component. `buildRelationMap`/`buildApiModel` in codegen-ts are left
as-is (they serve codegen); we reuse the primitives *under* them.

## Key finding — consume the primitives, not the lossy output

The Phase-2 framing ("source edges from the relations IR that `buildApiModel`
exposes") does not survive contact with the code:

- **`buildApiModel`'s output is lossy** — `relationNavField` (api-model.ts)
  flattens relationships into display strings and drops `@onDelete`,
  `symmetric`, the junction FK fields, and the relationship subtype.
- **`buildRelationMap`'s output (`RelationEntry`) doesn't fit** — it is shaped
  for Drizzle codegen: keyed by bare entity name, skips projections, and models
  **only declared `relationship` children (+ junction sides)**. It emits nothing
  for a bare `identity.reference` FK, and nothing for the structural
  `field`/`extends`/`origin`/`payload` edges the site's diagrams need. A model
  with FKs but no `relationship` children yields an **empty** `RelationMap`.

The genuinely shared single-source-of-truth is one layer down — the derivation
**primitives** in `@metaobjectsdev/metadata/core/relationship/`, which
`buildRelationMap` itself consumes and which are barrel-exported from
`@metaobjectsdev/metadata` (a package docs-site **already depends on**):

- `deriveM2MFields(rel, source, root): M2MFields` — junction-FK derivation
  (hetero / directed `@sourceRefField` / `@symmetric`).
- `findReferenceBetween(a, b): ReferenceLookup | undefined` — which side
  physically holds the FK (direction).
- `MetaRelationship` getters — `through`, `symmetric`, `onDelete`,
  `cardinality`, subtype.

So we consume those primitives directly. This satisfies "consolidate onto the
shared derivation / new relationship types flow into docs automatically" at the
correct (primitive) layer, with **no new package coupling** and **no lifting
code across packages**.

## Architecture

Keep `LinkGraph` as the graph *structure* — nodes, `from`/`to` indices,
`relHref`, `ancestors`, `extendedBy`, and the entire public query API the
builders depend on (`refsFrom`/`refsTo`/`relationshipsOf`/…). Replace only the
**relationship-edge derivation** inside its constructor, and add the
relationship-vs-FK dedupe. The structural walks (`field`/`fk`/`origin`/`extends`/
`payload`) are left as-is — they already resolve the `extends` chain via
`childrenOfType` → `children()`. This is a hybrid: enriched relationship edges
from the shared primitives; structural edges unchanged.

### Edge model (`Ref`) — additive

```ts
interface Ref {
  from, to, via, kind;              // unchanged
  cardinality?: "one" | "many";     // normalized (was a free string)
  through?: string;                 // junction FQN         ┐
  sourceJoinField?: string;         // junction source FK   │ M:N
  targetJoinField?: string;         // junction target FK   │
  symmetric?: boolean;              //                      ┘
  onDelete?: string;                // referential action
  subtype?: string;                 // association / aggregation / composition
}
```

### Edge-source table (the hybrid)

| kind | Phase-2 source | new data |
|---|---|---|
| `relationship` belongs-to (1:N) | `relationships()` (card `one`) + `referenceIdentities()` to match the FK field (dedupe) | normalized cardinality, `onDelete`, subtype |
| `relationship` **M:N** (`many` + `through`) | `relationships()` + `deriveM2MFields` | `through`, `sourceJoinField`, `targetJoinField`, `symmetric`, `onDelete` |
| `fk` (bare `identity.reference`) | `childrenOfType("identity")` — unchanged | none (dropped when a relationship covers the same FK) |
| `field` (composition, `field.objectRef`) | `childrenOfType("field")` — unchanged | none |
| `extends` / `origin` / `payload` | `superResolved` / origin children / `payloadRef` — unchanged | none |

### Dedupe: relationship wins over the bare FK

A declared belongs-to `relationship` and its underlying `identity.reference`
describe the same physical link; today `LinkGraph` emits **two parallel edges**
for that pair. Phase 2 dedupes: when a relationship edge's `fkField` matches an
`identity.reference` field (same `from`→`to`), the richer relationship edge wins
and the bare `fk` edge is suppressed. The M:N junction's own two FK edges are
different node-pairs, so they remain (consistent with keeping the junction node).

### Junction rendering — keep the node + add the M:N edge

Decision: a junction entity stays as its own node with its two FK edges (it has
its own page and FK structure — hiding it on some diagrams would misrepresent
the schema), **and** a distinct logical M:N edge is added between the two ends.
This is purely additive — lowest risk to the "presentation unchanged except
newly-covered edges" constraint. (If overview/core diagrams later get noisy with
junction boxes, collapsing them *only on the core diagram* is a clean, small
follow-up — YAGNI until observed.)

### Presentation (`mermaid.ts`) — confined + additive

- `erDiagramRich` picks the mermaid relationship connector from the edge's
  `cardinality`: M:N → `}o--o{`; belongs-to / everything else → the existing
  `||--o{`. Non-M:N edges therefore render **byte-identically**.
- `flowchartDomain` draws the logical M:N edge **dashed** (`-.->|M:N via X|`)
  against the solid physical FK edges — the "logical vs physical" cue in
  mermaid's own vocabulary, no color hack.
- `onDelete` + junction fold into the edge **label** (`author · cascade`,
  `M:N via OrderProduct`) — no new colors, no new glyphs.
- `ErEdge` and the flowchart edge input gain optional carry fields
  (`cardinality`, `style`) — additive; existing call sites compile unchanged.
- Kind-shape (▭/⬭/▱ + border-dash) and domain-color doctrine untouched.

Net: for a model with **no** relationship children, output is byte-identical to
Phase 1. The acme golden changes **only** because we deliberately add
relationships to it.

## Testing & fixture

**Extend the acme fixture** (its golden regenerates — the diff is the review
artifact showing exactly which new edges appeared). Add, minimally:

- **belongs-to + `onDelete`** — a `relationship` child (cardinality `one`) on an
  entity that already holds the matching FK (e.g. `Order`→`Customer`), with
  `@onDelete: cascade`.
- **M:N through junction (hetero)** — a `Product` entity + an `OrderProduct`
  junction (two `identity.reference` FKs) + a `many @through OrderProduct`
  relationship `Order ⇄ Product`.
- **directed self-join** — `Customer.referredBy → Customer` via `@sourceRefField`.
- **symmetric self-join** — `Customer ⇄ Customer` through a `CustomerFriend`
  junction with `@symmetric`.

(The dedupe case is already present: `Order` declares both `identity.reference
fkCustomer` **and** `relationship.association customer` → the enriched
relationship edge now supersedes the bare FK edge, changing the neighborhood
label from `customerId` to the relationship.)

**Gates:** double-generate byte-identical golden · link-check throws on dangling
· every new edge/attr list **sorted** (determinism) · escaping unchanged (new
labels are identifier/vocab-derived, still pass `safe()`/`edgeLabel()`).

**Unit tests** (extend existing): relationship-vs-fk dedupe; M:N edge carries
`through`/`sourceJoinField`/`targetJoinField`; directed + symmetric self-join
edges; `onDelete`/subtype carried; `erDiagramRich` emits `}o--o{` for M:N;
`flowchartDomain` emits the dashed M:N link.

## Hygiene fold-in

We are already editing `mermaid.ts`: genericize the `CURATED` palette **keys**
(domain-specific vocabulary carried over from the source project — a soft leak
in a public repo) to neutral slot names. acme's packages (`ai`/`common`/`shop`) match
none of them, so they hash into the same palette **values** either way — **zero
golden-color impact**, and the leak is gone.

## File-by-file

| File | Change |
|---|---|
| `src/link-graph.ts` | Primitive-based relationship derivation (`deriveM2MFields` + `MetaRelationship` getters); relationship-vs-fk dedupe; extend `Ref` (structural walks unchanged) |
| `src/mermaid.ts` | Cardinality connector in `erDiagramRich`; dashed M:N in `flowchartDomain`; additive `ErEdge`/edge-input fields; genericize `CURATED` keys |
| `src/builders/object-data.ts`, `index-data.ts` | Thread `cardinality`/`through`/`onDelete` into edge labels + the relations table |
| `test/fixture/input/acme/**` | The additions above |
| `test/fixture/golden/**` | Regenerate |
| `test/{link-graph,mermaid,graph-v2,object-data*}.test.ts` | New assertions |

## Success criteria

- The site's neighborhood + core diagrams render M:N-through-junction (with the
  junction kept as a node), belongs-to cardinality, and directed + symmetric
  self-join relationships; the relationship-vs-FK double edge is de-duplicated.
- The extended acme golden is regenerated, double-generate byte-identical,
  link-check green; unit tests above pass; `bun test docs-site` green.
- A model with no relationship children produces byte-identical output to Phase 1
  (the change is edge-coverage, not a presentation rewrite).
- No new package dependency; no private-name or absolute-local-path leak;
  `CURATED` keys genericized.

## Risks

- **Dedupe correctness** — matching a relationship's `fkField` to the right
  `identity.reference` must be exact (package-stripped compare, as
  `relation-resolver.ts` does) or an edge is wrongly dropped/kept. Covered by a
  dedicated unit test.
- **`deriveM2MFields` throws** on an ambiguous self-join (neither
  `@sourceRefField` nor `@symmetric`). The site must **skip that edge and warn**,
  never fail generation — mirror the resolver's silent-skip, but surface a
  `LoadedModel.warnings` entry so the anomaly page can list it.
- **Golden churn** — the acme golden diff will be non-trivial; review it as the
  artifact, and re-lock determinism (two regenerations identical) before commit.

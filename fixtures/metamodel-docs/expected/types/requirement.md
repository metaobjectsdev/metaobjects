<!-- @generated — DO NOT EDIT.
     Metamodel reference for the `requirement` type family — each subtype's composed attributes, allowed children, and cardinality.
     Regenerate with: meta docs --metamodel -->

# Metamodel — `requirement` types

Each section below is one `requirement.<subType>`. The **Attributes** table lists
the subtype's own + concern-contributed attributes (provider-tagged); universal
documentation attributes are omitted here (see [providers.md](../providers.md)).
**Allowed children** lists the structural child rules with their cardinality
(`min..max`, `*` = unbounded).

### requirement.architectural

How the system is built, applied uniformly across the model. Its check is UNIVERSALITY: it fails when something VIOLATES it, which is the opposite polarity to a functional requirement. Carries no level and no parent — levels come from object-in-focus decomposition and an architectural requirement is object-independent by definition.

**When to use:** Something exists because every entity here looks like this — a uuid primary key, an @autoSet createdAt, a change-attribution column, tenant scoping. The discriminator is mechanical: did this exist because someone asked for something, or because it is the architecture?

**Attributes**

| Attribute | Type | Required | Default | Allowed values | Provider | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `@implementedBy` | string[] | no |  |  | — | FQN references to the nodes applying this policy. High fan-out is normal and expected: one uuid-primary-key requirement is claimed by every entity. |
| `@statement` | string | yes |  |  | — | The policy, in one sentence. |
| `@status` | string | yes |  | `live`, `partial`, `abandoned`, `superseded` | — | As on requirement.functional. A live or partial architectural requirement claimed by NOTHING is an error: a policy declared and applied to nothing. |
| `@supersededBy` | string | no |  |  | — | The requirement that replaced this one. Expected on status=superseded. |
| `@violation` | string | yes |  |  | — | What breaking it looks like — the node that would contradict it. This is what makes universality checkable. |

**Allowed children**

_No structural children._

### requirement.functional

What the product does for a user, stated as one violable claim. Its check is EXISTENCE: it fails when nothing implements it. Hierarchy is nesting — an L1 solution contains its L2 segments, which contain L3 services, and so on down to the levels that reference the model.

**When to use:** Something exists because someone asked for it. Levels: 1 solution, 2 segment (an application or library), 3 service, 4 object, 5 member. Only L4 and L5 carry @implementedBy — L1-L3 are organisational and never reference the model.

**Attributes**

| Attribute | Type | Required | Default | Allowed values | Provider | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `@implementedBy` | string[] | no |  |  | — | FQN references to the model nodes realising this requirement. Legal on level 4 (an object) and level 5 (a field, view or identity) only; an organisational level carrying it is ERR_REQUIREMENT_LINK_ABOVE_FLOOR. Many-to-many by construction — several requirements may name the same node. |
| `@level` | int | yes |  |  | — | 1 solution, 2 segment (application/library), 3 service, 4 object, 5 member. Nesting depth must agree with it. |
| `@statement` | string | yes |  |  | — | What the capability is, in one sentence. |
| `@status` | string | yes |  | `live`, `partial`, `abandoned`, `superseded` | — | live implemented and in use; partial implemented with known gaps; abandoned built then deliberately retired; superseded replaced by a different mechanism. A dangling @implementedBy is an ERROR on live/partial (the model moved, the requirement is stale) and ALLOWED on abandoned/superseded (those nodes are meant to be gone — that is the entry doing its job). |
| `@supersededBy` | string | no |  |  | — | The requirement that replaced this one. Expected on status=superseded. |
| `@verifiedBy` | string[] | no |  |  | — | Names of the tests proving the behaviour. verify checks each exists and is not skipped; it never runs them. |
| `@violation` | string | yes |  |  | — | What breaking it looks like, in one sentence. A requirement MUST be violable: 'every entity has a uuid primary key' is (point at one with a composite string key); 'things are persisted' is not, and is a description rather than a requirement. |

**Allowed children**

- `requirement.*` — 0..*


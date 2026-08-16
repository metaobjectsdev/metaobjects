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

How the system is built, applied uniformly across the model. Its check is UNIVERSALITY: it fails when something VIOLATES it, which is the opposite polarity to a functional requirement. Flat by default and object-independent; it may optionally sit in a levelled tree when a quality taxonomy is being used to organise non-functional requirements.

**When to use:** Something exists because every entity here looks like this — a uuid primary key, an @autoSet createdAt, a change-attribution column, tenant scoping. The discriminator is mechanical: did this exist because someone asked for something, or because it is the architecture? For a non-functional tree, an established quality taxonomy makes a good fixed upper structure (e.g. an ISO/IEC 25010 characteristic at L1, its sub-characteristic or a control-catalogue category at L2), with the model-binding claims at L4 and L5 as usual.

**Attributes**

| Attribute | Type | Required | Default | Allowed values | Provider | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `@disposition` | string | no |  | `accepted`, `deferred` | — | As on requirement.functional. On an architectural requirement, accepted is the common and important case: a policy that is genuinely not universal, where the exceptions are known and tolerated, is more honest as partial+accepted than as a live claim nobody audits. |
| `@implementedBy` | string[] | no |  |  | — | FQN references to the nodes applying this policy. High fan-out is normal and expected: one uuid-primary-key requirement is claimed by every entity. |
| `@level` | int | no |  |  | — | OPTIONAL here, unlike on a functional requirement where it is required. ABSENT means a flat, object-independent policy that may reference the model directly — the original and still the default form. PRESENT means this node sits in a levelled tree, and then the same rules as functional apply: nesting must agree with the level, and only L4/L5 may carry @implementedBy. Levelling is opt-in so that adding a taxonomy on top of existing flat policies does not invalidate them. |
| `@statement` | string | yes |  |  | — | The policy, in one sentence. |
| `@status` | string | yes |  | `planned`, `live`, `partial`, `abandoned`, `superseded` | — | As on requirement.functional. A live or partial architectural requirement claimed by NOTHING is an error: a policy declared and applied to nothing. A planned one is exempt from that check — it is not applied yet by definition. |
| `@supersededBy` | string | no |  |  | — | The requirement that replaced this one. Expected on status=superseded. |
| `@trackedBy` | string[] | no |  |  | — | As on requirement.functional. Issue or ticket references for outstanding work; free-form, not resolved. |
| `@verifiedBy` | string[] | no |  |  | — | OPTIONAL — omit unless you have opened the test and read what it asserts. Names of tests that assert the policy holds. verify checks each name EXISTS and is not skipped; it never runs them, and it cannot tell whether the named test verifies this requirement — any occurrence in the test corpus satisfies it. |
| `@violation` | string | yes |  |  | — | What breaking it looks like — the node that would contradict it. This is what makes universality checkable. |

**Allowed children**

- `requirement.*` — 0..*

### requirement.functional

What the product does for a user, stated as one violable claim. Its check is EXISTENCE: it fails when nothing implements it. Hierarchy is nesting — an L1 solution contains its L2 segments, which contain L3 services, and so on down to the levels that reference the model.

**When to use:** Something exists because someone asked for it. L1-L3 are levels of ABSTRACTION AND OWNERSHIP in the problem domain — whose need is this, and at what altitude — and are never a directory, package, deployable or module. Binding to technical constructs happens only at L4 (an object) and L5 (a member), which is the allocation step. Test every node: if a refactor that changes no behaviour would force it to move, its level is wrong.

**Attributes**

| Attribute | Type | Required | Default | Allowed values | Provider | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `@disposition` | string | no |  | `accepted`, `deferred` | — | What has been DECIDED about outstanding work — a different question from whether the work is done, which is what @status answers. accepted: the gap is understood and deliberately not being closed. deferred: it will be closed, but not now. ABSENT MEANS UNDECIDED, which is a real and useful state — it is what an unreviewed gap looks like, and it is the one a review should be able to find. Meaningful on planned and partial only; on a status with no outstanding work it is a WARNING. Deliberately NOT a workflow vocabulary: which sprint, who owns it and whether it is in progress belong in the tracker named by @trackedBy, because two systems holding that answer will drift and only one of them is refreshed daily. |
| `@implementedBy` | string[] | no |  |  | — | FQN references to the model nodes realising this requirement. Legal on level 4 (an object) and level 5 (a field, view or identity) only; an organisational level carrying it is ERR_REQUIREMENT_LINK_ABOVE_FLOOR. Many-to-many by construction — several requirements may name the same node. |
| `@level` | int | yes |  |  | — | 1 solution, 2 segment, 3 service, 4 object, 5 member. L1-L3 are levels of abstraction and ownership in the problem domain, NOT of code structure. Nesting depth must agree with it; skipping a level is legal, going back up is not. |
| `@statement` | string | yes |  |  | — | What the capability is, in one sentence. |
| `@status` | string | yes |  | `planned`, `live`, `partial`, `abandoned`, `superseded` | — | planned intended but not built yet; live implemented and in use; partial implemented with known gaps; abandoned built then deliberately retired; superseded replaced by a different mechanism. A dangling @implementedBy is an ERROR on live/partial (the model moved, the requirement is stale) and ALLOWED on planned/abandoned/superseded — on planned the nodes do not exist YET, on the other two they are meant to be gone, and that is the entry doing its job. A planned requirement also never contributes to object coverage: planning a capability must not silence the warning that nothing implements it. |
| `@supersededBy` | string | no |  |  | — | The requirement that replaced this one. Expected on status=superseded. |
| `@trackedBy` | string[] | no |  |  | — | Issue or ticket references for outstanding work — a URL, an owner/repo#123 shorthand, or a tracker key. Free-form and NOT resolved by verify, which does not reach the network; unlike @verifiedBy, nothing here is checked to exist. Its job is to stop a deferred gap becoming invisible, so verify warns when a deferred requirement names no ticket. Also the right place to link the ticket that a planned requirement will be built under. |
| `@verifiedBy` | string[] | no |  |  | — | OPTIONAL — omit unless you have opened the test and read what it asserts. Names of tests that assert the behaviour. verify checks each name EXISTS and is not skipped; it never runs them, and it cannot tell whether the named test verifies this requirement — any occurrence in the test corpus satisfies it. |
| `@violation` | string | yes |  |  | — | What breaking it looks like, in one sentence. A requirement MUST be violable: 'every entity has a uuid primary key' is (point at one with a composite string key); 'things are persisted' is not, and is a description rather than a requirement. |

**Allowed children**

- `requirement.*` — 0..*


# FR-034 — Ecosystem tier: a semantic vocabulary for connected meta-modeled systems (design)

> **Status: DRAFT — deferred to post-1.0 (target 1.1).** This design is captured now so the
> exploration and the owner's rulings are not lost, but **no implementation happens until after
> the 1.0 release.** The whole tier is *purely additive* registered vocabulary — it removes and
> changes nothing shipped, so it slots cleanly into a minor without touching the 1.0 stability
> commitment (ADR-0035). Nothing here needs to land in 1.0 to keep the door open: it reuses
> FR-023 (transport), ADR-0041 (resolution), and ADR-0029 (the drift gate) with no new machinery.
>
> Authored 2026-07-10. Basis: a Fable-model design exploration run through the ADR-0037 ordered
> test and the ADR-0023 strict-provenance rule; owner rulings recorded in §1.2.

## 0. Thesis

Model the **ecosystem** — multiple meta-modeled systems and how they connect over a network,
with APIs as the glue — as *semantic* vocabulary, not implementation. The tier needs a small set
of new concepts: the logical **system** and its deployable **container**s (the network
participants), each container's **surface** stake in an API (`provided` / `consumed`), and the
named **environment** the whole thing instantiates into. Everything else the owner mentioned
(URLs, networks, deployment mechanics) is derivable, physical config, or deliberately external.

The load-bearing insight that keeps it slim: **the machinery already exists.** FR-023 metadata
packages are the transport (a consumer declares a metadata dependency on the provider's published
model); ADR-0041 is the resolution contract (FQN-exact cross-package refs); ADR-0029 is the drift
gate (a renamed/removed target breaks the dependent build); and ADR-0030 already obligated core to
keep `api`/`projection` nodes FQN-resolvable *precisely so an upper tier could reference them.*
This tier cashes that check — it adds reference-*bearing* vocabulary, not reference *machinery*.

This tier sits **on top of** the FR-024 declared-API surface (`api.operational` /
`operation.query|command` / `binding.rest`). A `surface` edge points at an `api.*` node. So
FR-024's declared-API remainder is the prerequisite, and it too is deferred to 1.1 (see the
roadmap FR-024 note).

## 1. Rulings and open items

### 1.1 Prerequisite

- **FR-024 Phase D — the declared-API surface in core** (`api.base`/`api.operational`,
  `operation.query|command`, `binding.rest`, `inputRef`/`outputRef`/`many`). Currently unbuilt
  and greenfield (no `api.*` in `expected-registry.json`). This is the foundation the ecosystem
  edges reference; it is deferred to 1.1 alongside this FR.

### 1.2 Owner rulings (settled 2026-07-10 — do not relitigate)

1. **Boundary move — RATIFIED.** The *logical topology* (`system.*`, `container.*`, `surface.*`,
   `environment.deployment`) moves **into core** — registered providers, `expected-registry.json`
   updated atomically, conformance-gated in all five ports — **superseding ADR-0030 decision 5**
   for the logical tier. The *physical tier* (URLs/hosts, infra, credentials, SLAs, org-chart
   ownership) stays **out of core permanently**, reached through a generated address contract
   (§4). Rationale: cross-port interop and cross-system drift detection only work if all five
   sealed registries speak the same vocabulary; a provider-SPI tier is per-adopter by
   construction (no shared corpus → no interop). A superseding ADR to ADR-0030 §5 is written
   **when this lands in 1.1**, not now (the accepted-ADR corpus is not edited during the freeze).

2. **Granularity — C4-style two-level nesting (`system → container`), NOT flat participants.**
   The owner chose the C4 model over the flat-network-participant model the exploration
   recommended. A **`system`** is a logical software system (a grouping); a **`container`** is a
   separately deployable/runnable unit (a backend service, a SPA, a worker) that actually
   participates on the network and carries the `surface.*` edges. This is more faithful to how
   larger organizations think and cannot be retrofitted cleanly, hence the up-front ruling. Cost:
   one extra registered type (`container`) versus the flat model. See §2 for the shape.

3. **Environments — names-only in v1; reserve rewiring.** `environment.deployment` is a
   first-class core node, but v1 is *only* the declared, verified name set (dev/staging/prod)
   that keys the generated per-environment config matrix and kills stringly-typed env-name drift.
   Topology variance — per-environment participation exceptions and mock-provider substitution —
   is **reserved** (documented, not registered). URLs/secrets/replicas stay external permanently.

4. **Third-party / external systems — deferred.** v1 models only first-party systems that publish
   an FR-023 model package. External-stub systems (a slim surface-only stub marked external, verify
   skipping implementation checks per ADR-0026 reference-don't-materialize) are a later iteration.

### 1.3 Still open (settle at planning, before 1.1 implementation)

- **O1 — Surface-version identity (an FR-024 loose end this tier exposes).** FR-024 §9 shows
  `name: CustomerApi, version: v1`, but overlay-merge makes same-package+name siblings
  impossible, so versioned surfaces must be distinct *node names* (`CustomerApiV1`, whose FQN IS
  the pin — assumed throughout this design). Needs an explicit ruling; consumption pinning is
  ill-defined until then. **Lean:** versioned node names.
- **O2 — `@visibility: public|internal` on `surface.provided`?** Powers a "clients may only
  consume public surfaces" reachability rule — the one semantic residue of "networks." **Lean:**
  reserve; v1's only reachability rule is structural (`container.client` licenses no provisions).
- **O3 — Exact `container` subtype axis + surface-edge attachment level.** Confirm
  `container.service|client` (execution locus) as the licensing axis and that `surface.*` edges
  attach to the container, with `system` as a pure grouping node. Confirm the concrete `system`
  subtype name (C4 "software system" → `system.software`?) and whether `system` needs subtypes at
  all in v1 versus a single concrete type.
- **O4 — Default surface-edge naming** (name defaults to the `@apiRef` tail, lower-camel — the
  identity-default-name precedent) as ergonomic sugar.
- **O5 — Exact error codes** for the new loader checks (`ERR_DUPLICATE_PROVISION`,
  `ERR_INVALID_SURFACE`, client-declares-provision, …) — reuse families vs mint new; conformance
  fixtures fix them.

## 2. The node model (C4 two-level, per ruling 1.2.2)

C4's levels map cleanly: a **system** is the C4 *software system* (logical grouping); a
**container** is the C4 *container* (a deployable/runnable unit); C4 *components* stay derivable
(code-level grouping = `package`), and the network conversation we model happens **between
containers**.

### 2.1 `system` — the logical software system (grouping)

**What it DOES:** groups the deployable containers that make up one logical system, and is the
unit an org-tier SPI (capabilities, teams, compliance) references by FQN. It is a *grouping*, not
itself a network participant.

**ADR-0037 walk:** not derivable (which containers constitute a logical system is an authored
architectural fact — `package` groups *code*, not *deployables*); not physical; owns
child-licensing (its children are `container.*`). → **top-level type.** Concrete subtype naming
is O3 (candidate `system.software`; `system.base` abstract; `system.external` reserved for the
deferred third-party case).

### 2.2 `container.service` / `container.client` — the network participants

**What it DOES:** a container is the deployable unit that (a) provides and/or consumes API
surfaces (it carries the `surface.*` edges), (b) anchors codegen (its consumed edges emit typed
clients; its provided edges are served by FR-024 route shells), (c) participates per environment,
and (d) is the unit of cross-system drift attribution (a `meta verify` break fails the build of a
*container*, not a file).

**Subtype axis — execution locus** (changes child-licensing; ADR-0028 §5 "a rule regime, not a
label"):

- **`container.service`** — an operator-run deployable (backend service, worker, scheduled job —
  a job is a service with no provisions, *derived*, not a subtype). May carry both
  `surface.provided` and `surface.consumed`.
- **`container.client`** — an end-user-device deployable (webapp/SPA, mobile app). **Licensed for
  `surface.consumed` only** — nothing dials into a browser or a phone, so `surface.provided` on a
  client is a load error. Real validation + codegen behavior (client-side fetcher emission vs
  server stubs), not a label. An SSR/BFF app is two containers: its server half is a
  `container.service`.
- *(reserved, not registered)* `webapp` vs `mobile` platform split → a `@kind` **within**
  `container.client` if behavior ever diverges (the `index.fulltext` reserved-not-registered
  precedent). Platform is otherwise implementation.

**Attributes:** none required beyond `name`/`package`. Repo URL, language, runtime platform, team
ownership are implementation/org-chart → the registered `attr.properties` bag (ADR-0023), never
new first-class attrs.

### 2.3 `surface.provided` / `surface.consumed` — the ecosystem edge

**What it DOES:** the edge of the ecosystem graph. It resolves (FQN, load-time, ADR-0041), anchors
codegen (consumed → typed client SDK + a required address-config key; provided → the exposure list
FR-024 route shells and `meta docs` serve), is the slot an environment's address config fills, and
is the unit of cross-system drift detection.

- **`surface.provided`** — "this container answers this surface." `@apiRef` must resolve to an
  `api.*` node **in this container's own composed model**. The declared provided set **IS the
  container's exposure — inclusive list, fail-closed** — the exact symmetry of ADR-0028's "the
  declared field set IS the exposure" at the shape tier.
- **`surface.consumed`** — "this container requires this surface." `@apiRef` resolves cross-package
  through the FR-023 dependency graph. This is the "dependency on `CustomerApiV1`" node.

**ADR-0037 walk:** not derivable (which container serves a shared-package api is not computable in
a monorepo; who calls whom is authored); not physical; owns behavior + attrs. → **type.**
Direction is the subtype axis (it changes licensing + validation + codegen: provided =
same-model resolution + uniqueness; consumed = cross-package resolution; `container.client`
licenses only consumed) — ADR-0028 §5, not a `@kind`.

**Why not reuse existing vocabulary:** `relationship.*` is entity-graph vocabulary
(association/aggregation/composition, `@cardinality`, FK derivation) — overloading it would poison
its child-licensing and M:N machinery. `operation.*`/`binding.*` are the surface's *interior*. The
edge is its own thing.

**`@apiRef`** — FQN reference to an `api.*` node (joins the `@objectRef`/`@payloadRef` family under
the ADR-0041 contract: FQN-exact, bare-name same-package preference, `ERR_AMBIGUOUS_REF` on
collision). Attribute, not a node.

**Uniqueness (v1):** at most **one** `surface.provided` per api FQN across the composed model — the
`@role: primary` exactly-one pattern (ADR-0007). Two containers claiming one surface is a load
error (O5). The mock-provider-in-dev case is handled by environments *only if* substitution is
ever adopted (reserved, ruling 1.2.3); otherwise it never enters the model.

### 2.4 `environment.deployment` — the named instantiation

Top-level type `environment`, one concrete subtype **`environment.deployment`** (a durable,
promoted-through instantiation). `environment.ephemeral` (PR-preview/CI envs — parameterized
names, different licensing) is *reserved, not registered*. See §5 for the full treatment.

### 2.5 Deliberately NOT nodes (ADR-0037 step 0 — derive, add nothing)

| Candidate | Verdict |
|---|---|
| `ecosystem` root/container | The ecosystem IS the composed load. A container node would restate the source set. Derive. |
| container→container dependency edge | Computed: consumed edge → `@apiRef` → unique provider → container. Derived graph, rendered by a Tier-2 diagram emitter (ADR-0020), never authored. |
| C4 *component* level | Code-level grouping = `package` (`acme::commerce::*`). Not a registered node in v1. |
| `job` / `worker` / `gateway` | A service with no / only pass-through provisions. Derivable postures, not kinds. |
| data-ownership ("who owns Customer") | Partially derivable from provision; a first-class claim is a v2 conversation. |
| network / zone (physical) | Only semantic residue is reachability → the reserved `@visibility` attr (O2). Physical networks are implementation. |

### 2.6 Authoring shape (ADR-0006 sigil-free YAML)

Provider repo (`crm`) — its model ships in its FR-023 package:

```yaml
metadata.root:
  package: acme::crm
  children:
    - system.software:
        name: crm
        children:
          - container.service:
              name: crm-api
              children:
                - surface.provided: { name: customers, apiRef: acme::crm::CustomerApiV1 }
```

Consumer repo (`checkout`), with an FR-023 `metadataDependencies` entry on the crm model package:

```yaml
metadata.root:
  package: acme::checkout
  children:
    - system.software:
        name: checkout
        children:
          - container.service:
              name: checkout-api
              children:
                - surface.provided: { name: orders,    apiRef: acme::checkout::OrderApiV1 }
                - surface.consumed: { name: customers, apiRef: acme::crm::CustomerApiV1 }
          - container.client:
              name: storefront
              children:
                - surface.consumed: { name: orders, apiRef: acme::checkout::OrderApiV1 }
```

The ecosystem view is **not a new artifact**: it is what the loader already produces when the
composed sources include several systems' models. An umbrella/platform repo that declares
`metadataDependencies` on every team's model package and runs `meta verify` **is** the ecosystem
build — same loader, same conformance corpus, same overlay/extends semantics.

## 3. APIs as the glue — cross-system references

No new machinery. Three shipped/designed pieces compose:

1. **Distribution — FR-023 metadata packages.** The provider publishes its model (or a slim,
   surface-only subset: the api nodes + the projections/values they reference + the system/container
   nodes) as a code-free versioned artifact (npm/Maven/PyPI/NuGet). The consumer declares it in
   `metadataDependencies`. The *only* transport — no registry protocol, no remote fetch, no runtime
   discovery in core.
2. **Resolution — ADR-0041.** `@apiRef` is one more ref-bearing attribute under the existing
   contract. `ERR_INVALID_SURFACE` (O5) joins the ERROR-CODES family with conformance fixtures in
   all five ports.
3. **Drift — ADR-0029's load-time gate, now spanning repos.** The consumer's build loads the pinned
   provider package; if the provider renamed `CustomerApiV1`, removed `getCustomer`, or retyped a
   projection field, the **consumer's build breaks at load/verify time** — cross-system drift
   detection, pillar 3 doing exactly what it was built to do, one tier up.

**Version pinning needs zero new vocabulary:**
- *Surface version* (intentional v1/v2): FR-024 rules versioned surfaces are **sibling api nodes**,
  so `@apiRef: acme::crm::CustomerApiV1` IS the pin (O1 rules the node-naming convention).
- *Temporal version* (the provider's model as-of-when): the metadata **package** version, resolved
  by each ecosystem's resolver and recorded in per-node provenance (FR-023 already decided this).

**Composition with the existing api surface:** the consumed edge points AT `api.operational`; it
never restates operations, shapes, or protocol (protocol stays `binding.*` per ADR-0030 — the
consumer inherits it). Codegen per consumed edge emits a typed client in the consumer's language —
`CustomerApiV1Client`, one method per operation, inputs as the declared `object.value`s, outputs as
the declared `object.projection`s — the purest instance of "pattern-derivable = codegen, never
hand-code." FR-025 package-binding governs where it lands per port; FR-022 emitters cover neutral
artifacts.

**One deliberate forcing function:** derived CRUD (FR-008/009) stays the zero-config default
*within* a container, but **cross-system consumption requires a declared surface** — you cannot
`surface.consumed` an implicit derived-CRUD endpoint, because there is no node to reference.
Fail-closed at the boundary: if another team builds against it, you declare it. The ecosystem-tier
twin of projection exposure.

## 4. The URL verdict: not core, not metadata at all

**The semantic fact is "checkout consumes `acme::crm::CustomerApiV1`." The URL is where crm happens
to answer in one environment this week.** ADR-0037 step 1: a URL changes neither the native type
nor the meaning of the dependency — it is physical/config, not vocabulary. The owner's instinct is
exactly right.

But we do better than "put it in config somewhere": **each `surface.consumed` generates a typed,
fail-closed *address contract*.** Codegen emits a required config key derived from the edge FQN (a
typed config class per port), which the generated client constructor demands. Deploy config (env
vars, k8s, gitops) supplies the value per environment; optionally `meta verify --addresses <file>`
checks the config supplies every (environment × consumed edge) key. **The metamodel never stores a
URL, yet a missing or orphaned URL is a build/verify error.** Same move as ADR-0026/FR-025: the
semantic identity lives in metadata; the physical binding lives in per-port/per-deploy config keyed
BY that identity.

Terminology guard: this is **not** a "binding" — `binding.*` is chartered protocol vocabulary on
operations (ADR-0030), and ADR-0037 forbids same-name-different-meaning. Call it the *address
contract* / address config. (`field.uri` existing is not a license to store infrastructure
addresses in the spine — that is a field *type* for user data.)

## 5. Environments

**`environment` is a first-class core node — the slimmest one here — and everything it binds TO
stays external.** What an environment DOES (ADR-0037 2a): it is the **named instantiation** of the
ecosystem — the key under which the address contract is enumerated (dev/staging/prod × every
consumed edge = the full required-config matrix, generated and verifiable), and the declared,
verified vocabulary that kills stringly-typed env-name drift ("stage" vs "staging" across five
repos).

- **Not an axis/`@kind`:** env names are open adopter vocabulary (qa, perf, eu-prod); `@kind`
  value-sets are closed and registry-gated. Instances, not kinds.
- **Not a load-time overlay** (`meta gen --env prod` selecting different files): overlays are
  anonymous merge inputs — you'd get N divergent models nobody can compare, and the model would
  stop being one durable spine. All environments visible in ONE loaded model is what lets verify
  say "staging and prod disagree structurally."
- **Shape:** top-level `environment`, concrete `environment.deployment`; `environment.ephemeral`
  reserved. Environments live in the umbrella/platform repo's model.

```yaml
metadata.root:
  package: acme::platform
  children:
    - environment.deployment: { name: dev }
    - environment.deployment: { name: staging }
    - environment.deployment: { name: prod }
```

**In the metamodel (v1):** environment names, keying the config matrix. **Reserved (ruling
1.2.3):** per-environment participation exceptions ("analytics is absent in dev") and provider
substitution ("in dev, `checkout.customers` is answered by `crm-mock`" — via the dotted-path
grammar). **Out of the metamodel permanently:** URLs/hosts/ports, credentials/secrets, replica
counts, scaling, region/infra — physical, fast-churning, owned by terraform/k8s/gitops, looked up
under keys the metamodel generates.

## 6. The ADR-0030 boundary — the ruled split

Per ruling 1.2.1, a superseding ADR (written at 1.1 implementation time) replaces ADR-0030
decision 5 with a split:

- **INTO core: the logical topology** — `system.*`, `container.service|client`,
  `surface.provided|consumed`, `environment.deployment` — registered providers,
  `expected-registry.json` updated atomically, conformance fixtures in all five ports. Cross-port
  interop is the point (a Java provider and a TS consumer must load the same ecosystem model
  byte-identically); verify's cross-system drift detection needs a shared sealed registry
  (ADR-0023); and ADR-0030's own Context shows it was rejecting the prior art's CSV-string org
  tier, not the tier itself — its FQN-resolvability clause exists to serve exactly this layer.
- **OUT of core permanently: the physical tier** — addresses/hosts/URLs, infra and deployment
  mechanics, credentials, SLAs/monitoring, org-chart ownership (teams, cost centers → org-tier SPI
  or `attr.properties`). These fail ADR-0037 step 1, churn on ops timescales, and are owned by
  better tools. The generated address contract is the interface between the tiers.

The org-tier SPI remains the home for genuinely org-specific modeling (business capabilities,
compliance zones, team topology), referencing core `system`/`container`/`surface` nodes by FQN.

## 7. What this buys (behavior inventory, for the 1.1 plan)

- **Codegen:** a typed cross-system client SDK per consumed edge (all five ports, Tier-1);
  generated address-contract config keys/classes; ecosystem + per-environment diagrams (Tier-2
  neutral emitter, ADR-0020).
- **Verify:** unresolved/removed surface breaks the consumer's build (cross-repo drift, pillar 3);
  duplicate provision; client-declares-provision; orphaned api (declared, never provided — warn);
  address-config completeness per environment (opt-in).
- **Runtime/MCP:** the loaded topology is exactly the map an AI agent needs for "what talks to what,
  where" — feeding the roadmap's MCP exposure with no new design.
- **Conformance:** pure vocabulary — positive + error-envelope fixtures in `fixtures/conformance/`,
  `expected-registry.json` updated atomically, five ports, no port-specific semantics anywhere.

## Appendix A — ADR-0037 scorecard

| Concept | 0 derivable? | 1 physical? | 2 own behavior/attrs? | Verdict |
|---|---|---|---|---|
| logical software system | no | no | groups containers, org-tier anchor | **type `system`** (subtype O3) |
| deployable participant | no | no | surface licensing, codegen anchor, env participation | **type `container`** |
| service vs client | no | no | changes child-licensing (ADR-0028 §5) | **subtypes** `container.service|client` |
| webapp vs mobile | — | platform | shared behavior | reserved `@kind` in `container.client`, unregistered |
| job/worker/gateway | **yes** (posture from edges) | — | — | derive; nothing |
| API stake (edge) | no | no | resolution, client codegen, address slot, drift unit | **type `surface`** |
| provided vs consumed | no | no | different licensing + validation + codegen | **subtypes** `surface.provided|consumed` |
| the api reference | no | no | config of the edge | **attr `@apiRef`** (FQN, ADR-0041) |
| version pin | **yes** (target FQN + pkg version) | — | — | derive; nothing |
| container→container graph | **yes** | — | — | derive; Tier-2 diagram |
| ecosystem container | **yes** (the composed load) | — | — | derive; nothing |
| URL / endpoint address | no | **yes** | — | external config against the generated address contract |
| environment | no | no | config-matrix key, verified name set | **type `environment`**, subtype `deployment` (`ephemeral` reserved) |
| dev/staging/prod | — | — | open adopter vocabulary | **instances**, never subtypes/`@kind` |
| network / zone | mostly | mostly | one residue: reachability | no node; reserved `@visibility` attr (O2) |
| third-party system | no | no | skip-implementation-verify | reuse `@provided` (ADR-0026) — **deferred** (ruling 1.2.4) |
| team/org ownership | no | org-chart | none in core | `attr.properties` / org-tier SPI |

## Appendix B — relationship to other FRs

- **Prerequisite:** FR-024 declared-API surface (`api.operational`/`operation`/`binding.rest`).
- **Transport:** FR-023 metadata packages. **Resolution:** ADR-0041. **Drift gate:** ADR-0029.
- **Supersedes:** ADR-0030 decision 5 (logical tier into core), at 1.1 implementation time.
- **Consumes/feeds:** FR-022 (neutral emitters), FR-025 (package-binding codegen config), the
  roadmap MCP-exposure item (topology as the agent's map).
- **Aligns with:** the FR-021 sketch's `api`/`wireId` direction, retyped onto projection/value.

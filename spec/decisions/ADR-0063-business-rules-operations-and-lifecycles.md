# ADR-0063: Business rules: operations, permission points and lifecycles

## Status

**Accepted** (2026-11-13). Both vocabulary slices are agreed under ADR-0023 §3: slice A
(operations and permission points) and slice B (lifecycles). This ADR registers the names
ADR-0030 reserved, adds `transition.*`, ten loader error codes and a `verify` gate, in all five
ports in one change. `metamodelVersion` stays `1.3`, because this lands in the unpublished 1.3.0.
It extends ADR-0030 and applies ADR-0037's procedure to each shape. Every rule reads through the
resolving accessors (ADR-0039), so a transition declared on a base entity's field applies to
every entity that extends it. ADR-0064 decides where the rules are enforced, and amends
ADR-0045 to match.

1.3.0 ships the vocabulary, the loader rules and the `verify` checks. The generated service
shells that enforce the rules at run time (§6) are later work. Until they land, the vocabulary
generates nothing. `fixtures/codegen-noop/rules/` holds every port to that.

## Context

The model has validation, `@autoSet`, cross-field validators with `@condition`, and
requirements. It has nothing for what an application *does*:

- no named command beyond derived CRUD;
- no place to say who may run one;
- no allowed moves between the values of a status field.

Audits of generated-and-extended applications found the result in every build: status changes
written as plain updates with no check of the current status, raw SQL with hand-typed names,
and permission checks that were scattered or missing.

Three constraints carry over from earlier rulings:

- **No logic in the model.** No sequencing, branching, loops, variables or user-defined
  functions. An operation may be declared, guarded, checked and announced. What it does is code.
- **ADR-0030.** The `api` subtype axis is the interaction model, never the protocol. Queries
  return projections, commands take values, both act on entities.
- **ADR-0023.** Every attribute below has a written reason why its value cannot be computed.
  Anything that can be computed is derived and gets no vocabulary. The first sketch had several
  such things as attributes, and they were removed: the initial state, the terminal states, the
  target entity in the common case, the REST path, and the permission point itself.

## Decision

### 1. Slice A: operations and permission points

| Node | Parent | Status |
|---|---|---|
| `api.base` | | abstract (ADR-0054: a registry anchor, not authorable) |
| `api.operational` | `metadata.root` | concrete. A named, packaged surface whose children are operations. |
| `operation.base` | | abstract |
| `operation.command` | `api.operational` | concrete. Changes state; takes an `object.value`. |
| `operation.query` | `api.operational` | concrete. Reads; returns a projection, entity or value. |
| `binding.base` | | abstract |
| `binding.rest` | `operation.*` | concrete, **optional**. Needed only to override the derived method and path. |

Attributes on operations:

| Attribute | On | Can it be computed? (ADR-0023) |
|---|---|---|
| `@inputRef` (an `object.value`) | both | No. The input is a value object the author chose. A query whose only parameter is the borrowed key needs none. |
| `@outputRef` (an entity, projection or value) | both | No. Which projection a query returns is the author's choice among several over one entity. |
| `@many` (boolean) | query | No. Whether a query returns a list, and so takes the filter, sort and paging contract, is not implied by the projection. Registered on `operation.query` only, so on a command it is `ERR_UNKNOWN_ATTR`. |
| `@objectRef` (an `object.entity`) | both | **Usually computed, so optional.** The target entity is derived (§3). The attribute is for an operation with nothing to derive from, such as a command that creates or imports. It has the same name and meaning as `@objectRef` elsewhere. When it is declared and a target also derives, the two must agree. |
| `@transitions` (string list) | command | No. Which lifecycle moves a command may make is a fact of the business. Each name resolves against the target's transitions. |
| `@permission` (string) | both | No, and this is the strongest case. The name is a key into grant data. Deriving it from the operation's name would make renaming an operation a silent change of who may run it. Several operations may share one name. |
| `@public` (boolean) | both | No. A boolean exception flag (ADR-0037 2c): the shell calls no permission check. Authentication is the transport's job and is unaffected. |
| `@errors` (string list, lower snake case) | command | No. The business failures a hand-written body can return are facts of code the model cannot see. Declaring them names them in the wire contract and the typed result. |

`binding.rest` has two attributes:

- `@method`, from the closed set `GET`, `POST`, `PUT`, `PATCH`, `DELETE`. When absent, a query is
  `GET` and a command is `POST`.
- `@path`, a path template whose `{}` placeholders must be the target's key fields. When absent,
  the path is `/<collection>/{id}/<operation>` for an operation that addresses one row by key,
  and `/<collection>/<operation>` for one that does not.

**A permission point has no type.** Each of the following is a point by construction:

- every operation;
- every transition that derives a command;
- in a layered service, every derived CRUD verb, when a setting turns that on.

The enforcing shell calls the project's policy with the point's permission name, the actor,
the loaded row and the input, before anything is written. A type would only restate the
operation. The model adds two facts, the name and `@public`. Who holds a permission is data,
and what the policy decides is code. *The model names where a decision is needed, never what
the decision is.* A team that wants a policy engine wires one behind the same call, and the
vocabulary does not change.

The derived permission name is `<package>.<name>`, using the package of the operation's API or
of the transition's entity. With no package, it is the bare name.

### 2. Slice B: lifecycles

| Node | Parent | Status |
|---|---|---|
| `transition.base` | | abstract |
| `transition.action` | `field.enum` of an `object.entity` | concrete. A move between two members of the enum, made by an operation. |
| `transition.timed` | | **reserved, not registered.** A move made by time ("expires after 7 days") has a different generated shape: a sweep or a derived read, with no operation and no permission point. It gets its own subtype when it is designed. Authoring it today is `ERR_UNKNOWN_SUBTYPE`. |

Attributes on `transition.action`:

| Attribute | Can it be computed? (ADR-0023) |
|---|---|
| `@from` (string list of members) | No. The allowed moves are the business rule itself. |
| `@to` (one member) | No. It may equal a member of `@from`. That self-transition records an action that leaves the state where it was. |
| `@condition` (the existing `attr.expression` grammar, over the entity's own fields) | No, for the reason ADR-0023 Amendment 1 gave for `@condition` on validators. It has the **same name, grammar and meaning** as there, and the loader checks it with the same code. It cannot read the actor; that is the policy's job. |
| `@permission`, `@public` | As on operations. A transition that derives its own command is a permission point. |

**Derived, with no vocabulary:**

- **The lifecycle.** An enum field with at least one `transition.action` is a lifecycle, named
  after its field. An entity may have several.
- **The states.** The enum's `@values`.
- **The initial state.** The enum's `@default`. A lifecycle with no `@default` fails to load.
- **The terminal states.** The members no transition leaves.
- **A transition's command.** Each transition that no declared `operation.command` lists in
  `@transitions` gets a derived command of the same name. It takes no input beyond the key and
  lives on the package's service (setting `rules.lifecycle.commands`). So a plain lifecycle
  needs no `api.operational` at all.

### 3. The derived target of an operation

An operation's target entity is the first of these that exists:

1. The declared `@objectRef`.
2. The one entity whose primary key field a field of the `@inputRef` value extends.
3. The `@outputRef`, when it is an entity.
4. The base entity of the `@outputRef`, when it is a projection: the entity its identity
   extends, else the one entity its fields extend.

An operation **addresses one row by key** in two cases:

- its input borrows the target's key;
- it is a query with no `@inputRef` and no `@many` whose target comes from its output, which
  is a get by key.

### 4. ADR-0037 applied

| Concept | Derivable? | Result |
|---|---|---|
| A named command or query | No: own signature, own shell, own binding | **type** `operation`, subtypes `command`, `query` |
| The surface holding operations | No: a named, versionable contract | **type** `api`, subtype `operational` |
| REST method and path | Yes, by default | derived; `binding.rest` overrides |
| The target entity | Yes, in the common case | derived; `@objectRef` when not |
| A permission point | Yes: every operation and derived command is one | no vocabulary |
| The permission's name; "needs no check" | No | **attributes** `@permission`, `@public` |
| Moves a command may make; its business errors | No | **attributes** `@transitions`, `@errors` |
| States, initial and terminal states, the lifecycle | Yes | derived |
| An allowed move | No: own guarded update, own error, own permission point, own derived command | **type** `transition`, subtype `action` |
| A move made by time | No: a different generated shape | **subtype** `transition.timed`, reserved |
| A guard on a move | No; reuses an existing attribute | **attribute** `@condition` |

### 5. What the loader refuses, and what `verify` reports

**Loader errors.** These are hard errors in all five ports, with one `fixtures/conformance/`
case each (`error-rules-*`):

| Rule | Code | When |
|---|---|---|
| L1 | `ERR_TRANSITION_NOT_ON_ENTITY` | A transition under an enum field that is not a field of an `object.entity`: a document-root field, or a field of a value, projection or report. |
| L2 | `ERR_TRANSITION_NOT_ON_ENTITY` | A concrete entity has a lifecycle and no writable source. Reported on the entity. |
| L3 | `ERR_LIFECYCLE_NO_INITIAL` | An enum field with transitions has no `@default`. |
| L4 | `ERR_TRANSITION_UNKNOWN_STATE` | A `@from` or `@to` value is not one of the enum's `@values`. |
| L5, O0 | `ERR_TRANSITION_NAME_COLLISION` | A transition or an operation is named `create`, `get`, `list`, `update` or `delete`. |
| L6 | `ERR_TRANSITION_NAME_COLLISION` | Two transitions of one entity share a name across its lifecycles. Each may derive a command, so they share one namespace. |
| L7 | `ERR_BAD_ATTR_VALUE` | A `@condition` names a field the entity does not have, or is not boolean. Same check as the validators' `@condition`. |
| P1 | `ERR_PERMISSION_PUBLIC_CONFLICT` | `@public: true` together with `@permission`, on an operation or a transition. |
| O1 | `ERR_OPERATION_SHAPE` | `@inputRef` is not an `object.value`, or `@outputRef` is not an entity, projection or value. This includes a reference that does not resolve. |
| O2 | `ERR_OPERATION_TARGET_UNRESOLVED` | `@objectRef` does not name an `object.entity`, or a command lists `@transitions` and has no target. |
| O3 | `ERR_OPERATION_TARGET_MISMATCH` | A declared `@objectRef` disagrees with the derived target. |
| O4 | `ERR_OPERATION_UNKNOWN_TRANSITION` | A `@transitions` name is not a transition of the target, declared or inherited. |
| O5 | `ERR_BAD_ATTR_VALUE` | An `@errors` code is not lower snake case, or is listed twice. |
| B1 | `ERR_BINDING_PATH_MISMATCH` | A `binding.rest @path`'s placeholders are not exactly the target's key fields, for an operation that addresses one row by key, or are not empty, for one that does not. |

Two refusals use existing codes:

- `@many` on a command is `ERR_UNKNOWN_ATTR`, because the attribute is registered on the query
  only.
- An invalid `@method` is `ERR_BAD_ATTR_VALUE`, from its closed set.

Each broken rule yields one error, on the offending node. An operation that fails O1 is not
checked further. One that fails O2 or O3 is not checked for O4 or B1.

**`verify` checks.** These run in every port's `verify`, with one case each in the
`fixtures/rules-check-conformance/` corpus:

| Code | Severity | When |
|---|---|---|
| `WARN_LIFECYCLE_UNREACHABLE_STATE` | `verify.lifecycle.unreachable` (default `warn`) | A state that no chain of transitions reaches from the initial state. This is almost always a missing transition. Sometimes only seeded data uses the state, so it is not an error by default. |
| `WARN_LIFECYCLE_INITIAL_TERMINAL` | `warn` | The initial state is terminal, so nothing can ever move. |
| `WARN_TRANSITION_UNREACHABLE` | `verify.lifecycle.unreachable` | A transition whose every `@from` state is unreachable, so it can never be made. |
| `WARN_PERMISSION_DERIVED_NAME` | `rules.permissions.names`: `derive` (default) skips it, `advise` warns, `require` errors | An operation, or a transition that derives a command, has no `@permission` and is not `@public`. A rename would silently move access. |

A requirement's `@implementedBy` may name an operation (`Purchasing.decide`) or a transition
(`PurchaseRequest.status.submit`), at level 5. The reference resolves like any other member
reference, so a renamed operation fails the build. This is the hook a behaviour claim needed:
something real to point at. The requirement-check and requirement-test identity corpora pin
it.

A model that declares no operation and no transition gets no rules diagnostics, no summary
line and no gate row. The settings `rules.permissions.names`, `rules.lifecycle.create`,
`rules.lifecycle.commands` and `verify.lifecycle.unreachable` are read from
`.metaobjects/config.json` by every port. When a key is absent, the setting takes today's
behaviour. `rules.lifecycle.create` is read and validated now; the shells will be the first to
act on it.

### 6. What the enforcing shell will guarantee, for every transition

The shells are later work. This is what they are held to:

1. Load the row: 404 when it is absent.
2. Call the permission point: 403 `forbidden` when the policy refuses.
3. Check that the row's state is in the `@from` of a transition the operation may make: 409
   `invalid_transition`.
4. Run the hand-written body, when the operation has one. It returns one of its declared
   transitions or "none", and its return type is the union of the declared names.
5. Make the guarded update:
   `UPDATE ... SET <state> = :to WHERE <key> = :id AND <state> IN (:from) [AND <condition>]`.
   When it matches no row, re-read once and answer 409 (`invalid_transition` or
   `transition_condition_failed`), or 404 when the row is gone.
6. Run steps 4 and 5, and the event hook, in one transaction.
7. Refuse a lifecycle field on the generic update path (409 `state_managed`).

**The guarded update is part of the store-neutral storage contract** (§8). Every store
driver, including one an adopter writes, is held to it by a persistence-conformance scenario.

### 7. Events and invariants in 1.3.0

- **Events: the derived transition hook only.** Every transition already carries what an event
  needs: entity, key, transition, `from`, `to`, actor and time. So the shell can call a typed
  event hook inside the transaction with no new vocabulary. That hook is where an adopter
  writes to an outbox, history table or audit log.
  - **`@emits` is held.** It would decide half of ADR-0030's reserved event surface without the
    other half.
  - **No outbox table in core.** An outbox table is schema in a specific store.
- **Cross-object invariants are held.** A "check before commit" shell reads as a guarantee and
  is not one: at the default isolation level of the common databases, two transactions can each
  pass the check and together break it (write skew). The sound shape is an invariant scoped to
  a composition root, with the shell locking the root row. It is a later design.

### 8. Where the core stops

The core is the contracts and the conformance kits; store-specific code is a supported helper.
This vocabulary, its loader rules, its `verify` checks and the corpora that pin them are core.
So is the guarded update, as part of the store-neutral storage contract. A shell for a
particular language and framework is a helper (ADR-0064).

## Consequences

- A project that declares none of this sees no change: no diagnostics, no output, no gate row.
- `docs/compatibility-policy.md` changes its lists:
  - `api.*`, `operation.*` and `binding.*` leave the reserved list, because they are now
    registered;
  - `transition.timed` and the `api` event sibling join it.
- ADR-0030's open items are settled: the error codes are in §5, `@many` is the only list
  attribute, and paging follows the existing list contract.
- Each port adds a rules pass to its loader, a rules gate to its `verify`, the four settings to
  its config reader, and an inert test over `fixtures/codegen-noop/rules/`.

## Alternatives considered

- **A `lifecycle` container type** holding the transitions and naming its field. It reads
  more explicitly on its own, but it is one more type that restates its parent.
- **No transition node, with moves as attributes of operations.** This loses derived
  commands, and the guarded update would no longer be one per declared move.
- **Operations without `@errors`.** Bodies would throw untyped errors and the wire would get
  one generic business error. That is smaller, but the typed result and the API documentation
  lose the names.
- **Operations without `@permission` and `@public`, with the policy mapping operation names
  itself.** Renaming an operation would silently change who may run it.

# ADR-0066: Business rules: operations, permission points and lifecycles

## Status

**Accepted** (2026-11-13). Both vocabulary slices are agreed under ADR-0023 §3: slice A
(operations and permission points) and slice B (lifecycles). This ADR registers the names
ADR-0030 reserved, adds `transition.*`, eleven loader error codes and a `verify` gate, in all five
ports in one change. `metamodelVersion` stays `1.3`, because this lands in the unpublished 1.3.0.
It extends ADR-0030 and applies ADR-0037's procedure to each shape. Every rule reads through the
resolving accessors (ADR-0039), so a transition declared on a base entity's field applies to
every entity that extends it. ADR-0067 decides where the rules are enforced, and amends
ADR-0045 to match.

1.3.0 ships the vocabulary, the loader rules and the `verify` checks. The generated service
shells that enforce the rules at run time (§6) are later work. Until they land, the vocabulary
generates nothing. `fixtures/codegen-noop/rules/` holds every port to that.

**Experimental.** Decision 2 of the 1.3.0 design pass gives new vocabulary an experimental label
until it is proven in use. Everything this ADR registers — `api.*`, `operation.*`, `binding.*`,
lifecycles and the permission points — with its loader rules, `verify` checks and settings, may
change in a MINOR, including removals and renames, as a `preview` library may
(`docs/compatibility-policy.md`). It is promoted on evidence: generated services running on it
in an adopter estate with the drift gate enforced. The registry descriptions say so.

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
- in a generated service, every derived CRUD verb, when an option of the service generator turns
  that on. Its name is `<package>.<Entity>.<verb>`, and a transition that shares a verb's name on
  an entity is refused when the model loads. (Designed here; it lands with the service generator,
  and nothing in 1.3.0 reads it.)

The enforcing shell calls the project's policy with the point's permission name, the actor (a type
the app defines, ADR-0067 §7),
the loaded row and the input, before anything is written. A type would only restate the
operation. The model adds two facts, the name and `@public`. Who holds a permission is data,
and what the policy decides is code. *The model names where a decision is needed, never what
the decision is.* A team that wants a policy engine wires one behind the same call, and the
vocabulary does not change.

The derived permission name includes its owner, so a grant means one thing. A declared
operation derives `<package>.<operation>`, with the package of its API; operation names are
unique per package across its APIs (O6), so two operations never share it by accident. The
one exception is the same operation exposed by two APIs, as a versioned API beside its
successor (ADR-0067 §2: one router per API, one service): two declarations with the same name,
subtype and contract are one operation, and share the name on purpose. A
transition's derived command derives `<package>.<Entity>.<transition>`, with the concrete
entity's package and name, so `Order.cancel` and `Invoice.cancel` ask about different
permissions. With no package, the `<package>.` prefix is dropped. A declared `@permission` is a
dotted identifier path (P2): it becomes a constant and a key into grant data, so it carries no
spaces, punctuation or path segments. A package prefix may use `::`, so a derived name can be
declared as it is. (Captain's ruling, 2026-11-13, on the independent check's call 1.)

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
  needs no `api.operational` at all. A command claims a transition for its target entity and
  every entity that extends the target, so a command acting on an abstract base claims the
  inherited transition of each child.

**Whose lifecycle it is.** A transition belongs to the entity that declares its field and to
every entity that extends that entity. It does not belong to an entity whose field merely
`extends` the lifecycle field: extending a field shares its values, and a status history table
is not the thing whose status it records. An inheritor that redeclares the lifecycle field must
extend the base's field, or the base's transitions would silently stop applying to it; the
loader refuses that (L10).

**A lifecycle on an entity with no source is inert.** It loads, like everything else on a
sourceless entity (#248): the shape rules apply (L1, L3-L10), but it derives no command, and
`verify` checks its states and skips its permission points. The writable-source check (L2)
applies when a source is added, declared or inherited. A library's core layer is sourceless by
rule, so it can declare its lifecycles there and its `db` layer makes them live. (Captain's
ruling, 2026-11-13, on the independent check's call 2.)

### 3. The derived target of an operation

An operation's target entity is the first of these that exists:

1. The declared `@objectRef`.
2. The one entity whose whole primary key the `@inputRef` value borrows: each of its primary
   key fields is extended by exactly one field of the value. An input that borrows part of a
   composite key or one key field twice (`fromId`, `toId`) names no single row, so it borrows
   nothing from that entity. An input that borrows the whole keys of two entities derives
   nothing either, and the operation falls through to its output or declares `@objectRef`.
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
| L2 | `ERR_TRANSITION_NOT_ON_ENTITY` | A concrete entity has a lifecycle and a source, declared or inherited, but no writable one. Reported on the entity. An entity with no source at all is not refused: its lifecycle is inert (§2). |
| L3 | `ERR_LIFECYCLE_NO_INITIAL` | An enum field with transitions has no `@default`. |
| L4 | `ERR_TRANSITION_UNKNOWN_STATE` | A `@from` or `@to` value is not one of the enum's `@values`. |
| L5, O0 | `ERR_TRANSITION_NAME_COLLISION` | A transition or an operation is named `create`, `get`, `list`, `update` or `delete`, in any case. |
| L6 | `ERR_TRANSITION_NAME_COLLISION` | Two transitions of one entity share a name across its lifecycles, compared without case. Each may derive a command, so they share one namespace. |
| L7 | `ERR_BAD_ATTR_VALUE` | A `@condition` names a field the entity does not have, or is not boolean. Same check as the validators' `@condition`. |
| L8 | `ERR_BAD_ATTR_VALUE` | A transition's `@from` is empty: it could never be made. |
| L9 | `ERR_BAD_ATTR_VALUE` | The lifecycle field is an array (`isArray`, read through the resolving accessor). A guarded update compares one state. |
| L10 | `ERR_LIFECYCLE_REDECLARED` | An entity declares a field with the name of an inherited lifecycle field and does not extend it, so the base's transitions would be lost. Reported on the field. |
| P1 | `ERR_PERMISSION_PUBLIC_CONFLICT` | `@public: true` together with `@permission`, on an operation or a transition. |
| P2 | `ERR_BAD_ATTR_VALUE` | A `@permission` is not a dotted identifier path: names of letters, digits and `_` joined by `.`, where a package prefix may use `::`. |
| O1 | `ERR_OPERATION_SHAPE` | `@inputRef` is not an `object.value`, or `@outputRef` is not an entity, projection or value. This includes a reference that does not resolve. |
| O2 | `ERR_OPERATION_TARGET_UNRESOLVED` | `@objectRef` does not name an `object.entity`, or a command lists `@transitions` and has no target. |
| O3 | `ERR_OPERATION_TARGET_MISMATCH` | A declared `@objectRef` disagrees with the derived target. |
| O4 | `ERR_OPERATION_UNKNOWN_TRANSITION` | A `@transitions` name is not a transition of the target, declared or inherited. |
| O5 | `ERR_BAD_ATTR_VALUE` | An `@errors` code is not lower snake case, is listed twice, or is a code the route answers itself: the shell's `not_found`, `forbidden`, `invalid_transition`, `transition_condition_failed` and `state_managed` (§6), and the API contract's `validation`, `invalid_json`, `invalid_id`, `method_not_allowed`, `constraint_violation` and `internal`. A body returning one would be indistinguishable on the wire from the shell. |
| O6 | `ERR_TRANSITION_NAME_COLLISION` | Two operations of one package share a name, compared without case, in one API or across the package's APIs. Each derives the permission name `<package>.<operation>` and a file in the package's service. Not refused: two APIs declaring the same operation, meaning the same name and subtype and the same `@inputRef`, `@outputRef` and `@objectRef` (compared by the node they resolve to), `@transitions` and `@errors` (as sets), `@permission`, `@public` and `@many`. Bindings are per API and may differ. |
| B1 | `ERR_BINDING_PATH_MISMATCH` | A `binding.rest @path`'s placeholders are not exactly the target's key fields, for an operation that addresses one row by key, or are not empty, for one that does not. |
| B2 | `ERR_BINDING_PATH_MISMATCH` | Two declared bindings of one API have the same effective method (declared, else derived) and the same `@path` once placeholder names are ignored. |

Names are compared without case (L5, L6, O0, O6) because each becomes a command, a permission
constant and a file, and those collide on a case-folding target.

Some inputs load on purpose, and are refused elsewhere or are legal:

- **A route collision that involves a derived path.** B2 compares declared bindings only. A
  derived path, and the derived CRUD routes such as `PATCH /<collection>/{id}`, depend on the
  collection path and the mount point, which are transport facts the loader does not have. The
  transport generator that mounts the routes refuses a collision, including a binding declared
  on the method and path of a derived CRUD route.
- **One operation declared twice in one API, or one API declared twice.** Same-named
  siblings merge under the loader's general rule (`WARN_DUPLICATE_DECLARATION` when the
  declarations are in different files), so there is one operation and one API, O6 does not
  fire, and an
  `@implementedBy` claim on it resolves. `fixtures/requirement-check-conformance/claim-operation-api-in-two-files`
  pins that.
- **An input that borrows the keys of two entities.** It derives no target (§3); the operation
  takes its target from the output or declares `@objectRef`, and O2 refuses a command with
  `@transitions` that has neither.

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
| `WARN_TRANSITION_PERMISSION_SHADOWED` | `warn` | A transition declares `@permission` or `@public: true` but derives no command of its own for any concrete entity with a source carrying it (claimed by a declared command, or `rules.lifecycle.commands: none`), so nothing reads the attribute. An author reading the model would believe it guards the move. |
| `WARN_PERMISSION_DERIVED_NAME` | `rules.permissions.names`: `derive` (default) skips it, `advise` warns, `require` errors | An operation, or a transition that derives a command (on a concrete entity with a source), has no `@permission` and is not `@public`. A rename would silently move access. The message names the derived name. |

A requirement's `@implementedBy` may name an operation (`Purchasing.decide`) or a transition
(`PurchaseRequest.status.submit`), at level 5. The reference resolves like any other member
reference, so a renamed operation fails the build. This is the hook a behaviour claim needed:
something real to point at. The requirement-check and requirement-test identity corpora pin
it.

A model that declares no operation and no transition gets no rules diagnostics, no summary
line and no gate row. The settings `rules.permissions.names`, `rules.lifecycle.create`,
`rules.lifecycle.commands` and `verify.lifecycle.unreachable` are read from
`.metaobjects/config.json` by every port. When a key is absent, the setting takes today's
behaviour. `rules.lifecycle.create` is read and validated and has **no effect yet**: the shells
will be the first to act on it, and the documentation says so until they do.

### 6. What the enforcing shell will guarantee, for every transition

The shells are later work: service generators that an app adds (ADR-0067). A project that declares
a lifecycle and wires no service generator will be told so by `verify`, as an advisory, once that check lands; today's flat
routes enforce nothing. This is what the shells are held to:

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
driver, including one an adopter writes, will be held to it by a persistence-conformance scenario.
That scenario is `fixtures/persistence-conformance/queries/guarded-update.yaml` (`op:
guardedUpdate`): the state guard, a failing condition, a missing row, the second of two moves, and
a condition with a field compared with a field, `not`, `coalesce` and an int-backed state. The
TypeScript runtime implements it as `ObjectManager.guardedUpdate` on every bundled
`PersistenceDriver` and runs the scenario; the C#, Java, Kotlin and Python runners defer it by name
until each port builds its own guarded update in 1.3.0.

### 7. Events and invariants in 1.3.0

- **Events: the derived transition hook only.** Every transition already carries what an event
  needs: entity, key, transition, `from`, `to`, actor and time. So the shell calls the package's
  write-event hook (ADR-0067 §4) inside the transaction, with `kind: "transition"`, with no new
  vocabulary. That hook is where an adopter
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
particular language and framework is a helper (ADR-0067).

## Consequences

- A project that declares none of this sees no change: no diagnostics, no output, no gate row.
- `docs/compatibility-policy.md` changes its lists:
  - `api.*`, `operation.*` and `binding.*` leave the reserved list, because they are now
    registered, and join the business-rules vocabulary as experimental;
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
- **A package-flat derived permission name, `<package>.<name>`.** Two entities' `cancel`
  transitions, or two APIs' `approve` operations, would share one permission, so a grant for
  orders would silently grant invoices. Refusing every repeated name in a package instead would
  allow `cancel` on one entity per package.
- **Refusing a lifecycle on an entity with no source.** A library's core layer is sourceless by
  rule, so its lifecycles, and requirements pointing at them, could live only in its `db`
  layer.

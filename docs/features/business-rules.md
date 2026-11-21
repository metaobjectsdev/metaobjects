# Business rules: operations, permissions and lifecycles

Declare what your application *does*, beside the entities it does it to:

- **named commands and queries**, with the shapes they take and return;
- **who may run them**, as a permission name;
- **the allowed moves** between the values of a status field.

The model never says *how* an operation works. That is code. The model says where a decision
is needed, which moves are legal, and what a command may return, so all three can be checked.

**What 1.3.0 ships.** The vocabulary, checked when it loads and by `verify`, in all five ports.
The Rust preview port loads the vocabulary and runs the same loader rules; its `verify` is the
codegen drift gate only, so the checks under "What `verify` reports" do not run there
([Rust port](../ports/rust.md)).
A requirement can claim an operation or a transition. Nothing is generated from the vocabulary
yet: the service shells that enforce these rules at run time are later work (ADR-0067): service
generators an app adds to its generator list, as it adds any generator. A lifecycle in a project
that wires none is advised by `verify`, with the flat routes enforcing nothing. Until they land, a model with this vocabulary generates byte-identical code to the same model
without it. The design is [ADR-0066](../../spec/decisions/ADR-0066-business-rules-operations-and-lifecycles.md).

**Experimental.** This vocabulary, its loader rules, its `verify` checks and its settings may
change in a MINOR, including removals and renames, until generated services run on it in an
adopter estate ([compatibility policy](../compatibility-policy.md)). A model that declares none
of it is unaffected.

## An example

```yaml
metadata:
  package: acme::purchasing
  children:
    - object.entity:
        name: PurchaseRequest
        children:
          - source.rdb: { table: purchase_requests }
          - field.long: { name: id }
          - identity.primary: { name: pk, fields: [id] }
          - field.long: { name: total }
          - field.enum:
              name: status
              values: [draft, submitted, approved, rejected]
              default: draft                       # the initial state
              children:
                - transition.action: { name: submit, from: [draft], to: submitted }
                - transition.action:
                    name: approve
                    from: [submitted]
                    to: approved
                    condition: { op: lte, left: { field: total }, right: { value: 50000 } }
                - transition.action: { name: reject, from: [submitted], to: rejected }

    - object.value:
        name: DecisionInput
        children:
          - field.long: { name: requestId, extends: PurchaseRequest.id }   # borrows the key: the target is derived

    - api.operational:
        name: Purchasing
        children:
          - operation.command:
              name: decide
              inputRef: DecisionInput
              transitions: [approve, reject]       # claims both: they derive no command of their own
              permission: purchasing.decide        # so this is the permission that guards them
              errors: [limit_exceeded]
          - operation.query:
              name: openRequests
              outputRef: PurchaseRequest
              many: true
              public: true
```

## Operations

An `api.operational` is a named, packaged surface at the top of a document. Its children are
operations:

- **`operation.command`** changes state. It takes an `object.value` as input.
- **`operation.query`** reads. It returns an entity, a projection or a value.

| Attribute | On | Meaning |
|---|---|---|
| `inputRef` | both | The input, an `object.value`. A query whose only parameter is its target's key needs none. |
| `outputRef` | both | What it returns: an `object.entity`, `object.projection` or `object.value`. |
| `many` | query | It returns a list, with the filter, sort and paging contract of a generated list. |
| `objectRef` | both | The target entity. Declare it only when it cannot be derived (below). |
| `transitions` | command | The transitions of its target that it may make. |
| `permission` | both | The permission name the policy is asked about: a dotted identifier path such as `purchasing.approve`. Several operations may share one. |
| `public` | both | `true`: no permission check. Cannot be combined with `permission`. |
| `errors` | command | The business errors its body may return, as lower snake case codes. |

**The target entity is derived** when it can be:

1. from the one entity whose whole primary key the input borrows, each key field extended by
   exactly one field of the input (`requestId extends PurchaseRequest.id` above). An input that
   borrows part of a composite key, one key field twice (`fromId` and `toId`), or the keys of
   two entities derives nothing from the input;
2. else from the output: an entity is its own target, and a projection's target is its base
   entity.

Declare `objectRef` only for an operation with nothing to derive from, such as a command that
creates or imports. When you declare it and a target also derives, the two must agree.

**`binding.rest`** is an optional child of an operation that overrides the derived HTTP
binding:

- `method` is one of `GET`, `POST`, `PUT`, `PATCH`, `DELETE`. When absent, a query is `GET` and
  a command is `POST`.
- `path` is a path template. Its `{placeholders}` must be the target's key fields when the
  operation addresses one row by key, and must be empty when it does not. Two declared bindings
  of one API may not have the same method and path.

Most models never write a binding.

## Lifecycles

A `transition.action` is a child of a `field.enum` on an `object.entity`. An enum field with at
least one transition **is** a lifecycle. Nothing else needs declaring, because the rest is
derived:

| Derived | From |
|---|---|
| The states | the enum's `values` |
| The initial state | the enum's `default` (required once the field has a transition) |
| The terminal states | the members no transition leaves |
| A transition's command | every transition that no declared command lists in `transitions` gets a command of its own name (setting `rules.lifecycle.commands`) |

| Attribute | Meaning |
|---|---|
| `from` | The states the move starts from: members of the enum. |
| `to` | The state it ends in. It may be one of `from`, which records an action that changes nothing. |
| `condition` | A guard over the entity's own fields, in the same grammar as a cross-field validator's `condition`. |
| `permission`, `public` | As on operations. They apply to the transition's derived command only: when a declared command claims the transition, the command's own `permission` guards it, and `verify` warns that the transition's is never read. |

A transition declared on an abstract base entity's field belongs to every entity that extends
it. It does not belong to an entity whose field merely `extends` the lifecycle field: a status
history table that borrows the enum's values has no lifecycle. An entity that extends the base
and redeclares the field must extend the base's field too, or the loader refuses it
(`ERR_LIFECYCLE_REDECLARED`). `transition.timed`, a move made by time rather than by a command, is reserved and not yet
registered.

**A lifecycle on an entity with no source is inert.** It loads and is checked for shape, but
nothing is derived from it until the entity gets a source, declared or inherited; from then on
the source must be writable. A library's core layer, which declares no source, can carry its
lifecycles this way, and its `db` layer makes them live.

**Permission names.** Every operation and every derived command asks the project's policy
about a permission name. A declared `permission` is a dotted identifier path: names of letters,
digits and `_` joined by `.`, such as `purchasing.approve`. When `permission` is absent, the name
is derived and includes its owner:

- a declared operation: `<package>.<operation>`, with its API's package. Operation names are
  unique across the APIs of a package, so two operations never share one by accident. Two
  APIs may expose the same operation by declaring it identically, and then share its name;
- a transition's derived command: `<package>.<Entity>.<transition>`, so `Order.cancel` and
  `Invoice.cancel` ask about different permissions. Above, `submit` derives
  `acme::purchasing.PurchaseRequest.submit`.

A package prefix may use `::`, so a derived name can be declared as it is. A derived name
changes when the operation, transition or entity is renamed, which silently moves access. The
setting `rules.permissions.names` makes `verify` warn about derived names, or fail on them.

## What the loader refuses

| Rule | Code | When |
|---|---|---|
| L1 | `ERR_TRANSITION_NOT_ON_ENTITY` | A transition on a field that is not a field of an `object.entity`: a document-root field, or a field of a value, projection or report. |
| L2 | `ERR_TRANSITION_NOT_ON_ENTITY` | A concrete entity has a lifecycle and a source, but no writable one. An entity with no source is not refused: its lifecycle is inert. |
| L3 | `ERR_LIFECYCLE_NO_INITIAL` | An enum field with transitions has no `default`. |
| L4 | `ERR_TRANSITION_UNKNOWN_STATE` | A `from` or `to` value is not one of the enum's `values`. |
| L5, O0 | `ERR_TRANSITION_NAME_COLLISION` | A transition or an operation is named `create`, `get`, `list`, `update` or `delete`, in any case. |
| L6 | `ERR_TRANSITION_NAME_COLLISION` | Two transitions of one entity share a name, across all its lifecycles, compared without case. |
| L7 | `ERR_BAD_ATTR_VALUE` | A `condition` names a field the entity does not have, or is not boolean. |
| L8 | `ERR_BAD_ATTR_VALUE` | A transition's `from` is empty. |
| L9 | `ERR_BAD_ATTR_VALUE` | The lifecycle field is an array (`isArray: true`). |
| L10 | `ERR_LIFECYCLE_REDECLARED` | An entity redeclares an inherited lifecycle field without extending it, dropping the base's transitions. |
| P1 | `ERR_PERMISSION_PUBLIC_CONFLICT` | `public: true` together with `permission`. |
| P2 | `ERR_BAD_ATTR_VALUE` | A `permission` is not a dotted identifier path. |
| O1 | `ERR_OPERATION_SHAPE` | `inputRef` is not an `object.value`, or `outputRef` is not an entity, projection or value. |
| O2 | `ERR_OPERATION_TARGET_UNRESOLVED` | `objectRef` is not an `object.entity`, or a command lists `transitions` and has no target. |
| O3 | `ERR_OPERATION_TARGET_MISMATCH` | A declared `objectRef` disagrees with the derived target. |
| O4 | `ERR_OPERATION_UNKNOWN_TRANSITION` | A `transitions` name is not a transition of the target. |
| O5 | `ERR_BAD_ATTR_VALUE` | An `errors` code is not lower snake case, is listed twice, or is one the route answers itself: `not_found`, `forbidden`, `invalid_transition`, `transition_condition_failed`, `state_managed`, `validation`, `invalid_json`, `invalid_id`, `method_not_allowed`, `constraint_violation`, `internal`. |
| O6 | `ERR_TRANSITION_NAME_COLLISION` | Two operations of one package share a name, compared without case, in one API or across the package's APIs. One operation declared in two files merges and is not refused. Neither is one operation declared identically in two APIs (a `v1` beside a `v2`): same name, subtype and every operation attribute; only the bindings may differ. |
| B1 | `ERR_BINDING_PATH_MISMATCH` | A `binding.rest` `path` has the wrong placeholders. |
| B2 | `ERR_BINDING_PATH_MISMATCH` | Two declared bindings of one API have the same method (declared or derived) and the same path, ignoring placeholder names. |

Names are compared without case because each one becomes a command, a permission constant and a
file, and those collide on a case-folding target.

Some refusals come from the registry:

- `many` on a command is `ERR_UNKNOWN_ATTR`.
- A `method` outside its set is `ERR_BAD_ATTR_VALUE`.
- An authored `operation.base` is `ERR_ABSTRACT_SUBTYPE_AUTHORED`.
- An `api.operational` anywhere but the top of a document is `ERR_CHILD_NOT_ALLOWED`.

Each case is pinned in `fixtures/conformance/` (`error-rules-*`).

## What `verify` reports

`verify` in every port runs a rules gate. When the model declares an operation or a
transition, it prints one line:

```
meta verify — rules: 2 operation(s), 1 lifecycle(s) with 3 transition(s).
```

and reports:

| Code | Severity | When |
|---|---|---|
| `WARN_LIFECYCLE_UNREACHABLE_STATE` | `verify.lifecycle.unreachable` | A state no chain of transitions reaches from the initial state. |
| `WARN_LIFECYCLE_INITIAL_TERMINAL` | warn | The initial state is terminal, so no row can ever move. |
| `WARN_TRANSITION_UNREACHABLE` | `verify.lifecycle.unreachable` | A transition whose every `from` state is unreachable. |
| `WARN_TRANSITION_PERMISSION_SHADOWED` | warn | A transition declares `permission` or `public: true` but derives no command of its own (every carrier's transition is claimed by a declared command, or `rules.lifecycle.commands` is `none`), so nothing reads it. |
| `WARN_PERMISSION_DERIVED_NAME` | `rules.permissions.names` | An operation, or a transition that derives a command, relies on a derived permission name. The message names it. A transition on an entity with no source derives no command and is not reported. |

An error-severity finding fails the run. A model with no operation and no transition sees no
line and no finding. The cases are in `fixtures/rules-check-conformance/`.

## Settings

These go in `.metaobjects/config.json`, and every port reads them. When a key is absent, the
setting behaves as it does today.

| Setting | Values | When absent | Effect |
|---|---|---|---|
| `rules.permissions.names` | `derive`, `advise`, `require` | `derive` | `derive` accepts derived permission names. `advise` warns about each one. `require` fails `verify` on each one. |
| `rules.lifecycle.commands` | `unclaimed`, `all`, `none` | `unclaimed` | Which transitions derive a command of their own, and so are permission points: those no declared command claims, every one, or none. A command claims a transition for its target entity and every entity extending it. |
| `rules.lifecycle.create` | `initial`, `any` | `initial` | **No effect yet.** Whether a create may start a row in a state other than the initial one. It is read and validated, and nothing acts on it until the service shells land. |
| `verify.lifecycle.unreachable` | `warn`, `error`, `off` | `warn` | The severity of the two reachability checks. `off` skips them. |

```json
{
  "rules": {
    "permissions": { "names": "advise" },
    "lifecycle": { "commands": "unclaimed", "create": "initial" }
  },
  "verify": { "lifecycle": { "unreachable": "warn" } }
}
```

## Requirements can claim operations and transitions

A level 5 requirement's `implementedBy` can name an operation as `<Api>.<operation>`, or a
transition as `<Entity>.<field>.<transition>`. The reference is resolved, not trusted: renaming
the operation fails the build. The generated requirement test for it has the unit
`operation.command`, `operation.query` or `transition.action`.

```yaml
- requirement.functional:
    name: Decided
    level: 5
    status: live
    statement: A reviewer decides a submitted request.
    counterexample: A request that waits forever.
    implementedBy: [Purchasing.decide]
```

See [requirements](requirements.md).

# Business rules: operations, permissions and lifecycles

Declare what your application *does*, beside the entities it does it to:

- **named commands and queries**, with the shapes they take and return;
- **who may run them**, as a permission name;
- **the allowed moves** between the values of a status field.

The model never says *how* an operation works. That is code. The model says where a decision
is needed, which moves are legal, and what a command may return, so all three can be checked.

**What 1.3.0 ships.** The vocabulary, checked when it loads and by `verify`, in all five ports.
A requirement can claim an operation or a transition. Nothing is generated from the vocabulary
yet: the service shells that enforce these rules at run time are later work (ADR-0064). Until
they land, a model with this vocabulary generates byte-identical code to the same model
without it. The design is [ADR-0063](../../spec/decisions/ADR-0063-business-rules-operations-and-lifecycles.md).

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
                - transition.action: { name: reject, from: [submitted], to: rejected, permission: purchasing.decide }

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
              transitions: [approve, reject]
              permission: purchasing.decide
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
| `permission` | both | The permission name the policy is asked about. Several operations may share one. |
| `public` | both | `true`: no permission check. Cannot be combined with `permission`. |
| `errors` | command | The business errors its body may return, as lower snake case codes. |

**The target entity is derived** when it can be:

1. from the one entity whose primary key a field of the input extends (`requestId extends
   PurchaseRequest.id` above);
2. else from the output: an entity is its own target, and a projection's target is its base
   entity.

Declare `objectRef` only for an operation with nothing to derive from, such as a command that
creates or imports. When you declare it and a target also derives, the two must agree.

**`binding.rest`** is an optional child of an operation that overrides the derived HTTP
binding:

- `method` is one of `GET`, `POST`, `PUT`, `PATCH`, `DELETE`. When absent, a query is `GET` and
  a command is `POST`.
- `path` is a path template. Its `{placeholders}` must be the target's key fields when the
  operation addresses one row by key, and must be empty when it does not.

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
| `permission`, `public` | As on operations. They apply to the transition's derived command. |

A transition declared on an abstract base entity's field belongs to every entity that extends
it. `transition.timed`, a move made by time rather than by a command, is reserved and not yet
registered.

**Permission names.** Every operation and every derived command asks the project's policy
about a permission name. When `permission` is absent, the name is `<package>.<name>`:
`acme::purchasing.submit` above. A derived name changes when the operation or transition is
renamed, which silently moves access. The setting `rules.permissions.names` makes `verify` warn
about derived names, or fail on them.

## What the loader refuses

| Rule | Code | When |
|---|---|---|
| L1 | `ERR_TRANSITION_NOT_ON_ENTITY` | A transition on a field that is not a field of an `object.entity`: a document-root field, or a field of a value, projection or report. |
| L2 | `ERR_TRANSITION_NOT_ON_ENTITY` | A concrete entity has a lifecycle and no writable source. |
| L3 | `ERR_LIFECYCLE_NO_INITIAL` | An enum field with transitions has no `default`. |
| L4 | `ERR_TRANSITION_UNKNOWN_STATE` | A `from` or `to` value is not one of the enum's `values`. |
| L5, O0 | `ERR_TRANSITION_NAME_COLLISION` | A transition or an operation is named `create`, `get`, `list`, `update` or `delete`. |
| L6 | `ERR_TRANSITION_NAME_COLLISION` | Two transitions of one entity share a name, across all its lifecycles. |
| L7 | `ERR_BAD_ATTR_VALUE` | A `condition` names a field the entity does not have, or is not boolean. |
| P1 | `ERR_PERMISSION_PUBLIC_CONFLICT` | `public: true` together with `permission`. |
| O1 | `ERR_OPERATION_SHAPE` | `inputRef` is not an `object.value`, or `outputRef` is not an entity, projection or value. |
| O2 | `ERR_OPERATION_TARGET_UNRESOLVED` | `objectRef` is not an `object.entity`, or a command lists `transitions` and has no target. |
| O3 | `ERR_OPERATION_TARGET_MISMATCH` | A declared `objectRef` disagrees with the derived target. |
| O4 | `ERR_OPERATION_UNKNOWN_TRANSITION` | A `transitions` name is not a transition of the target. |
| O5 | `ERR_BAD_ATTR_VALUE` | An `errors` code is not lower snake case, or is listed twice. |
| B1 | `ERR_BINDING_PATH_MISMATCH` | A `binding.rest` `path` has the wrong placeholders. |

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
| `WARN_PERMISSION_DERIVED_NAME` | `rules.permissions.names` | An operation, or a transition that derives a command, relies on a derived permission name. |

An error-severity finding fails the run. A model with no operation and no transition sees no
line and no finding. The cases are in `fixtures/rules-check-conformance/`.

## Settings

These go in `.metaobjects/config.json`, and every port reads them. When a key is absent, the
setting behaves as it does today.

| Setting | Values | When absent | Effect |
|---|---|---|---|
| `rules.permissions.names` | `derive`, `advise`, `require` | `derive` | `derive` accepts derived permission names. `advise` warns about each one. `require` fails `verify` on each one. |
| `rules.lifecycle.commands` | `unclaimed`, `all`, `none` | `unclaimed` | Which transitions derive a command of their own, and so are permission points: those no declared command claims, every one, or none. |
| `rules.lifecycle.create` | `initial`, `any` | `initial` | Whether a create may start a row in a state other than the initial one. It is read and validated now; the service shells will act on it. |
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

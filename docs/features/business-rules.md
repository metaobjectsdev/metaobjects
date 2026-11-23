# Business rules: operations, permissions and lifecycles

Declare what your application *does*, beside the entities it does it to:

- **named commands and queries**, with the shapes they take and return;
- **who may run them**, as a permission name;
- **the allowed moves** between the values of a status field.

The model never says *how* an operation works. That is code. The model says where a decision
is needed, which moves are legal, and what a command may return, so all three can be checked.

**What 1.3.0 ships.** The vocabulary, checked when it loads and by `verify`, in all five ports.
The Rust port loads the vocabulary and runs the same loader rules, and its `verify` runs the
same rules gate, held to `fixtures/rules-check-conformance/` ([Rust port](../ports/rust.md)).
A requirement can claim an operation or a transition. The flat generators generate nothing from
the vocabulary. The layer generators of ADR-0067 do, and an app adds them to its generator list as
it adds any generator. The first is `rules-names`, which writes the states, transitions,
permissions and error codes as constants, in TypeScript (see
[The names layer](#the-names-layer-typescript)) and C#. The second is `contract-types`: in
TypeScript it writes the shapes and errors an operation takes and returns (see
[The contract types layer](#the-contract-types-layer-typescript)), and in C# so far each
entity's create and update records ([C# port](../ports/csharp.md)). The TypeScript runtime makes the
guarded update a transition writes, `ObjectManager.guardedUpdate`, held to the shared
persistence scenario `guarded-update.yaml`. The service layer starts in TypeScript: `service` writes
each package's derived list, get, create, update and delete, every write in one transaction with the
declared write rules, behind a thin Fastify transport (`service-routes`) or Hono transport
(`service-routes-hono`) that answers the shared API tests as the flat routes do (see
[The service layer](#the-service-layer-typescript)). It also writes a command per transition and a
shell per declared command and query, and enforces at run time what this page declares: the
permission point, the state check, the guarded update, `state_managed` and the declared errors, held to the shared API tests' `rules/` corpus. The other ports' services are
later 1.3.0 work. A lifecycle in a project that wires no service generator will be advised by
`verify` once that check lands; until then the flat routes enforce nothing and `verify` says
nothing about it. Every flat generator writes byte-identical code for
a model with this vocabulary and the same model without it. The design is [ADR-0066](../../spec/decisions/ADR-0066-business-rules-operations-and-lifecycles.md).

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
| `rules.permissions.names` | `derive`, `advise`, `require` | `derive` | `derive` accepts derived permission names. `advise` warns about each one. `require` fails `verify` on each one, and the TypeScript service generator refuses to generate such a point, naming the permission it would derive. |
| `rules.lifecycle.commands` | `unclaimed`, `all`, `none` | `unclaimed` | Which transitions derive a command of their own, and so are permission points: those no declared command claims, every one, or none. A command claims a transition for its target entity and every entity extending it. |
| `rules.lifecycle.create` | `initial`, `any` | `initial` | Whether a create may start a row in a state other than the initial one. Under `initial` the generated service fills an omitted state with the initial one and answers a different one 409 `state_managed`; under `any` it accepts any state of the lifecycle. The TypeScript service acts on it; a port whose service has not landed has nothing to act on. |
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

## The names layer (TypeScript)

`rulesNamesFile()` (stable name `rules-names`, ejectable like any reference generator) writes one
`rules.names.ts` per metadata package that declares a lifecycle or an operation, under the
package's directory (`acme/purchasing/rules.names.ts`) in either output layout. A package without
the vocabulary gets no file. Hand-written code (a command body, a policy, a grant table) imports
these instead of writing a state, a transition, a permission or an error code as a string, so a
rename in the model stops it compiling:

```ts
export const PurchaseRequestStatusLifecycle = {
  field: "status",
  states: ["draft", "submitted", "approved", "rejected"],
  initial: "draft",
  terminal: ["approved", "rejected"],
  transitions: {
    submit: { from: ["draft"], to: "submitted" },
    approve: { from: ["submitted"], to: "approved" },
    reject: { from: ["submitted"], to: "rejected" },
  },
} as const;
export type PurchaseRequestStatusState = (typeof PurchaseRequestStatusLifecycle.states)[number];
export type PurchaseRequestStatusTransition = keyof typeof PurchaseRequestStatusLifecycle.transitions;

export const PurchaseRequestCommands = {
  submit: { lifecycle: "status", permission: "acme::purchasing.PurchaseRequest.submit" },
} as const;

export const Operations = {
  decide: { kind: "command", permission: "purchasing.decide", transitions: ["approve", "reject"], errors: ["over_budget", "already_decided"] },
  openRequests: { kind: "query", public: true },
} as const;

export const Permissions = ["acme::purchasing.PurchaseRequest.submit", "purchasing.decide"] as const;
export type Permission = (typeof Permissions)[number];
export const BusinessErrors = ["already_decided", "over_budget"] as const;
```

The file also carries `ShellErrors`, the codes the enforcing shell answers with on its own. What
is derived (the terminal states, which transitions get a command under `rules.lifecycle.commands`,
each derived permission name) comes from the same functions `verify`'s rules gate uses, so the
constant and a `verify` message name the same thing. The file ends in `.names.ts`, so
`meta verify --codegen` treats a hand edit in it as drift, as it does for `<Entity>.names.ts`.

## The contract types layer (TypeScript)

`contractTypes()` (stable name `contract-types`, ejectable) writes the shapes a caller and a
service exchange, with no persistence mapping in them, so a transport, a client or a job can import
them without the ORM. Each module imports `zod` and nothing else. Beside where the entity generator
writes `<Name>.ts`, it writes:

- `<Entity>.contract.ts` for each store-backed entity: the read schema and type (`<Entity>Schema`,
  `<Entity>`, a row as the store returns it), the create and update schemas with their validation
  (`<Entity>InsertSchema`, `<Entity>UpdateSchema`) and the typed `<Entity>Create` and
  `<Entity>Patch`. A TPH subtype's read schema pins its discriminator, and a TPH base's read type
  is the union of its subtypes';
- `<Projection>.contract.ts` for each projection: its read schema and type, and nothing a caller
  sends;
- the value module of each value object those shapes or an operation reach, byte for byte the
  entity generator's, so the two collapse into one file when both run;
- `<pkg path>/operations.contract.ts` for each package that declares operations, under the
  package's directory in either layout;
- `errors.contract.ts` at the target root: the wire error bodies.

For the example's `decide` command and its queries:

```ts
/** `decide` (command). */
export const DecideInputSchema = DecisionInputInsertSchema;
export type DecideInput = z.input<typeof DecisionInputInsertSchema>;
export type DecideBusinessError = "over_budget" | "already_decided";
export type DecideError = ErrorBody<ShellErrorCode | ContractErrorCode | DecideBusinessError>;

/** `openRequests` (query). */
export type OpenRequestsOutput = readonly RequestSummary[];
export type OpenRequestsBusinessError = never;
export type OpenRequestsError = ErrorBody<ShellErrorCode | ContractErrorCode | OpenRequestsBusinessError>;
```

`errors.contract.ts` carries the shell's codes (`ShellErrorCodes`) and the API contract's
(`ContractErrorCodes`), the HTTP status of each fixed code (`ErrorStatus`), and the bodies:
`ErrorBody`, `ValidationErrorBody` with its `issues`, and `ConstraintViolationBody` with its
`constraint` kind (see [API contract](api-contract.md)). It gives no status for a business error a
command declares; that is the service shell's to answer. A key a derived command or a keyed query
takes is not here either: the service generator decides its parameters.

## The service layer (TypeScript)

`serviceFile()` (stable name `service`, layer `service`, ejectable) writes the layer a route, a job
or an agent tool calls (ADR-0067 layer 4): one module per metadata package, under the package's
directory in either layout.

- `<pkg path>/service/<operation>.ts`: one function per operation, `(deps, ...args, opts) =>
  OpResult`. Each concrete entity with a writable table and a single-field key gets five:
  `list<Plural>`, `get<Entity>`, `create<Entity>`, `update<Entity>` and `delete<Entity>`.
- `<pkg path>/service/index.ts`: `ServiceDeps` (the database, and the hand-written pieces below),
  the `<Pkg>Service` interface, `create<Pkg>Service(deps)` that binds the operations to it, and
  each entity's wire mapper.

By default every write runs in one transaction (Cloudflare D1 is the exception, below), in
ADR-0067's order: load the row under a row lock (`not_found` when there is none), validate the input
and stamp what the model declares (ADR-0045: `@autoSet`, write-once fields, server-owned and unknown
keys), then write it. A caller that runs several operations atomically passes its own transaction as
`opts.tx`, and each operation runs in a savepoint inside it. A refusal rolls the transaction back. A
query opens no write transaction. An operation answers an `OpResult`: the value, or a failure
carrying the code and the HTTP status the [API contract](api-contract.md) gives it, so every
transport maps it the same way.

On SQLite the service takes a sync or an async Drizzle driver, as the flat generators do. An async
one (libsql) runs Drizzle's own transaction. A sync one (bun:sqlite, better-sqlite3) cannot: its
`transaction()` commits when its callback returns, at the first `await`. So the runtime drives the
transaction with statements (`BEGIN IMMEDIATE`, `COMMIT`, `ROLLBACK`) and runs one at a time on each
database handle, since SQLite has one writer; a read waits for the transaction in flight. A job that
runs several operations atomically on any driver opens the transaction with
`withWriteTransaction(db, async (tx) => ...)` from `@metaobjectsdev/runtime-ts/service` and passes
`tx` as each operation's `opts.tx`. On a sync driver every operation inside must be passed that
`tx`: one that is not waits for the transaction it is inside, and never runs.

Cloudflare D1 holds no transaction across application code: it refuses the `BEGIN` the service
opens. Generate its service with `serviceFile({ interactiveTransactions: false })` (ADR-0067 §4).
That service opens no transaction. Each derived write is its one statement after the load and the
checks, and a transition is its guarded update, which needs no transaction to hold. There are no
`<Pkg>Hooks` and no `<Pkg>Events`, since a hook's refusal could not undo the write it followed. A
package that declares a command fails generation with `ERR_STORE_NO_INTERACTIVE_TX`, naming the
package, the command and the option; queries are generated as usual.

`serviceRoutesFile()` (stable name `service-routes`, layer `api`, Fastify) writes the thin
transport (layer 5) beside it, `<pkg path>/transport/fastify.ts`: one plugin per package,
registered with the service it calls. Each route parses the request, calls one operation and
sends what it answered; it holds no rules and no database handle. `serviceRoutesHonoFile()`
(stable name `service-routes-hono`) writes the same routes for Hono, `<pkg path>/transport/hono.ts`,
as one function per package that adds them to your app: `shopServiceHonoRoutes(app, { service })`.

```ts
import { createShopService } from "./generated/acme/shop/service/index.js";
import { shopServiceRoutes } from "./generated/acme/shop/transport/fastify.js";
import { withWriteTransaction } from "@metaobjectsdev/runtime-ts/service";

const service = createShopService({ db });
await app.register(shopServiceRoutes, { service });

// A job calls the same operations, here two in one transaction (on any driver):
await withWriteTransaction(db, async (tx) => {
  await service.createOrder({ title: "first" }, { tx });
  await service.createOrder({ title: "second" }, { tx });
});
```

Both import the entity module (`entity`, for the table and the allowlists) and the contract types
(`contract-types`), written to the same target, and `@metaobjectsdev/runtime-ts`'s `service` and
`service/fastify` (or `service/hono`) entries; `meta eject service`, `meta eject service-routes` and
`meta eject service-routes-hono` copy that source into `codegen/runtime/` as they do for the routes.
The shared API tests run the service behind each transport over a subset of the corpora the flat
routes pass; the subset and its engines are listed in the
[API contract README](../../fixtures/api-contract-conformance/README.md#ts-lanes-illustrative-detail).

### Transitions, declared operations and what you write by hand

The service also writes what the rules on this page declare:

- `<pkg path>/service/<transition><Entity>.ts` for each transition that derives a command (by
  `rules.lifecycle.commands`), mounted at `POST <collection>/{id}/<transition>`.
- `<pkg path>/service/<operation>.ts` for each declared command and query, mounted at its
  `binding.rest` method and path, or at the derived path (`<collection>/{id}/<operation>` when it
  addresses a row, `<collection>/<operation>` when it does not; a query is a `GET`, a command a
  `POST`). Two routes on one method and path are refused when the transport is generated.

Each one runs ADR-0066 §6's checks in this order, in one transaction unless the store has none (a query in the read scope):
load the row (`not_found`), validate the input, the permission point (403 `forbidden`), the state
check (409 `invalid_transition`), the hand-written body, the guarded update (409
`invalid_transition` or `transition_condition_failed` when it matches no row), and the event hook.
The generic update refuses a different value of a lifecycle field (409 `state_managed`) and lets
the same value through. Under `rules.lifecycle.create: initial` a create starts in the initial
state, so an omitted state is filled and another is `state_managed`.

What you write is passed to `create<Pkg>Service(deps)`; there is no base class to extend.
`index.ts` types each piece:

| In `deps` | Type | What it is |
|---|---|---|
| `policy` | `<Pkg>Policy<A>` | `allows(permission, actor, row, input, tx)`: a refusal is 403 `forbidden`. Required when the package has a permission point. `<Pkg>Permission` lists every name it is asked about. |
| `bodies` | `<Pkg>Bodies<A>` | One per declared operation. A command with `@transitions` returns the move to make, or `"none"`; `ctx.refuse(code)` answers one of its `@errors` (409). Required when the package declares an operation. |
| `hooks` | `<Pkg>Hooks<A>` | Optional `before`/`after` hooks on each derived create, update and delete. A before hook may return a replacement input. |
| `events` | `<Pkg>Events<A>` | Optional `onWrite(event, ctx)`, told about every create, update, delete, transition and command, in its transaction, with the actor. An outbox, a history table or an audit log is written here. |

By default every hook, body and event runs in the write's transaction (`ctx.tx`), and any of them may refuse
with `ctx.refuse(code)`, which answers 409 with that code and rolls the whole write back. A code the
API contract reserves (`not_found`, `forbidden`, `validation`, ...) is not accepted.

The actor is a type you define, `A`. A caller passes it per call as `opts.actor`, and the service
hands it to the policy, the bodies, the hooks and the event hook without looking inside it. The
Fastify transport takes a `getActor(request)` resolver of yours, and the Hono transport a
`getActor(c)`:

```ts
const service = createPurchasingService<Actor>({
  db,
  policy: { allows: (permission, actor) => actor?.grants.includes(permission) ?? false },
  bodies: {
    decide: (input, ctx) => (input.approve ? "approve" : "reject"),
    requestTotals: async (ctx) => totalsOf(ctx.tx),
  },
  events: { onWrite: (event, ctx) => writeAudit(ctx.tx, event) },
});
await app.register(purchasingServiceRoutes, { service, getActor: (req) => actorFromSession(req) });
// or, on Hono:
purchasingServiceHonoRoutes(app, { service, getActor: (c) => actorFromSession(c) });
```

The shared API tests' `fixtures/api-contract-conformance/rules/` corpus runs a model with a
lifecycle, a declared command and query, permission points and declared errors against the
generated service, under the default settings and under `rules.lifecycle.create: any` and
`rules.lifecycle.commands: all` and `none`. Its README specifies the hand-written pieces, so every
port's lane implements the same ones.

The service covers every object the flat routes serve, with the same answers:

- A projection and a served report get a list (and a get, when the projection is keyed). Their
  transports answer every write `405 method_not_allowed`. A report keeps its row cap
  (`serviceFile({ reportMaxRows })`, as `routesFile` takes it) and, with `report-export` wired,
  its `?format=` export.
- A write-through entity reads through its replica view and answers a write by reading the row
  back through that view.
- A single-table (TPH) hierarchy's base gets the polymorphic list and get. Each concrete subtype
  gets the five operations at its own path, on the base table, scoped to its discriminator value.
- A many-to-many relationship gets a query, `<relation>Of<Entity>(id)`, served at
  `GET <path>/{id}/<relation>`.

The `projection/`, `report/`, `write-through/`, `tph/`, `m2m/`, `decimal/` and `secret-fields/`
corpora run on the service lanes as well as the routes lane. An entity with a composite key has no
derived operations.

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

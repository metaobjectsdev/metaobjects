# api-contract-conformance / rules

Gates what a generated service does with ADR-0066's rules, over HTTP: the lifecycle, the derived
transition commands, a declared command and query, the permission points, the declared errors and
the refusals of a hook and of the event hook. The check order and the answers are ADR-0066 §6; the
hand-written pieces attach as ADR-0067 §4 and §7 describe.

**Generated lane only, by design.** What is under test is whether a port's service GENERATOR emits
these shells. A hand-rolled reference server would answer every scenario by construction.

## The model

`meta.json`, package `acme::purchasing`:

- `PurchaseRequest` (table `purchase_requests`): `id`, `title`, `amountCents`, `limitCents` and the
  lifecycle field `status` (`draft`, `submitted`, `approved`, `rejected`, `cancelled`; initial
  `draft`). Its transitions:

  | Transition | From | To | Permission |
  |---|---|---|---|
  | `submit` | `draft` | `submitted` | derived: `acme::purchasing.PurchaseRequest.submit` |
  | `approve` | `submitted` | `approved` | derived; `@condition` amountCents <= coalesce(limitCents, 0) |
  | `reject` | `submitted` | `rejected` | derived |
  | `cancel` | `draft`, `submitted` | `cancelled` | `@public` |
  | `reopen` | `rejected` | `draft` | declared: `purchasing.reopen` |

- `AuditEntry` (table `audit_entries`): `id`, `kind`, `detail`. The event hook writes it.
- API `Purchasing`:
  - `decide`, a command: input `DecisionInput` (`requestId` borrows the key, `approve`, `note`),
    `@transitions` `approve` and `reject`, `@permission: purchasing.decide`, `@errors`
    `note_required`, bound to `PUT /purchase-requests/{id}/decision`, answering the request.
  - `requestTotals`, a `@public` query on `PurchaseRequest`, answering `RequestTotals`
    (`count`, `totalCents`) at the derived path `GET /purchase_requests/requestTotals`.

Routes mount under `/api`. `seed.json` holds requests 1 to 5, in states `draft`, `submitted`,
`submitted` (over its limit), `rejected` and `approved`.

## The hand-written pieces every lane implements

These are the app's code, not the generator's, and every port's lane writes the same ones:

- **Actor.** From the request headers: `x-actor` is the actor's name (absent or empty: no actor),
  `x-grants` a comma-separated list of the permission names it holds.
- **Policy.** Allows a permission exactly when the actor holds it by name. No actor is refused.
- **`decide` body.** When `approve` is false and `note` is absent or empty, refuse `note_required`.
  Otherwise return `approve` when `approve` is true, else `reject`.
- **`requestTotals` body.** `count` is the number of purchase requests, `totalCents` the sum of
  their `amountCents` (0 for none), read in the query's scope.
- **Hook.** After a purchase request is updated, refuse `title_refused` when its title is
  `REFUSE`.
- **Event hook.** For every write: refuse `audit_unavailable` when the actor's name is
  `no-audit`; otherwise insert an audit entry in the write's transaction, `kind` the event's kind
  and `detail`:
  - a transition: `<Entity> <key> <transition> <from>-><to> by <actor name or ->`;
  - a command that made no move: `<operation> <key> by <actor name or ->`;
  - a create, update or delete: `<Entity> <key> by <actor name or ->`.

## Settings variants

`scenarios/` runs under the default settings. Each `settings/<variant>/` directory holds a
`.metaobjects/config.json` and its own `scenarios/`, run over the same `meta.json` and seed:

| Variant | Setting | What it shows |
|---|---|---|
| `create-any` | `rules.lifecycle.create: any` | a create may start in any state |
| `commands-all` | `rules.lifecycle.commands: all` | a transition `decide` claims still gets its own command |
| `commands-none` | `rules.lifecycle.commands: none` | no transition gets a command; `decide` still moves |

A 404 for a route that is not mounted is asserted on the status only: the body is the web
framework's own.

## Port coverage

| Port | Lane |
|---|---|
| TypeScript | `server/typescript/packages/integration-tests/test/api-contract-rules.test.ts`, both output layouts |
| Rust | service level only: `server/rust/metaobjects-codegen/tests/service.rs` runs the scenarios through the generated service on SQLite, and checks the settings variants in the generated text; the HTTP lane waits for its transport |
| C#, Java, Kotlin, Python | not yet: each port's service generator is its own 1.3.0 work |

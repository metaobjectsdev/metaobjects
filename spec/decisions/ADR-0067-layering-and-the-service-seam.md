# ADR-0067: Generated code is layered, and hand-written code attaches at the service seam

## Status

**Accepted** (2026-11-13), **amended 2026-11-20** (see "Amendment 1" at the end). This ADR decides
the layers, each a generator an app chooses, where the business rules of ADR-0066 are enforced, and
how hand-written code attaches. Two answers were ruled with it:

- In every language, hand-written code attaches by implementing a generated interface and
  being passed in.
- The service is one module per metadata package, and its surface is that package's
  operations.

It amends ADR-0045 (§6). It depends on the line between core and helpers: ADR-0034
Amendment 3, as ADR-0066 §8 restates it. The core is the contracts and the conformance kits,
and every generator below is a helper.

Nothing in this ADR is generated yet. The layer generators, the service shells and the
per-package choice of generators are later work. ADR-0066's vocabulary is inert until they land.

**Experimental.** The vocabulary this design generates from is experimental (ADR-0066 Status,
`docs/compatibility-policy.md`): it may change in a MINOR, including removals and renames, until
generated services run on it in an adopter estate. The layers, the seam and the shells below are
designed against it and change with it.

## Context

Today's generators emit a flat shape: entity and model types, then routes or controllers that
call persistence directly. Two things break that shape:

- **There is no place for a rule to live.** ADR-0066 declares operations, permission points and
  lifecycles. Enforcing them needs code that sits between the transport and the data access.
  Every caller passes through it: an HTTP request, a background job, a queue consumer, an agent
  tool.
- **There is no seam for hand-written code that keeps a guarantee.** A hand-written body has to
  run *inside* the checks, not around them. A generated base class to override lets an
  override call around the checks. A hook that only observes cannot decide which transition
  applies.

## Decision

### 1. The layers

Each layer is a generator. An app lists the ones it wants in its port's own generator
configuration (§5); MetaObjects ships them as part of its default generators, written
idiomatically for each language. A layer can be imported, ejected or replaced on its own. There
are no layer settings: choosing a layer means choosing a generator.

| Layer | What it holds | Regenerated | Who owns what |
|---|---|---|---|
| 0. Names | Constants for every entity, field, table, column, enum member, state, transition, permission and error | Always | Generated. This layer is the tether: hand code that uses it stops compiling when the model renames something. Every generator that reads names or shapes uses these. |
| 1. Contract types | Create, update and read shapes with their validation; operation inputs and outputs; the wire error shapes | Always | Generated. Every generator in a language shares it, so a transport from one generator calls a service from another. |
| 2. Persistence mapping | The chosen ORM's mapping, where the language has one | Always | Generated, replaceable |
| 3. Data access | Typed queries per entity, including the guarded update | Always | Generated, replaceable. Omitted where the ORM is already this layer. |
| 4. Service | One module per metadata package. Its surface is the package's operations: derived CRUD, derived transition commands and declared operations. Each operation is a shell that enforces the declared rules. | Shells always; bodies never | Shells generated. Bodies, policy and event handling are hand-written against generated interfaces. |
| 5. Transport | Routes or controllers | Always | Generated; run as is, extend through hooks, or own a copy. Parses the request, calls the service, maps errors to the wire contract. Holds no rules. |
| 6. Client and UI logic | Hooks, forms, grids, field metadata | Always | Generated; run as is, extend through hooks, or own a copy. TypeScript only. |

"Replaceable" means `meta eject` and its equivalents in each port (ADR-0034): the adopter owns
the copy from then on. Generated code is real code that adopters ship. A layer is replaced
because a project wants a different shape, not because the generated one is a draft.

### 2. The unit is the operation; the module is the package

There is one file per operation inside a package's service folder. The service module of a
metadata package holds the operations of every `api.operational` in that package, plus the
derived ones. The grouping is fixed at one module per package: a project that wants another
grouping subclasses the generator or ejects it.

An `api.operational` node is a wire contract, and it may be versioned (`v1` and `v2` side by
side). The service is code. So there is one router per `api.operational` node, and every
router calls the same service.

### 3. How hand-written code attaches: an interface, passed in, in every language

The pattern has three steps, in every language:

1. The generator emits an interface for the bodies, the policy and the event hook.
2. The adopter writes a type that implements it, in a file the generator never touches.
3. The composition root passes that type to the generated service's constructor or factory.

Regeneration replaces the interfaces and the shells. When the model adds an operation or a
permission, the adopter's implementation stops compiling. In Python the type checker and a
start-up check say what is missing. Hand-written code cannot reach the shell's internals, so it
cannot bypass the shell's guarantees with an override.

There is no generated base class to extend, and C# does not use partial methods. That was the
design's choice, taken as the safer one; no separate ruling decided it, and it can be reopened
by a later ruling. A partial class is the same class, so hand-written code would see the
shell's private state and could call around it.

### 4. Per language

| | TypeScript | C# | Java | Kotlin | Python | Rust |
|---|---|---|---|---|---|---|
| Names (0) | `const`s and literal unions | `static class` of `const string` | `final class` of `static final String`; enums for states | `object` of `const val`; enum class for states | module constants; `StrEnum` for states | `pub const` items; enums for states |
| Contract types (1) | Zod schemas, inferred types | `record`s with DataAnnotations | `record`s with Bean Validation | `data class`es with validation | Pydantic v2 models | serde structs with `validate()` |
| Mapping (2) | Drizzle tables | EF Core entities and `AppDbContext` | none generated | Exposed `Table` objects | none generated | none: row types derive sqlx `FromRow` |
| Data access (3) | query functions taking `db` | none: the context is the data layer | a generated repository implementation on `ObjectManagerDB`, with the guarded update as a method | Exposed repository functions | a generated repository over the abstract `ObjectManager`, implemented by `ObjectManagerDb` | generated repository functions on sqlx, with the guarded update |
| Service (4) | a function per operation; `createXService(deps)` | `sealed class XService`, constructor-injected `IXPolicy`, `IXBodies`, `IXEvents`; `services.AddX()` | `@Service` class implementing a generated `XOperations`; constructor injection of `XPolicy` and `XBodies`; `@Transactional` per operation | `class XService(db, policy, bodies, events)`; each operation in `transaction {}`; returns a sealed `OpResult` | a module per package, a function per operation taking an `OpContext`; bodies and policy as `Protocol`s | `struct XService<P, B, E>` over generated traits `XPolicy`, `XBodies`, `XEvents`; each operation takes the transaction and returns `Result<T, XError>` |
| Transport (5) | Fastify routes | minimal-API route groups | Spring MVC controllers | Spring controllers | FastAPI router with `Depends` | an axum router |

**Rust gets layered generators like every other port** (ruled 2026-11-20); it is not exempt. The
Rust column above is the shape its generators are written to.

**Java's data access stays on `ObjectManagerDB` (no JPA).** The repository implementation is
promoted from the test-only one. **Python's data access is the `ObjectManager` split:** an
abstract `ObjectManager` and a concrete `ObjectManagerDb`, with a clean break for
`ObjectManager(root, driver)` and no compatibility shim, plus a transaction API the service shell
uses. A session driver for SQLAlchemy ships; a SQLAlchemy generator set is deferred (see
Alternatives).

These calls are recorded here:

- **Transactions and hooks.** Every write operation of the service runs in one transaction:
  derived create, update and delete, derived transition commands, and declared commands. The
  shell opens it, or uses one passed in as an optional parameter, for a job that runs several
  operations atomically. Inside it, in this order:
  1. The shell loads the target row, with a row lock where the dialect has one. The policy
     check and the state check use that row.
  2. The before hook runs (derived CRUD). It may return a replacement input or refuse.
  3. The shell validates and stamps the final input (ADR-0045).
  4. The write runs, or the body, then the guarded update for a transition.
  5. The after hook runs.
  6. The write-event hook runs.

  The hook interfaces and the event hook are always generated, with do-nothing defaults. There is
  no switch for them. Every hook receives the transaction the write used. If a hook or body
  throws or refuses, the whole transaction rolls back: the row, any cascade a hook wrote, and
  the event handler's own rows (an audit row, an outbox row). A refusal is answered
  `409 {"error": "<code>"}`, and a code reserved by the shell or the API contract is refused
  (ADR-0066 O5). Queries open no write transaction and call no hooks.
- **Stores without interactive transactions.** A store whose driver cannot hold a transaction
  across application code (Cloudflare D1 is one) is declared with an option on the TypeScript
  service generator. Under it the generator refuses hooks and events with
  `ERR_STORE_NO_INTERACTIVE_TX`, naming the package and the option. There is no storage kit.

  The option and the code `ERR_STORE_NO_INTERACTIVE_TX` are designed here and land with the
  TypeScript service generator; nothing in 1.3.0 reads or reports them yet.
- **Kotlin** returns a sealed result for declared business errors, and the transport maps it.
  The result type is fixed as designed: a project that wants exceptions ejects the generator.
- **Java's** generated `@Service` class is not `final`, so Spring's transaction proxy works.
  It is still not meant to be extended, and its generated header says so.
- **ADR-0066's four settings stay** (`rules.permissions.names`, `rules.lifecycle.commands`,
  `rules.lifecycle.create` and `verify.lifecycle.unreachable`). They decide what the model derives,
  which every port must agree on, so they are not generator options. The service generators read
  `rules.lifecycle.commands` and `rules.lifecycle.create`; until they land, `rules.lifecycle.create`
  is read and validated and has no effect (ADR-0066 §5). What reads each key: `rules.permissions.names`
  and `verify.lifecycle.unreachable` are read by the `verify` rules gate today, and the service
  generators will read `rules.lifecycle.commands` (the derived commands) and `rules.lifecycle.create`.

### 5. Choosing layers

An app picks the generators it wants, in the generator configuration its port already has:

| Port | Where the list lives | Per-package choice |
|---|---|---|
| TypeScript | `generators` in `metaobjects.config.ts` | the generator's `filter` function |
| C# | `codegen/Generators.cs` | the generator's `Include` lambda |
| Java and Kotlin | `<generators>` in the pom | `<filters>` |
| Python | `targets.<name>.generators` in `metaobjects.config.yaml` | a package and entity selection per generator, added with the service generators |
| Rust | the generator list `cargo meta init` writes | the same package selection |

1. **MetaObjects recommends one list per port** for the layers it ships (the names, contract
   types, data access, service and transport generators of §1). The list is documentation and
   what an opt-in `init` writes (§7). It is not a mode: an app adds, removes, configures or
   replaces an entry the way it already does.
2. **The layer generators are separate from today's flat ones.** The flat generators keep their
   output, so a project that changes nothing sees no diff, and `fixtures/codegen-noop/rules/`
   keeps guarding them. Both kinds can run in one project on different packages, using each port's
   per-package choice above.
3. **Names and contract types are shared** by every generator in a language. That is what lets a
   transport from one generator call a service from another.
4. **The service interface is the seam.** A transport talks to layer 4 only through the
   generated operations interface, or `createXService` in TypeScript.
5. **One owner per output path.** The engine already refuses two generators writing one file,
   and each generator writes under its own folder per package.
6. **Each layer carries a label** in the shared generator manifest
   (`fixtures/generator-registry-conformance/registry.json`: `model`, `persistence`, `api`,
   `client`, `docs` or `capability`, and a new `service`), and `gen --list` groups by it. That is the whole catalogue;
   no named set of generators exists.
7. **A list is a list, not a framework.** Ejecting a generator ejects that generator. Replacing a
   layer means replacing one entry.

### 6. Where the business-rules shell sits, and the amendment to ADR-0045

The shell sits in layer 4, and only there:

- The transport parses the request and maps errors; it holds no rules.
- Data access provides the guarded update but decides nothing.
- The shell is the only caller of data access where the service generator is used. So a job, a
  queue consumer or an agent tool that calls the service gets the same checks as an HTTP request.

Today's flat generators have no service layer. A project that declares a lifecycle and wires no
service generator is advised by `verify` that the lifecycle is not enforced; the flat routes
enforce nothing. (This replaces the first version of this section, which promised the
guarded update and the `state_managed` refusal in the flat routes. That would have changed the
output of five routes generators for projects that asked for nothing.)

**ADR-0045 is amended.** Its decision sentence becomes: *"The outermost generated write-path
artifact an adopter deploys must guarantee every metamodel-declared write semantic, either
itself or by calling a generated service shell that does. No consumer-supplied seam may sit
between the guarantee and the wire. A hand-written operation body is called by the shell,
inside the guarantee, and is not such a seam."*

ADR-0045 rejected rewiring controllers through a lower layer, because it "would churn all
generated output". That reason does not apply here: the service generators are separate
generators an app adds, so no existing output churns.

### 7. The actor

"The actor" is the caller a rule is checked for. ADR-0066 passes it to the policy and to the
event hook. It is a type the app defines:

- Generated code never looks inside it. It is a generic parameter on the service, and the shell
  only passes it on, to the policy and to the event hook.
- The transport gets it from a resolver the app supplies at the composition root, the same way
  the policy is supplied. A job or a test builds an actor directly and passes it.
- It is passed **explicitly**, never through ambient context, because a job or a Kotlin coroutine
  has none.
- For an operation marked `@public` the shell skips the policy, and the actor may be absent.

The resolver reads as each framework reads: Fastify `getActor(request)`; Hono `getActor(c)`;
ASP.NET a `Func<HttpContext, TActor>`; Spring a generated `ActorResolver<A>` interface the app
implements as a bean; FastAPI `Depends(get_actor)`, overridden the way `get_repository` is
today. Rust: an axum extractor for the app's actor type. No generated
transport passes "who is calling" into generated code today, so this is new in every port.

The framework's own principal (`ClaimsPrincipal`, Spring `Authentication`) was rejected: it makes
the service layer depend on the web framework, and a job would have to fake a web principal. A
MetaObjects-defined actor shape (an id and roles) was rejected: it would make the tool own a
permission model, and the model names where a decision is needed, never what the decision is
(ADR-0066 §1).

### 8. What `init` writes

`meta init`, `dotnet meta init` and `metaobjects init` keep writing an **empty** generator list
(ADR-0034 Amendment 2), with a comment naming the usual generators. One opt-in flag, on the
pattern of the existing `--with-docs`, wires the recommended list of §5 instead. Rust's
`init` writes the project's list the same way. Java and Kotlin have no
`init`: the documentation carries the recommended pom `<generators>` block.

After the service generators have run in the adopter estates with the drift gate enforced, the
scaffold's comment and the quickstart recommend the service list. The captain's ruling of
2026-11-12 that new projects get the new behaviour is met by what the scaffold recommends, not by
reversing "empty by design".

## Consequences

- Each port gains the layer generators, as later work, one change per language. TypeScript goes
  first, and its shared API tests become the contract the other ports pass. Rust gets them too.
- A port whose generator list the app could not change (Rust's, until its own `init` writes one)
  gains a project-level list, and Python gains per-generator package selection. No port gains a `layers`,
  `sets` or `preset` key.
- Today's flat generators are unchanged for every project that does not add a service generator.
- ADR-0045's guarantee is unchanged. A semantic is still never left to a consumer-supplied seam;
  this ADR adds the generated service as a place where the guarantee may live.

## Alternatives considered

- **A generated base class with overridable methods.** This is the most common shape in other
  generators, and it is rejected: an override can call around the checks.
- **Today's flat shape, with rules in the routes.** A job or agent tool that writes without
  HTTP would bypass every rule.
- **A generated hexagonal core, or a runtime rules engine.** The first is heavier than the
  problem. The second is a proprietary runtime, which is out of scope.
- **One service per `api.operational` node.** Rejected, because versioned surfaces would
  duplicate the shells for the same business operation. A project that wants one service per
  entity or per API subclasses the generator or ejects it.
- **Named generator sets and layer settings (`classic`, `layered`, `layers.*`).** Rejected by the
  ruling of 2026-11-20: a layer is a generator, and an app chooses generators the way it already
  does. A set adds a second place to say the same thing.
- **Hooks as events (`onBeforeCreate` style) instead of bodies.** An event can observe but
  cannot decide which transition applies, so the decision would leak into an untyped place.
  Events are kept for derived CRUD as before and after hooks per verb, always generated with
  do-nothing defaults, inside the operation's transaction (§4). They may refuse or replace the
  input, but they never choose which operation runs.
- **C# partial methods.** Rejected by the design's choice of an interface-only attachment (§3).
- **JPA for Java.** Rejected: Java's data access stays on `ObjectManagerDB`.
- **A SQLAlchemy generator set for Python** (models, and functions over a `Session`). Deferred,
  not rejected: it is an estimated 13 to 22 sessions, and the ruled split of `ObjectManager`
  already gives Python data access. A small session driver that joins an `ObjectManager` to a
  `Session`'s transaction ships now.

## Amendment 1 (2026-11-20): a layer is a generator

It was ruled that layers are only code generators. This amendment replaces the original
§5, "Several generator sets in one language", which named `classic` and `layered` sets, a `sets`
field in the generator manifest and per-package set selection; it removes the `layers.*`
settings the original §2 and §4 named (`layers.service.unit`, `layers.transactions`,
`layers.crudHooks`, `layers.events`, `layers.errors`) and the storage kit; it replaces the
Java and Python data-access cells of §4 (JPA, SQLAlchemy), adds the Rust column, replaces §6's
"minimum enforcement" in the flat routes with an advisory from `verify` (the flat routes enforce nothing), and adds §7 and §8. The
four `rules.*` and `verify.*` settings of ADR-0066 stay.

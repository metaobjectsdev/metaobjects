# ADR-0064: Generated code is layered, and hand-written code attaches at the service seam

## Status

**Accepted** (2026-11-13). This ADR decides the layers a generator set emits, where the
business rules of ADR-0063 are enforced, and how hand-written code attaches. Two answers were
ruled with it:

- In every language, hand-written code attaches by implementing a generated interface and
  being passed in.
- The service is one module per metadata package, and its surface is that package's
  operations.

It amends ADR-0045 (§6). It depends on the line between core and helpers: ADR-0034
Amendment 3, as ADR-0063 §8 restates it. The core is the contracts and the conformance kits,
and every set below is a helper.

Nothing in this ADR is generated yet. The layered set, its service shells and the per-package
set selection are later work. ADR-0063's vocabulary is inert until they land.

## Context

Today's generators emit a flat shape: entity and model types, then routes or controllers that
call persistence directly. Two things break that shape:

- **There is no place for a rule to live.** ADR-0063 declares operations, permission points and
  lifecycles. Enforcing them needs code that sits between the transport and the data access.
  Every caller passes through it: an HTTP request, a background job, a queue consumer, an agent
  tool.
- **There is no seam for hand-written code that keeps a guarantee.** A hand-written body has to
  run *inside* the checks, not around them. A generated base class to override lets an
  override call around the checks. A hook that only observes cannot decide which transition
  applies.

## Decision

### 1. The layers

A generator set emits some or all of these layers. Each layer is a separate generator that
can be imported, ejected or replaced on its own.

| Layer | What it holds | Regenerated | Who owns what |
|---|---|---|---|
| 0. Names | Constants for every entity, field, table, column, enum member, state, transition, permission and error | Always | Generated. This layer is the tether: hand code that uses it stops compiling when the model renames something. Every set shares it. |
| 1. Contract types | Create, update and read shapes with their validation; operation inputs and outputs; the wire error shapes | Always | Generated. Every set in a language shares it, so two sets interoperate. |
| 2. Persistence mapping | The chosen ORM's mapping | Always | Generated, replaceable |
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
derived ones.

An `api.operational` node is a wire contract, and it may be versioned (`v1` and `v2` side by
side). The service is code. So there is one router per `api.operational` node, and every
router calls the same service.

The setting `layers.service.unit` lets a project group the service per entity or per API
instead.

### 3. How hand-written code attaches: an interface, passed in, in every language

The pattern has three steps, in every language:

1. The generator emits an interface for the bodies, the policy and the event hook.
2. The adopter writes a type that implements it, in a file the generator never touches.
3. The composition root passes that type to the generated service's constructor or factory.

Regeneration replaces the interfaces and the shells. When the model adds an operation or a
permission, the adopter's implementation stops compiling. In Python the type checker and a
start-up check say what is missing. Hand-written code cannot reach the shell's internals, so it
cannot bypass the shell's guarantees with an override.

There is no generated base class to extend, and C# does not use partial methods. A partial
class is the same class, so hand-written code would see the shell's private state and could
call around it.

### 4. Per language

| | TypeScript | C# | Java | Kotlin | Python |
|---|---|---|---|---|---|
| Names (0) | `const`s and literal unions | `static class` of `const string` | `final class` of `static final String`; enums for states | `object` of `const val`; enum class for states | module constants; `StrEnum` for states |
| Contract types (1) | Zod schemas, inferred types | `record`s with DataAnnotations | `record`s with Bean Validation | `data class`es with validation | Pydantic v2 models |
| Mapping (2) | Drizzle tables | EF Core entities and `AppDbContext` | JPA entities | Exposed `Table` objects | SQLAlchemy 2.0 models |
| Data access (3) | query functions taking `db` | none: the context is the data layer | Spring Data JPA repositories, with a generated `@Modifying @Query` per transition | Exposed repository functions | functions taking a `Session` |
| Service (4) | a function per operation; `createXService(deps)` | `sealed class XService`, constructor-injected `IXPolicy`, `IXBodies`, `IXEvents`; `services.AddX()` | `@Service` class implementing a generated `XOperations`; constructor injection of `XPolicy` and `XBodies`; `@Transactional` per operation | `class XService(db, policy, bodies, events)`; each operation in `transaction {}`; returns a sealed `OpResult` | a module per package, a function per operation taking an `OpContext`; bodies and policy as `Protocol`s |
| Transport (5) | Fastify routes | minimal-API route groups | Spring MVC controllers | Spring controllers | FastAPI router with `Depends` |

These calls are recorded here:

- **Transactions.** The service opens one transaction per operation. The setting
  `layers.transactions: "caller"` lets a project open them outside, for a job that runs several
  operations atomically. The shell then requires a transaction to be passed in.
- **Kotlin** returns a sealed result for declared business errors, and the transport maps it.
  The setting `layers.errors` switches to exceptions.
- **Java's** generated `@Service` class is not `final`, so Spring's transaction proxy works.
  It is still not meant to be extended, and its generated header says so.

### 5. Several generator sets in one language

A **set** is a named list of generators, each assigned to a layer. Today's flat generators
become the `classic` set, and the new one is `layered`. More sets can be added, by this project
or by adopters.

1. **Layers 0 and 1 are shared** by every set in a language. That is what lets a transport from
   one set call a service from another.
2. **The service interface is the seam.** A transport talks to layer 4 only through the
   generated operations interface, or `createXService` in TypeScript.
3. **One owner per output path.** The engine already refuses two generators writing one file,
   and each set writes under its own folder per package.
4. **A set is chosen per package**, in the codegen config, for example
   `sets: { "billing": "layered", "*": "classic" }`. A project that names no set keeps `classic`,
   exactly as it runs today.
5. **A set is a list, not a framework.** Ejecting a set ejects its generators. Replacing a
   layer means replacing one entry.

### 6. Where the business-rules shell sits, and the amendment to ADR-0045

The shell sits in layer 4, and only there:

- The transport parses the request and maps errors; it holds no rules.
- Data access provides the guarded update but decides nothing.
- The shell is the only caller of data access in the `layered` set. So a job, a queue consumer
  or an agent tool that calls the service gets the same checks as an HTTP request.

The `classic` set has no service layer. A project on `classic` that declares lifecycles gets
the minimum enforcement in the generated routes: the guarded update and the `state_managed`
refusal. `verify` advises that the full shell needs `layered`.

**ADR-0045 is amended.** Its decision sentence becomes: *"The outermost generated write-path
artifact an adopter deploys must guarantee every metamodel-declared write semantic, either
itself or by calling a generated service shell that does. No consumer-supplied seam may sit
between the guarantee and the wire. A hand-written operation body is called by the shell,
inside the guarantee, and is not such a seam."*

ADR-0045 rejected rewiring controllers through a lower layer, because it "would churn all
generated output". That reason does not apply here: the layered set is opt-in per package, so
no existing output churns.

## Consequences

- Each port gains a layered set, as later work, one change per language. TypeScript goes first.
- The shared generator manifest gains a `sets` field, and the codegen config gains per-package
  set selection.
- `classic` is unchanged for every project that does not opt in.
- ADR-0045's guarantee is unchanged. A semantic is still never left to a consumer-supplied seam;
  this ADR adds the generated service as a place where the guarantee may live.

## Alternatives considered

- **A generated base class with overridable methods.** This is the most common shape in other
  generators, and it is rejected: an override can call around the checks.
- **Today's flat shape, with rules in the routes.** A job or agent tool that writes without
  HTTP would bypass every rule.
- **A generated hexagonal core, or a runtime rules engine.** The first is heavier than the
  problem. The second is a proprietary runtime, which is out of scope.
- **One service per `api.operational` node.** Rejected as the default, because versioned
  surfaces would duplicate the shells for the same business operation. It is kept as a choice
  through `layers.service.unit`.
- **Hooks as events (`onBeforeCreate` style) instead of bodies.** An event can observe but
  cannot decide which transition applies, so the decision would leak into an untyped place.
  Events are kept for derived CRUD, where the shell may offer optional before and after hooks
  per verb.
- **C# partial methods.** Rejected by the attachment ruling (§3).

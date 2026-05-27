# FR-008 — Universal React/UI hookup: per-port REST route codegen + Angular 18 client + API contract conformance

- **Date:** 2026-05-26
- **Status:** Design — plan-of-record. Captures the cross-port work needed so any backend (TS / Java / Kotlin / C# / Python) can serve a universal browser-side UI client (React/TanStack today, Angular 18 added by this FR).
- **Target version:** 7.0.0 + follow-ups
- **Scope:** Five workstreams that together close the React/UI hookup gap across all language ports:
  1. **Java route codegen** — Spring `@RestController` per entity matching the cross-port URL grammar
  2. **Kotlin route codegen** — Spring-Kotlin or Ktor controller per entity (substrate decision needed)
  3. **Python route codegen** — FastAPI `APIRouter` per entity
  4. **C# route codegen refinement** — gap audit + Angular 18 client integration for ASP.NET Minimal API backends (already shipped)
  5. **Angular 18 client tier** — `client/web/packages/angular/` runtime + `server/typescript/packages/codegen-ts-angular/` codegen (universal browser client; consumes any backend via the API contract)
  6. **API contract conformance corpus** — cross-port runner that verifies every backend's emitted routes conform to the URL grammar + wire format

## 1. Background

The TS browser client (`client/web/packages/{runtime-web,react,tanstack}`) is **architecturally universal** — any backend implementing the URL grammar + wire format from [`docs/features/api-contract.md`](../../docs/features/api-contract.md) can serve it. The contract:

- `GET /api/<entity>?filter[field][op]=value&sort=field:asc&limit=N&offset=N`
- `GET /api/<entity>/:id`
- `POST /api/<entity>` / `PATCH /api/<entity>/:id` / `PUT /api/<entity>/:id` / `DELETE /api/<entity>/:id`
- 8 filter operators (eq / ne / gt / gte / lt / lte / in / like / isNull) gated by field subtype
- JSON wire format, currency as integer minor units, ISO 8601 dates, `?withCount=1` pagination envelope

**Today's state:**

| Port | Route codegen | Status |
|---|---|---|
| TypeScript | `routesFile()` → Fastify via `runtime-ts/drizzle-fastify` | ✓ shipped |
| C# | `RoutesGenerator.cs` → ASP.NET Minimal API | ✓ shipped (needs Angular-side polish) |
| Java | — | ✗ consumers hand-write Spring controllers |
| Kotlin | — | ✗ consumers hand-write Spring-Kotlin or Ktor handlers |
| Python | — | ✗ consumers hand-write FastAPI routers |

For the React client, the TS + C# backends light up end-to-end; the other three require consumers to hand-write controllers that conform.

For the Angular client, **none** of the backends ship a codegen story today — adding it is part of this FR. The Angular runtime + codegen package live under TypeScript (`client/web/packages/angular/` + `server/typescript/packages/codegen-ts-angular/`) because Angular IS TypeScript; the codegen output is consumed by any backend the same way as React.

## 2. Decomposition into 5 sub-projects

Each sub-project gets its own implementation plan; this FR is the umbrella that locks the cross-port contract + tracks the matrix.

### 2.1 Java route codegen (Spring Boot 3 / Java 21)

New module: `server/java/codegen-spring/` (mirrors `codegen-kotlin/`).

- Extends `codegen-base`'s `MultiFileDirectGeneratorBase<MetaObject>`
- One generator per concern (mirrors TS pattern):
  - `SpringControllerGenerator` — emits `<Entity>Controller.java` with `@RestController` + 5 CRUD endpoints
  - `SpringDtoGenerator` — emits `<Entity>Dto.java` records (Java 21 records) for request/response — separates wire from persistence entity
  - `SpringFilterAllowlistGenerator` — emits server-side filter allowlist per entity (mirrors TS Project D)
- Filter operators wired via Spring Data `Specification` OR raw Criteria API
- Pagination + sort via `Pageable` from Spring Data; output normalized to the wire `{ rows, total }` envelope
- Currency: minor-units `long` throughout; no conversion at the controller layer
- Targets: Spring Boot 3.x (Spring Web MVC; not Spring WebFlux — consumers can wire WebFlux separately if needed)
- New deps to scope: `metaobjects-codegen-base` + `metaobjects-omdb` (or `metaobjects-metadata` only, and route codegen is substrate-agnostic; consumer wires their own persistence — TBD design choice).

### 2.2 Kotlin route codegen — substrate decision

**Option A: Spring-Kotlin controllers.** New generator in `codegen-kotlin/` (already a Kotlin module). Emits `<Entity>Controller.kt` with `@RestController` + Kotlin extension functions. Plays nicely with existing `KotlinSpringConfigGenerator`.

**Option B: Ktor route handlers.** New generator emitting `<Entity>Routes.kt` with `Route.<Entity>Routes()` extension installing the 5 CRUD endpoints on a Ktor `Application`. More Kotlin-native; not Spring-coupled.

**Recommendation:** ship Spring-Kotlin first (the driving Kotlin consumer is Spring-based). Add Ktor as a follow-up substrate once a Ktor-stack consumer surfaces.

### 2.3 Python route codegen (FastAPI)

Extends Python's codegen module (lives at `server/python/src/metaobjects/codegen/` or similar — verify existing layout when implementation begins).

- Emits `<entity>_router.py` with FastAPI `APIRouter` + 5 CRUD endpoints
- Pydantic v2 request/response models (consumers already use Pydantic per the existing `field_types` codegen output)
- Pagination + sort via Query params; filter via the same URL grammar
- Currency: minor-units `int`; no float conversion
- Targets: FastAPI 0.110+; consumer wires `APIRouter` instances into their FastAPI `app`

### 2.4 C# route refinement + Angular 18 hookup

`MetaObjects.Codegen/Generators/RoutesGenerator.cs` already ships ASP.NET Minimal API routes for .NET 8 / C# 12. The refinement work:

- **Gap audit** vs the cross-port URL grammar — verify filter operators, pagination envelope, sort syntax all conform
- **withCount=1 envelope** support — ensure the routes return `{ rows, total }` when requested
- **PATCH vs PUT** — match the TS contract (TS supports both verbs for updates; C# should too)
- **CORS preflight** helpers in the consumer setup recipe (so an Angular dev-server on port 4200 can call an ASP.NET backend on port 5000)
- **Angular-side integration** — generated Angular services target ASP.NET Minimal API URL conventions cleanly (no special-casing needed; this is the validation that the cross-port grammar holds)

### 2.5 Angular 18 client tier (NEW universal client)

**Two new packages on the TypeScript side:**

#### `client/web/packages/angular/` — Angular 18 runtime

Mirrors `client/web/packages/react/` shape but for Angular. Universal — works with any backend that conforms to the API contract.

- **`EntityFetcherToken`** — Angular `InjectionToken` for the `EntityFetcher` function (consumer provides via `provideEntityFetcher(fetcher)`)
- **`CurrencyInputComponent`** (`<mo-currency-input>`) — standalone Angular component mirroring React's `<CurrencyInput>` for minor-units bidirectional binding
- **`EntityGridComponent`** (`<mo-entity-grid>`) — standalone component over TanStack Table Angular adapter (`@tanstack/angular-table` 8.x)
- **`CellRendererRegistry`** — Angular DI-friendly registry for cell renderer overrides per view subtype
- **`buildFilterQs`** — re-export from `runtime-web` (framework-agnostic; no Angular-specific re-implementation needed)
- **`formatCurrency` / `parseCurrency`** — re-export from `runtime-web`
- Angular 18 specifically: standalone components only (no NgModules), signals-based reactivity where idiomatic

#### `server/typescript/packages/codegen-ts-angular/` — Angular codegen

Mirrors `codegen-ts-react/` + `codegen-ts-tanstack/` pair. One package; emits both forms + service code.

- **`angularServiceFile()`** — emits `<Entity>.service.ts` per entity: `@Injectable({ providedIn: 'root' })` class wrapping the EntityFetcher with typed methods (`list`, `get(id)`, `create(dto)`, `update(id, patch)`, `delete(id)`)
- **`angularFormFile()`** — emits `<Entity>.form.component.ts` per entity: standalone form component using Angular reactive forms + the metadata-driven validators (mirrors React's `useEntityForm`)
- **`angularGridFile()`** — emits `<Entity>.grid.component.ts` per entity with `layout.dataGrid` metadata: standalone grid component pre-wired with column defs derived from metadata + TanStack Angular Table integration
- **Per-entity opt-out**: `@emitAngular: false` on an entity skips all three Angular outputs

#### Why this lives in the TS workspace, not C#

Angular IS TypeScript — the generated output is `.ts` files consumed by an Angular CLI project. The codegen package is TS that emits TS. The natural home is `server/typescript/packages/codegen-ts-angular/` (parallel to `codegen-ts-react` + `codegen-ts-tanstack`), and the runtime package is `client/web/packages/angular/` (parallel to `client/web/packages/react`).

**C# .NET 8 / C# 12 backends consume the Angular client the same way they'd consume the React client** — via the API contract. The "C# + Angular 18" combination becomes a documented recipe in `docs/recipes/csharp-angular18.md` (new) explaining the CORS + base-URL wiring, not a new codegen module under `server/csharp/`.

### 2.6 API contract conformance corpus

New shared corpus: `fixtures/api-contract-conformance/` (NEW). Goal: any backend's emitted routes should pass this corpus' assertions identically.

Fixtures shape:

```
fixtures/api-contract-conformance/<scenario-name>/
├── meta.json                   # canonical metadata for the entity under test
├── seed.json                   # seed rows
├── requests.yaml               # ordered HTTP requests (method + path + body)
└── expected.json               # per-request expected status + body shape
```

Per-port runner (one per shipped backend codegen, including TS + C# already-shipped + Java/Kotlin/Python/C#-Angular-route after FR-008.x lands):

1. Generate routes for the fixture's metadata
2. Run the generated backend (TS: Fastify; Java: Spring Boot test slice; Kotlin: same; C#: WebApplicationFactory; Python: FastAPI TestClient)
3. Execute `requests.yaml` against the running backend via HTTP
4. Assert each response matches `expected.json` (status + body, normalized for non-deterministic fields like timestamps)

Scenarios to ship Day 1 (12+):

- `list-empty` — GET /api/Author → `[]`
- `list-with-pagination` — GET /api/Author?limit=10&offset=20 → page slice
- `list-with-withcount` — GET /api/Author?limit=10&withCount=1 → `{ rows, total }`
- `filter-eq` / `filter-ne` / `filter-gt` / `filter-like` / `filter-in` / `filter-isnull` — one per operator
- `sort-asc` / `sort-desc`
- `get-by-id` / `get-by-id-not-found`
- `create-201` / `create-400-validation-error`
- `update-patch` / `update-put`
- `delete-204` / `delete-not-found`

This is the analog of `persistence-conformance/` for the API tier. Reuses the same canonical entity (`Author` / `acme::blog`) so the metadata stays shared.

## 3. Cross-port classification per `cross-language-porting`

### Tier 1 — invariant (must match cross-port)

- URL grammar (paths + verbs + filter syntax + sort syntax + pagination params)
- Wire format (JSON, currency as integer minor-units, ISO 8601 dates, withCount envelope shape)
- HTTP status codes (200 / 201 / 204 / 400 / 404)
- Filter operator vocabulary (eq / ne / gt / gte / lt / lte / in / like / isNull) + subtype gating

### Tier 2 — idiomatic per port

- Spring `@RestController` annotations vs ASP.NET `MapGet` vs Fastify `app.get` vs FastAPI `@router.get` vs Ktor `route { get { } }`
- Java `Pageable` vs FastAPI `Query` params vs Spring `@RequestParam`
- DTO/record shapes (Java records, Kotlin data classes, C# records, Pydantic models, Zod schemas)
- Error response idiom (Spring `@ControllerAdvice` vs FastAPI exception handlers vs ASP.NET ProblemDetails)
- Angular vs React component API (Angular standalone components + DI; React hooks + context)

### Tier 3 — internal / free

- Test runner choice per port
- Dev-server port conventions

## 4. Driving consumers

- **Spring-Boot/Kotlin/Exposed/Postgres consumer**: wants 2.2 (Kotlin Spring controllers)
- **C# .NET 8 + Angular 18 adopter** (new addition this FR): wants 2.4 (C# refinement) + 2.5 (Angular client) + a docs recipe
- **Future TS-only React adopter**: covered today, gets 2.5 Angular as an alternate client option
- **Future Python/FastAPI adopter**: wants 2.3
- **Future Java/Spring adopter**: wants 2.1

## 5. Out of scope

- **GraphQL** route codegen — REST only Day 1; GraphQL can be a separate FR
- **WebSocket / SSE** route codegen — REST only Day 1
- **Authentication / authorization** middleware — out of scope; consumer wires Spring Security / `[Authorize]` / FastAPI dependencies / Ktor auth around the generated routes
- **OpenAPI schema generation** — useful but separate; Spring + ASP.NET + FastAPI already emit OpenAPI natively from the generated controllers. Codifying a cross-port OpenAPI Tier 1 contract is a follow-up FR.
- **Svelte / React Native / Vue clients** — defer; the Angular addition validates that the universal client pattern scales beyond React/TanStack.

## 6. Ordering + dependencies

Each sub-project (2.1–2.6) is independently implementable. Recommended sequence based on likely consumer demand:

1. **2.5 Angular client tier** first — unblocks the C#-Angular adopter immediately (C# routes already ship). Validates the universal-client architecture.
2. **2.4 C# refinement** — small audit; lands in parallel with 2.5.
3. **2.2 Kotlin Spring controllers** — driving Kotlin consumer.
4. **2.6 API contract conformance corpus** — once 2+ ports have route codegen, the corpus has something to verify cross-port.
5. **2.1 Java Spring controllers** — when a Spring/Java consumer surfaces.
6. **2.3 Python FastAPI routes** — when a FastAPI consumer surfaces.

Each gets its own brainstorm → spec → plan → impl cycle. This FR is the umbrella spec; individual sub-project specs live at `docs/superpowers/specs/2026-XX-XX-fr-008-<sub-project>-design.md`.

## 7. Risks

1. **Angular 18 standalone-components-only is a recent default** — older Angular tutorials reference NgModules. Mitigation: codegen output uses standalone components throughout; recipe documents this explicitly.
2. **CORS + dev-server proxying** is consumer-specific — Angular dev-server on port 4200, ASP.NET on port 5000, Spring on 8080. Mitigation: per-recipe documentation; not a codegen concern.
3. **TanStack Angular Table 8.x** maturity — newer than React equivalent. Mitigation: snapshot test the Angular grid output; if TanStack Angular Table doesn't fit, fall back to AG Grid or a hand-rolled table — decision deferred to 2.5 implementation time.
4. **OpenAPI Tier 1 invariant** absence may let backends drift on response shapes — mitigation is the API contract conformance corpus (2.6).
5. **Spring controller codegen** (2.1) must not collide with consumers' existing manually-written controllers — mitigation: `@generated` headers + overwrite policy (same as Java codegen-mustache today).

## 8. Versioning + compatibility

- Target: `7.0.0+` for each sub-project as it lands
- The API contract (URL grammar + wire format) is **frozen Tier 1** — any future change requires bumping the major version and updating every port's runner in lockstep
- Generator names are Tier 1 invariants per sub-project's spec

## 9. Cross-references

- [`docs/features/api-contract.md`](../../docs/features/api-contract.md) — the cross-port REST contract this FR builds against
- [`docs/ports/typescript-client.md`](../../docs/ports/typescript-client.md) — the React/TanStack client; Angular adds a peer
- TS reference: `server/typescript/packages/codegen-ts/src/templates/routes-file.ts` + `runtime-ts/drizzle-fastify`
- C# reference: `server/csharp/MetaObjects.Codegen/Generators/RoutesGenerator.cs`
- Kotlin codegen pattern: [`docs/superpowers/specs/2026-05-25-codegen-kotlin-design.md`](2026-05-25-codegen-kotlin-design.md)
- Java codegen pattern: `server/java/codegen-base/` + `server/java/codegen-mustache/`
- Universal client architecture: CLAUDE.md "Framework integration: separate codegen and runtime packages"

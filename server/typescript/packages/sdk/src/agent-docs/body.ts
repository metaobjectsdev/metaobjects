// Agent reference docs body. Scaffolded into .metaobjects/AGENTS.md and CLAUDE.md by `meta init`.
/**
 * @deprecated The single-blob agent doc is replaced by the assembled agent-context
 * (see `@metaobjectsdev/sdk/agent-context`). Kept only for back-compat; not scaffolded by `meta init`.
 */
export const AGENT_DOCS_BODY = `# Meta Forge — agent reference

This file is scaffolded by \`meta init\` and lives alongside your \`metaobjects/\` records. It teaches AI coding assistants (Claude Code, Codex, etc.) how to read and modify MetaObjects metadata correctly. Refresh after CLI updates with \`meta init --refresh-docs\`.

## Five working principles (read first)

These shape every interaction with a metaobjects-driven project. Follow them when you author metadata, write hand-coded business logic, or review someone else's work.

### 1. If it's pattern-derivable from metadata, generate it. Never hand-write boilerplate.

The metaobjects raison d'être is that anything the metadata fully describes — schemas, FK references, basic CRUD, query helpers, Zod validators, route handlers, RHF rules, form fields — should be produced by codegen, not hand-typed. If you find yourself hand-writing something the metadata already knows about, stop and use the generated artifact.

The first version of the trainer website's database layer had hand-written Drizzle schemas, Zod schemas, and CRUD endpoints. Every one of those is now generated. The hand-written code that remains is real business logic (Stripe webhooks, Loops integration, custom auth flows) — things the generator genuinely cannot derive.

When you're about to add a new field or entity: edit \`metaobjects/*.json\` and re-run \`meta gen\`. Don't reach for the generated file directly.

### 2. Use the generated constants. Never use magic strings that touch metadata.

After \`meta gen\`, each entity file exports a rich metadata-constants block. Each non-dollar-prefixed key is a per-field object that carries everything a consumer might need (name, label, view, html input type, placeholder, RHF validation rules):

\`\`\`ts
export const Subscriber = {
  $entity: "Subscriber",            // entity name string
  $table:  "subscribers",           // SQL table name
  $path:   "/subscribers",          // REST resource path

  email: {
    name:        "email",           // field name string (use for filters, register())
    label:       "Email Address",   // humanized fallback or @label override
    view:        "text",            // MetaView subtype
    htmlType:    "email",           // optional; maps view → HTML <input type=>
    placeholder: "you@example.com", // optional; only when @placeholder is set on the view
    helpText:    "We never share this.", // optional; only when @helpText is set
    rules: {                         // optional; derived from validator children
      required:  "Email is required",
      maxLength: { value: 255, message: "Too long" },
      pattern:   { value: /.../, message: "Invalid email" },
    },
  },
  firstName: { name: "firstName", label: "First Name", view: "text", htmlType: "text", rules: { required: "First Name is required" } },
  // ...
} as const;
\`\`\`

**Use them everywhere — in both generated AND hand-written code:**

\`\`\`tsx
// ✗ Don't:
<input name="email" type="email" placeholder="Email" />

// ✓ Do:
<input
  type={Subscriber.email.htmlType}
  name={Subscriber.email.name}
  placeholder={Subscriber.email.placeholder}
  aria-label={Subscriber.email.label}
/>
\`\`\`

Rename a field in \`metaobjects/\` and re-gen — TypeScript catches every stale reference.

**Special case — Drizzle column access:** when you're already inside Drizzle's typed builder, just use the column properties directly. Drizzle's table-const types are themselves derived from metadata, so \`weeks.programId\` is already TS-safe:

\`\`\`ts
// ✓ Use Drizzle's typed accessor directly — no constants needed here:
db.select().from(weeks).where(eq(weeks.programId, X))

// ✗ Don't do this — it's redundant indirection:
db.select().from(weeks).where(eq(weeks[Week.programId.name], X))
\`\`\`

Use the constants when you need a STRING (filter object keys, registration arguments, REST paths, labels). Use Drizzle properties directly when the type system already does the work.

### 3. Forms: spread \`form.input.<field>\` from useEntityForm. One line per input.

For React forms, use \`useEntityForm\` from \`@metaobjectsdev/react\`. It returns the standard React Hook Form surface plus a pre-bound \`.input\` accessor — one entry per field, ready to spread onto an \`<input>\`:

\`\`\`tsx
import { useEntityForm } from '@metaobjectsdev/react';
import { Subscriber, SubscriberInsertSchema } from './generated/Subscriber';

const form = useEntityForm(Subscriber, SubscriberInsertSchema);

<label>{Subscriber.email.label}</label>
<input {...form.input.email} />   // ← type, placeholder, name, rules, aria-label all spread automatically
\`\`\`

For non-\`<input>\` controls (textarea, select), the \`type\` attr is omitted from \`form.input.X\` — pick the right element yourself.

The same Zod schema (\`SubscriberInsertSchema\`) validates on the server (in Fastify routes) and on the client (via the resolver). One schema, two surfaces, zero drift.

### 4. Routes: use the generated \`<Entity>.routes.ts\` for stock CRUD. Hand-write only what's custom.

\`meta gen\` emits a per-entity routes file that mounts the 5 standard verbs via \`mountCrudRoutes\` from \`@metaobjectsdev/runtime-ts/drizzle-fastify\`. The runtime is plain Drizzle + Zod — no extra ORM.

For custom flows (Stripe webhooks, side effects, auth-gated actions), hand-write the route — but import the entity constants + generated Zod schema. The boilerplate (CRUD, validation, 404 mapping, pagination) lives in the helper; your hand-written code is just the business logic.

**Auth pattern:** install a plugin-level Fastify \`preHandler\` hook at the top of your route plugin. The hook applies to every route registered after it — both hand-written handlers AND metaobjects-generated routes via the \`routeOptions\` field. Beats sprinkling \`if (!auth(...)) return;\` at the top of every handler.

### 5. Hand-coded code is always available, but coexists with generated code.

Generated code does the boilerplate. Hand-coded code does the business logic. They live in the same project, the same package, sometimes the same file. The hand-coded code consumes the generated constants and generated Zod schemas — it never duplicates schema, never hard-codes paths, never declares its own validators that metadata could declare.

Concrete pattern from the trainer website:
- Generated \`Subscriber.routes.ts\` registers GET / GET-by-id / POST / PATCH / DELETE on \`/api/subscribers\`.
- Hand-written \`apps/api/src/routes/subscribers.ts\` keeps \`POST /subscribe\` — the custom endpoint with the Loops side-effect.
- Both registered with \`fastify.register()\`. Both validate via \`SubscriberInsertSchema\`. Both use \`Subscriber.email.name\` / etc. Neither knows the other exists.

## Metaobjects metamodel — quick rules

The format used by \`metaobjects/*.json\` is **metaobjects metadata**, a cross-language standard. Eight base types:

| Type | Purpose |
|---|---|
| \`metadata\` | Root document wrapper |
| \`object\` | An entity (table/record) |
| \`field\` | A property on an object |
| \`attr\` | Named scalar/array decoration on any parent |
| \`validator\` | A validation rule |
| \`view\` | A UI control kind |
| \`identity\` | A primary/secondary key |
| \`relationship\` | An association between objects |

### Two most-violated rules

1. **Attribute uniqueness.** Within a single parent metadata node, all attribute names must be unique. You cannot have two \`attr\` children both named \`alternative\`. For multi-value, use a single \`stringarray\` attr: \`"@alternatives": ["a", "b", "c"]\`.

2. **Inline \`@<name>\` and \`attr\` child are the same thing.** \`"@maxLength": 50\` is shorthand for \`{"attr": {"name": "maxLength", "subType": "int", "value": "50"}}\`. The parser converts inline form into attr children. Don't use both forms for the same attribute name on the same parent.

### Object subtypes (v0.3)

- \`base\` — abstract template (no runtime semantics)
- \`entity\` — persistent record; should have a primary identity
- \`value\` — value-object; equality by content; must NOT have a primary identity

Java-runtime strategies (pojo / map / proxy) belong on \`@javaRuntime\`, not in \`subType\`.

### Reserved structural keys (NOT attributes)

\`name\`, \`subType\`, \`package\`, \`extends\`, \`isAbstract\`, \`children\`, \`merge\`, \`value\`.

The v0.2 keys (\`super\`, \`overlay\`, \`override\`, \`isInterface\`, \`implements\`) are **gone**. The current parser will reject them. Use:
- \`extends:\` instead of \`super:\` for the supertype reference
- \`merge: true\` instead of \`overlay: true\` / \`override: true\` for in-place modification
- \`@isAbstract: true\` instead of \`isInterface: true\` (multiple inheritance is not supported)

### Package paths and inheritance

- Package segments separated by \`::\` — \`acme::common::id\`
- Relative references in \`extends:\` — \`..::common::id\` means "go up to parent package, descend into \`common::id\`". Relative forms (\`..::\` parent-relative, leading \`::\` root-absolute) are a **YAML-authoring affordance only**; canonical JSON must be fully-qualified (a relative ref in JSON is rejected with \`ERR_RELATIVE_REF_IN_CANONICAL\`).
- Cross-file resolution works as long as all files are passed to Loader (or live in the same \`metaobjects/\` directory)

### Two special intercepted attrs (parser-routed)

- \`@isArray\` → marks a field as a collection
- \`@isAbstract\` → marks a node as abstract (inheritable but not instantiable)

## Validators — two layers

Validators can attach in two places, and they compose:

**Field-level validators** describe what makes the *stored value* valid. They survive across UI, API, batch import, manual SQL — anywhere data enters the system. The generated Zod \`<Entity>InsertSchema\` encodes these.

\`\`\`json
{"field": {"name": "email", "subType": "string",
  "children": [
    {"validator": {"subType": "required"}},
    {"validator": {"subType": "regex", "@pattern": "^[^@]+@[^@]+\\\\.[^@]+$"}}
  ]
}}
\`\`\`

**View-level validators** describe what makes user *input* valid in a specific UI surface — possibly stricter, possibly with different messages, possibly format-specific. They run client-side in generated forms. They do NOT necessarily reject the stored value if it's already in the DB.

\`\`\`json
{"field": {"name": "phone", "subType": "string",
  "children": [
    {"validator": {"subType": "regex", "@pattern": "^\\\\+?[0-9]+$"}},
    {"view": {"subType": "text-input", "@label": "Phone",
      "children": [
        {"validator": {"subType": "length", "@min": 7, "@max": 20,
          "@message": "Phone must be 7-20 digits"}}
      ]
    }}
  ]
}}
\`\`\`

Rule of thumb: rules that protect data integrity → field. Rules that improve input UX → view.

## metaobjects.config.ts — generator wiring (project root)

\`meta gen\` reads \`metaobjects.config.ts\` at the project root. This is where you declare which generators run and their options. It is TypeScript, type-checked, and imported via \`jiti\` at run time.

\`\`\`ts
import { defineConfig } from "@metaobjectsdev/cli";
import {
  entityFile, queriesFile, routesFile, /* formFile, */ barrel,
} from "@metaobjectsdev/codegen-ts/generators";

export default defineConfig({
  outDir:   "packages/database/src/generated",
  extStyle: "none",
  dbImport: "../index",
  dialect:  "sqlite",
  generators: [
    entityFile(),
    queriesFile(),
    routesFile(),
    // formFile(),  // opt-in: emits stock React forms per entity
    barrel(),
  ],
});
\`\`\`

3rd-party generator example: \`import { tanstackQuery } from "@metaobjectsdev/codegen-ts-tanstack"; // then add tanstackQuery({ ... }) to the generators array\`

Filters live on the generator entry: \`routesFile({ filter: e => e.name !== "AuditLog" })\`

\`.metaobjects/config.json\` is unchanged — it still holds static project state (schema_version, pending_in_git, confidence_thresholds). Generator wiring belongs in \`metaobjects.config.ts\` so TypeScript can type-check the imports.

## Generated hooks + grids (TanStack)

When \`tanstackQuery()\` is in your \`metaobjects.config.ts\`, every entity gets \`<Entity>.hooks.ts\` with a query-key factory + \`useEntity\`, \`useEntities\`, \`useCreate\`, \`useUpdate\`, \`useDelete\` hooks. When \`tanstackGrid()\` is in the config, entities with a \`layout[dataGrid]\` child also get \`<Entity>.columns.tsx\`.

\`\`\`tsx
import { usePrograms, useCreateProgram } from "@your-pkg/database/generated/Program.hooks";
import { programDefaultColumns, programDefaultGrid } from "@your-pkg/database/generated/Program.columns";
import { EntityGrid } from "@metaobjectsdev/tanstack";

const { data, isLoading } = usePrograms();
const create = useCreateProgram({ onSuccess: () => navigate("/programs") });

<EntityGrid
  columns={programDefaultColumns}
  grid={programDefaultGrid}
  data={data ?? []}
  isLoading={isLoading}
  onRowClick={(row) => navigate(\`/admin/programs/\${row.id}\`)}
/>
\`\`\`

**Provider setup.** Wrap your app with \`<EntityFetcherProvider value={fetcher}>\` (supplies the HTTP fetcher to all generated hooks). For an admin subtree with different auth, wrap a second time inside: \`<EntityFetcherProvider value={adminFetch}>...</EntityFetcherProvider>\` overrides the outer one.

**Metadata layer — grid definition:**

\`\`\`jsonc
{ "layout": {
    "subType": "dataGrid",
    "name": "default",
    "@pageSize": 25,
    "@defaultSortField": "createdAt",
    "@defaultSortOrder": "desc",
    "@filterable": true,
    "@columns": ["email", "firstName", "subscribed", "createdAt"]
}}
\`\`\`

The \`@columns\` attr is a flat string array listing fields to display. Per-column rendering comes from each field's own \`view\` subtype (the same one that drives forms); sortability comes from the field's \`@sortable\` attr; width belongs in app CSS. There are no nested per-column children — just \`@columns\`.

**Cell renderers.** Field rendering inside grids comes from each field's own \`view\` subtype (the same one that drives forms). Override defaults app-wide with \`<CellRendererProvider value={{ currency: ({ getValue }) => <Money value={getValue()} /> }}>\`.

**Per-entity opt-out.** \`@emitTanstack: false\` on an entity skips both hooks and columns.

## Filtering generated lists

Mark filterable fields in metadata with \`@filterable: true\`:

\`\`\`jsonc
{ "field": { "name": "email", "subType": "string", "@filterable": true } }
\`\`\`

The generated \`useSubscribers(filter)\` hook accepts a typed filter:

\`\`\`tsx
const { data } = useSubscribers({
  email: { like: "amy@%" },
  subscribed: true,
  sort: "createdAt:desc",
  limit: 25,
});
\`\`\`

URL sent: \`/subscribers?filter[email][like]=amy@%25&filter[subscribed]=true&sort=createdAt:desc&limit=25\`

**Leading wildcards are rejected by default.** The generated \`<Entity>FilterAllowlist\` ships \`leadingWildcard: false\` on every field, so a \`like\` pattern starting with \`%\` (e.g. \`"%@example.com"\`) is a 400 \`filter.leading_wildcard_disallowed\` — an unanchored LIKE defeats index usage, so it is fail-closed. To opt a field in, hand-edit that field's entry in the generated allowlist to \`leadingWildcard: true\` (hand edits inside generated files survive regeneration via the three-way merge). This gate is TypeScript-only; other ports' generated APIs do not enforce it.

**Operators by field subtype:**
- String: \`eq, ne, in, like, isNull\`
- Number/date: \`eq, ne, gt, gte, lt, lte, in, isNull\`
- Boolean: \`eq, isNull\`

Illegal combinations like \`useSubscribers({ subscribed: { gte: true } })\` fail to compile (booleans don't support \`gte\`).

**Per-grid preset filter** via layout \`@filter\`:

\`\`\`jsonc
{ "layout": { "subType": "dataGrid", "name": "active",
    "@filter": { "subscribed": true },
    "@columns": ["email", "firstName", "subscribed"] }}
\`\`\`

Generates \`subscriberActiveFilter\` const consumable in pages. Compose with ad-hoc filters via object spread.

## Projections (read models with joined/aggregated columns)

When a list needs computed columns (counts, sums, joined fields), create a **projection** — an entity that extends a base entity but reads from a SQL view:

\`\`\`json
// metaobjects/meta.commerce.json (inline with Program)
{
  "object": {
    "name": "ProgramSummary",
    "subType": "entity",
    "extends": "Program",
    "children": [
      { "source": { "subType": "rdb", "@kind": "view", "@table": "v_program_summary" } },
      { "field": { "name": "weekCount", "subType": "int", "children": [
        { "origin": { "subType": "aggregate",
            "@agg": "count", "@of": "Week.id", "@via": "Program.weeks" }}
      ]}},
      { "identity": { "subType": "primary", "name": "id", "@fields": "id" } }
    ]
  }
}
\`\`\`

\`meta gen\` produces a read-only \`useProgramSummaries(filter)\` hook, a SQL view DDL in the migration, and a read-only GET-only route.

**Aggregate vocabulary** (\`origin.aggregate @agg\`): \`count\`, \`sum\`, \`avg\`, \`min\`, \`max\`; plus \`any\`/\`all\` (a boolean predicate quantifier over a required \`@filter\` — no \`@of\`; "did any/every related row match?"), and \`collect\` (an array rollup of \`@of\` — the field must be \`isArray: true\`; \`@distinct\` dedupes, \`@orderBy\` sets element order).

**Other read-model origins**: \`origin.computed\` — a row-level value from the base row's own fields via a structured \`@expr\` tree (e.g. \`{ "op": "isNotNull", "arg": { "field": "payloadJson" } }\` → a boolean, to avoid shipping a heavy column); \`origin.first\` — the single related row picked by \`@orderBy\` along \`@via\`, projecting \`@of\` (e.g. "the latest child's status"; the field must not be \`@required\` — an empty related set yields null).

**Multi-level via paths** are supported: \`@via: "Program.weeks.workouts"\` builds a 2-level JOIN tree.

**For pages that need a full nested tree** (e.g., Program → Weeks → Workouts → Exercises), use 4 entity hooks with Project D's filter syntax for batched lookups (no projection needed — flat hooks + client-side stitching is enough):

\`\`\`tsx
const { data: weeks } = useWeeks({ programId, sort: "weekNumber:asc" });
const weekIds = weeks?.map((w) => w.id) ?? [];
const { data: workouts } = useWorkouts(
  weekIds.length ? { weekId: { in: weekIds } } : undefined,
);
\`\`\`

## Currency fields

Declare a money field with \`subType: "currency"\`:

\`\`\`json
{ "field": { "name": "priceCents", "subType": "currency", "@currency": "USD" } }
\`\`\`

Storage stays as integer minor units (cents for USD). The generated \`<Entity>\` constants block carries \`view\`, \`currency\`, \`locale\` so admin grids auto-format prices.

**Imports — use sub-paths in browser code:**

\`\`\`tsx
import { formatCurrency } from "@metaobjectsdev/runtime-web";
import { CurrencyInput } from "@metaobjectsdev/react";
\`\`\`

**Display:**

\`\`\`tsx
<span>{formatCurrency(program.priceCents)}</span>          // $15.00
<span>{formatCurrency(p.amountCents, "EUR", "de-DE")}</span>  // 15,00 €
\`\`\`

**Form input:**

\`\`\`tsx
<CurrencyInput value={priceCents} onChange={setPriceCents} currency="USD" />
\`\`\`

User types \`15.99\` → component emits \`1599\` to \`onChange\` on blur. Wire format is always integer cents.

**Locale override** via a \`view[currency]\` child:

\`\`\`json
{ "field": { "name": "priceCents", "subType": "currency", "@currency": "EUR",
    "children": [{ "view": { "subType": "currency", "@locale": "de-DE" } }]
}}
\`\`\`

Currency code lives on the field; locale lives on the view.

## Generated artifacts — what \`meta gen\` produces

After \`meta gen\`, you get one barrel + per-entity files in your configured \`outDir\` (default \`packages/database/src/generated/\`):

| File | What's in it | When to touch by hand |
|---|---|---|
| \`<Entity>.ts\` | Drizzle table, relations(), inferred types, Zod insert/update schemas, and the rich \`<Entity>\` constants block (per-field objects with name, label, view, htmlType, rules, etc.) | Never. Regenerate. |
| \`<Entity>.queries.ts\` | Typed query helpers (\`findUserById\`, \`listUsers\`, \`createUser\`, ...) using prepared statements | Never. Regenerate. |
| \`<Entity>.routes.ts\` | Fastify CRUD plugin delegating to \`mountCrudRoutes\` from \`@metaobjectsdev/runtime-ts/drizzle-fastify\` (5 verbs, Zod validation, 404/204 mapping, Drizzle-direct under the hood) | Never. Regenerate. |
| \`<Entity>.form.tsx\` | React form using \`useEntityForm\` + the entity constants. **OPT-IN at project level:** add \`formFile()\` to \`generators\` in \`metaobjects.config.ts\`. Opt out per-entity via \`@emitForm: false\`. | Never. Regenerate. |
| \`index.ts\` | Barrel re-exporting every entity file | Never. Regenerate. |

For business logic the generator doesn't cover, create a SIBLING file: \`<Entity>.extra.ts\` for query/route helpers, or any file you like in your apps directory. Import the constants from the generated \`<Entity>.ts\`.

### Stock route mounting

\`\`\`ts
import { subscriberRoutes } from "@your-pkg/database/generated/Subscriber.routes";
fastify.register(subscriberRoutes, { prefix: "/api" });
\`\`\`

That mounts: \`GET /api/subscribers\`, \`GET /api/subscribers/:id\`, \`POST /api/subscribers\`, \`PATCH /api/subscribers/:id\`, \`DELETE /api/subscribers/:id\`. Pagination via \`?limit=\` & \`?offset=\`. Validation via the generated Zod schemas. Drizzle calls under the hood.

### Mixing custom routes alongside generated

\`\`\`ts
import { db, subscribers } from "@your-pkg/database";
import { Subscriber, SubscriberInsertSchema } from "@your-pkg/database/generated/Subscriber";
import { eq } from "drizzle-orm";

fastify.post("/subscribe", async (req, reply) => {
  // Generated Zod schema validates the body — same schema the API route uses.
  const parsed = SubscriberInsertSchema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ issues: parsed.error.issues });

  // Drizzle's typed accessors are already TS-safe; no need for indirection.
  const existing = await db.select().from(subscribers).where(eq(subscribers.email, parsed.data.email)).get();
  if (existing) return reply.code(409).send({ error: "Already subscribed" });

  const [row] = await db.insert(subscribers).values(parsed.data).returning();
  // ... your business logic (analytics, Loops/Mailchimp, navigation, etc.)
  return reply.code(201).send(row);
});
\`\`\`

The fact that every metadata-derived value flows from \`Subscriber\` / \`SubscriberInsertSchema\` / the typed \`subscribers\` table is what makes rename-the-field-in-metadata-and-regen safe.

### Hand-written form using \`useEntityForm\`

\`\`\`tsx
import { useEntityForm } from '@metaobjectsdev/react';
import { Subscriber, SubscriberInsertSchema, type Subscriber as Row } from './generated/Subscriber';

export function SubscribeForm() {
  const form = useEntityForm(Subscriber, SubscriberInsertSchema);
  const { handleSubmit, formState: { errors } } = form;

  return (
    <form onSubmit={handleSubmit(/* your onSubmit */)} className="your-design-system">
      <label>{Subscriber.email.label}</label>
      <input {...form.input.email} />
      {errors.email && <span>{errors.email.message}</span>}

      <label>{Subscriber.firstName.label}</label>
      <input {...form.input.firstName} />
      {errors.firstName && <span>{errors.firstName.message}</span>}

      <button type="submit">Subscribe</button>
    </form>
  );
}
\`\`\`

Spread \`form.input.<field>\` — it carries name, type, placeholder, rules, aria-label automatically. No magic strings.

## Meta Forge additions

### \`@forge*\` attribute namespace

Provenance and confidence concerns expressed as inline attributes on any metadata child. Names use camelCase (no separator).

Most common:
- \`@forgeConfidence\` (double 0..1) — confidence the record is correct
- \`@forgeSource\` (string) — \`human\` | \`claude\` | \`ts-ast\` | \`drizzle\` | ...
- \`@forgePrimaryLocation\` (string) — file path for an entity
- \`@forgeRationale\` (string, decision only) — why this decision
- \`@forgeAlternatives\` (stringarray, decision only) — alternatives considered

Full inventory in \`packages/sdk/FORGE-METADATA.md\`.

### New top-level types

Registered by \`@metaobjectsdev/sdk\` into the TypeRegistry:

| Type | Purpose |
|---|---|
| \`decision\` | Architectural or design decision |
| \`principle\` | Design principle (advisory/enforced) |
| \`convention\` | Coding/structural convention |
| \`glossary\` | Domain-term definition |
| \`failure\` | Recorded failure mode |

These coexist with \`object\` children in the same package files. \`meta gen\` and \`meta migrate\` only consume \`object\`; the descriptive types are context for AI tooling and don't drive codegen.

## File layout

\`\`\`
metaobjects/
├── meta.common.json          shared base fields/validators (optional)
├── meta.<domain>.json        your entity packages(s)
└── _pending/<pkg>.json       proposed packages awaiting review

.metaobjects/
├── config.json               static project state
├── migrations/               written by meta migrate
└── .gen-state/               codegen merge base (gitignored)

metaobjects.config.ts         generator wiring (committed)
\`\`\`

## Worked example

\`\`\`json
{
  "metadata": {
    "package": "myapp",
    "children": [
      {
        "object": {
          "name": "User",
          "subType": "entity",
          "@forgeConfidence": 0.95,
          "@forgeSource": "human",
          "@forgePrimaryLocation": "src/db/users.schema.ts",
          "children": [
            {"field": {"name": "id", "extends": "common::id"}},
            {"field": {"name": "email", "subType": "string",
              "@column": "email_address",
              "children": [{"validator": {"subType": "required"}}]
            }},
            {"identity": {"name": "pk", "subType": "primary", "@fields": ["id"], "@generation": "increment"}}
          ]
        }
      },
      {
        "decision": {
          "name": "useTanstackQuery",
          "subType": "global",
          "@forgeConfidence": 0.9,
          "@forgeSource": "human",
          "@forgeRationale": "Real-time invalidation matters for live game state.",
          "@forgeAlternatives": ["swr", "redux-toolkit-query"]
        }
      }
    ]
  }
}
\`\`\`

## Authoring guidance

| Situation | Action |
|---|---|
| Adding a field to an existing entity | Edit the \`object\`'s \`children\`; append a \`field\` node, then \`meta gen\` |
| New entity in an existing domain | Append an \`object\` to the appropriate package file, then \`meta gen\` |
| Renaming an entity or field | Edit the metadata, regenerate; TS will surface every stale consumer of the constants |
| New REST resource | Already done — \`meta gen\` produced \`<Entity>.routes.ts\`. Just \`fastify.register(...)\` it |
| Custom business logic (Stripe webhook, side-effects, auth flows) | Hand-write a route/handler that imports the generated constants + \`om()\` |
| Architectural choice affecting how entities are built | Add a \`decision\` with \`@forgeRationale\` + \`@forgeAlternatives\` |
| Coding convention | Add a \`convention\` with \`@forgePatternDescription\` + \`@forgeAppliesTo\` |
| Domain term | Add a \`glossary\` entry with \`@forgeTerm\` + \`@forgeDefinition\` |

## Deeper references

- \`packages/metadata/METAMODEL.md\` — full metamodel reference
- \`packages/sdk/FORGE-METADATA.md\` — full \`@forge*\` inventory + MetaObjects layout details
- \`docs/strategy/2026-05-12-v0.3-ai-first-metadata-loading.md\` — current strategy (v0.3 vocab, packages, AI-first loading)
`;

#!/usr/bin/env python3
"""Write the fixed A/B task set (fixture project + one directory per task).

usage: mk_tasks.py <work-dir>     writes <work-dir>/fixture, <work-dir>/tasks, <work-dir>/tasks.txt
"""
import json, os, shutil, sys

if len(sys.argv) != 2:
    sys.exit(__doc__)
HERE = os.path.abspath(sys.argv[1])
TAIL = (
    "\n\nYou have no shell here: do not try to run commands. Write your complete answer to "
    "`ANSWER.md` in the current directory (aim for under 80 lines), then stop."
)


def w(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(text)


# ── the fixture project every task starts from ───────────────────────────────
MODEL = {
    "metadata.root": {
        "package": "acme::shop",
        "children": [
            {"object.entity": {"name": "Customer", "children": [
                {"source.rdb": {"@table": "customers"}},
                {"field.uuid": {"name": "id"}},
                {"field.string": {"name": "email", "@required": True, "@maxLength": 320}},
                {"field.string": {"name": "name", "@required": True, "@maxLength": 200}},
                {"field.timestamp": {"name": "createdAt", "@autoSet": "onCreate"}},
                {"identity.primary": {"name": "id", "@fields": ["id"]}},
                {"identity.secondary": {"name": "customerByEmail", "@fields": ["email"]}},
            ]}},
            {"object.entity": {"name": "Product", "children": [
                {"source.rdb": {"@table": "products"}},
                {"field.uuid": {"name": "id"}},
                {"field.string": {"name": "name", "@required": True, "@maxLength": 200}},
                {"field.currency": {"name": "priceCents", "@currency": "USD", "@required": True}},
                {"identity.primary": {"name": "id", "@fields": ["id"]}},
            ]}},
            {"object.entity": {"name": "Order", "children": [
                {"source.rdb": {"@table": "orders"}},
                {"field.uuid": {"name": "id"}},
                {"field.uuid": {"name": "customerId", "@required": True}},
                {"field.enum": {"name": "status", "@required": True,
                                "@values": ["PENDING", "PAID", "SHIPPED", "CANCELLED"]}},
                {"field.string": {"name": "callPurpose", "@column": "purpose_code", "@maxLength": 40}},
                {"field.timestamp": {"name": "createdAt", "@autoSet": "onCreate"}},
                {"identity.primary": {"name": "id", "@fields": ["id"]}},
                {"identity.reference": {"name": "fkOrderCustomer", "@fields": ["customerId"],
                                        "@references": "Customer"}},
                {"relationship.association": {"name": "customer", "@objectRef": "Customer",
                                              "@cardinality": "one"}},
            ]}},
        ],
    }
}

shutil.rmtree(os.path.join(HERE, "fixture"), ignore_errors=True)
shutil.rmtree(os.path.join(HERE, "tasks"), ignore_errors=True)
w(os.path.join(HERE, "fixture/metaobjects/meta.shop.json"), json.dumps(MODEL, indent=2) + "\n")
w(os.path.join(HERE, "fixture/.metaobjects/config.json"), '{ "sources": [] }\n')
w(os.path.join(HERE, "fixture/metaobjects.config.ts"),
  'import { defineConfig } from "@metaobjectsdev/cli";\n\n'
  'export default defineConfig({\n  apiPrefix: "/api",\n  generators: [],\n});\n')

TASKS = []


def task(tid, skill, prompt, stack="ts-react-tanstack", files=None):
    TASKS.append(tid)
    d = os.path.join(HERE, "tasks", tid)
    w(os.path.join(d, "prompt.md"), f"Load the `{skill}` skill before answering.\n\n{prompt.strip()}{TAIL}\n")
    w(os.path.join(d, "stack"), stack)
    w(os.path.join(d, "skill"), skill)
    for rel, text in (files or {}).items():
        w(os.path.join(d, "files", rel), text)


# ── authoring ────────────────────────────────────────────────────────────────
task("authoring-1-new-entity", "metaobjects-authoring", """
Add a `Review` entity to `metaobjects/meta.shop.json`. Give me just the new `object.entity`
node, as canonical JSON. Requirements:

- UUID primary key; table `reviews`.
- `rating`, an integer.
- `body`, optional free text.
- `status`: one of PENDING / APPROVED / REJECTED. `rejectReason` must be present when the
  status is REJECTED.
- `amountPaid`: the price the customer paid, in US dollars.
- `createdAt`, stamped automatically on insert.
- `productUrl`, a link to the product page.
- `tags`, a list of strings.
- It belongs to a Product: deleting the product deletes its reviews.
- It records the Customer who wrote it: deleting a customer who has reviews must be refused.
""")

task("authoring-2-adoption", "metaobjects-authoring", """
We are adopting MetaObjects onto an existing Postgres database. The table and the code below
are in production and must not change. Write the metadata (canonical JSON) for it so that
`meta verify --db` reports no drift and the generated types match what the code already uses.

```sql
CREATE TABLE user_settings (
  settings_id   uuid PRIMARY KEY,
  user_ref      uuid NOT NULL REFERENCES customers(id),
  display_nm    varchar(80) NOT NULL,
  notif_prefs   jsonb NOT NULL,
  favorite_skus text[] NOT NULL,
  raw_import    jsonb,
  updated_at    timestamptz NOT NULL
);
```

```ts
type NotifPref = { channel: "email" | "sms"; enabled: boolean };

async function saveSettings(db: Db, s: {
  settingsId: string;
  userRef: string;
  displayName: string;
  notifPrefs: Record<string, NotifPref>;   // keyed by event name
  favoriteSkus: string[];
  rawImport: unknown;                       // whatever the legacy importer sent, stored verbatim
}) { /* ... */ }
```
""")

task("authoring-3-yaml", "metaobjects-authoring", """
Write this as a sigil-free YAML metadata file, `metaobjects/meta.flags.yaml`, package
`acme::flags`. Entity `FeatureFlag`, table `feature_flags`:

- `id`: long, auto-increment primary key.
- `key`: required string, at most 64 characters, unique.
- `enabled`: a yes/no flag stored as an enum whose members are Y and N.
- `rollout`: an enum whose members are on, off and canary.
- `launchDate`: a calendar date.
- `allowedPlanIds`: an array of longs.
- `notes`: must always be provided, but may be an empty string.
""")

# ── codegen ──────────────────────────────────────────────────────────────────
task("codegen-1-standing-rule", "metaobjects-codegen", """
Our team has a standing rule: never modify MetaObjects itself. The generated Fastify route
files export functions named like `registerCustomerRoutes`, but our house style needs
`mountCustomer`, and the route files must land in `src/http/`, not `src/generated/`. My plan
is to rename things by hand in the generated files after each `meta gen`, or just write the
routes by hand. What should I do instead? Give me the concrete steps.
""", files={"metaobjects.config.ts":
    'import { defineConfig } from "@metaobjectsdev/cli";\n'
    'import { entityFile, queriesFile, routesFile, barrel } from "@metaobjectsdev/codegen-ts/generators";\n\n'
    'export default defineConfig({\n  apiPrefix: "/api",\n'
    '  generators: [entityFile(), queriesFile(), routesFile(), barrel()],\n});\n'})

task("codegen-2-nothing-generated", "metaobjects-codegen", """
Fresh project: I ran `meta init`, wrote the model in `metaobjects/`, ran `meta gen`, and got no
files at all. I want Drizzle/Zod entity code, a Fastify REST API, and React forms plus TanStack
grids for Customer and Order. Is something broken? What exactly do I do, in order?
""")

task("codegen-3-write-generator", "metaobjects-codegen", """
Write a TypeScript generator for this project that emits one Markdown data-dictionary file per
entity at `docs/data/<Entity>.md`: a table of every field the entity has (including fields it
inherits from an abstract base such as `BaseEntity`), with the field's subtype, whether it is
an array, and whether it is required. Abstract bases themselves get no file. Show the generator
source, how it is registered, and how I check in CI that the files stay current.
""")

task("codegen-4-refused-write", "metaobjects-codegen", """
CI is red: `meta gen` exited 1 saying it refused to write `src/generated/Order.ts`. A teammate
added a `get isOverdue()` helper directly to that file last week.

(a) Why did gen refuse instead of overwriting?
(b) What is the right fix for the helper?
(c) We also generate `*.names.ts` files that nobody should ever edit. Can gen just overwrite
    those when someone does?
(d) A colleague says "delete the `@generated` header line and the tool will leave the file
    alone from then on". True?
""")

# ── verify ───────────────────────────────────────────────────────────────────
task("verify-1-retired-vocab-java", "metaobjects-verify", """
This is a Java/Spring project. After bumping MetaObjects, `mvn metaobjects:verify` fails
immediately with `ERR_UNKNOWN_ATTR` on `@readOnly` and never reaches any drift check. A teammate
suggests adding a compatibility flag or loosening strict mode. What is actually going on, and
what do I run?
""", stack="java-react")

task("verify-2-python-schema-change", "metaobjects-verify", """
Python/FastAPI service on Postgres, using MetaObjects. I need to add a nullable `shippingNotes`
text column to `Order`, and I want CI to fail if the database schema or the generated code ever
drifts from the metadata. Which commands do I run, with which tool, in what order? For dev I
was going to `ALTER TABLE` in psql to save time.
""", stack="python")

task("verify-3-hand-edit-passes", "metaobjects-verify", """
Someone loosened a generated Zod validator by hand (changed `.max(200)` to `.max(5000)` inside
a `@generated` file), and `meta verify --codegen` still exits 0 in CI. Is the gate broken? How
do I make this fail the build, how do I see exactly what was edited, and what is the correct way
to make that change if we do want it?
""")

task("verify-4-uuid-and-psql", "metaobjects-verify", """
Two questions.

1. Our ids are modeled as `field.string` with `@dbColumnType: uuid`, and `meta verify --db`
   passes. So that is fine, right?
2. A teammate ran `ALTER TABLE orders ADD COLUMN gift boolean` in psql to try something. Now
   `meta migrate` fails with "column gift already exists" when we add the field properly. How
   do we get out of this, and how do we stop it happening again?
""")

# ── runtime + web client ─────────────────────────────────────────────────────
task("runtime-ui-1-urls", "metaobjects-runtime-ui", """
`apiPrefix` is `/api`. Give me the exact collection URL the generated routes serve for each of:
entity `PostCategory`, entity `Day`, entity `Address`, entity `HTTPServer`, projection
`OrderSummary`.

Then write the full request URL that lists post categories whose `name` contains "foo" and
whose `rank` is at least 3, newest first by `createdAt`, 20 per page, the second page, with the
total count. Say what the response body looks like.

Finally: what does a GET by id return when the row does not exist, and how is a
`field.currency` value encoded in a response?
""")

task("runtime-ui-2-physical-names", "metaobjects-runtime-ui", """
In a hand-written TypeScript repository module I need a raw SQL report query that counts orders
per call purpose. The entity `Order` has a field `callPurpose`, so I assume the column is
`call_purpose` in table `orders`. Write the query code for `src/reports/orders-by-purpose.ts`.
""")

task("runtime-ui-3-client-wiring", "metaobjects-runtime-ui", """
React + TanStack client against the generated API (the server mounts under `/api`). Three
problems:

1. I wired the grid generator and ran gen. There are hooks for `Customer` but no grid files.
2. Every generated hook 404s: requests go to `/customers` instead of `/api/customers`.
3. `priceCents` renders as `1999`.

Fix all three, and show the provider setup at the app root.
""")

# ── prompts ──────────────────────────────────────────────────────────────────
PROMPTS_META = json.dumps({"metadata.root": {"package": "acme::support", "children": [
    {"object.value": {"name": "WelcomePayload", "children": [
        {"field.string": {"name": "displayName"}}]}},
    {"template.prompt": {"name": "WelcomePrompt", "@payloadRef": "WelcomePayload",
                         "@textRef": "support/welcome"}},
]}}, indent=2) + "\n"
SUMMARIZE = '''import type { Llm } from "../llm";

export async function summarizeTicket(
  llm: Llm,
  t: { customerName: string; subject: string; messages: { from: string; text: string }[] },
) {
  let prompt = `You are a support assistant.\\nCustomer: ${t.customerName}\\nSubject: ${t.subject}\\n`;
  for (const m of t.messages) prompt += `- ${m.from}: ${m.text}\\n`;
  prompt += `Reply with JSON: {"urgency": "low|medium|high", "summary": "..."}`;
  const reply = await llm.complete(prompt);
  const urgency = /"urgency"\\s*:\\s*"(\\w+)"/.exec(reply)?.[1] ?? "low";
  const summary = /"summary"\\s*:\\s*"([^"]*)"/.exec(reply)?.[1] ?? "";
  return { urgency, summary };
}
'''
task("prompts-1-migrate-first", "metaobjects-prompts", """
In `src/support/summarize.ts`, add an instruction telling the model to answer in the customer's
language. Show me what you would change.
""", files={"src/support/summarize.ts": SUMMARIZE,
            "metaobjects/meta.support.json": PROMPTS_META,
            "prompts/support/welcome.mustache": "Welcome, {{displayName}}!\n"})

task("prompts-2-declare-and-parse", "metaobjects-prompts", """
Declare the metadata for a new LLM prompt, `ChurnRiskPrompt`. Its inputs are the customer's
name, their plan name, and a list of their last orders (each with a title and a total in
cents). The prompt body is plain text. The model must answer with a JSON object: `risk` (one of
low / medium / high) and `reasons` (a list of strings).

Show the metadata JSON and the template text file, and tell me which generated parser to call
on the raw chat-completion reply, and why.
""", files={"metaobjects/meta.support.json": PROMPTS_META,
            "prompts/support/welcome.mustache": "Welcome, {{displayName}}!\n"})

task("prompts-3-variants-and-email", "metaobjects-prompts", """
Our `RenewalPrompt` needs different wording per plan tier: premium users get a paragraph about
priority support that free users never see, and the word for the plan is "membership" for
premium and "account" for free. My plan is an `if (tier === "premium")` in the service that
concatenates the right paragraphs.

Separately, we want to send a renewal email (subject plus HTML body) rendered from a template.

Sketch the right design for both.
""", files={"metaobjects/meta.support.json": PROMPTS_META,
            "prompts/support/welcome.mustache": "Welcome, {{displayName}}!\n"})

# ── audit ────────────────────────────────────────────────────────────────────
task("audit-1-owned-generators", "metaobjects-audit", """
You are partway through a MetaObjects adoption audit (Phase 0 triage) of a TypeScript project
on `@metaobjectsdev/*` 1.2.3. `meta eject --list --format text` printed the rows below, and the
config also imports `tanstackQuery` from its package.

```
entity       codegen/generators/entity.ts     identical to the reference
  runtime    codegen/runtime/zod-adapter.ts   DIFFERS, 9 line(s) of your own
queries      codegen/generators/queries.ts    identical to the reference
routes       codegen/generators/routes.ts     DIFFERS, 41 line(s) behind, 0 line(s) of your own
barrel       codegen/generators/barrel.ts     same content as the reference, your formatting
form         codegen/generators/form.ts       DIFFERS, 12 line(s) behind, 37 line(s) of your own
```

Write the owned-generators part of the triage: what each row tells you, what you still have to
check before reporting it, and the finding or findings (with their ids) you would raise.
""")

task("audit-2-classify", "metaobjects-audit", """
As part of a MetaObjects adoption audit, review the five files under `src/` against the model
in `metaobjects/meta.shop.json`. Classify each surface, then write the two highest-priority
findings as JSON objects in the `adoption-audit.json` finding shape. Do not change any code.
""", files={
    "src/routes/customers.ts": '''import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { customers } from "../generated/Customer";
import { customerInput } from "../validation/customer";

export function customerRoutes(app: FastifyInstance, db: Db) {
  app.get("/api/customers", async () => db.select().from(customers));
  app.get("/api/customers/:id", async (req, reply) => {
    const [row] = await db.select().from(customers).where(eq(customers.id, (req.params as { id: string }).id));
    return row ?? reply.code(404).send({ error: "not_found" });
  });
  app.post("/api/customers", async (req, reply) => {
    const body = customerInput.parse(req.body);
    const [row] = await db.insert(customers).values(body).returning();
    return reply.code(201).send(row);
  });
}
''',
    "src/validation/customer.ts": '''import { z } from "zod";

// keep in sync with the customers table
export const customerInput = z.object({
  email: z.string().email().max(320),
  name: z.string().min(1).max(100),
});
''',
    "src/reports/org-tree.ts": '''import { sql } from "drizzle-orm";

export const orgTree = (db: Db, rootId: string) => db.execute(sql`
  WITH RECURSIVE tree AS (
    SELECT id, parent_id, 0 AS depth FROM org_units WHERE id = ${rootId}
    UNION ALL
    SELECT o.id, o.parent_id, t.depth + 1 FROM org_units o JOIN tree t ON o.parent_id = t.id
  )
  SELECT * FROM tree ORDER BY depth`);
''',
    "src/ui/CustomerTable.tsx": '''import { CustomerFields } from "../generated/Customer.meta";

export function CustomerTable({ rows }: { rows: Record<string, unknown>[] }) {
  const columns = Object.values(CustomerFields).filter((f) => f.sortable);
  return (
    <table>
      <thead><tr>{columns.map((c) => <th key={c.name}>{c.label}</th>)}</tr></thead>
      <tbody>{rows.map((r, i) => <tr key={i}>{columns.map((c) => <td key={c.name}>{String(r[c.name])}</td>)}</tr>)}</tbody>
    </table>
  );
}
''',
    "src/routes/demo.ts": '''import type { FastifyInstance } from "fastify";

export function demoRoutes(app: FastifyInstance) {
  app.get("/api/featured", async () => [
    { id: "p1", name: "Sample widget", priceCents: 1999 },
    { id: "p2", name: "Sample gadget", priceCents: 4999 },
  ]);
}
''',
})

task("audit-3-gate-and-versions", "metaobjects-audit", """
For an adoption-audit scorecard. What the repository shows:

- The only CI workflow, `.github/workflows/ci.yml`, runs `npx meta verify --codegen || true`.
- Deploys run from a separate `release.yml` that never calls verify.
- One developer has a pre-commit hook in their local `.git/hooks/` that runs verify; nothing
  in the repository installs it.
- `package.json` resolves `@metaobjectsdev/*` at 1.2.3. The Java backend's `pom.xml` has
  `com.metaobjects:*` at 8.1.0.

Write the "Binary CI drift gate" line of the scorecard, and the cross-language
version-consistency finding.
""")

# ── fit assessment (pre-adoption) ────────────────────────────────────────────
FIT_HEAD = (
    "Run the quick pass of the MetaObjects fit assessment. You cannot browse the target "
    "repository; the facts below are everything it shows. Treat them as your evidence and cite "
    "them as given.\n\n"
)
task("fit-1-small-single-app", "metaobjects-fit-assessment", FIT_HEAD + """
- One Next.js app (TypeScript), Prisma on Postgres, deployed as a single service.
- `prisma/schema.prisma`: 4 models (User, Post, Comment, Tag).
- `lib/validation.ts`: hand-written Zod schemas restating the same four shapes.
- Commit `a1b2c3d`: "fix: zod schema out of sync with prisma Post.title length".
- No other service, client, SDK or package consumes any of these shapes.
- No LLM calls anywhere.
- One developer. Nobody is available to answer questions about future plans.
""")

task("fit-2-multi-service-estate", "metaobjects-fit-assessment", FIT_HEAD + """
- Monorepo. `web/`: TypeScript + React. `api/`: Go with sqlc on Postgres. `billing/`: Python,
  FastAPI + Pydantic.
- `packages/shared-types/index.ts`: TypeScript types for the API's responses, copied by hand
  from the Go structs in `api/internal/model/*.go`.
- `billing/events/models.py`: hand-written Pydantic models mirroring the Go event structs that
  `api` publishes on NATS (`api/internal/events/invoice.go`).
- Commit `9f8e7d6`: "fix(web): Invoice.total renamed in api, update shared-types".
- Commit `4c3b2a1`: "billing: event payload mismatch, add missing field".
- No OpenAPI document, no protobuf, no schema registry, no contract tests.
- The team says the system is growing and a mobile client (TypeScript, React Native) starts
  next quarter.
""")

task("fit-3-large-finished-app", "metaobjects-fit-assessment", FIT_HEAD + """
- One large Java/Spring application, Hibernate (JPA) on MySQL 8, 140 `@Entity` classes.
- Server-rendered Thymeleaf pages. No JSON API consumed by any other program.
- No LLM calls. No second service, no shared library consumed elsewhere.
- Flyway migrations, 310 of them; no drift incidents found in `git log`.
- The team lead says: "It is feature-complete and in maintenance mode."
""")

w(os.path.join(HERE, "tasks.txt"), "\n".join(TASKS) + "\n")
print(f"{len(TASKS)} tasks")

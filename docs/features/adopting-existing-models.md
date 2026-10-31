# Adopting existing models

> The sections from "The recipe" on are shipped verbatim in the `metaobjects-authoring` skill as
> `references/adopting-existing-models.md`; change them here and copy them there (a test compares
> the two).

You have Zod schemas, Drizzle tables or Pydantic models in a working project, and you want the
MetaObjects model to own them. You do not need a rewrite. You write the model from the types you
already have, generate beside them, prove the two match, and move call sites one at a time. The
old code keeps working until the last one has moved.

**MetaObjects never reads your source.** You, or your agent, read the existing types and write the
model. The comparison belongs to your language's own tools: `tsc` for TypeScript, Pydantic's
`model_json_schema()` for Python, and a test file you delete at the end. There is no import command
and no special `verify` mode.

Three small projects run this recipe end to end, each with deliberate mismatches that must fail:

| Project | Moves | Gate |
|---|---|---|
| [`examples/brownfield/drizzle`](../../examples/brownfield/drizzle) | Drizzle tables, and a real Postgres built by [`db/schema.sql`](../../examples/brownfield/drizzle/db/schema.sql) | `server/typescript/packages/cli/test/integration/brownfield-recipe.test.ts` |
| [`examples/brownfield/zod`](../../examples/brownfield/zod) | Zod request schemas | the same file |
| [`examples/brownfield/pydantic`](../../examples/brownfield/pydantic) | Pydantic models | `server/python/tests/codegen/test_brownfield_recipe.py` |

## The recipe

1. **Write the model from the existing types.** Read the types and model what they are, not what
   you would design fresh. `references/adopting-existing-code.md` in the `metaobjects-authoring`
   skill has the rules.
2. **Generate beside them.** Send the output to a new directory. Nothing imports it yet.
3. **Write the proof.** It is one test file that names each pair of types.
4. **See it fail once.** Break one field in the model, regenerate, and check that the proof names
   that field. Then undo it.
5. **Fix the differences in the model,** not in the existing code, until the proof passes.
6. **Check the database,** if the project has one.
7. **Move one call site at a time.** Run the proof and the project's tests after each move.
8. **Retire the old code,** delete the proof, and keep `meta verify` in CI.

Step 4 is not optional. A proof that cannot fail looks the same as one that passes. If the proof
stays green with a field broken, its file is outside `include` in `tsconfig.json`, or `strict` is
off, or pytest never collected it.

### Drizzle

Install the CLI with `npm i -D @metaobjectsdev/cli @metaobjectsdev/codegen-ts typescript`, then run
`npx meta init` once in the project root.

Write the model. Field names are the TypeScript property names. `snake_case` is the default for
columns, so `displayName` already means `display_name`. Reuse the names the database has: the name
of a `.unique()` index goes on `identity.secondary`, and an existing foreign key name goes in
`constraintName`.

```yaml
metadata:
  package: shop
  children:
    - object.entity:
        name: Customer
        children:
          - source.rdb: { table: customers }
          - field.uuid: { name: id, required: true }
          - field.string: { name: email, required: true, maxLength: 254 }
          - field.string: { name: displayName, required: true, maxLength: 120 }
          - field.int: { name: loyaltyPoints, required: true, default: 0 }
          - field.string: { name: notes }
          - field.timestamp: { name: createdAt, required: true, default: now(), mutability: readOnly }
          - identity.primary: { fields: id, generation: uuid }
          - identity.secondary: { name: customers_email_unique, fields: email }
```

Generate beside the existing schema:

```ts
// metaobjects.config.ts
import { defineConfig } from "@metaobjectsdev/cli";

export default defineConfig({
  outDir: "src/generated", // beside the existing code; nothing imports it yet
  dialect: "postgres",
  timestampMode: "date", // when the existing timestamp columns read as Date
  generators: ["entity"],
});
```

Run `npx meta gen` to generate.

Copy this helper into `proof/differs.ts`:

```ts
// Names every field that differs between two object types, or `never` when they match.
//
// Mutual assignability alone is not enough. A field that is optional and present on only one
// side passes both ways, and `any` is assignable to and from everything, so this compares
// key by key and treats `any` on one side as a difference. Pick<> keeps each field's optional
// modifier. It looks one level down: give a nested type its own line in equivalence.ts.
type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type IsAny<T> = 0 extends 1 & T ? true : false;

export type Differs<A, B> = {
  [K in keyof A | keyof B]: K extends keyof A & keyof B
    ? [IsAny<A[K]>] extends [IsAny<B[K]>]
      ? Mutual<Pick<A, K>, Pick<B, K>> extends true
        ? never
        : K
      : K
    : K;
}[keyof A | keyof B];

// tsc reports each differing field as: Type '"name"' does not satisfy the constraint 'never'.
export type Same<_NoDifferences extends never> = true;
```

Then name each pair in `proof/equivalence.ts`, inside `include` in `tsconfig.json`, with `strict`
on. Compare what a query reads and what an insert takes:

```ts
import type { Customer, NewCustomer } from "../src/db/schema.js";
import type { Customer as GeneratedCustomer, CustomerInsert } from "../src/generated/Customer.js";
import type { Differs, Same } from "./differs.js";

export type Proof = [
  Same<Differs<Customer, GeneratedCustomer>>,
  Same<Differs<NewCustomer, CustomerInsert>>,
];
```

`npx tsc --noEmit` is the check.

Types do not include column names, so `tsc` passes even with a wrong column. `meta verify --db` is
the check for those (it needs `pg` installed):

```sh
npx meta verify --codegen --db "$DATABASE_URL"
```

`--db` runs only the database check unless you name the others, so keep `--codegen` beside it.

Two Drizzle objects for one table can exist side by side, since each only describes SQL. Move a
call site by changing its import, with an alias where the generated name differs:

```ts
import { type Customer, customers, type CustomerInsert as NewCustomer } from "./generated/Customer.js";
```

When the last one has moved, replace the old table definitions with re-exports and delete
`proof/`:

```ts
export { customers } from "../generated/Customer.js";
export { orders } from "../generated/Order.js";
```

Keep one migration tool per database. To stay on drizzle-kit, point it at this file. To move to
`meta migrate`, adopt the live schema with `meta migrate baseline --from-db`.

### Zod

Install the CLI with `npm i -D @metaobjectsdev/cli @metaobjectsdev/codegen-ts typescript`, then run
`npx meta init` once in the project root.

A Zod project often has no ORM, so generate a contract-only target. An object with no table is an
`object.value`:

```ts
// metaobjects.config.ts
import { defineConfig } from "@metaobjectsdev/cli";
import { entityFile } from "@metaobjectsdev/codegen-ts/generators";

export default defineConfig({
  outDir: "src/generated",
  dialect: "postgres",
  targets: {
    contract: { outDir: "src/generated", runtime: false }, // Zod schemas and types, no ORM
  },
  generators: [entityFile({ target: "contract" })],
});
```

```yaml
metadata:
  package: api
  children:
    - object.value:
        name: CreateCustomer
        children:
          - field.string: { name: email, required: true, maxLength: 254 }
          - field.int: { name: seats }
          - field.string[]: { name: tags, required: true }
```

Run `npx meta gen` to generate. The schema for `CreateCustomer` is `CreateCustomerInsertSchema`. The generated `CreateCustomer` is
the type. Use the same `proof/differs.ts` as above, and compare both `z.input` and `z.output`,
because a default or a transform changes one without the other:

```ts
import type { z } from "zod";
import type { CreateCustomer } from "../src/api/schemas.js";
import type { CreateCustomerInsertSchema } from "../src/generated/CreateCustomer.js";
import type { Differs, Same } from "./differs.js";

export type Proof = [
  Same<Differs<z.input<typeof CreateCustomer>, z.input<typeof CreateCustomerInsertSchema>>>,
  Same<Differs<z.output<typeof CreateCustomer>, z.output<typeof CreateCustomerInsertSchema>>>,
];
```

`tsc` cannot see `.min()`, `.max()` or `.email()`, because they do not change the type. Zod can
describe them, so add `proof/rules.ts` and run it with your test runner, or with node or bun:

```ts
import assert from "node:assert/strict";
import { z } from "zod";
import { CreateCustomer } from "../src/api/schemas.js";
import { CreateCustomerInsertSchema } from "../src/generated/CreateCustomer.js";

// `required` follows the order of the fields, which does not change what a schema accepts.
const rules = (schema: z.ZodType, io: "input" | "output") =>
  JSON.parse(
    JSON.stringify(z.toJSONSchema(schema, { io, unrepresentable: "any" }), (key, value) =>
      key === "required" && Array.isArray(value) ? [...value].sort() : value,
    ),
  );

for (const io of ["input", "output"] as const) {
  assert.deepEqual(rules(CreateCustomer, io), rules(CreateCustomerInsertSchema, io));
}
```

`z.toJSONSchema` is Zod 4. On Zod 3, sort and compare `zodToJsonSchema(schema)` from the
`zod-to-json-schema` package instead.

A required string generates `.min(1)`, so a hand-written `z.string()` with no minimum shows up here
as a `minLength` difference. If the existing schema really accepts an empty string, say so in the
model with `validator.length: { min: 0 }` as a child of the field.

Move a call site by swapping the import and the schema name:

```ts
import { type CreateCustomer, CreateCustomerInsertSchema } from "./generated/CreateCustomer.js";

export function parseSignup(body: unknown): CreateCustomer {
  return CreateCustomerInsertSchema.parse(body);
}
```

### Pydantic

Install with `pip install metaobjects "pydantic>=2.8"`.

The model's field name is the Pydantic attribute, so keep `snake_case` names in the model. A shared
`str` Enum is an abstract `field.enum` that each field `extends`. An enum declared inline on the
field generates a `Literal` instead.

```yaml
metadata:
  package: shop
  children:
    - field.enum:
        name: OrderStatus
        abstract: true
        values: [pending, paid, shipped]
    - object.entity:
        name: Order
        children:
          - source.rdb: { table: orders }
          - field.long: { name: id, required: true }
          - field.enum: { name: status, extends: OrderStatus, required: true, default: pending }
          - field.string[]: { name: tags, required: true, default: "{}" }
          - field.date: { name: placed_on, required: true }
          - identity.primary: { fields: id, generation: increment }
```

Generate beside the existing models:

```yaml
# metaobjects.config.yaml
metadata: metaobjects
targets:
  app:
    outDir: generated # beside the existing code; nothing imports it yet
    generators: [entity]
```

Run `metaobjects gen` from the project root to generate.

mypy cannot compare two Pydantic models, because a class is its own type, whatever its fields are.
Pydantic can describe a model as JSON Schema, so compare those. Pydantic validates input and writes
output differently, so check both modes. Copy this into `proof/test_equivalence.py` and name each
pair:

```python
from typing import Any

import pytest
from pydantic import BaseModel

import app.models as existing
from generated import Customer, Order, ShippingAddress


def shape(model: type[BaseModel], mode: str) -> dict[str, Any]:
    """The schema with what does not change behaviour removed: titles and descriptions, the
    order of `required`, and `$ref`, which is inlined so a `str` Enum matches a Literal."""
    schema = model.model_json_schema(mode=mode)
    defs = schema.pop("$defs", {})

    def walk(node: Any, seen: tuple[str, ...] = ()) -> Any:
        if isinstance(node, list):
            return [walk(item, seen) for item in node]
        if not isinstance(node, dict):
            return node
        if "$ref" in node:
            name = node["$ref"].rsplit("/", 1)[-1]
            if name in seen:  # a model that contains itself
                return {"$recursive": name}
            rest = {key: value for key, value in node.items() if key != "$ref"}
            return walk({**defs[name], **rest}, (*seen, name))
        out: dict[str, Any] = {}
        for key, value in node.items():
            if key in ("title", "description"):
                continue
            if key == "properties":
                out[key] = {field: walk(prop, seen) for field, prop in value.items()}
            elif key == "required":
                out[key] = sorted(value)
            elif key == "default":
                out[key] = value
            else:
                out[key] = walk(value, seen)
        return out

    return walk(schema)


@pytest.mark.parametrize("mode", ["validation", "serialization"])
@pytest.mark.parametrize(
    ("hand_written", "generated"),
    [
        (existing.Customer, Customer.Customer),
        (existing.CustomerCreate, Customer.CustomerCreate),
        (existing.ShippingAddress, ShippingAddress.ShippingAddress),
        (existing.Order, Order.Order),
    ],
)
def test_same_shape(hand_written: type[BaseModel], generated: type[BaseModel], mode: str) -> None:
    assert shape(hand_written, mode) == shape(generated, mode)
```

Run `python -m pytest proof/ -vv` from the project root. `-vv` prints the whole difference, with
the field name in it. Schemas carry field constraints such as `max_length`, so this also catches a
rule the Python type does not show.

Move a call site by changing its import:

```python
from generated.Customer import Customer, CustomerCreate
```

Move models that nest together. Pydantic refuses an instance of a different class even when the
shape matches, so a generated `ShippingAddress` passed to the hand-written `Order` raises a
`ValidationError`. If they cannot move together, hand over `address.model_dump()` at the seam.

The check against a database is `meta verify --db`, which needs the Node CLI, because schema
tooling is TypeScript only. `metaobjects verify` compares the generated code with the model.

## Fixing the differences

Fix each one in the model or the config, and leave the existing code alone until it has moved.

| What you see | Why | Fix |
|---|---|---|
| A timestamp is `Date` on one side and `string` on the other | Generated timestamps read as strings by default | `timestampMode: "date"` in the config (Postgres) |
| A field the database fills is required on insert | The model has no default | Add `default:` to the field |
| A database-set timestamp is accepted on create | The field is writable | `default: now(), mutability: readOnly` |
| An array column's default is reported by `verify --db` | An array `default` must be a string | `default: "{}"`, not `default: []` |
| `verify --db` reports a different foreign key name | The generated name differs | `constraintName` on `identity.reference` |
| `verify --db` reports a different unique index name | The name comes from the identity | Name `identity.secondary` after the existing index |
| A `tsc` failure names a field that is `T \| null` on one side | The existing type allows both null and absent | Model what the code relies on. If the difference is deliberate, keep it visible: `Same<Exclude<Differs<A, B>, "notes">>` with a comment |

## What the proof does not cover

- **Custom logic.** A `.refine()`, a `.transform()` or a Pydantic validator is not in the type or
  in the JSON Schema, so neither side of the proof sees it, and the model does not carry it. Keep
  it in your code: refine the generated schema, or subclass the generated model.
- **Behaviour.** The proof compares declared shapes. The project's own tests still have to pass
  after each move.
- **Native Postgres enums.** A `pgEnum` column cannot be modelled: `field.enum` is text plus a
  CHECK. `tsc` passes and `meta verify --db` reports the missing CHECK. Convert the column to text
  with a CHECK first, or leave that table out for now.
- **Python enum member names.** JSON Schema sees the values, not the member names. A generated enum
  has `UPPER_CASE` members, so `OrderStatus.pending` in a call site must become
  `OrderStatus.PENDING`. mypy or pyright finds those call sites.
- **Extra optional fields on a nested TypeScript type.** `Differs` compares a nested field as a
  whole, so an optional extra inside it still assigns both ways. Give each nested type its own line.
- **Pairs you did not name.** The proof compares only what it lists, so list every exported type.

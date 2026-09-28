# MongoDB, Cassandra, Neo4j and other stores MetaObjects does not manage

MetaObjects owns a relational schema: `meta migrate` diffs your model against Postgres,
SQLite or D1 and writes the migration. For any other store, including a document database,
a wide-column store, a graph database or a remote API, MetaObjects does not own the schema.
You create collections, keyspaces, labels and indexes the way that store normally expects.

The model still does its job. You declare the records once, and you get:

- the types, the create and PATCH validation schemas and the filter allowlists, in every
  port;
- `meta verify`, the docs and the requirements ledger;
- prompt render and reply extract.

The data access layer is a generator you own. Every store's driver is different, so no
reference generator is shipped for it.

## Model the record as a sourceless entity

A sourceless entity is an `object.entity` with an `identity.primary` and **no `source.*`
child**:

```json
{ "object.entity": { "name": "Order", "@mongo": { "collection": "orders" }, "children": [
  { "field.uuid":   { "name": "id" } },
  { "field.string": { "name": "customerEmail", "@required": true, "@filterable": true } },
  { "field.enum":   { "name": "status", "@required": true, "@values": ["NEW", "SHIPPED"], "@filterable": true } },
  { "field.object": { "name": "items", "@objectRef": "LineItem", "isArray": true } },
  { "identity.primary": { "name": "id", "@fields": "id", "@generation": "uuid" } }
]}}
```

- **No `source.*` child.** A source is how MetaObjects learns that it owns the storage. With
  no source, nothing generates a table, queries or routes for `Order`, and `meta migrate`
  ignores it (#248).
- **The `identity.primary` is required.** It makes `Order` a record that a client can
  create, fetch and patch. Without it, the object is only a shape, and it gets only a shape.
  (`object.value` can never carry an identity: ADR-0028.)
- **`@mongo` is your own property bag.** Any `@name` whose value is a JSON object is loaded
  as a registered `attr.properties` bag, so you can record store-specific settings without
  registering vocabulary. Your generator reads the bag; MetaObjects ignores it.

Embedded documents are value objects: `field.object` pointing at an `object.value`, with
`isArray` for a list. They validate as part of the parent.

## What each port generates for it

| Port | Generated for a sourceless entity |
|---|---|
| TypeScript (`entity`) | `Order` interface, `OrderInsertSchema` / `OrderUpdateSchema` (Zod), `OrderCreate` / `OrderPatch` input types, `OrderFilterAllowlist`, `OrderSortAllowlist`, `OrderFilter`. No Drizzle table. |
| Python (`entity`, `filter-allowlist`) | `Order`, `OrderCreate`, `OrderPatch` (Pydantic), `order_filter_allowlist.py`. No router. |
| Java (`SpringDtoGenerator`, `SpringFilterAllowlistGenerator`) | `OrderDto` (with Jakarta validation), `OrderPatch` (presence-tracked), `OrderFilterAllowlist`. No controller, no repository. |
| Kotlin (`KotlinEntityGenerator`, `KotlinFilterAllowlistGenerator`) | the entity class and `OrderFilterAllowlist`. No Exposed table, no controller. |
| C# (`entity`, `filter-allowlist`) | an `Order` POCO with DataAnnotations and no EF mapping, plus `OrderFilterAllowlist`. No DbSet, no routes. |

Each port's generators recognize a sourceless entity through one shared predicate:
`isSourcelessEntity` (TypeScript), `is_sourceless_entity` (Python),
`RestSurfaceGate.isSourcelessEntity` (Java and Kotlin) and
`InstanceArtifacts.IsSourcelessEntity` (C#). Use the same predicate in your own generator.

## Generate the data access

The generator below is also shipped, verbatim, in the `metaobjects-codegen` skill as
`references/typescript-document-store.md`, so an agent in your project has it without this
repository. A test keeps the two identical.

[`generators/typescript/mongo-repository.ts`](generators/typescript/mongo-repository.ts) is
a complete example for the MongoDB Node driver. Copy it into `codegen/generators/`, then wire
it next to the entity generator:

```bash
meta eject entity
cp <metaobjects>/docs/recipes/generators/typescript/mongo-repository.ts codegen/generators/
```

```ts
import { entityFile } from "./codegen/generators/entity.js";
import { mongoRepositoryGenerator } from "./codegen/generators/mongo-repository.js";

export default defineConfig({
  outDir: "src/generated",
  generators: [entityFile(), mongoRepositoryGenerator()],
});
```

For each sourceless entity, `meta gen` then writes `<Entity>.repository.ts` with
`create`, `findById`, `list`, `patch` and `delete`. The repository is built on the
generated contract:

- `create` validates the body with `OrderInsertSchema` and mints the uuid when the identity
  has `@generation: uuid`.
- `patch` validates with `OrderUpdateSchema`. An absent key is left unchanged, and an
  explicit `null` unsets the field.
- `list` accepts `{ field: value }` or `{ field: { op: value } }`. It refuses any field or
  operator that `OrderFilterAllowlist` does not allow.
- The identity is stored as the document's `_id`.

This was run end to end against MongoDB 7 with the `mongodb` 7.x Node driver:

- create, list by `status` and by `status in [...]`, patch, and delete all worked;
- a filter on the undeclared field `items` was refused;
- a create with a status outside the enum failed Zod validation.

`meta verify --codegen` is clean after `meta gen`. Adding an enum value to the model makes it
fail until you regenerate. The integration test `document-store-recipe.test.ts` copies the
example into a fresh project on every CI run.

A Cassandra, Neo4j or HTTP repository has the same shape. Only the driver calls change. The
model walk, the predicate and the generated schemas are the same. For the other ports, the
generator structure is in [Write your own generator](write-your-own-generator.md). Pick
objects with the port's sourceless predicate and build on its DTO, Patch and allowlist.

## What you do not get

- **Schema management.** Nothing creates or migrates collections, indexes, keyspaces or
  constraints. `meta migrate` and `meta verify --db` do not apply to this store. If the
  store has an optional schema (for example, a MongoDB `$jsonSchema` validator), you can
  write a generator for it from the model like any other output.
- **Generated routes, hooks, grids and forms.** The reference REST tier talks to a store
  that MetaObjects manages. Your repository is the seam: put your own routes on top of it,
  or write a generator for them.
- **Relationship traversal.** `identity.reference` and relationships still load, document
  and verify. No generated join or `$lookup` follows them.

## Mixing stores

One model can hold both kinds of entity. A `Customer` with a `source.rdb` gets the full
relational tier. An `Order` without a source gets the contract plus your repository. An
`identity.reference` from `Order` to `Customer` loads and resolves, but no foreign key
exists, because the two records live in different stores.

## Why this is not new vocabulary

ADR-0007 designs `source.document`, `source.graph` and the other paradigm subtypes, but
only `source.rdb` is registered. The others stay unregistered until a shipping consumer
dispatches on them. That is the bar ADR-0007 Amendment 2 set for `@role` members, applied to
paradigms. Registering one today would make `Order` persistable to
every tier in all five ports, and each tier would then need to learn to skip it. A
sourceless entity with a property bag gives an adopter everything a store-specific
generator needs, and it changes nothing in the metamodel.

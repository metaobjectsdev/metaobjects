# codegen-conformance / inheritance

Shared input for the cross-port "inherited fields surface in codegen" guarantee, with a
focus on **multi-level** abstract inheritance — the case most likely to expose a port's
field-walking divergence.

- **Base** (`abstract: true`): `id`, `createdBy` (required).
- **Auditable** (`abstract: true`, `extends Base`): adds `updatedBy`.
- **Product** (concrete, `extends Auditable`, table `products`): adds `sku` (required,
  filterable) + `qtyOnHand`.

So `Product` inherits across **two** abstract levels and must, in generated code, carry the
full field set in declaration order: `id`, `createdBy`, `updatedBy`, `sku`, `qtyOnHand`.

Each port's own suite loads `input/meta.inheritance.json` and asserts (idiomatically):

| Port | How inherited fields appear on the concrete entity |
|---|---|
| **TypeScript** | flattened inline — all 5 fields in `Product`'s entity/table/schema |
| **C#** | flattened inline — all 5 fields on the `Product` entity class |
| **Java/Spring** | flattened inline — all 5 components on `ProductDto` |
| **Kotlin** | flattened inline — all 5 columns/properties on `Product` |
| **Python** | **inherited** — `class Product(Auditable)` (own `sku`/`qtyOnHand`); the chain `Auditable(Base)` carries `updatedBy`, `Base` carries `id`/`createdBy` |

The two abstract bases (`Base`, `Auditable`) still emit no instance/write artifacts (the
abstract invariant), so no `base`/`auditable` table, route, repo, or allowlist.

Enum inheritance (`field.enum` reused via `extends`) is exercised separately by the
`enum/` fixture; this one isolates multi-level entity-field inheritance.

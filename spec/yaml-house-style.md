# YAML authoring house style (ADR-0006 D3)

YAML is a **TypeScript-only authoring front-end** for MetaObjects metadata. It
lowers to canonical JSON, which is the sole cross-language interchange. This
document defines the single house style AI authors (Claude) and humans should
use when writing YAML metadata.

The desugar may *accept* additional shorthand for backward compatibility; the
rules below are the form to *emit*.

## D3.1 — Explicit `type.subType`

Always write the fused form. Do not rely on a registered default subType.

```yaml
# Good
object.entity:
  name: Product
  children:
    - field.string: { name: sku }

# Avoid (defaults change; explicit form survives registry edits)
object:
  name: Product
  children:
    - field: { name: sku }
```

## D3.2 — Map body form (not scalar body)

Use a map body for every node, even when only `name` is set. The scalar
shorthand (`field.string: sku` → `{ name: "sku" }`) is accepted but harder for
AI to extend incrementally.

```yaml
# Good
field.string:
  name: sku

# Avoid
field.string: sku
```

## D3.3 — Quote string values that look like booleans, numbers, or null

YAML 1.2 core-schema coercion silently rewrites unquoted scalars. The D2
type-coercion guard rejects the obvious cases (`column: TRUE` for a
string-typed attr) with an `ERR_YAML_COERCION`, but the only way to *prevent*
the surprise is to quote.

```yaml
# Good — quoted; the value lands as the string "TRUE"
field.string:
  name: active
  column: "TRUE"

# Rejected — D2 fires ERR_YAML_COERCION
field.string:
  name: active
  column: TRUE      # parses as the boolean true
```

Member symbols in an enum's `values` array are domain data — always quote:

```yaml
# Good
field.enum:
  name: status
  values: ["DRAFT", "REVIEW", "PUBLISHED"]

# Rejected — `Y` and `N` would coerce to booleans in YAML 1.1; D2 catches it
field.enum:
  name: flag
  values: [Y, N]
```

## D3.4 — Bare (not `@`-prefixed) attribute keys

Per D1, every body key not in the closed reserved structural set is treated
as an inline attribute, and the desugar adds the `@` when lowering to
canonical JSON. The legacy `"@attr": value` (quoted) form is accepted for
backward compatibility but should not be emitted.

Reserved structural keys (stay bare in YAML, stay bare in canonical JSON):

```
name, package, extends, abstract, overlay, isArray, children, value
```

Everything else is an attribute and is `@`-prefixed in canonical JSON.

```yaml
# Good
field.object:
  name: address
  objectRef: Address      # bare → canonical "@objectRef"
  storage: flattened       # bare → canonical "@storage"

# Avoid (still accepted, but noisy)
field.object:
  name: address
  "@objectRef": Address
  "@storage": flattened
```

A common consequence: any literal `@` in YAML must now appear inside a quoted
string (it is reserved as a YAML indicator anyway).

## D3.5 — Array-shaped attribute values

Use YAML list syntax for array-shaped attrs (`stringarray` subtype, e.g.
`@values`, `@fields`).

```yaml
# Good
identity.primary:
  fields: ["sku"]

# Accepted (one-element shorthand; coerced to a single-element array)
identity.primary:
  fields: sku
```

## Why these rules

- **Less surface area.** A single emit-form means AI authors don't have to
  choose between equivalent shapes.
- **No silent coercions.** D2 catches the obvious YAML 1.2 footguns; D3.3
  keeps you out of the trap to begin with.
- **Stable across the loader's history.** Defaults change; explicit
  `type.subType` does not.
- **Cross-language safety.** The canonical JSON the desugar produces is what
  every language port consumes — explicit, conservative YAML preserves the
  canonical form's stability.

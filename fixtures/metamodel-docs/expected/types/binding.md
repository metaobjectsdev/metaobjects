<!-- @generated — DO NOT EDIT.
     Metamodel reference for the `binding` type family — each subtype's composed attributes, allowed children, and cardinality.
     Regenerate with: meta gen (the metamodel-docs generator, metamodelDocsFile()) -->

# Metamodel — `binding` types

Each section below is one `binding.<subType>`. The **Attributes** table lists
the subtype's own + concern-contributed attributes (provider-tagged); universal
documentation attributes are omitted here (see [providers.md](../providers.md)).
**Allowed children** lists the structural child rules with their cardinality
(`min..max`, `*` = unbounded).

### binding.base

Registry anchor for protocol bindings (ADR-0030, ADR-0054): not authorable.

**Attributes**

_No subtype-specific attributes._

**Allowed children**

_No structural children._

### binding.rest

The HTTP method and path of an operation, declared only to override the derived ones. A query is `GET`, a command `POST`; the path is `/<collection>/{id}/<operation-kebab>` for an operation with a target key and `/<collection>/<operation-kebab>` without one. Most models never write it. Experimental since 1.3.0: the shape may change in a MINOR, including removals and renames (docs/compatibility-policy.md).

**When to use:** An operation must keep a method or path the derived one would not give it, such as an existing public URL.

**Attributes**

| Attribute | Type | Required | Default | Allowed values | Provider | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `@method` | string | no |  | `GET`, `POST`, `PUT`, `PATCH`, `DELETE` | — | The HTTP method. Absent: GET for a query, POST for a command. |
| `@path` | string | no |  |  | — | A path template. Its `{name}` placeholders must be exactly the target's primary key fields when the operation is keyed, and there must be none when it is not; two declared bindings of one API may not share the method and path (ERR_BINDING_PATH_MISMATCH). |

**Allowed children**

_No structural children._


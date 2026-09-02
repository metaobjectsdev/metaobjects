<!-- @generated — DO NOT EDIT.
     Metamodel reference for the `view` type family — each subtype's composed attributes, allowed children, and cardinality.
     Regenerate with: meta docs --metamodel -->

# Metamodel — `view` types

Each section below is one `view.<subType>`. The **Attributes** table lists
the subtype's own + concern-contributed attributes (provider-tagged); universal
documentation attributes are omitted here (see [providers.md](../providers.md)).
**Allowed children** lists the structural child rules with their cardinality
(`min..max`, `*` = unbounded).

### view.base

Abstract view base — the shared root subtype for field-level UI/render hints. A view declares how a field's value is rendered or edited; the base carries no attrs of its own. Not authored directly: a `view.base` node fails to load (ERR_ABSTRACT_SUBTYPE_AUTHORED) — this subtype is a registry anchor concrete subtypes inherit from, never a node in a document.

**Owning provider:** metaobjects-core-types

**Attributes**

_No subtype-specific attributes._

**Allowed children**

_No structural children._

### view.currency

Currency display formatting (locale-aware via @locale).

**Owning provider:** metaobjects-core-types

**Attributes**

| Attribute | Type | Required | Default | Allowed values | Provider | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `@locale` | string | no | `en-US` |  | metaobjects-ui | BCP 47 locale code controlling currency display formatting. Defaults to 'en-US' when omitted. |

**Allowed children**

_No structural children._


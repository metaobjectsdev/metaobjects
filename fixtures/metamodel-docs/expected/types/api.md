<!-- @generated — DO NOT EDIT.
     Metamodel reference for the `api` type family — each subtype's composed attributes, allowed children, and cardinality.
     Regenerate with your port's gen command (the metamodel-docs generator) -->

# Metamodel — `api` types

Each section below is one `api.<subType>`. The **Attributes** table lists
the subtype's own + concern-contributed attributes (provider-tagged); universal
documentation attributes are omitted here (see [providers.md](../providers.md)).
**Allowed children** lists the structural child rules with their cardinality
(`min..max`, `*` = unbounded).

### api.base

Registry anchor for the declared API surface (ADR-0030, ADR-0054): not authorable. The `api` subtype axis is the interaction model, never the protocol; protocol lives in `binding.*` on each operation.

**Owning provider:** metaobjects-rules

**Attributes**

_No subtype-specific attributes._

**Allowed children**

_No structural children._

### api.operational

A named, packaged request/response surface whose children are operations (ADR-0030). It is a wire contract: two of them (`v1`, `v2`) may declare the same operation side by side. The code behind it is one service per metadata package, whose surface is the package's operations (ADR-0067). Experimental since 1.3.0: the shape may change in a MINOR, including removals and renames (docs/compatibility-policy.md).

**Owning provider:** metaobjects-rules

**Rules:** Children are `operation.command` and `operation.query`. Lives at the document root. Declares no fields, sources or identities: shapes are referenced, never defined, by the surface. Operation names are compared without case, are unique across every API of one package, except one operation declared identically in two APIs, such as a versioned API beside its successor (one operation declared twice in one API merges), and may not be create, get, list, update or delete in any case (ERR_TRANSITION_NAME_COLLISION). Two declared bindings of one API may not share a method and path (ERR_BINDING_PATH_MISMATCH).

**When to use:** The application does something beyond derived CRUD: a named command (approve, cancel, import) or a named query (my open requests). Declare it here so its input, output, permission and business errors are part of the model. A plain lifecycle needs no api.operational at all: a transition nobody claims is held to derive its own command once a shell is generated, and no shell is generated yet.

**Attributes**

_No subtype-specific attributes._

**Allowed children**

- `operation.*` — 0..*


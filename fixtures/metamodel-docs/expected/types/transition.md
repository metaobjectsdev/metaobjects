<!-- @generated — DO NOT EDIT.
     Metamodel reference for the `transition` type family — each subtype's composed attributes, allowed children, and cardinality.
     Regenerate with: meta gen (the metamodel-docs generator, metamodelDocsFile()) -->

# Metamodel — `transition` types

Each section below is one `transition.<subType>`. The **Attributes** table lists
the subtype's own + concern-contributed attributes (provider-tagged); universal
documentation attributes are omitted here (see [providers.md](../providers.md)).
**Allowed children** lists the structural child rules with their cardinality
(`min..max`, `*` = unbounded).

### transition.action

An allowed move between two values of a `field.enum`, made by an operation (ADR-0066). A `field.enum` with at least one is a lifecycle, named after the field. Its states are the enum's @values, its initial state the enum's @default, its terminal states the members no transition leaves; none of them has vocabulary of its own. Each transition is held to become a guarded update (`... WHERE id = ? AND <field> IN (@from) [AND @condition]`), its own command when no declared operation claims it, its own permission point and its own wire error. No shell is generated yet: nothing is generated from this vocabulary, and the loader and `verify` only check it. Experimental since 1.3.0: the shape may change in a MINOR, including removals and renames (docs/compatibility-policy.md).

**Owning provider:** metaobjects-rules

**Rules:** Legal only under a `field.enum` of an `object.entity` (ERR_TRANSITION_NOT_ON_ENTITY). A concrete entity with a lifecycle and a source needs a writable one (ERR_TRANSITION_NOT_ON_ENTITY); on an entity with no source the lifecycle loads and is inert, deriving no command until a source is added. The field must declare @default (ERR_LIFECYCLE_NO_INITIAL). The field is not an array, and @from names at least one state (ERR_BAD_ATTR_VALUE). Names are unique across every lifecycle of the entity, compared without case, and may not be create, get, list, update or delete in any case (ERR_TRANSITION_NAME_COLLISION). A transition belongs to the entity that declares its field and to every entity extending it, never to an entity whose field merely `extends` that field; an inheritor that redeclares the field without extending it is ERR_LIFECYCLE_REDECLARED.

**When to use:** A status field whose values may only change in certain ways: a request is submitted from draft, approved or rejected from submitted. Declare each allowed move here; once a shell is generated, the generic update path will no longer write the field. A move that leaves the state where it was (from submitted to submitted) records an action that changes nothing but still happened, such as a first approval of two.

**Attributes**

| Attribute | Type | Required | Default | Allowed values | Provider | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `@condition` | expression | no |  |  | metaobjects-rules | A guard over the entity's own fields, in the attr.expression grammar: the same name, grammar and meaning as on the cross-field validators. The shell will evaluate it against the loaded row and also put it into the guarded update's WHERE (no shell is generated yet). It cannot read the actor; that is the policy's job. A field the entity does not have, or an expression that is not boolean, is ERR_BAD_ATTR_VALUE. |
| `@from` | string[] | yes |  |  | metaobjects-rules | The states this move may start from: members of the parent enum's @values (ERR_TRANSITION_UNKNOWN_STATE otherwise), at least one (ERR_BAD_ATTR_VALUE when empty). The allowed moves are the business rule itself, so they cannot be computed. |
| `@permission` | string | no |  |  | metaobjects-rules | As on an operation: the permission name the derived command for this transition will ask the policy about (no command is derived yet). A dotted identifier path, as on an operation. Absent and not @public: the derived name `<package>.<Entity>.<transition>`, naming the concrete entity, so two entities' transitions of one name ask about different permissions. Read only when the transition derives its own command; a declared operation that claims it uses its own, and verify warns that this one is never read (WARN_TRANSITION_PERMISSION_SHADOWED). |
| `@public` | boolean | no |  |  | metaobjects-rules | As on an operation: the derived command will call no permission check (no command is derived yet). Declaring it with @permission is ERR_PERMISSION_PUBLIC_CONFLICT. |
| `@to` | string | yes |  |  | metaobjects-rules | The state this move ends in: one member of the parent enum's @values (ERR_TRANSITION_UNKNOWN_STATE otherwise). May equal a member of @from, which records an action that leaves the state where it was. |

**Allowed children**

_No structural children._

### transition.base

Registry anchor for the attributes every lifecycle move shares (ADR-0054): not authorable.

**Owning provider:** metaobjects-rules

**Attributes**

| Attribute | Type | Required | Default | Allowed values | Provider | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `@permission` | string | no |  |  | metaobjects-rules | As on an operation: the permission name the derived command for this transition will ask the policy about (no command is derived yet). A dotted identifier path, as on an operation. Absent and not @public: the derived name `<package>.<Entity>.<transition>`, naming the concrete entity, so two entities' transitions of one name ask about different permissions. Read only when the transition derives its own command; a declared operation that claims it uses its own, and verify warns that this one is never read (WARN_TRANSITION_PERMISSION_SHADOWED). |
| `@public` | boolean | no |  |  | metaobjects-rules | As on an operation: the derived command will call no permission check (no command is derived yet). Declaring it with @permission is ERR_PERMISSION_PUBLIC_CONFLICT. |

**Allowed children**

_No structural children._


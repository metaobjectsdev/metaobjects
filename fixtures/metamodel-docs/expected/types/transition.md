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

An allowed move between two values of a `field.enum`, made by an operation (ADR-0063). A `field.enum` with at least one is a lifecycle, named after the field. Its states are the enum's @values, its initial state the enum's @default, its terminal states the members no transition leaves; none of them has vocabulary of its own. Each transition becomes a guarded update (`... WHERE id = ? AND <field> IN (@from) [AND @condition]`), its own command when no declared operation claims it, its own permission point and its own wire error.

**Rules:** Legal only under a `field.enum` of an `object.entity` that has a writable source, or of an abstract entity whose concrete inheritors have one (ERR_TRANSITION_NOT_ON_ENTITY). The field must declare @default (ERR_LIFECYCLE_NO_INITIAL). Names are unique across every lifecycle of the entity and may not be create, get, list, update or delete (ERR_TRANSITION_NAME_COLLISION).

**When to use:** A status field whose values may only change in certain ways: a request is submitted from draft, approved or rejected from submitted. Declare each allowed move here, and the generic update path can no longer write the field. A move that leaves the state where it was (from submitted to submitted) records an action that changes nothing but still happened, such as a first approval of two.

**Attributes**

| Attribute | Type | Required | Default | Allowed values | Provider | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `@condition` | expression | no |  |  | — | A guard over the entity's own fields, in the attr.expression grammar: the same name, grammar and meaning as on the cross-field validators. Evaluated against the loaded row and also put into the guarded update's WHERE. It cannot read the actor; that is the policy's job. A field the entity does not have, or an expression that is not boolean, is ERR_BAD_ATTR_VALUE. |
| `@from` | string[] | yes |  |  | — | The states this move may start from: members of the parent enum's @values (ERR_TRANSITION_UNKNOWN_STATE otherwise). The allowed moves are the business rule itself, so they cannot be computed. |
| `@permission` | string | no |  |  | — | As on an operation: the permission name the derived command for this transition asks the policy about. Absent and not @public: the derived name `<package>.<transition>`. Read only when the transition derives its own command; a declared operation that claims it uses its own. |
| `@public` | boolean | no |  |  | — | As on an operation: the derived command calls no permission check. Declaring it with @permission is ERR_PERMISSION_PUBLIC_CONFLICT. |
| `@to` | string | yes |  |  | — | The state this move ends in: one member of the parent enum's @values (ERR_TRANSITION_UNKNOWN_STATE otherwise). May equal a member of @from, which records an action that leaves the state where it was. |

**Allowed children**

_No structural children._

### transition.base

Registry anchor for the attributes every lifecycle move shares (ADR-0054): not authorable.

**Attributes**

| Attribute | Type | Required | Default | Allowed values | Provider | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `@permission` | string | no |  |  | — | As on an operation: the permission name the derived command for this transition asks the policy about. Absent and not @public: the derived name `<package>.<transition>`. Read only when the transition derives its own command; a declared operation that claims it uses its own. |
| `@public` | boolean | no |  |  | — | As on an operation: the derived command calls no permission check. Declaring it with @permission is ERR_PERMISSION_PUBLIC_CONFLICT. |

**Allowed children**

_No structural children._


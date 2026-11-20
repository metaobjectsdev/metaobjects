<!-- @generated — DO NOT EDIT.
     Metamodel reference for the `operation` type family — each subtype's composed attributes, allowed children, and cardinality.
     Regenerate with: meta gen (the metamodel-docs generator, metamodelDocsFile()) -->

# Metamodel — `operation` types

Each section below is one `operation.<subType>`. The **Attributes** table lists
the subtype's own + concern-contributed attributes (provider-tagged); universal
documentation attributes are omitted here (see [providers.md](../providers.md)).
**Allowed children** lists the structural child rules with their cardinality
(`min..max`, `*` = unbounded).

### operation.base

Registry anchor for the attributes every operation shares (ADR-0054): not authorable.

**Owning provider:** metaobjects-rules

**Attributes**

| Attribute | Type | Required | Default | Allowed values | Provider | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `@inputRef` | string | no |  |  | metaobjects-rules | The `object.value` this operation takes as its input (ADR-0030). Absent on an operation whose only parameter is the target's borrowed key. Anything other than an `object.value` is ERR_OPERATION_SHAPE. |
| `@objectRef` | string | no |  |  | metaobjects-rules | The entity this operation acts on, declared only when it cannot be derived. It is derived from the input value when its fields `extend` every primary key field of exactly one entity, each once, else from the output's base entity; an input that borrows part of a key, one key field twice, or the keys of two entities derives nothing, so declare it. Declared and derivable, the two must agree (ERR_OPERATION_TARGET_MISMATCH). It must name an `object.entity` (ERR_OPERATION_TARGET_UNRESOLVED). |
| `@outputRef` | string | no |  |  | metaobjects-rules | The object this operation returns: an `object.projection`, `object.entity` or `object.value`. Which projection a query returns is the author's choice among several over one entity, so it cannot be computed. Anything else is ERR_OPERATION_SHAPE. |
| `@permission` | string | no |  |  | metaobjects-rules | The permission name the generated shell will ask the project's policy about before anything is written (no shell is generated yet). A key into grant data (who holds it is data, what the policy decides is code), so an explicit name is stable: a derived name moves when the operation is renamed. A dotted identifier path such as `purchasing.approve`; a package prefix may use `::` (ERR_BAD_ATTR_VALUE otherwise). Absent and not @public: the shell will use the derived name `<package>.<operation>`, with the package of the operation's API, and `verify` advises or requires an explicit one (setting `rules.permissions.names`). Several operations may share one. |
| `@public` | boolean | no |  |  | metaobjects-rules | The shell will call no permission check (no shell is generated yet). Authentication is the transport's job and is unaffected. Absent means checked. Declaring it with @permission is ERR_PERMISSION_PUBLIC_CONFLICT. |

**Allowed children**

- `binding.*` — 0..*

### operation.command

A named operation that changes state. Takes an `object.value` (ADR-0030). Its body is hand-written. The contract (ADR-0066) is that a generated shell around it loads the row, checks the permission and the current state, runs the body, and makes the guarded update in one transaction. No shell is generated yet: this vocabulary is registered, loaded and checked, and nothing is generated from it. Experimental since 1.3.0: the shape may change in a MINOR, including removals and renames (docs/compatibility-policy.md).

**Owning provider:** metaobjects-rules

**When to use:** A business action with its own name, input and rules: approve, cancel, transfer. A command that moves a lifecycle names the transitions it may make in @transitions; its body decides which one applies.

**Attributes**

| Attribute | Type | Required | Default | Allowed values | Provider | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `@errors` | string[] | no |  |  | metaobjects-rules | The business failures the hand-written body may return, each a lower snake case code (`insufficient_funds`). They name the wire error, the OpenAPI document and the typed result; the shell will refuse an undeclared one (no shell is generated yet). A code that is not lower snake case, appears twice, or is one the route answers itself (not_found, forbidden, invalid_transition, transition_condition_failed, state_managed, validation, invalid_json, invalid_id, method_not_allowed, constraint_violation, internal) is ERR_BAD_ATTR_VALUE. |
| `@inputRef` | string | no |  |  | metaobjects-rules | The `object.value` this operation takes as its input (ADR-0030). Absent on an operation whose only parameter is the target's borrowed key. Anything other than an `object.value` is ERR_OPERATION_SHAPE. |
| `@objectRef` | string | no |  |  | metaobjects-rules | The entity this operation acts on, declared only when it cannot be derived. It is derived from the input value when its fields `extend` every primary key field of exactly one entity, each once, else from the output's base entity; an input that borrows part of a key, one key field twice, or the keys of two entities derives nothing, so declare it. Declared and derivable, the two must agree (ERR_OPERATION_TARGET_MISMATCH). It must name an `object.entity` (ERR_OPERATION_TARGET_UNRESOLVED). |
| `@outputRef` | string | no |  |  | metaobjects-rules | The object this operation returns: an `object.projection`, `object.entity` or `object.value`. Which projection a query returns is the author's choice among several over one entity, so it cannot be computed. Anything else is ERR_OPERATION_SHAPE. |
| `@permission` | string | no |  |  | metaobjects-rules | The permission name the generated shell will ask the project's policy about before anything is written (no shell is generated yet). A key into grant data (who holds it is data, what the policy decides is code), so an explicit name is stable: a derived name moves when the operation is renamed. A dotted identifier path such as `purchasing.approve`; a package prefix may use `::` (ERR_BAD_ATTR_VALUE otherwise). Absent and not @public: the shell will use the derived name `<package>.<operation>`, with the package of the operation's API, and `verify` advises or requires an explicit one (setting `rules.permissions.names`). Several operations may share one. |
| `@public` | boolean | no |  |  | metaobjects-rules | The shell will call no permission check (no shell is generated yet). Authentication is the transport's job and is unaffected. Absent means checked. Declaring it with @permission is ERR_PERMISSION_PUBLIC_CONFLICT. |
| `@transitions` | string[] | no |  |  | metaobjects-rules | The lifecycle moves this command may make: names of `transition.action` nodes on its target entity (ERR_OPERATION_UNKNOWN_TRANSITION otherwise). A fact of the business the model cannot compute. A transition a command lists gets no derived command of its own. Listing any requires a target (ERR_OPERATION_TARGET_UNRESOLVED). |

**Allowed children**

- `binding.*` — 0..*

### operation.query

A named operation that reads. Returns an `object.projection` (or an entity or value). It changes nothing. Experimental since 1.3.0: the shape may change in a MINOR, including removals and renames (docs/compatibility-policy.md).

**Owning provider:** metaobjects-rules

**When to use:** A read with its own name and shape beyond derived get and list: my open requests, the dashboard summary.

**Attributes**

| Attribute | Type | Required | Default | Allowed values | Provider | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `@inputRef` | string | no |  |  | metaobjects-rules | The `object.value` this operation takes as its input (ADR-0030). Absent on an operation whose only parameter is the target's borrowed key. Anything other than an `object.value` is ERR_OPERATION_SHAPE. |
| `@many` | boolean | no |  |  | metaobjects-rules | The query returns a list and takes the filter, sort and paging contract. Not implied by the projection, so declared. Absent means one row. Legal on a query only. |
| `@objectRef` | string | no |  |  | metaobjects-rules | The entity this operation acts on, declared only when it cannot be derived. It is derived from the input value when its fields `extend` every primary key field of exactly one entity, each once, else from the output's base entity; an input that borrows part of a key, one key field twice, or the keys of two entities derives nothing, so declare it. Declared and derivable, the two must agree (ERR_OPERATION_TARGET_MISMATCH). It must name an `object.entity` (ERR_OPERATION_TARGET_UNRESOLVED). |
| `@outputRef` | string | no |  |  | metaobjects-rules | The object this operation returns: an `object.projection`, `object.entity` or `object.value`. Which projection a query returns is the author's choice among several over one entity, so it cannot be computed. Anything else is ERR_OPERATION_SHAPE. |
| `@permission` | string | no |  |  | metaobjects-rules | The permission name the generated shell will ask the project's policy about before anything is written (no shell is generated yet). A key into grant data (who holds it is data, what the policy decides is code), so an explicit name is stable: a derived name moves when the operation is renamed. A dotted identifier path such as `purchasing.approve`; a package prefix may use `::` (ERR_BAD_ATTR_VALUE otherwise). Absent and not @public: the shell will use the derived name `<package>.<operation>`, with the package of the operation's API, and `verify` advises or requires an explicit one (setting `rules.permissions.names`). Several operations may share one. |
| `@public` | boolean | no |  |  | metaobjects-rules | The shell will call no permission check (no shell is generated yet). Authentication is the transport's job and is unaffected. Absent means checked. Declaring it with @permission is ERR_PERMISSION_PUBLIC_CONFLICT. |

**Allowed children**

- `binding.*` — 0..*


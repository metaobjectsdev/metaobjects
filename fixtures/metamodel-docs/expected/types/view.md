<!-- @generated — DO NOT EDIT.
     Metamodel reference for the `view` type family — each subtype's composed attributes, allowed children, and cardinality.
     Regenerate with: meta gen (the metamodel-docs generator, metamodelDocsFile()) -->

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

### view.checkbox

Checkbox selection control.

**Owning provider:** metaobjects-core-types

**Implemented in:** typescript so far — every port loads and type-checks it; the others do not act on it yet.

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

### view.date

Date picker / date display.

**Owning provider:** metaobjects-core-types

**Implemented in:** typescript so far — every port loads and type-checks it; the others do not act on it yet.

**Attributes**

_No subtype-specific attributes._

**Allowed children**

_No structural children._

### view.dropdown

Single-select dropdown control.

**Owning provider:** metaobjects-core-types

**Implemented in:** typescript so far — every port loads and type-checks it; the others do not act on it yet.

**Attributes**

_No subtype-specific attributes._

**Allowed children**

_No structural children._

### view.hidden

Not rendered; carried but not shown.

**Owning provider:** metaobjects-core-types

**Implemented in:** typescript so far — every port loads and type-checks it; the others do not act on it yet.

**Attributes**

_No subtype-specific attributes._

**Allowed children**

_No structural children._

### view.hotlink

Renders the value as a clickable link.

**Owning provider:** metaobjects-core-types

**Implemented in:** typescript so far — every port loads and type-checks it; the others do not act on it yet.

**Attributes**

_No subtype-specific attributes._

**Allowed children**

_No structural children._

### view.image

Image upload/display control; the field stores an opaque storage key (field.string).

**Owning provider:** metaobjects-core-types

**Implemented in:** typescript so far — every port loads and type-checks it; the others do not act on it yet.

**Attributes**

| Attribute | Type | Required | Default | Allowed values | Provider | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `@accept` | string[] | no |  |  | metaobjects-ui-web | Accepted MIME types (client guard; the server re-enforces). |
| `@aspectRatio` | double | no |  |  | metaobjects-ui-web | Crop aspect ratio (width / height). Omit for freeform. |
| `@maxBytes` | int | no |  |  | metaobjects-ui-web | Client-side size ceiling in bytes. |
| `@maxEdge` | int | no |  |  | metaobjects-ui-web | Longest-edge bound in px for the re-encoded output. |
| `@store` | string | no |  |  | metaobjects-ui-web | Opaque storage-namespace hint passed to the upload adapter (not infrastructure). |

**Allowed children**

_No structural children._

### view.month

Month picker / month display.

**Owning provider:** metaobjects-core-types

**Implemented in:** typescript so far — every port loads and type-checks it; the others do not act on it yet.

**Attributes**

_No subtype-specific attributes._

**Allowed children**

_No structural children._

### view.number

Numeric input control.

**Owning provider:** metaobjects-core-types

**Implemented in:** typescript so far — every port loads and type-checks it; the others do not act on it yet.

**Attributes**

_No subtype-specific attributes._

**Allowed children**

_No structural children._

### view.password

Masked input for sensitive values.

**Owning provider:** metaobjects-core-types

**Implemented in:** typescript so far — every port loads and type-checks it; the others do not act on it yet.

**Attributes**

_No subtype-specific attributes._

**Allowed children**

_No structural children._

### view.radio

Radio-button selection control.

**Owning provider:** metaobjects-core-types

**Implemented in:** typescript so far — every port loads and type-checks it; the others do not act on it yet.

**Attributes**

_No subtype-specific attributes._

**Allowed children**

_No structural children._

### view.text

Single-line text input/display.

**Owning provider:** metaobjects-core-types

**Implemented in:** typescript so far — every port loads and type-checks it; the others do not act on it yet.

**Attributes**

_No subtype-specific attributes._

**Allowed children**

_No structural children._

### view.textarea

Multi-line text area.

**Owning provider:** metaobjects-core-types

**Implemented in:** typescript so far — every port loads and type-checks it; the others do not act on it yet.

**Attributes**

| Attribute | Type | Required | Default | Allowed values | Provider | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `@rows` | int | no |  |  | metaobjects-ui-web | Visible row count for the generated <textarea>; the form generator defaults to 4 when absent. |

**Allowed children**

_No structural children._

### view.web

Abstract base for web-rendered views.

**Owning provider:** metaobjects-core-types

**Implemented in:** typescript so far — every port loads and type-checks it; the others do not act on it yet.

**Attributes**

_No subtype-specific attributes._

**Allowed children**

_No structural children._


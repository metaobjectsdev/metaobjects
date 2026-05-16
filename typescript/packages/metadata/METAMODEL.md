# Metaobjects metamodel reference

This is the canonical reference for the **metaobjects metadata format** — the language-neutral metamodel used across Java, TypeScript, Python, and (eventually) C# implementations. If you're working with `.meta/memory/*.json` files or any other metaobjects-formatted JSON/XML, the rules below apply.

> **For agentic assistants:** read this whole file before authoring or modifying metadata files. The attribute-uniqueness rule and the `attr`-vs-`@attr` equivalence are the two most common stumbling points.

## 1. The 8 base types

Every metadata node is exactly one of these types:

| Type | Purpose | Example use |
|---|---|---|
| `metadata` | Root document wrapper. Every file starts here. | `{"metadata": {"package": "...", "children": [...]}}` |
| `object` | An entity (data shape, table, record). | `User`, `Post`, `Comment` |
| `field` | A property on an object. | `id`, `email`, `createdAt` |
| `attr` | An attribute (named scalar/array decoration) on any parent. | `dbColumn`, `maxLength`, `isArray` |
| `validator` | A validation rule on a field or object. | `required`, `length`, `regex` |
| `view` | A UI control kind (rendering metadata). | `text`, `dropdown`, `password` |
| `identity` | A primary/secondary key on an object. | Primary key on `id` |
| `relationship` | An association between two objects. | `User has many Post` |

Each type has its own set of **subtypes** (open lists, registered via `TypeRegistry`):
- `object`: `pojo`, `map`, `proxy`, `base`
- `field`: `string`, `int`, `long`, `double`, `boolean`, `date`, `decimal`, `byte`, `short`, `float`, `time`, `timestamp`, `object`, `class`
- `attr`: `string`, `int`, `long`, `double`, `boolean`, `class`, `properties`, `stringarray`
- `validator`: `required`, `length`, `regex`, `numeric`, `array`
- `view`: `text`, `textarea`, `date`, `month`, `hotlink`, `dropdown`, `radio`, `checkbox`, `number`, `password`, `hidden`, `web`
- `identity`: `primary`, `secondary`
- `relationship`: `association`, `aggregation`, `composition`

## 2. Reserved structural keys

These JSON keys on a metadata node are **not** attributes — they're structural:

| Key | Meaning |
|---|---|
| `name` | The node's name within its parent package |
| `subType` | The subtype (see §1) |
| `package` | Package qualifier (relative or absolute) |
| `super` | Inheritance reference to another node |
| `isAbstract` | Marks the node as abstract (can't be instantiated; only inherited from) |
| `isInterface` | Marks the node as an interface |
| `implements` | List of interfaces the node implements |
| `children` | Child nodes (array of single-key wrappers) |
| `overlay` | Overlay reference (apply this node's changes to a target) |
| `override` | Override marker (replace, don't merge) |
| `value` | Value field on `attr` children |

If you want a custom property with one of these names, you can't — they're reserved.

## 3. Attributes — two equivalent forms

Attributes decorate any metadata node with named scalar/array values. There are **two equivalent ways** to write them:

**Inline shorthand** (most common, fewest keystrokes):
```json
{"field": {"name": "email", "subType": "string", "@maxLength": 50, "@required": true}}
```

**Expanded form** (when you need explicit `subType`):
```json
{"field": {"name": "email", "subType": "string",
  "children": [
    {"attr": {"name": "maxLength", "subType": "int", "value": "50"}},
    {"attr": {"name": "required", "subType": "boolean", "value": "true"}}
  ]
}}
```

The parser converts inline form into `attr` children — they are the same thing structurally. Use inline form unless you need to be explicit about an attr's `subType` (e.g., for a `stringarray` attr where the value is genuinely an array).

### 3.1 The uniqueness rule

**Within a single parent metadata node, all attribute names must be unique.** You cannot have two `attr` children both named `alternative`, nor two inline `@alternative` keys (which would be invalid JSON anyway, but worth stating).

If you need multiple values, use a single attribute with array value:

```json
{"object": {"name": "Decision",
  "@alternatives": ["swr", "redux-toolkit-query"]
}}
```

This is one attribute named `alternatives`, subType `stringarray`, with array value — not three separate attrs.

### 3.2 Array-valued attributes

Two ways:

**Inline array (recommended):**
```json
{"identity": {"name": "pk", "subType": "primary", "@fields": ["id", "tenantId"]}}
```

**Inline CSV string** (legacy XML compatibility):
```json
{"validator": {"subType": "required", "@values": "gas,diesel,electric,hybrid"}}
```

CSV form parses as a comma-separated string. Prefer inline arrays.

### 3.3 Special intercepted attributes

Two attribute names are intercepted by the parser and routed to special model methods rather than stored as ordinary attrs:

- `@isArray` → calls `setIsArray(true)` (marks a field as a collection)
- `@isAbstract` → calls `setIsAbstract(true)` (marks the node as abstract)

Use them as you would any other inline attr; the parser does the rest.

## 4. Package paths and inheritance

### 4.1 Package separator

Package segments use `::` as separator:

```
acme              — top-level package
acme::common      — nested
acme::vehicle::car — deeper nesting
```

### 4.2 Relative references in `super:`

A child node's `super:` reference can use `..` to navigate up one level:

```json
{"field": {"name": "id", "super": "..::common::id"}}
```

Read: "go to my parent's parent (`..`), then descend into `common::id`."

Absolute references work too:
```json
{"field": {"name": "id", "super": "acme::common::id"}}
```

### 4.3 What `super:` means

When node B has `super: A`:
- B inherits A's children (fields, validators, attrs) by default
- B can add new children
- B can override A's children by re-declaring with the same name (last wins, modulo `override` semantics — see §5)
- B inherits A's reserved keys (`subType`, `isAbstract`, etc.) unless re-declared

### 4.4 Cross-file resolution

A `super:` reference can target a node in a different file, as long as both files were passed to `FileMetaDataLoader.loadFiles(paths[])` (or both live in the directory passed to `loadDirectory`). The loader resolves references across the full set of input files.

## 5. Overlay vs override

Two mechanisms exist for modifying inherited or imported nodes. They're often confused.

### 5.1 `super:` (inheritance)

The default. Child node inherits from parent; child can add children; child's same-name children replace parent's by default (without an `override` marker, behavior is permissive).

### 5.2 `override: true` on a child

Used inside a sub-classed object's children list to explicitly replace a parent's same-name child:

```json
{"object": {"name": "ChildObject", "super": "ParentObject",
  "children": [
    {"field": {"name": "id", "subType": "long", "override": true, "@dbColumn": "child_id"}}
  ]
}}
```

Signals intent: "this replaces ParentObject.id, not augments it."

### 5.3 `overlay:` on a top-level node

Used in a separate file to layer additional attributes onto an existing node without re-declaring its full structure:

```json
{"metadata": {"package": "acme",
  "children": [
    {"object": {"name": "Vehicle", "overlay": true, "@dbTable": "vehicles"}}
  ]
}}
```

When this file is loaded alongside one that declares `acme::Vehicle`, the overlay merges its attrs (and any added children) onto the existing definition. Overlays are how packages add Meta Forge concerns to existing entities without rewriting them, or how database/codegen attrs get layered onto entities defined by domain modelers.

## 6. Worked example — a full file

```json
{
  "metadata": {
    "package": "myapp",
    "children": [
      {
        "object": {
          "name": "User",
          "subType": "map",
          "@dbTable": "users",
          "children": [
            {"field": {"name": "id", "subType": "long", "@dbColumn": "id"}},
            {"field": {"name": "email", "subType": "string", "@dbColumn": "email",
              "@maxLength": 255,
              "children": [{"validator": {"subType": "required"}}]
            }},
            {"identity": {"name": "pk", "subType": "primary", "@fields": ["id"]}}
          ]
        }
      }
    ]
  }
}
```

## 7. Loader API

Two entry points (TypeScript):

```typescript
import { FileMetaDataLoader, MetaDataLoader, InMemorySource } from "@metaobjects/metadata";

// Load specific files from disk:
const loader = new FileMetaDataLoader();
const result1 = await loader.loadFiles(["path/to/a.json", "path/to/b.json"]);

// Load everything in a directory:
const result2 = await loader.loadDirectory("path/to/dir", {
  exclude: ["_pending/**"],
});

// Load from an in-memory JSON string (e.g. in tests):
const result3 = await new MetaDataLoader().load([new InMemorySource(jsonString)]);

// result.root is the merged MetaModel; result.errors / result.warnings carry diagnostics.
```

Strict mode rejects unknown types/attributes; permissive mode (the default) tolerates them as warnings. Set via `new FileMetaDataLoader({ strict: true })`.

## 8. See also

- [SP4 design](docs/specs/2026-05-11-v0.2-sp4-migrate-ts-design.md) — migration tool that reads metadata
- [SP5 design](docs/specs/2026-05-12-v0.2-sp5-cli-extensions-design.md) — CLI that wraps codegen + migrate
- [`packages/sdk/FORGE-METADATA.md`](../sdk/FORGE-METADATA.md) — Meta Forge's `@forge*` attribute namespace + new top-level types

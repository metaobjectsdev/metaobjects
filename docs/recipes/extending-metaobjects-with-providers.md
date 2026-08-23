# Extending MetaObjects with a custom provider

This recipe walks through adding a new metamodel subtype to a downstream
project — using the same `example-template-toolcall` example the conformance
fixtures use, so the example here matches a real test that runs in TS, C#,
and Python.

For the conceptual reference (what a provider is, the error codes, the
cross-port semantic rule), see
[`../features/extending-with-providers.md`](../features/extending-with-providers.md).

## The scenario

You're building an LLM-driven app. The metamodel knows about `template.prompt`
(LLM-targeted Mustache template) and `template.output` (any other rendered
artifact), but not `template.toolcall` — the structured-output tool-call
envelope your app needs to drive Anthropic's `tool_use` mode. You want:

1. To declare toolcalls in YAML/JSON metadata, with `@payloadRef`, `@textRef`,
   `@toolName` attrs.
2. The loader to validate those declarations (unknown subtypes, missing attrs,
   wrong types — all caught at load time, not runtime).
3. A custom code generator to walk those toolcall nodes and emit typed wrapper
   functions.

The recipe shows steps 1 + 2. Step 3 (the custom generator) follows the
existing `exampleRegistry` pattern in this repo — see
[`features/templates-and-payloads.md`](../features/templates-and-payloads.md)
for how custom generators walk MO-typed metadata.

## 1. Write the provider

A provider is ~25 lines. Drop it next to your codegen config:

```ts
// src/codegen/example-provider.ts
import {
  type MetaDataTypeProvider,
  TYPE_TEMPLATE,
  TYPE_ATTR,
  TypeId,
  MetaTemplate,
  CHILD_RULE_WILDCARD,
  ATTR_SUBTYPE_STRING,
} from "@metaobjectsdev/metadata";

export const exampleProvider: MetaDataTypeProvider = {
  id: "example-template-toolcall",
  dependencies: ["metaobjects-core-types"],
  description: "Adds template.toolcall for LLM tool-use templates.",
  registerTypes(registry) {
    registry.register({
      typeId: new TypeId(TYPE_TEMPLATE, "toolcall"),
      description: "Template that emits an LLM tool-call envelope.",
      factory: (typeId, name) => new MetaTemplate(typeId, name),
      childRules: [
        { childType: TYPE_ATTR, childSubType: CHILD_RULE_WILDCARD, childName: CHILD_RULE_WILDCARD },
      ],
      attributes: [
        { name: "payloadRef", valueType: ATTR_SUBTYPE_STRING, required: true,
          description: "Tool-input payload value-object reference." },
        { name: "textRef",    valueType: ATTR_SUBTYPE_STRING, required: true,
          description: "Tool-call template body reference." },
        { name: "toolName",   valueType: ATTR_SUBTYPE_STRING, required: true,
          description: "Name of the LLM tool to invoke." },
      ],
    });
  },
};
```

Notable bits:

- **`dependencies: ["metaobjects-core-types"]`** ensures the core type registry
  loads first so `TYPE_TEMPLATE` is known when we extend it.
- **`factory`** maps the `(type, subType)` to a concrete node class. Reuse
  `MetaTemplate` because `toolcall` is structurally a template; for a brand-new
  shape, write your own `class extends MetaData`.
- **`childRules`** declares what child node types are legal. Wildcards
  (`*` / `CHILD_RULE_WILDCARD`) accept anything — tighten for stricter
  validation.
- **`attributes`** is the closed list of attr schemas. `payloadRef` / `textRef`
  / `toolName` are required strings; the loader rejects any node that omits
  them.

## 2. Wire the provider into `metaobjects.config.ts`

```ts
// metaobjects.config.ts
import { defineConfig } from "@metaobjectsdev/cli";
// Owned generators scaffolded by `meta init` (ADR-0034 scaffold-and-own).
import { entityFile } from "./codegen/generators/entity";
import { queriesFile } from "./codegen/generators/queries";
import { barrel } from "./codegen/generators/barrel";
import { promptRender } from "@metaobjectsdev/codegen-ts/generators";
import { exampleProvider } from "./src/codegen/example-provider";

export default defineConfig({
  outDir: "src/db/generated",
  dialect: "sqlite",
  providers: [exampleProvider],                            // ← the new field
  generators: [entityFile(), queriesFile(), barrel(), promptRender()],
});
```

`defineConfig({ providers })` threads the list through to every CLI command
(`meta gen`, `meta verify`, `meta migrate`, `meta prompt-snapshot`) so all
tooling sees the same metamodel.

## 3. Author metadata that uses the new subtype

<!-- meta-example: external-provider -->

```jsonc
// metaobjects/meta.toolcalls.json
{ "metadata.root": {
    "package": "examples",
    "children": [
      { "object.value": {
        "name": "ToolCall",
        "children": [
          { "field.string": { "name": "spell" } },
          { "field.string": { "name": "target" } }
        ]
      }},
      { "template.toolcall": {
        "name": "InvokeTool",
        "@payloadRef": "ToolCall",
        "@textRef": "tools/invoke",
        "@toolName": "invoke_tool"
      }}
    ]
}}
```

YAML works just as well:

```yaml
# metaobjects/meta.toolcalls.yaml
metadata:
  package: examples
  children:
    - object.value:
        name: ToolCall
        children:
          - field.string: { name: spell }
          - field.string: { name: target }
    - template.toolcall:
        name: InvokeTool
        "@payloadRef": ToolCall
        "@textRef": tools/invoke
        "@toolName": invoke_tool
```

Run `meta gen` and the loader recognizes `template.toolcall`, validates the
three required attrs, and resolves `@payloadRef` against the package's
`ToolCall` value-object.

## 4. What you get from this

Once the provider is wired, three things happen automatically:

- **Load-time validation.** Omit `@toolName` from a toolcall declaration and
  `meta verify` reports `ERR_MISSING_REQUIRED_ATTR` with the exact JSON path.
  Misspell `@paloadRef` and the loader catches it instead of silently passing.
- **A traversable AST.** Custom code generators can walk
  `root.ownChildren().filter((c) => c.type === "template" && c.subType === "toolcall")`
  to find every toolcall declaration. The
  [`example-template-toolcall` example in
  the canonical pattern is the existing `exampleRegistry` generator: it walks
  `root.ownChildren()` filtered by `(type, subType)` and emits one TS file per
  matched node. Custom toolcall generators do the same — emit
  `callEmit<Name>(params)` wrapper functions, one per toolcall declaration.
- **Cross-tool consistency.** `meta gen` / `meta verify` / `meta migrate` all
  see the same metamodel because they share the provider list.

## 5. Verify it works

```bash
$ meta gen
✓ Loaded 3 metadata files (2 entities, 1 toolcall).
✓ Generators ran: entity-file, queries-file, barrel, prompt-render, structured-completion.
✓ 7 files written under src/db/generated/ + src/llm/generated/.

$ meta verify
✓ No metadata drift. 4 providers composed:
    metaobjects-core-types, metaobjects-forge, metaobjects-documentation, example-template-toolcall
```

## What happens when the provider is missing

Forget to add `providers: [exampleProvider]` to `defineConfig` (or to delete
the provider entirely), and the same metadata fails to load:

```
$ meta gen
✗ ERR_UNKNOWN_SUBTYPE at metaobjects/meta.toolcalls.json:6
    template.toolcall — unknown subtype 'toolcall' on type 'template'.
    Known subtypes: prompt, output.
    Hint: register a provider declaring this subtype before loading.
```

That's the value: **the metamodel becomes self-checking**. The toolcall
declarations and the provider that gives them meaning live in the same
project, and any divergence is caught at the load boundary, not at runtime.

## C# / Python equivalents

The C# and Python ports use the same provider contract — the only difference
is the API surface for loader composition. See the per-port quickstarts:

- [`../ports/csharp.md`](../ports/csharp.md)
- [`../ports/python.md`](../ports/python.md)

The provider object itself is structurally identical across languages
(id + dependencies + description + a body that calls `registry.register` or
`registry.extend`). A C# port of `exampleProvider` reads exactly like the TS
version with C# spelling.

## When NOT to write a provider

You don't need a provider if:

- The vocabulary is one project-specific declaration — just put it in your
  metadata files using existing subtypes.
- You're extending a single attribute that already has a stable convention
  (e.g., `@since`, `@deprecated` are first-class on every node).
- The "new subtype" is structurally identical to an existing one and only
  differs by name — that's a discriminator value, not a subtype.

You DO want a provider when the same domain concept shows up across multiple
metadata files, requires its own validation, and benefits from custom codegen.
`template.toolcall` qualifies; a one-off `template.welcome-email` does not.

## See also

- [`../features/extending-with-providers.md`](../features/extending-with-providers.md) — the conceptual reference
- [`../features/templates-and-payloads.md`](../features/templates-and-payloads.md) — the built-in `template.prompt` + `template.output` subtypes
- [`../../fixtures/conformance/provider-extension-new-subtype-success/`](../../fixtures/conformance/provider-extension-new-subtype-success/) — the matching conformance fixture
- The conformance fixture at
  [`../../fixtures/conformance/provider-extension-new-subtype-success/`](../../fixtures/conformance/provider-extension-new-subtype-success/) —
  a runnable proof of this exact pattern across TS / C# / Python

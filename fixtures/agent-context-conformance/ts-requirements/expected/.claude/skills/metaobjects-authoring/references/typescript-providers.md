# Your own vocabulary in TypeScript — a provider

> Part of the `metaobjects-authoring` skill, "Your own vocabulary". Read it when the project
> needs a subtype or an attribute the core does not ship, and its TypeScript tools load the
> metadata.

A provider is an object implementing `MetaDataTypeProvider`: an `id`, the provider ids it
depends on, and a `registerTypes(registry)` body that calls `register` (a new subtype) and
`extend` (attributes on an existing one). This one registers `layout.picker` and adds
`@searchable` and `@valueLabels` to `field.string`:

```ts
// codegen/vocabulary.ts
import { TypeId, MetaLayout, type MetaDataTypeProvider } from "@metaobjectsdev/metadata";
import {
  TYPE_FIELD, TYPE_LAYOUT, FIELD_SUBTYPE_STRING,
  ATTR_SUBTYPE_STRING, ATTR_SUBTYPE_BOOLEAN,
} from "@metaobjectsdev/metadata/constants";

export const vocabulary: MetaDataTypeProvider = {
  id: "acme-vocabulary",
  dependencies: ["metaobjects-core-types"],
  registerTypes(registry) {
    // A new subtype, with its own attribute (an own attribute may be required).
    registry.register({
      typeId: new TypeId(TYPE_LAYOUT, "picker"),
      description: "A picker over the owning object.",
      factory: (typeId, name) => new MetaLayout(typeId, name),
      childRules: [],
      attributes: [
        { name: "displayField", valueType: ATTR_SUBTYPE_STRING, required: false, description: "Field shown per choice." },
      ],
    });
    // Attributes on a type another provider owns: always optional.
    registry.extend(TYPE_FIELD, FIELD_SUBTYPE_STRING, {
      attributes: [
        { name: "searchable", valueType: ATTR_SUBTYPE_BOOLEAN, required: false, description: "Offer in search." },
        { name: "valueLabels", valueType: ATTR_SUBTYPE_STRING, isArray: true, required: false, description: "Display labels." },
      ],
    });
  },
};
```

Wire it once, in `metaobjects.config.ts`:

```ts
import { defineConfig } from "@metaobjectsdev/cli";
import { vocabulary } from "./codegen/vocabulary";

export default defineConfig({
  generators: [/* ... */],
  providers: [vocabulary],
});
```

Every `meta` command that loads metadata reads that list: `gen` (with the docs generators and
the docs site), `verify`, `migrate`, `fmt`, `types`, `export`, `deps`, `upgrade`. `meta types
picker` then lists the new subtype. A config that fails to load is reported as its own error,
never as an unknown subtype. Code that loads the model itself passes the same provider:
`loadMemory(root, { providers: [vocabulary] })`.

The metadata uses it like core vocabulary:

<!-- meta-example: external-provider -->
```json
{ "field.string": { "name": "name", "@searchable": true } }
{ "layout.picker": { "name": "contactPicker", "@displayField": "name" } }
```

Without the provider the same file fails `meta verify` with `ERR_UNKNOWN_SUBTYPE` on
`layout.picker` and `ERR_UNKNOWN_ATTR` on `@searchable`. If another port's tools load this
metadata too, that port needs its own copy of the provider (same `id`, same vocabulary).
Full contract: `docs/features/extending-with-providers.md`.

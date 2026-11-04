# Your own vocabulary in Python — a provider

> Part of the `metaobjects-authoring` skill, "Your own vocabulary". Read it when the project
> needs a subtype or an attribute the core does not ship, and its Python tools load the
> metadata.

A provider is a `metaobjects.provider.Provider`: an id, the provider ids it depends on, the
`TypeDefinition`s it adds (a new subtype), and an `on_register` hook that `extend`s existing
types. This one registers `layout.picker` and adds `@searchable` and `@valueLabels` to
`field.string`:

```python
# acme_vocab.py (beside metaobjects.config.yaml)
from metaobjects.meta.presentation.layout.meta_layout import MetaLayout
from metaobjects.provider import Provider
from metaobjects.registry import AttrSchema, ChildRule, TypeDefinition
from metaobjects.shared.base_types import TYPE_ATTR

provider = Provider("acme-vocabulary", dependencies=("metaobjects-core-types",))

# A new subtype, with its own attribute (an own attribute may be required).
provider.add(TypeDefinition(
    type="layout", sub_type="picker", factory=MetaLayout,
    attrs=[AttrSchema("displayField", "string", required=False)],
    child_rules=[ChildRule(TYPE_ATTR, "*")],
))

# Attributes on a type another provider owns: always optional.
provider.on_register(lambda registry: registry.extend(
    "field", "string",
    attributes=[
        AttrSchema("searchable", "boolean", required=False),
        AttrSchema("valueLabels", "string", required=False, is_array=True),
    ],
))
```

Wire it once, in `metaobjects.config.yaml`, as `module:symbol`. The module resolves relative
to the config's directory, so no `PYTHONPATH` is needed:

```yaml
metadata: metaobjects
providers: ["acme_vocab:provider"]
```

`metaobjects gen` (with its docs generators), every `metaobjects verify` mode and
`metaobjects fmt` read that list; `--provider module:symbol` adds to it for one run. Code that
loads the model itself passes the full list, core first, because `providers=` is exactly the
set composed:

```python
from metaobjects.core_types import core_providers
from metaobjects.loader.meta_data_loader import MetaDataLoader

result = MetaDataLoader.from_directory("metaobjects", providers=[*core_providers, provider], strict=True)
```

The metadata uses it like core vocabulary:

<!-- meta-example: external-provider -->
```json
{ "field.string": { "name": "name", "@searchable": true } }
{ "layout.picker": { "name": "contactPicker", "@displayField": "name" } }
```

Without the provider the same file fails `metaobjects verify` with `ERR_UNKNOWN_SUBTYPE` on
`layout.picker` and `ERR_UNKNOWN_ATTR` on `@searchable`. If another port's tools load this
metadata too, that port needs its own copy of the provider (same id, same vocabulary). Full
contract: `docs/features/extending-with-providers.md`.

# Your own vocabulary in Kotlin — a provider

> Part of the `metaobjects-authoring` skill, "Your own vocabulary". Read it when the project
> needs a subtype or an attribute the core does not ship, and its Kotlin tools load the
> metadata.

Kotlin runs on the JVM registry, so a provider is a class implementing
`com.metaobjects.registry.MetaDataTypeProvider`, written in Kotlin: a provider id, the JVM
provider ids it depends on (`field-types`, `layout-types`), and a `registerTypes` body that
calls `registerType` (a new subtype, backed by its own node class) and `extendType`
(attributes on an existing one). This one registers `layout.picker` and adds `@searchable` and
`@valueLabels` to `field.string`:

```kotlin
package com.acme.vocab

import com.metaobjects.field.StringField
import com.metaobjects.layout.MetaLayout
import com.metaobjects.registry.MetaDataRegistry
import com.metaobjects.registry.MetaDataTypeProvider

/** The node class behind layout.picker. */
class PickerLayout(name: String) : MetaLayout("picker", name)

class AcmeVocabulary : MetaDataTypeProvider {
    override fun getProviderId() = "acme-vocabulary"
    override fun getDependencies() = arrayOf("field-types", "layout-types")

    override fun registerTypes(registry: MetaDataRegistry) {
        // A new subtype, with its own attribute (an own attribute may be required).
        registry.registerType(PickerLayout::class.java) { def ->
            def.type("layout").subType("picker").inheritsFrom("layout", "base")
            def.optionalAttributeWithConstraints("displayField").ofType("string").asSingle()
        }
        // Attributes on a type another provider owns: always optional.
        registry.extendType(StringField::class.java) { def ->
            def.optionalAttributeWithConstraints("searchable").ofType("boolean").asSingle()
            def.optionalAttributeWithConstraints("valueLabels").ofType("string").asArray()
        }
    }
}
```

Wire it once. Kotlin generators run through `metaobjects:generate`, so the build lists it in
the `metaobjects-maven-plugin` configuration, with the provider's module on the plugin's
classpath (a project dependency or the plugin's `<dependencies>`; a provider in the same
module is not compiled yet at `generate-sources`):

```xml
<configuration>
  <providers>
    <provider>com.acme.vocab.AcmeVocabulary</provider>
  </providers>
</configuration>
```

`generate`, `verify`, `fmt` and `editor` then all load it. `META-INF/services` does not add a
provider to the loader. In a Spring Boot app, a `MetaDataTypeProvider` bean is composed into
the auto-configured loader. Code that loads the model through the `metadata-ktx` facade passes
it directly:

```kotlin
val result = loadUris("app", uris, LoaderOptions.create(false, false, true), providers = listOf(AcmeVocabulary()))
```

The metadata uses it like core vocabulary:

<!-- meta-example: external-provider -->
```json
{ "field.string": { "name": "name", "@searchable": true } }
{ "layout.picker": { "name": "contactPicker", "@displayField": "name" } }
```

Without the provider the same file fails `metaobjects:verify` with `ERR_UNKNOWN_SUBTYPE` on
`layout.picker` and `ERR_UNKNOWN_ATTR` on `@searchable`. If another port's tools load this
metadata too, that port needs its own copy of the provider (the same vocabulary). Full
contract: `docs/features/extending-with-providers.md`.

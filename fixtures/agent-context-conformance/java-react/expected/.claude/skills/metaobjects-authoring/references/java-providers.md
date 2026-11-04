# Your own vocabulary in Java — a provider

> Part of the `metaobjects-authoring` skill, "Your own vocabulary". Read it when the project
> needs a subtype or an attribute the core does not ship, and its Java tools load the metadata.

A provider is a public class implementing `com.metaobjects.registry.MetaDataTypeProvider`, with
a public no-arg constructor: a provider id, the provider ids it depends on (the JVM ids:
`field-types` registers the field types, `layout-types` the layouts), and a `registerTypes`
body that calls `registerType` (a new subtype, backed by its own node class) and `extendType`
(attributes on an existing one). This one registers `layout.picker` and adds `@searchable` and
`@valueLabels` to `field.string`:

```java
package com.acme.vocab;

import com.metaobjects.attr.BooleanAttribute;
import com.metaobjects.attr.StringAttribute;
import com.metaobjects.field.StringField;
import com.metaobjects.layout.MetaLayout;
import com.metaobjects.registry.MetaDataRegistry;
import com.metaobjects.registry.MetaDataTypeProvider;

public final class AcmeVocabulary implements MetaDataTypeProvider {
    /** The node class behind layout.picker. */
    public static final class PickerLayout extends MetaLayout {
        public PickerLayout(String name) { super("picker", name); }
    }

    @Override public String getProviderId() { return "acme-vocabulary"; }
    @Override public String[] getDependencies() { return new String[] {"field-types", "layout-types"}; }

    @Override public void registerTypes(MetaDataRegistry registry) {
        // A new subtype, with its own attribute (an own attribute may be required).
        registry.registerType(PickerLayout.class, def -> {
            def.type("layout").subType("picker").inheritsFrom("layout", "base");
            def.optionalAttributeWithConstraints("displayField").ofType(StringAttribute.SUBTYPE_STRING).asSingle();
        });
        // Attributes on a type another provider owns: always optional.
        registry.extendType(StringField.class, def -> {
            def.optionalAttributeWithConstraints("searchable").ofType(BooleanAttribute.SUBTYPE_BOOLEAN).asSingle();
            def.optionalAttributeWithConstraints("valueLabels").ofType(StringAttribute.SUBTYPE_STRING).asArray();
        });
    }
}
```

Wire it once, in the `metaobjects-maven-plugin` configuration. The class must be on the
plugin's classpath: put the provider in its own module and add that module as a project
dependency or under the plugin's `<dependencies>`. A provider in the same module is not
compiled yet when `generate` runs at `generate-sources`.

```xml
<plugin>
  <groupId>com.metaobjects</groupId>
  <artifactId>metaobjects-maven-plugin</artifactId>
  <configuration>
    <providers>
      <provider>com.acme.vocab.AcmeVocabulary</provider>
    </providers>
  </configuration>
  <dependencies>
    <dependency><groupId>com.acme</groupId><artifactId>acme-vocabulary</artifactId><version>1.0</version></dependency>
  </dependencies>
</plugin>
```

`metaobjects:generate` (with its docs generators), `metaobjects:verify`, `metaobjects:fmt` and
`metaobjects:editor` all compose the metamodel providers plus these. Listing a class in
`META-INF/services` does NOT add it to the loader: the strict loader composes a fixed
metamodel set plus the providers you name, so a jar on the classpath cannot change the
vocabulary by accident.

In a Spring Boot app, declare the provider as a bean and the auto-configured loader composes
it: `@Bean MetaDataTypeProvider acmeVocabulary() { return new AcmeVocabulary(); }`. Code that
loads the model itself passes it on the options:

```java
MetaDataLoader.fromUris("app", uris,
    LoaderOptions.create(false, false, true).setProviders(List.of(new AcmeVocabulary())));
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

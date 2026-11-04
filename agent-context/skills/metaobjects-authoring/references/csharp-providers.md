# Your own vocabulary in C# — a provider

> Part of the `metaobjects-authoring` skill, "Your own vocabulary". Read it when the project
> needs a subtype or an attribute the core does not ship, and its C# tools load the metadata.

A provider is a public class implementing `IMetaDataTypeProvider`, with a public parameterless
constructor: an `Id`, the provider ids it depends on, and a `RegisterTypes(registry)` body that
calls `Register` (a new subtype) and `Extend` (attributes on an existing one). Put it in its
own class library that references the `MetaObjects` package at the version your `dotnet meta`
tool runs. This one registers `layout.picker` and adds `@searchable` and `@valueLabels` to
`field.string`:

```csharp
// vocabulary/AcmeVocabularyProvider.cs  (vocabulary/Acme.Vocabulary.csproj: net8.0 class
// library with <PackageReference Include="MetaObjects" Version="<your tool's version>" />)
using MetaObjects;
using MetaObjects.Meta;
using MetaObjects.Shared;

namespace Acme.Vocabulary;

public sealed class AcmeVocabularyProvider : IMetaDataTypeProvider
{
    public string Id => "acme-vocabulary";
    public IReadOnlyList<string> Dependencies => ["metaobjects-core-types"];

    public void RegisterTypes(TypeRegistry registry)
    {
        // A new subtype, with its own attribute (an own attribute may be required).
        registry.Register(new TypeDefinition(
            typeId: new TypeId("layout", "picker"),
            description: "A picker over the owning object.",
            childRules: [new ChildRule(BaseTypes.TYPE_ATTR, Structural.CHILD_RULE_WILDCARD, Structural.CHILD_RULE_WILDCARD)],
            factory: (typeId, name) => new MetaLayout(typeId, name),
            attributes: [new AttrSchema("displayField", "string", Required: false)]));

        // Attributes on a type another provider owns: always optional.
        registry.Extend("field", "string", attributes:
        [
            new AttrSchema("searchable", "boolean", Required: false),
            new AttrSchema("valueLabels", "string", Required: false, IsArray: true),
        ]);
    }
}
```

Wire it once, in `.metaobjects/config.json`. `assembly` is the BUILT dll, relative to the
directory holding `.metaobjects/`; `type` is the provider's full type name:

```json
{
  "schema_version": 1,
  "csharp": {
    "providers": [
      { "assembly": "vocabulary/bin/Debug/net8.0/Acme.Vocabulary.dll", "type": "Acme.Vocabulary.AcmeVocabularyProvider" }
    ]
  }
}
```

Build the vocabulary first (`dotnet build vocabulary`); a missing dll is refused with the path
and that instruction. Then `dotnet meta gen` and `verify --codegen` (through the project's
`codegen/` runner), `dotnet meta verify` (templates, requirements, field lint) and
`dotnet meta fmt` all compose the core providers plus this one. The `codegen/` project may
also reference the vocabulary project directly; the already-loaded assembly is reused.

An application host that loads the model itself composes the registry in code:

```csharp
var registry = Provider.ComposeRegistry([.. CoreTypes.LibraryProviders, new AcmeVocabularyProvider()]);
var load = MetaDataLoader.FromDirectory("metaobjects", registry, strict: true);
```

The metadata uses it like core vocabulary:

<!-- meta-example: external-provider -->
```json
{ "field.string": { "name": "name", "@searchable": true } }
{ "layout.picker": { "name": "contactPicker", "@displayField": "name" } }
```

Without the provider the same file fails `dotnet meta verify` with `ERR_UNKNOWN_SUBTYPE` on
`layout.picker` and `ERR_UNKNOWN_ATTR` on `@searchable`. If another port's tools load this
metadata too, that port needs its own copy of the provider (same id, same vocabulary). Full
contract: `docs/features/extending-with-providers.md`.

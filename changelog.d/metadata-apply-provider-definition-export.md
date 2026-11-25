- **metadata: a provider outside core can register vocabulary from a definition file.**
  `applyProviderDefinition` and its types (`ProviderDefinition`, `TypeDef`, `ChildDef`,
  `ExtendDef`, `FactoryMap`, `ValidatorMap`) are exported from `@metaobjectsdev/metadata`, with
  the validation hook's types (`NodeValidator`, `ValidationContext`, `SymbolTable`,
  `LoaderCode`). `applyProviderDefinition` takes an optional fourth argument, a
  `"<type>.<subType>"` → validator map, so a type registered from data can carry a check the data
  cannot express. `referrerPackageFor` (ADR-0059 R3: the package a reference attribute resolves
  in) is exported too, so a provider's own reference check resolves as the loader's does. The
  bundled packs already registered this way; the independent packs under `packs/` (ADR-0069) now
  can too. No vocabulary or `metamodelVersion` change.

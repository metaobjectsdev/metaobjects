### C#: generate with `dotnet meta gen`

1. **Config.** `codegen/Generators.cs` (written by `dotnet meta init`) is the generator list.
   Nothing is generated until it is listed. The EF Core data layer and its routes:

   ```csharp
   new MetaObjects.Codegen.Generators.EntityGenerator(),
   new MetaObjects.Codegen.Generators.DbContextGenerator(),
   new MetaObjects.Codegen.Generators.FilterAllowlistGenerator(),
   new MetaObjects.Codegen.Generators.RoutesGenerator(),
   ```

   `RequirementTestsGenerator { OutDir = "<tests project>/Generated" }` writes one test per
   requirement; `ApiDocsGenerator` writes `api/csharp/AGENT-API.md`. `dotnet meta gen --list`
   is the catalog.
2. **Generate.** `dotnet meta gen`. `dotnet meta eject <name>` copies a generator into the repo
   to change what it emits.

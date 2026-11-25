- **C#: the route helpers are their own package, `MetaObjects.AspNetCore`, and `MetaObjects.Codegen`
  and the `dotnet meta` tool no longer carry EF Core.** `FilterParser`, `FilterParseResult`,
  `FilterPredicate`, `EfCoreFilterDispatch`, `ValueObjectValidator`, `ConstraintErrors`,
  `ValidationIssues`, `UnknownFieldCheck`, `Iso8601TimestampConverter`, `DecimalWire`,
  `DurationWire`, `DecimalRangeEndpointFilter`, `ReportExportHttp` and `SerializerKeys` moved from
  `MetaObjects.Codegen` (namespace `MetaObjects.Codegen.Runtime`) to the new `MetaObjects.AspNetCore`
  package (namespace `MetaObjects.AspNetCore`), which depends on ASP.NET Core and EF Core and on no
  MetaObjects package. `MetaObjects.Codegen` drops its EF Core and ASP.NET Core references: the tool
  installs about 42% smaller (14 DLLs to 6), and the first restore of a `codegen/` project no longer
  pulls EF Core's 11 packages. `ExtractObject` and `M2MResolver` stay in `MetaObjects.Codegen` under
  `MetaObjects.Codegen.Runtime`. The packaged routes generator now writes `using MetaObjects.AspNetCore;`,
  so the next `dotnet meta gen` moves that line in every generated routes file. `dotnet meta gen` and
  `dotnet meta verify` warn when a generated file imports `MetaObjects.AspNetCore` and the project
  that compiles it (the one `.csproj` in its directory or above, a project it references, or a
  `Directory.Build.props`/`.targets` above them) does not reference the package, and when generated
  output still imports the helpers from `MetaObjects.Codegen.Runtime`. Both warnings are advisory.
  `dotnet meta eject routes` still copies the helpers into `codegen/runtime/` as `Codegen.Runtime`.
  Generated-output change — regenerate to pick it up; three-way merge preserves hand edits.

  Upgrading: add `<PackageReference Include="MetaObjects.AspNetCore" Version="1.3.0" />` to the
  app that compiles the generated routes, run `dotnet meta gen`, and change any hand-written
  `using MetaObjects.Codegen.Runtime;` that names one of the helpers (a host registering
  `Iso8601TimestampConverter`, say) to `using MetaObjects.AspNetCore;`. A routes generator you
  ejected before the helpers were handed over writes `using MetaObjects.Codegen.Runtime;`: set its
  `HelperRuntimeNamespace` constant to `"MetaObjects.AspNetCore"`, or re-eject with
  `dotnet meta eject routes --force`. An app that only uses the ejected helpers in `codegen/runtime/`
  needs nothing.

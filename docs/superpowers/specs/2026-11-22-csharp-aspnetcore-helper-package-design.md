# C#: the route helpers become their own package (1.3.0)

**Status:** decided 2026-11-22 (owner: "make the C# change to split that out"), built in 1.3.0.

## Problem

`MetaObjects.Codegen` carried a `PackageReference` on EF Core and a `FrameworkReference` on
ASP.NET Core for one reason: the helpers under `MetaObjects.Codegen/Runtime/` that generated
routes call. `EfCoreFilterDispatch.cs` was the only source in the assembly that used an EF Core
type, and the generators only write EF code as text. Everything that installs the generators paid
for it: the `dotnet meta` tool (14 DLLs, 11.9 MB installed, EF Core present twice) and every
`codegen/` project's first restore (EF Core's 11-package closure, about 25 MB). The code that
needs EF Core runs in the adopter's app, which already restores EF Core for the generated
`AppDbContext`.

## Package boundary

A new project and NuGet package, `server/csharp/MetaObjects.AspNetCore/`, id and namespace
`MetaObjects.AspNetCore`. It holds the fourteen files `HelperRuntime.Files` lists (the filter
parser and its result and predicate types, `EfCoreFilterDispatch`, `ValueObjectValidator`,
`ConstraintErrors`, `ValidationIssues`, `UnknownFieldCheck`, `Iso8601TimestampConverter`,
`DecimalWire`, `DurationWire`, `DecimalRangeEndpointFilter`, `ReportExportHttp`,
`SerializerKeys`). It references ASP.NET Core and EF Core 8 and **no MetaObjects package**: the
helper set was already closed (eject copies it into an adopter's repo as it is), and the project
boundary now enforces that by compilation.

The name says what it binds to, the .NET convention for a framework integration package. It is
not called `MetaObjects.Runtime`: the runtime-metadata pillar is a separate, unbuilt C#
capability, and a package by that name would claim it.

What stays in `MetaObjects.Codegen`, under `MetaObjects.Codegen.Runtime`: `ExtractObject` (the
reply parser the generated output parsers delegate to; it needs the metamodel and
`MetaObjects.Render`) and `M2MResolver` (metadata-driven M:N traversal). Both are core, neither
uses EF Core or ASP.NET Core, and moving them would put a prompt-only app on an EF Core
dependency. `MetaObjects.Codegen` drops both framework references.

## Eject

`dotnet meta eject routes` still copies the helpers into `codegen/runtime/` as `Codegen.Runtime`.
The tool cannot compile the new project (that is the point), so `MetaObjects.Codegen.csproj`
embeds the files' source by link (`<EmbeddedResource Include="../MetaObjects.AspNetCore/<file>"
LogicalName="MetaObjects.AspNetCore.<file>" />`). `HelperRuntimeTests` keeps its gates: each
embedded copy equals its source, the embedded set equals `HelperRuntime.Files`, and every file in
`MetaObjects.AspNetCore/` is a helper and every file in `MetaObjects.Codegen/Runtime/` is core.
The owned namespace is unchanged, so copies ejected before 1.3.0 compare as they did.

## The namespace move on regen

The packaged routes generator's `HelperRuntimeNamespace` is `MetaObjects.AspNetCore`, so the next
`dotnet meta gen` rewrites the one `using` line in every generated routes file. Nothing else in
generated output changes. An owned routes generator keeps `Codegen.Runtime` and is unaffected.

## The reference warning

`dotnet meta gen` (from what it writes) and `dotnet meta verify --codegen` (from the committed
generated files, on the cached fast path too) warn, never fail, when:

1. a generated file imports `MetaObjects.AspNetCore` and its project does not reference the
   package. The project is the one `.csproj` in the file's directory or above (the rule the
   DbContext's assembly name already uses). The reference counts when it is in that project, a
   project it references (transitively), or a `Directory.Build.props`/`.targets` above any of
   them, as a `PackageReference` or a `ProjectReference`. No project found, or a file that cannot
   be read, is silent: the drift-check bias is toward under-flagging. The warning names the
   project and the exact `PackageReference` line to add.
2. a generated file still imports `MetaObjects.Codegen.Runtime` and names one of the moved types:
   the output of a routes generator owned from before the helpers were handed over. The warning
   says to set its `HelperRuntimeNamespace` to `MetaObjects.AspNetCore` or re-eject.

## Upgrade path

Add `<PackageReference Include="MetaObjects.AspNetCore" Version="1.3.0" />` to the app, run
`dotnet meta gen`, and change any hand-written `using MetaObjects.Codegen.Runtime;` that names a
helper (typically the host's `Iso8601TimestampConverter` registration). The CHANGELOG carries
this under 1.3.0's "Upgrading from 1.2.0". There is no forwarding shim: a type-forward from
`MetaObjects.Codegen` would need the reference this change removes.

## Publishing

`MetaObjects.AspNetCore` joins the lockstep C# set: `publish-csharp.yml`, `scripts/prerelease.mjs`
and `docs/RELEASING.md` pack five packages.

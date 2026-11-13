# `xpkg-value-object-refs/` — one file meets two same-named types from two packages

One metadata input every port's codegen test loads. Nothing is renamed: each
object keeps its short name in its own package, so the generated code that meets two of them
must tell them apart without a rename.

| Object | Package | Meets |
|---|---|---|
| `Host` (entity) | `acme::app` | `acme::alpha::Note` (`fromAlpha`) and `acme::beta::Note` (`fromBeta`, an array; `byKey`, a map) — the routes' and the entity's value-object types |
| `Summary` (a stored-procedure read model) | `acme::app` | its own arguments object, `acme::alpha::Summary` — the callable wrapper names both |

A port that writes every package into one namespace or module directory refuses this model
with `ERR_NAME_COLLISION` (two `Note`s, two `Summary`s); the corpus is run with the packages
kept apart — C# by default (each package is its own namespace), TypeScript `outputLayout: "package"` (the default). With them apart, every
generated file that names one of the pair must name it unambiguously:

- **C#:** every generated file names a type of another namespace `global::`-qualified (a bare
  `Note` or `Summary` under `using`s of both namespaces is `CS0104`).
- **TypeScript:** a file that imports both binds each under a package-qualified local alias
  (`import type { Note as AcmeAlphaNote }`).

The C# runner compiles every file except the routes (which need the ASP.NET Core shared
framework, see `CodegenCompileConformanceTests`) and asserts the routes' type references.

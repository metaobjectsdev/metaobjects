# Maintainers

This file lists who holds each role in the project and who owns each registry package today.
[GOVERNANCE.md](GOVERNANCE.md) defines the roles and how they are earned. A change to this file
goes through a pull request like any other change.

## Core maintainers

| Name | GitHub | Contact |
|---|---|---|
| Doug Mealing (creator) | [`dmealing`](https://github.com/dmealing) | doug@dougmealing.com |

The creator is the only maintainer today and covers every area below until it has a port
maintainer. Every area is open.

## Areas

| Area | Paths | Port maintainer |
|---|---|---|
| TypeScript server port (loader, codegen, runtime, migrations, CLI) | `server/typescript/` | Maintainer wanted |
| Web client (React, TanStack, Angular, framework-agnostic core) | `client/web/` | Maintainer wanted |
| Java port (loader, OMDB, render, Spring codegen, Maven plugin) | `server/java/` except the Kotlin modules | Maintainer wanted |
| Kotlin port | `server/java/codegen-kotlin/`, `server/java/metadata-ktx/`, `server/java/omdb-ktx/` | Maintainer wanted |
| C# port | `server/csharp/` | Maintainer wanted |
| Python port | `server/python/` | Maintainer wanted |
| Metamodel spec and conformance corpora (core-maintainer approval always applies) | `spec/`, `fixtures/` | Maintainer wanted |
| Documentation and the docs-site generator | `docs/`, `server/typescript/packages/docs-site/` | Maintainer wanted |
| Libraries (`ai`, `iam`) | `library/` | Maintainer wanted |
| Agent context (skills, `AGENTS.md` sources, `llms.txt`) | `agent-context/` | Maintainer wanted |
| CI and release tooling | `scripts/`, `.github/` | Maintainer wanted |

A new generator family (for example Prisma or Django) can become its own area once someone
maintains it.

## Registry owners

As of 2026-10-28, every registry package has a single owner, the creator.

| Registry | Packages | Owner today | How it is published |
|---|---|---|---|
| npm | The 14 `@metaobjectsdev/*` packages: `ai-runtime`, `cli`, `codegen-ts`, `codegen-ts-react`, `codegen-ts-tanstack`, `docs-site`, `metadata`, `migrate-ts`, `react`, `render`, `runtime-ts`, `runtime-web`, `sdk`, `tanstack` | npm user `dougmealing`, the only owner of each package, in the `metaobjectsdev` npm organization | Locally, by the release script ([docs/RELEASING.md](docs/RELEASING.md)) |
| Maven Central | The `com.metaobjects` namespace: the `metaobjects` parent POM and 14 modules (`metaobjects-metadata`, `-codegen-base`, `-codegen-mustache`, `-codegen-spring`, `-codegen-kotlin`, `-codegen-plantuml`, `-render`, `-metadata-ktx`, `-maven-plugin`, `-core-spring`, `-spring-boot-starter`, `-om`, `-omdb`, `-omdb-ktx`) | The creator's Sonatype Central Portal account, which holds the verified namespace; artifacts are signed with the creator's GPG key | Locally, with `mvn deploy` |
| NuGet | `MetaObjects`, `MetaObjects.Render`, `MetaObjects.Codegen`, `MetaObjects.Cli` | nuget.org organization `metaobjects`, administered by the creator | Trusted Publishing from `.github/workflows/publish-csharp.yml` |
| PyPI | `metaobjects` | PyPI user `dougmealing` (Owner) | Locally or from `.github/workflows/publish-python.yml` with an API token |

`@metaobjectsdev/angular` and `@metaobjectsdev/codegen-ts-angular` are source-only and are not on
npm ([ADR-0048](spec/decisions/ADR-0048-angular-tier-source-only.md)).

The `metaobjectsdev` GitHub organization has one member and owner, `dmealing`.

## Emeritus

None yet.

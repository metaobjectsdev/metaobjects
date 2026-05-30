# OMDB Spring Boot 3 Starter + Autoconfiguration — Design

_Date: 2026-05-29_

## Problem

The Java port's Spring integration (`core-spring`) registers its autoconfiguration
**only** through the legacy Boot 2.x `META-INF/spring.factories`
`EnableAutoConfiguration` key. **Spring Boot 3 no longer honors that key** —
autoconfiguration classes must be listed in
`META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports`.
The project builds on **Java 21** and **Spring Boot 3.5.6**, so today a consumer who
adds the dependency and expects `@SpringBootApplication` to pick MetaObjects up gets
**nothing** auto-wired; they must manually `@Import(MetaDataAutoConfiguration.class)`.
The existing integration test masks this because it wires the config via
`@ContextConfiguration(classes = MetaDataAutoConfiguration.class)` rather than
exercising Boot's autoconfiguration *discovery*.

Separately, `core-spring` only wires the **metadata loader** (`MetaDataLoaderRegistry`,
a primary `MetaDataLoader`, `MetaDataService`). There is **no** autoconfiguration for
the OMDB persistence layer: a Spring app that wants an `ObjectManagerDB` must hand-build
it (`new ObjectManagerDB()` + `setDatabaseDriver(...)` + `setDataSource(...)`).

This work modernizes the Spring integration to Boot 3, ships an idiomatic
one-dependency **starter**, adds **OMDB persistence autoconfiguration**, and hardens
OMDB for Java 21 virtual threads. It deliberately does **not** adopt jOOQ (see
Non-Goals).

## Scope

In scope:
1. **Boot 3 registration fix** — `AutoConfiguration.imports`; delete the dead
   `spring.factories` entry.
2. **OMDB persistence autoconfiguration** — build an `ObjectManagerDB` from a Spring
   `DataSource` + the primary `MetaDataLoader`, transaction-integrated via the existing
   `SpringObjectConnections`.
3. **Thin `metaobjects-spring-boot-starter`** module — one-dependency onboarding.
4. **Virtual-thread hardening (cheap)** — audit OMDB's blocking JDBC paths for
   carrier-thread pinning (`synchronized` across JDBC calls) and convert to
   `ReentrantLock` where found. No async API, no forced toggle.
5. **Tidy** — strip stale "OSGi-compatible" language from the autoconfig javadoc
   (OSGi was removed in 7.1.0); refresh the `core-spring` README.

Out of scope / Non-Goals:
- **jOOQ migration.** jOOQ's free Open Source Edition supports only open-source
  databases; Oracle / SQL Server / DB2 require a *paid* license. OMDB ships drivers for
  Postgres / MySQL / MSSQL / Oracle / Derby, so a jOOQ migration would paywall or drop
  commercial-DB support in a public OSS project. jOOQ also generates code *from* a DB
  schema, the inverse of MetaObjects' metadata-is-the-spine model, and would rip out the
  driver layer just cleaned up in FR-003 Plan 4. Recorded as a closed open-question.
- Forcing `spring.threads.virtual.enabled` on consumers.
- Any change to the OMDB SQL-generation or driver dialect logic beyond the pinning audit.

## Architecture

### Module structure

- **`core-spring`** remains the **autoconfigure** module. It **already** compile-depends
  on `omdb` (for `SpringObjectConnections`/`ObjectConnectionDB`), so no dependency change
  is needed; the OMDB beans are gated at runtime by `@ConditionalOnBean(DataSource)` (plus
  a defensive `@ConditionalOnClass(ObjectManagerDB)`), so they only activate when the
  consumer actually has a `DataSource`.
- **New `metaobjects-spring-boot-starter`** — a thin module (no Java code) whose pom
  depends on `metadata` + `omdb` + `core-spring`. Adding this single dependency gives a
  consumer the full metadata-loader + OMDB-persistence wiring.
- `omdb` / `om` are unchanged except for the §"Virtual-thread hardening" pinning audit.

Net change: one new module; `core-spring` gains one optional dependency.

### Autoconfiguration classes

Two independent `@AutoConfiguration` classes (loader and persistence stay decoupled):

**`MetaDataAutoConfiguration`** (existing — behavior unchanged):
- `MetaDataLoaderRegistry` (`@Primary`), primary `MetaDataLoader`, `MetaDataService`.
- Driven by the existing `metaobjects.*` `@ConfigurationProperties`
  (`MetaDataLoaderConfiguration`).
- Only the registration mechanism and stale OSGi javadoc change.

**`ObjectManagerAutoConfiguration`** (new):
- Produces an `ObjectManagerDB` bean from the Spring `DataSource` + the primary
  `MetaDataLoader`.
- Connections flow through the existing `SpringObjectConnections` so Spring-managed
  transactions / `@Transactional` participate correctly (FR-003 Spring-tx groundwork).
- Conditions:
  - `@ConditionalOnClass(ObjectManagerDB.class)` — only when `omdb` is on the classpath.
  - `@ConditionalOnBean(DataSource.class)` — only when a DataSource exists.
  - `@ConditionalOnMissingBean(ObjectManagerDB.class)` — consumer override always wins.
- New `metaobjects.omdb.*` `@ConfigurationProperties`: `dialect`,
  `enforce-transaction` (maps to `ObjectManagerDB.setEnforceTransaction`).

### Driver selection

`DatabaseDriver` is chosen by **auto-detection with an explicit override**:
- If `metaobjects.omdb.dialect` is set (`postgres|mysql|mssql|oracle|derby`), use the
  matching driver.
- Otherwise open one connection and map
  `DatabaseMetaData.getDatabaseProductName()` to the driver
  (`PostgreSQL`→`PostgresDriver`, `MySQL`→`MySQLDriver`,
  `Microsoft SQL Server`→`MSSQLDriver`, `Oracle`→`OracleDriver`,
  `Apache Derby`→`DerbyDriver`). Unknown product name → a clear
  `MetaDataException` instructing the user to set `metaobjects.omdb.dialect`.

Rationale: zero-config for the common case, explicit escape hatch otherwise. The
product-name→driver mapping lives in a small, separately-tested helper.

> **Implementation note:** confirm during planning whether `ObjectManagerDB` needs the
> `MetaDataLoader`/registry wired beyond `DataSource` + `DatabaseDriver` (the integration
> tests set only driver + datasource). If the OM requires the loader for object-class
> binding, wire the primary `MetaDataLoader` in the same bean method.

## Virtual-thread hardening

OMDB stays a synchronous JDBC API. On Java 21, blocking calls run fine on virtual
threads **provided** no `synchronized` monitor is held across a blocking JDBC call
(that pins the carrier thread). Audit the OMDB blocking paths — the FR-003 Plan 4
atomic-mapping-cache locking and the `synchronized getDatabaseDriver()` are the prime
suspects — and convert any `synchronized`-around-JDBC to `java.util.concurrent.locks.ReentrantLock`.
If the audit finds no JDBC-spanning monitor, document that and make no change (no churn).
The starter does not set `spring.threads.virtual.enabled`; it only guarantees OMDB is
pinning-safe when a consumer enables it, and documents the option.

## Boot 3 registration fix + tidy

- Add `core-spring/src/main/resources/META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports`
  listing `MetaDataAutoConfiguration` and `ObjectManagerAutoConfiguration`.
- Delete `core-spring/src/main/resources/META-INF/spring.factories`.
- Remove "OSGi-compatible" / OSGi references from `MetaDataAutoConfiguration` javadoc and
  any sibling that still mentions it. Refresh the `core-spring` README: document the
  one-dependency starter and the `metaobjects.omdb.*` properties.

## Testing

- **Autoconfiguration discovery** (`ApplicationContextRunner`, the gap the current
  `@ContextConfiguration` test masks):
  - With a DataSource + OMDB present → the `ObjectManagerDB` bean is created.
  - With no DataSource → `ObjectManagerAutoConfiguration` backs off (no bean, no error).
  - With a consumer-defined `ObjectManagerDB` → autoconfig backs off (`@ConditionalOnMissingBean`).
  - The loader autoconfig still produces its beans through real discovery.
- **Driver selection** — unit-test the product-name→driver mapping and the
  `metaobjects.omdb.dialect` override; unknown product name → clear error.
- **Transaction-binding slice** — an embedded-Derby test (Derby is a real OMDB driver,
  auto-detected from product name; core-spring has no Testcontainers, and full persist/read
  is already covered by the `integration-tests` module against Postgres/Derby). With a
  Derby `DataSource` + `DataSourceTransactionManager`, assert the *autoconfigured*
  `ObjectManagerDB`'s `getConnection()` returns the SAME physical connection Spring bound
  to the active transaction, and that `close()` on it is a no-op (mirrors the existing
  `SpringObjectConnectionTest`). This proves the new Spring-tx wiring without duplicating
  OMDB persistence coverage.
- Existing `core-spring` tests stay green.

## Sequencing

1. Boot 3 registration fix + OSGi tidy (loader autoconfig only) + discovery test —
   smallest standalone fix; verifies the bug is closed.
2. `ObjectManagerAutoConfiguration` + driver-selection helper + `metaobjects.omdb.*`
   properties + slice tests.
3. `metaobjects-spring-boot-starter` thin module + README.
4. Virtual-thread pinning audit (+ fix if found).
5. Record jOOQ as a closed non-goal in CLAUDE.md open questions.

## Open questions

- Whether `ObjectManagerDB` requires the `MetaDataLoader` wired beyond driver +
  datasource for object-class binding (resolve in planning by reading the OM API).
- Boot 2.x support is dropped (Boot 2 is EOL); the starter targets Boot 3.5+ only.

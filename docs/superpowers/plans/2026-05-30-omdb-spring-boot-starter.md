# OMDB Spring Boot 3 Starter + Autoconfiguration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make MetaObjects' Spring integration work under Spring Boot 3 (fixing dead autoconfiguration registration), add OMDB persistence autoconfiguration (DataSource → `ObjectManagerDB`), ship a one-dependency `metaobjects-spring-boot-starter`, and document OMDB's virtual-thread safety.

**Architecture:** `core-spring` is the autoconfigure module (it already compile-depends on `omdb`). It registers two `@AutoConfiguration` classes via the Boot 3 `AutoConfiguration.imports` file: the existing `MetaDataAutoConfiguration` (loader beans) and a new `ObjectManagerAutoConfiguration` (an `ObjectManagerDB` built from a Spring `DataSource`, transaction-bound via the existing `SpringObjectConnections`). A new thin `spring-boot-starter` module aggregates the dependencies.

**Tech Stack:** Java 21, Spring Framework 6.2.11, Spring Boot 3.5.6, Maven, JUnit 4 + `spring-test` + `spring-boot-test` (`ApplicationContextRunner`), embedded Derby 10.17.1.0 for tests.

**Spec:** `docs/superpowers/specs/2026-05-29-omdb-spring-boot-starter-design.md`

---

## File Structure

**Created:**
- `server/java/core-spring/src/main/resources/META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports` — Boot 3 autoconfig registration.
- `server/java/core-spring/src/main/java/com/metaobjects/spring/ObjectManagerProperties.java` — `metaobjects.omdb.*` config props.
- `server/java/core-spring/src/main/java/com/metaobjects/spring/DatabaseDriverResolver.java` — dialect/product → `DatabaseDriver`.
- `server/java/core-spring/src/main/java/com/metaobjects/spring/SpringObjectManagerDB.java` — tx-aware `ObjectManagerDB`.
- `server/java/core-spring/src/main/java/com/metaobjects/spring/ObjectManagerAutoConfiguration.java` — new autoconfig.
- `server/java/core-spring/src/test/java/com/metaobjects/spring/AutoConfigurationRegistrationTest.java`
- `server/java/core-spring/src/test/java/com/metaobjects/spring/DatabaseDriverResolverTest.java`
- `server/java/core-spring/src/test/java/com/metaobjects/spring/ObjectManagerAutoConfigurationTest.java`
- `server/java/spring-boot-starter/pom.xml` — thin aggregator module.

**Modified:**
- `server/java/core-spring/src/main/java/com/metaobjects/spring/MetaDataAutoConfiguration.java` — `@Configuration` → `@AutoConfiguration`; strip OSGi javadoc.
- `server/java/core-spring/pom.xml` — add `spring-boot-test` + Derby test deps.
- `server/java/pom.xml` — register `<module>spring-boot-starter</module>`.
- `server/java/core-spring/README.md` — starter usage, `metaobjects.omdb.*`, virtual-threads note.
- `CLAUDE.md` — open-questions update (Boot 3 starter done; jOOQ closed non-goal).

**Deleted:**
- `server/java/core-spring/src/main/resources/META-INF/spring.factories` — dead on Boot 3.

---

## Conventions used throughout

- **Work dir:** the `omdb-spring-boot-starter` worktree. Maven commands run from `server/java`.
- **Run a single test class:** `cd server/java && mvn -q -pl core-spring test -Dtest=<ClassName>`.
- **Per-unit gate:** after each unit, run the full module suite green, then the **review + simplify gate** (code-reviewer AND code-simplifier), fix findings, then merge forward to `main` (FF/merge onto current tip; never rewrite main).
- **Commit cadence:** commit after each task.
- **Resolved spec open question:** `ObjectManagerDB` needs only `DataSource` + `DatabaseDriver` + `init()`; the `MetaDataLoader` is NOT wired onto the OM (object-class binding goes through the registry / caller-supplied `MetaObject`, as in the `integration-tests` runners). No loader is injected into the `ObjectManagerDB` bean.

---

## Unit 1 — Boot 3 registration fix + OSGi tidy

### Task 1.1: Add `spring-boot-test` test dependency

**Files:**
- Modify: `server/java/core-spring/pom.xml`

- [ ] **Step 1: Add the dependency**

In `core-spring/pom.xml`, inside `<dependencies>`, after the existing `spring-test` test dependency block, add:

```xml
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-test</artifactId>
            <version>3.5.6</version>
            <scope>test</scope>
        </dependency>
```

(`spring-boot-test` transitively brings `spring-boot`, which provides
`org.springframework.boot.context.annotation.ImportCandidates` and
`org.springframework.boot.test.context.runner.ApplicationContextRunner`.)

- [ ] **Step 2: Verify it resolves**

Run: `cd server/java && mvn -q -pl core-spring dependency:resolve 2>&1 | tail -5`
Expected: no resolution error.

- [ ] **Step 3: Commit**

```bash
git add server/java/core-spring/pom.xml
git commit -m "build(core-spring): add spring-boot-test (ApplicationContextRunner/ImportCandidates)"
```

### Task 1.2: Failing test — autoconfig is NOT Boot-3-registered

**Files:**
- Test: `server/java/core-spring/src/test/java/com/metaobjects/spring/AutoConfigurationRegistrationTest.java`

- [ ] **Step 1: Write the failing test**

Create `AutoConfigurationRegistrationTest.java`:

```java
package com.metaobjects.spring;

import org.junit.Test;
import org.springframework.boot.context.annotation.ImportCandidates;
import org.springframework.boot.autoconfigure.AutoConfiguration;

import java.util.ArrayList;
import java.util.List;

import static org.junit.Assert.assertTrue;

/**
 * Boot 3 reads autoconfiguration classes from
 * META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports,
 * NOT the legacy spring.factories EnableAutoConfiguration key. This pins that the
 * MetaObjects autoconfigurations are discoverable the Boot-3 way.
 */
public class AutoConfigurationRegistrationTest {

    private static List<String> candidates() {
        List<String> out = new ArrayList<>();
        ImportCandidates.load(AutoConfiguration.class,
                AutoConfigurationRegistrationTest.class.getClassLoader())
            .forEach(out::add);
        return out;
    }

    @Test
    public void metaDataAutoConfiguration_isRegisteredForBoot3Discovery() {
        assertTrue("MetaDataAutoConfiguration must be listed in AutoConfiguration.imports; saw: " + candidates(),
            candidates().contains("com.metaobjects.spring.MetaDataAutoConfiguration"));
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server/java && mvn -q -pl core-spring test -Dtest=AutoConfigurationRegistrationTest`
Expected: FAIL — the `AutoConfiguration.imports` file does not exist yet, so the candidate list is empty.

### Task 1.3: Convert to `@AutoConfiguration`, add imports file, delete `spring.factories`, strip OSGi

**Files:**
- Modify: `server/java/core-spring/src/main/java/com/metaobjects/spring/MetaDataAutoConfiguration.java`
- Create: `server/java/core-spring/src/main/resources/META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports`
- Delete: `server/java/core-spring/src/main/resources/META-INF/spring.factories`

- [ ] **Step 1: Switch the annotation**

In `MetaDataAutoConfiguration.java`, replace the import
`import org.springframework.context.annotation.Configuration;` with
`import org.springframework.boot.autoconfigure.AutoConfiguration;` and change the
class-level `@Configuration` annotation to `@AutoConfiguration`.

- [ ] **Step 2: Strip stale OSGi javadoc**

In the same file, replace the class javadoc's OSGi lines. Change the opening line
`* Spring Auto-Configuration for MetaObjects OSGi-compatible registry.` to
`* Spring Boot auto-configuration for the MetaObjects metadata-loader registry.`
and remove the two `<li>` bullets mentioning OSGi (`Creates OSGi-compatible
MetaDataLoaderRegistry...` and `Works in both OSGi and non-OSGi environments`). Also
change the `metaDataLoaderRegistry()` method comment `// Create OSGi-compatible registry
(auto-detects environment)` to `// Create the loader registry`. (OSGi was removed in
7.1.0; the bean behavior is unchanged.)

- [ ] **Step 3: Create the Boot 3 imports file**

Create `server/java/core-spring/src/main/resources/META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports` with exactly:

```
com.metaobjects.spring.MetaDataAutoConfiguration
```

(The second line, `ObjectManagerAutoConfiguration`, is added in Task 3.4.)

- [ ] **Step 4: Delete the dead spring.factories**

```bash
git rm server/java/core-spring/src/main/resources/META-INF/spring.factories
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd server/java && mvn -q -pl core-spring test -Dtest=AutoConfigurationRegistrationTest`
Expected: PASS.

- [ ] **Step 6: Run the full core-spring suite (no regression)**

Run: `cd server/java && mvn -q -pl core-spring test`
Expected: all existing tests still pass.

- [ ] **Step 7: Commit**

```bash
git add server/java/core-spring
git commit -m "fix(core-spring): register autoconfig via Boot 3 AutoConfiguration.imports; drop dead spring.factories; strip OSGi javadoc"
```

### Task 1.4: Unit 1 gate

- [ ] **Step 1:** `cd server/java && mvn -q -pl core-spring test` — green.
- [ ] **Step 2:** code-reviewer on the Unit 1 diff; fix findings.
- [ ] **Step 3:** code-simplifier on the Unit 1 diff; apply.
- [ ] **Step 4:** Re-run green. (Hold the merge-forward until the feature is complete, or merge per-unit per controller preference.)

---

## Unit 2 — `DatabaseDriverResolver`

### Task 2.1: Resolver + tests

**Files:**
- Create: `server/java/core-spring/src/main/java/com/metaobjects/spring/DatabaseDriverResolver.java`
- Test: `server/java/core-spring/src/test/java/com/metaobjects/spring/DatabaseDriverResolverTest.java`

- [ ] **Step 1: Write the failing test**

Create `DatabaseDriverResolverTest.java`:

```java
package com.metaobjects.spring;

import com.metaobjects.manager.db.driver.DerbyDriver;
import com.metaobjects.manager.db.driver.MySQLDriver;
import com.metaobjects.manager.db.driver.OracleDriver;
import com.metaobjects.manager.db.driver.PostgresDriver;
import com.metaobjects.manager.db.driver.MSSQLDriver;
import org.junit.Test;

import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

public class DatabaseDriverResolverTest {

    @Test
    public void forDialect_mapsKnownDialects() {
        assertTrue(DatabaseDriverResolver.forDialect("postgres") instanceof PostgresDriver);
        assertTrue(DatabaseDriverResolver.forDialect("mysql") instanceof MySQLDriver);
        assertTrue(DatabaseDriverResolver.forDialect("mssql") instanceof MSSQLDriver);
        assertTrue(DatabaseDriverResolver.forDialect("oracle") instanceof OracleDriver);
        assertTrue(DatabaseDriverResolver.forDialect("derby") instanceof DerbyDriver);
    }

    @Test
    public void forDialect_unknownThrows() {
        assertThrows(IllegalArgumentException.class, () -> DatabaseDriverResolver.forDialect("sqlite"));
    }

    @Test
    public void forProduct_mapsJdbcProductNames() {
        assertTrue(DatabaseDriverResolver.forProduct("PostgreSQL") instanceof PostgresDriver);
        assertTrue(DatabaseDriverResolver.forProduct("MySQL") instanceof MySQLDriver);
        assertTrue(DatabaseDriverResolver.forProduct("Microsoft SQL Server") instanceof MSSQLDriver);
        assertTrue(DatabaseDriverResolver.forProduct("Oracle") instanceof OracleDriver);
        assertTrue(DatabaseDriverResolver.forProduct("Apache Derby") instanceof DerbyDriver);
    }

    @Test
    public void forProduct_unknownThrows() {
        assertThrows(IllegalStateException.class, () -> DatabaseDriverResolver.forProduct("H2"));
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server/java && mvn -q -pl core-spring test -Dtest=DatabaseDriverResolverTest`
Expected: FAIL — `DatabaseDriverResolver` does not exist.

- [ ] **Step 3: Implement the resolver**

Create `DatabaseDriverResolver.java`:

```java
package com.metaobjects.spring;

import com.metaobjects.manager.db.DatabaseDriver;
import com.metaobjects.manager.db.driver.DerbyDriver;
import com.metaobjects.manager.db.driver.MSSQLDriver;
import com.metaobjects.manager.db.driver.MySQLDriver;
import com.metaobjects.manager.db.driver.OracleDriver;
import com.metaobjects.manager.db.driver.PostgresDriver;

import javax.sql.DataSource;
import java.sql.Connection;
import java.sql.SQLException;

/**
 * Resolves the OMDB {@link DatabaseDriver} for a Spring {@link DataSource}: an explicit
 * {@code metaobjects.omdb.dialect} wins; otherwise the JDBC
 * {@code DatabaseMetaData.getDatabaseProductName()} is mapped to a driver.
 */
final class DatabaseDriverResolver {

    private DatabaseDriverResolver() {}

    static DatabaseDriver resolve(String dialect, DataSource dataSource) {
        if (dialect != null && !dialect.isBlank()) {
            return forDialect(dialect.trim().toLowerCase());
        }
        return forProduct(detectProduct(dataSource));
    }

    static DatabaseDriver forDialect(String dialect) {
        switch (dialect) {
            case "postgres":
            case "postgresql":
                return new PostgresDriver();
            case "mysql":
                return new MySQLDriver();
            case "mssql":
            case "sqlserver":
                return new MSSQLDriver();
            case "oracle":
                return new OracleDriver();
            case "derby":
                return new DerbyDriver();
            default:
                throw new IllegalArgumentException(
                    "Unknown metaobjects.omdb.dialect '" + dialect +
                    "'. Use one of: postgres, mysql, mssql, oracle, derby.");
        }
    }

    static DatabaseDriver forProduct(String product) {
        String p = product == null ? "" : product.toLowerCase();
        if (p.contains("postgresql")) return new PostgresDriver();
        if (p.contains("mysql")) return new MySQLDriver();
        if (p.contains("sql server")) return new MSSQLDriver();
        if (p.contains("oracle")) return new OracleDriver();
        if (p.contains("derby")) return new DerbyDriver();
        throw new IllegalStateException(
            "Could not auto-detect an OMDB driver for database product '" + product +
            "'. Set metaobjects.omdb.dialect explicitly (postgres|mysql|mssql|oracle|derby).");
    }

    private static String detectProduct(DataSource dataSource) {
        try (Connection c = dataSource.getConnection()) {
            return c.getMetaData().getDatabaseProductName();
        } catch (SQLException e) {
            throw new IllegalStateException(
                "Failed to read DatabaseMetaData for OMDB driver auto-detection: " + e.getMessage(), e);
        }
    }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server/java && mvn -q -pl core-spring test -Dtest=DatabaseDriverResolverTest`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/java/core-spring/src/main/java/com/metaobjects/spring/DatabaseDriverResolver.java server/java/core-spring/src/test/java/com/metaobjects/spring/DatabaseDriverResolverTest.java
git commit -m "feat(core-spring): DatabaseDriverResolver (dialect override + product auto-detect)"
```

---

## Unit 3 — OMDB persistence autoconfiguration

### Task 3.1: `ObjectManagerProperties`

**Files:**
- Create: `server/java/core-spring/src/main/java/com/metaobjects/spring/ObjectManagerProperties.java`

- [ ] **Step 1: Implement (no test of its own — exercised in Task 3.4)**

Create `ObjectManagerProperties.java`:

```java
package com.metaobjects.spring;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * Configuration properties for the OMDB {@code ObjectManagerDB} autoconfiguration,
 * bound from {@code metaobjects.omdb.*}.
 */
@ConfigurationProperties(prefix = "metaobjects.omdb")
public class ObjectManagerProperties {

    /**
     * Explicit database dialect: postgres | mysql | mssql | oracle | derby.
     * When blank, the driver is auto-detected from the DataSource's product name.
     */
    private String dialect;

    /** Whether the ObjectManagerDB enforces an active transaction for writes. */
    private boolean enforceTransaction = false;

    public String getDialect() { return dialect; }
    public void setDialect(String dialect) { this.dialect = dialect; }

    public boolean isEnforceTransaction() { return enforceTransaction; }
    public void setEnforceTransaction(boolean enforceTransaction) { this.enforceTransaction = enforceTransaction; }
}
```

- [ ] **Step 2: Compile check**

Run: `cd server/java && mvn -q -pl core-spring test-compile`
Expected: compiles.

- [ ] **Step 3: Commit**

```bash
git add server/java/core-spring/src/main/java/com/metaobjects/spring/ObjectManagerProperties.java
git commit -m "feat(core-spring): metaobjects.omdb.* configuration properties"
```

### Task 3.2: `SpringObjectManagerDB` (transaction-aware)

**Files:**
- Create: `server/java/core-spring/src/main/java/com/metaobjects/spring/SpringObjectManagerDB.java`

- [ ] **Step 1: Implement**

Create `SpringObjectManagerDB.java`:

```java
package com.metaobjects.spring;

import com.metaobjects.MetaDataException;
import com.metaobjects.manager.ObjectConnection;
import com.metaobjects.manager.db.ObjectManagerDB;
import org.springframework.jdbc.datasource.DataSourceUtils;

import java.sql.Connection;

/**
 * An {@link ObjectManagerDB} whose connections join the active Spring-managed
 * transaction. {@link #getConnection()} returns the connection Spring has bound to the
 * current {@code @Transactional} scope (via {@link SpringObjectConnections}); when no
 * transaction is active a fresh pooled connection is used. {@link #releaseConnection}
 * hands the physical connection back to Spring, which releases it only when it is not
 * transaction-bound.
 */
public class SpringObjectManagerDB extends ObjectManagerDB {

    @Override
    public ObjectConnection getConnection() throws MetaDataException {
        return SpringObjectConnections.current(getDataSource());
    }

    @Override
    public void releaseConnection(ObjectConnection oc) throws MetaDataException {
        if (oc == null) {
            return;
        }
        // The wrapper's own close() is a no-op (Spring owns the lifecycle); explicitly
        // route the physical connection through DataSourceUtils so a non-tx connection
        // is returned to the pool while a tx-bound one is left for the tx manager.
        DataSourceUtils.releaseConnection((Connection) oc.getDatastoreConnection(), getDataSource());
    }
}
```

- [ ] **Step 2: Compile check**

Run: `cd server/java && mvn -q -pl core-spring test-compile`
Expected: compiles.

- [ ] **Step 3: Commit**

```bash
git add server/java/core-spring/src/main/java/com/metaobjects/spring/SpringObjectManagerDB.java
git commit -m "feat(core-spring): SpringObjectManagerDB joins Spring-managed transactions"
```

### Task 3.3: `ObjectManagerAutoConfiguration`

**Files:**
- Create: `server/java/core-spring/src/main/java/com/metaobjects/spring/ObjectManagerAutoConfiguration.java`

- [ ] **Step 1: Implement**

Create `ObjectManagerAutoConfiguration.java`:

```java
package com.metaobjects.spring;

import com.metaobjects.manager.db.DatabaseDriver;
import com.metaobjects.manager.db.ObjectManagerDB;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnClass;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.autoconfigure.jdbc.DataSourceAutoConfiguration;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;

import javax.sql.DataSource;

/**
 * Auto-configures a transaction-aware {@link ObjectManagerDB} from a Spring
 * {@link DataSource}. Activates only when OMDB is on the classpath and a DataSource
 * bean exists; backs off if the application defines its own ObjectManagerDB.
 */
@AutoConfiguration(after = { DataSourceAutoConfiguration.class, MetaDataAutoConfiguration.class })
@ConditionalOnClass(ObjectManagerDB.class)
@ConditionalOnBean(DataSource.class)
@EnableConfigurationProperties(ObjectManagerProperties.class)
public class ObjectManagerAutoConfiguration {

    @Bean
    @ConditionalOnMissingBean(ObjectManagerDB.class)
    public ObjectManagerDB objectManagerDB(DataSource dataSource, ObjectManagerProperties props) throws Exception {
        SpringObjectManagerDB omdb = new SpringObjectManagerDB();
        DatabaseDriver driver = DatabaseDriverResolver.resolve(props.getDialect(), dataSource);
        omdb.setDatabaseDriver(driver);
        omdb.setDataSource(dataSource);
        omdb.setEnforceTransaction(props.isEnforceTransaction());
        omdb.init();
        return omdb;
    }
}
```

> `DataSourceAutoConfiguration` is in `spring-boot-autoconfigure` (already a compile dep
> of core-spring), so referencing it in `@AutoConfiguration(after=...)` needs no new
> dependency.

- [ ] **Step 2: Compile check**

Run: `cd server/java && mvn -q -pl core-spring test-compile`
Expected: compiles.

- [ ] **Step 3: Commit**

```bash
git add server/java/core-spring/src/main/java/com/metaobjects/spring/ObjectManagerAutoConfiguration.java
git commit -m "feat(core-spring): ObjectManagerAutoConfiguration (DataSource -> ObjectManagerDB)"
```

### Task 3.4: Register the new autoconfig + add Derby test deps + discovery/tx tests

**Files:**
- Modify: `server/java/core-spring/src/main/resources/META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports`
- Modify: `server/java/core-spring/pom.xml`
- Test: `server/java/core-spring/src/test/java/com/metaobjects/spring/ObjectManagerAutoConfigurationTest.java`

- [ ] **Step 1: Add Derby test dependencies**

In `core-spring/pom.xml`, after the H2 test dependency block, add:

```xml
        <dependency>
            <groupId>org.apache.derby</groupId>
            <artifactId>derby</artifactId>
            <version>${derby.version}</version>
            <scope>test</scope>
        </dependency>
        <dependency>
            <groupId>org.apache.derby</groupId>
            <artifactId>derbyshared</artifactId>
            <version>${derby.version}</version>
            <scope>test</scope>
        </dependency>
        <dependency>
            <groupId>org.apache.derby</groupId>
            <artifactId>derbytools</artifactId>
            <version>${derby.version}</version>
            <scope>test</scope>
        </dependency>
```

(`${derby.version}` = `10.17.1.0`, defined in the parent pom.)

- [ ] **Step 2: Write the failing tests**

Create `ObjectManagerAutoConfigurationTest.java`:

```java
package com.metaobjects.spring;

import com.metaobjects.manager.ObjectConnection;
import com.metaobjects.manager.db.ObjectManagerDB;
import org.junit.Test;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.autoconfigure.jdbc.DataSourceAutoConfiguration;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DataSourceUtils;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabaseBuilder;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import javax.sql.DataSource;
import java.sql.Connection;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Exercises real Boot autoconfiguration of {@link ObjectManagerDB}: it is created when a
 * DataSource is present, backs off otherwise and when the app defines its own, and the
 * bean joins the active Spring transaction. Uses embedded Derby (a real OMDB driver,
 * auto-detected from the product name).
 */
public class ObjectManagerAutoConfigurationTest {

    private static DataSource derby() {
        return new EmbeddedDatabaseBuilder()
            .setName("omdbAutoConfigTest")              // in-memory Derby via Spring's embedded support
            .build();
    }

    private final ApplicationContextRunner runner = new ApplicationContextRunner()
        .withConfiguration(AutoConfigurations.of(ObjectManagerAutoConfiguration.class));

    @Test
    public void createsObjectManagerDB_whenDataSourcePresent() {
        runner.withBean(DataSource.class, ObjectManagerAutoConfigurationTest::derby)
            .run(ctx -> {
                assertThat(ctx).hasSingleBean(ObjectManagerDB.class);
                assertThat(ctx.getBean(ObjectManagerDB.class)).isInstanceOf(SpringObjectManagerDB.class);
            });
    }

    @Test
    public void backsOff_whenNoDataSource() {
        runner.run(ctx -> assertThat(ctx).doesNotHaveBean(ObjectManagerDB.class));
    }

    @Test
    public void backsOff_whenUserDefinesOwnObjectManagerDB() {
        runner.withBean(DataSource.class, ObjectManagerAutoConfigurationTest::derby)
            .withBean("myOmdb", ObjectManagerDB.class, ObjectManagerDB::new)
            .run(ctx -> assertThat(ctx).hasSingleBean(ObjectManagerDB.class)
                .getBean(ObjectManagerDB.class).isNotInstanceOf(SpringObjectManagerDB.class));
    }

    @Test
    public void connectionJoinsActiveSpringTransaction() {
        runner.withBean(DataSource.class, ObjectManagerAutoConfigurationTest::derby)
            .run(ctx -> {
                DataSource ds = ctx.getBean(DataSource.class);
                PlatformTransactionManager tm = new DataSourceTransactionManager(ds);
                ObjectManagerDB omdb = ctx.getBean(ObjectManagerDB.class);
                new TransactionTemplate(tm).execute(status -> {
                    Connection bound = DataSourceUtils.getConnection(ds);   // Spring-bound tx connection
                    ObjectConnection oc = omdb.getConnection();
                    assertThat(oc.getDatastoreConnection()).isSameAs(bound);
                    omdb.releaseConnection(oc); // no-op release of the tx-bound connection
                    return null;
                });
            });
    }
}
```

> `assertj` ships transitively with `spring-boot-test`. If the module's surefire cannot
> resolve `org.assertj.core.api.Assertions`, add `assertj-core` as a test dependency
> (version aligned with Boot 3.5.6's managed `3.26.x`) and note it in the commit.
>
> The test builds its own `DataSourceTransactionManager` over the context's single
> `DataSource` bean, so `DataSourceUtils.getConnection(ds)` and the OM (which wraps the
> same DataSource) resolve to the same physical, transaction-bound connection.

- [ ] **Step 3: Run to verify it fails**

Run: `cd server/java && mvn -q -pl core-spring test -Dtest=ObjectManagerAutoConfigurationTest`
Expected: FAIL on `connectionJoinsActiveSpringTransaction` / bean assertions until the
imports file lists the class **and** the autoconfig is correct. (The discovery via
`AutoConfigurations.of(...)` is explicit, so the bean-creation tests may already pass;
the tx test pins the wiring. If all green at this step, that is acceptable — the
registration is separately pinned by `AutoConfigurationRegistrationTest` after Step 4.)

- [ ] **Step 4: Register the new autoconfig in the imports file**

Append a second line to
`core-spring/src/main/resources/META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports`
so it reads:

```
com.metaobjects.spring.MetaDataAutoConfiguration
com.metaobjects.spring.ObjectManagerAutoConfiguration
```

- [ ] **Step 5: Extend the registration test**

Append to `AutoConfigurationRegistrationTest.java`:

```java
    @Test
    public void objectManagerAutoConfiguration_isRegisteredForBoot3Discovery() {
        assertTrue("ObjectManagerAutoConfiguration must be listed in AutoConfiguration.imports; saw: " + candidates(),
            candidates().contains("com.metaobjects.spring.ObjectManagerAutoConfiguration"));
    }
```

- [ ] **Step 6: Run to verify all pass**

Run: `cd server/java && mvn -q -pl core-spring test -Dtest=ObjectManagerAutoConfigurationTest,AutoConfigurationRegistrationTest`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/java/core-spring
git commit -m "feat(core-spring): register + test ObjectManagerDB autoconfig (discovery, back-off, tx-binding) on embedded Derby"
```

### Task 3.5: Unit 3 gate

- [ ] **Step 1:** `cd server/java && mvn -q -pl core-spring test` — green.
- [ ] **Step 2:** code-reviewer on the Unit 3 diff; fix.
- [ ] **Step 3:** code-simplifier on the Unit 3 diff; apply.
- [ ] **Step 4:** Re-run green.

---

## Unit 4 — `spring-boot-starter` module

### Task 4.1: Thin aggregator module

**Files:**
- Create: `server/java/spring-boot-starter/pom.xml`
- Modify: `server/java/pom.xml`

- [ ] **Step 1: Register the module in the reactor**

In `server/java/pom.xml`, add to `<modules>` (after `<module>core-spring</module>`):

```xml
    <module>spring-boot-starter</module>
```

- [ ] **Step 2: Create the starter pom**

Create `server/java/spring-boot-starter/pom.xml`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 http://maven.apache.org/xsd/maven-4.0.0.xsd">
    <modelVersion>4.0.0</modelVersion>

    <parent>
        <groupId>com.metaobjects</groupId>
        <artifactId>metaobjects</artifactId>
        <version>7.1.1-SNAPSHOT</version>
    </parent>

    <artifactId>metaobjects-spring-boot-starter</artifactId>
    <packaging>jar</packaging>

    <name>MetaObjects :: Spring Boot Starter</name>
    <description>One-dependency Spring Boot starter: metadata-loader + OMDB persistence autoconfiguration.</description>

    <dependencies>
        <dependency>
            <groupId>com.metaobjects</groupId>
            <artifactId>metaobjects-metadata</artifactId>
            <version>${project.version}</version>
        </dependency>
        <dependency>
            <groupId>com.metaobjects</groupId>
            <artifactId>metaobjects-omdb</artifactId>
            <version>${project.version}</version>
        </dependency>
        <dependency>
            <groupId>com.metaobjects</groupId>
            <artifactId>metaobjects-core-spring</artifactId>
            <version>${project.version}</version>
        </dependency>
    </dependencies>
</project>
```

- [ ] **Step 3: Build the module + assert it aggregates the three deps**

Run: `cd server/java && mvn -q -pl spring-boot-starter -am install 2>&1 | tail -5`
Expected: BUILD SUCCESS.

Run: `cd server/java && mvn -q -pl spring-boot-starter dependency:tree 2>&1 | grep -E "metaobjects-(metadata|omdb|core-spring)"`
Expected: all three appear in the tree.

- [ ] **Step 4: Commit**

```bash
git add server/java/spring-boot-starter/pom.xml server/java/pom.xml
git commit -m "feat(spring-boot-starter): thin one-dependency starter (metadata + omdb + core-spring)"
```

### Task 4.2: Unit 4 gate

- [ ] **Step 1:** `cd server/java && mvn -q -pl spring-boot-starter -am install` — green.
- [ ] **Step 2:** code-reviewer on the new pom + reactor change.
- [ ] **Step 3:** code-simplifier (likely no-op for a pom).
- [ ] **Step 4:** green.

---

## Unit 5 — Virtual-thread documentation + README + jOOQ non-goal

### Task 5.1: Record the virtual-thread audit finding

The pinning audit is complete (done during planning): the only `synchronized` in the
OMDB JDBC path is the non-blocking `ObjectManagerDB.getDatabaseDriver()` lazy-init; the
`om` module's `synchronized` blocks guard in-memory state (event-listener list,
attribute map) — none is held across a blocking JDBC call. Therefore OMDB does not pin
carrier threads, and no code change is warranted (YAGNI). This task documents that.

**Files:**
- Modify: `server/java/core-spring/README.md`

- [ ] **Step 1: Add a "Virtual threads" section**

Append to `core-spring/README.md`:

```markdown
## Virtual threads (Java 21)

OMDB is a synchronous JDBC API and is safe to run on JVM virtual threads. An audit of
the OMDB blocking paths found no `synchronized` monitor held across a JDBC call (the only
synchronized methods guard in-memory state — the driver lazy-init, the event-listener
list, and per-object attribute maps), so OMDB does not pin carrier threads.

To run a Spring Boot 3.2+ application's request handling on virtual threads, set:

```properties
spring.threads.virtual.enabled=true
```

The starter does not enable this for you — it is the application's choice.
```

- [ ] **Step 2: Commit**

```bash
git add server/java/core-spring/README.md
git commit -m "docs(core-spring): document OMDB virtual-thread safety + pinning audit result"
```

### Task 5.2: README starter usage + `metaobjects.omdb.*`

**Files:**
- Modify: `server/java/core-spring/README.md`

- [ ] **Step 1: Document the starter + properties**

Add a section to `core-spring/README.md` (place it near the top, after any intro):

```markdown
## Spring Boot starter

Add the single starter dependency:

```xml
<dependency>
    <groupId>com.metaobjects</groupId>
    <artifactId>metaobjects-spring-boot-starter</artifactId>
    <version>7.1.1-SNAPSHOT</version>
</dependency>
```

On Spring Boot 3, this auto-configures the metadata-loader registry and — when a
`DataSource` is present — a transaction-aware `ObjectManagerDB`.

Properties:

| Property | Default | Description |
|---|---|---|
| `metaobjects.metadata-sources` | (none) | Loader source URIs/resources. |
| `metaobjects.omdb.dialect` | (auto) | `postgres`/`mysql`/`mssql`/`oracle`/`derby`. Auto-detected from the DataSource when blank. |
| `metaobjects.omdb.enforce-transaction` | `false` | Require an active transaction for writes. |

Define your own `ObjectManagerDB` bean to opt out of the autoconfigured one.
```

Also remove any remaining OSGi references in the README intro if present (search the
file for "OSGi" and reword to drop it; OSGi was removed in 7.1.0).

- [ ] **Step 2: Commit**

```bash
git add server/java/core-spring/README.md
git commit -m "docs(core-spring): document the Spring Boot starter + metaobjects.omdb.* properties"
```

### Task 5.3: Close jOOQ in CLAUDE.md open questions

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update the open-questions bullet**

In `CLAUDE.md`, find the `[TECHNICAL] ObjectManagerDB further modernization (jOOQ
migration, Spring Boot 3 starter, async via virtual threads). ...` bullet and replace it
with:

```markdown
- [TECHNICAL] ObjectManagerDB further modernization. FR-003 Plan 4 (2026-05-27) closed
  the three engine-debt anti-patterns. The Spring Boot 3 starter + OMDB autoconfiguration
  + virtual-thread audit shipped 2026-05-30 (`metaobjects-spring-boot-starter`). **jOOQ
  migration is a closed non-goal**: jOOQ's OSS edition excludes Oracle/SQL Server/DB2
  (commercial license required), which would paywall OMDB's commercial-DB drivers in a
  public OSS project, and jOOQ generates code *from* a schema — the inverse of
  MetaObjects' metadata-is-the-spine model.
```

- [ ] **Step 2: Verify no private-name / home-path leak in the staged diff**

Run: `cd <repo-root> && git diff --staged CLAUDE.md | grep -nE "/home/|/Users/" || echo "clean"`
Expected: `clean`.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: close jOOQ as a non-goal; record Spring Boot starter shipped"
```

### Task 5.4: Unit 5 gate + full reactor verification

- [ ] **Step 1:** Full reactor build: `cd server/java && mvn -q test` — BUILD SUCCESS across all modules (metadata, core-spring, omdb, om, spring-boot-starter, …).
- [ ] **Step 2:** code-reviewer on the Unit 5 docs diff (hygiene: no private names / home paths).
- [ ] **Step 3:** code-simplifier (docs — likely no-op).
- [ ] **Step 4:** green.

---

## Final — cross-cutting review + finish branch

- [ ] Full reactor `mvn -q test` green.
- [ ] Cross-cutting code-reviewer over the whole branch diff (`main..HEAD`), fix findings.
- [ ] code-simplifier over the whole branch diff, apply.
- [ ] Finish the development branch (merge forward to `main`, push, clean up worktree) via the finishing-a-development-branch flow.

---

## Self-Review Notes

- **Spec coverage:** §Boot-3 registration → Unit 1; §OMDB autoconfiguration (driver select, tx via SpringObjectConnections, conditions, properties) → Units 2–3; §thin starter → Unit 4; §virtual-thread hardening (audit + doc) → Unit 5 Task 5.1; §tidy (OSGi javadoc + README) → Unit 1 Task 1.3 + Unit 5 Tasks 5.2; §jOOQ non-goal → Unit 5 Task 5.3; §testing (discovery/back-off/tx-binding + driver resolver) → Tasks 1.2, 2.1, 3.4. All spec sections map to a task.
- **Resolved open question:** `ObjectManagerDB` needs only DataSource + driver + `init()` (no loader injected) — baked into Task 3.3.
- **Type/name consistency:** `DatabaseDriverResolver.resolve/forDialect/forProduct`, `ObjectManagerProperties.getDialect()/isEnforceTransaction()`, `SpringObjectManagerDB`, `ObjectManagerAutoConfiguration.objectManagerDB(...)` are used identically across tasks.
- **Known follow-ups flagged inline (not placeholders):** (a) `assertj-core` may need an explicit test dep if not transitive from `spring-boot-test`; (b) the empty-jar starter — if a reactor plugin objects to no sources, the implementer notes it. Both are conditional, with the action stated.

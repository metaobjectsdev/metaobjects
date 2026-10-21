package com.metaobjects.spring;

import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.manager.ObjectConnection;
import com.metaobjects.manager.QueryOptions;
import com.metaobjects.manager.db.ObjectManagerDB;
import com.metaobjects.object.MetaObject;
import com.metaobjects.object.value.ValueObject;
import com.metaobjects.registry.ObjectClassRegistry;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.autoconfigure.context.ConfigurationPropertiesAutoConfiguration;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabaseBuilder;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabaseType;

import javax.sql.DataSource;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.Statement;
import java.util.Collection;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * B1 persistence-level proof: the Spring runtime reads a table whose columns are the literal
 * field names ({@code firstName}) because the project's {@code naming.columns: literal} reaches
 * the loader through {@code metaobjects.physical-naming-config}. Without it the runtime would
 * query {@code first_name}. (Derby folds the unquoted DDL names, so {@code firstName} and
 * {@code first_name} are different columns.)
 */
public class SpringRuntimeLiteralNamingTest {

    @Before public void registerClasses() {
        ObjectClassRegistry reg = new ObjectClassRegistry();
        reg.register(() -> Map.of("lit::Person", ValueObject.class));
        ObjectClassRegistry.setGlobal(reg);
    }

    @After public void reset() {
        ObjectClassRegistry.resetGlobal();
    }

    @Test
    public void readsLiteralColumnsNamedByTheProjectConfig() throws Exception {
        Path root = Files.createTempDirectory("spring-literal-");
        Files.createDirectories(root.resolve(".metaobjects"));
        Files.writeString(root.resolve(".metaobjects/config.json"),
            "{\"schema_version\":1,\"naming\":{\"columns\":\"literal\"}}");
        Path meta = root.resolve("metaobjects");
        Files.createDirectories(meta);
        Path file = meta.resolve("meta.person.json");
        Files.writeString(file, """
            {"metadata.root":{"package":"lit","children":[
              {"object.entity":{"name":"Person","children":[
                {"source.rdb":{"@table":"people"}},
                {"field.long":{"name":"id"}},
                {"field.string":{"name":"firstName","@maxLength":50}},
                {"identity.primary":{"name":"id","@fields":"id","@generation":"increment"}}
              ]}}
            ]}}""");

        DataSource ds = new EmbeddedDatabaseBuilder().setType(EmbeddedDatabaseType.DERBY)
            .setName("springLiteralNaming").build();
        try (Connection c = ds.getConnection(); Statement s = c.createStatement()) {
            s.execute("CREATE TABLE people (id BIGINT PRIMARY KEY, firstName VARCHAR(50))");
            s.execute("INSERT INTO people VALUES (1, 'Ada')");
        }

        new ApplicationContextRunner()
            .withConfiguration(AutoConfigurations.of(MetaDataAutoConfiguration.class,
                ConfigurationPropertiesAutoConfiguration.class, ObjectManagerAutoConfiguration.class))
            .withBean(DataSource.class, () -> ds)
            .withPropertyValues(
                "metaobjects.metadata-sources=" + file.toUri(),
                "metaobjects.physical-naming-config=" + root.resolve(".metaobjects/config.json"))
            .run(ctx -> {
                assertThat(ctx.getStartupFailure()).isNull();
                MetaDataLoader loader = ctx.getBean(MetaDataLoader.class);
                ObjectManagerDB omdb = ctx.getBean(ObjectManagerDB.class);
                MetaObject person = loader.getMetaObjectByName("lit::Person");
                ObjectConnection oc = omdb.getConnection();
                try {
                    Collection<?> rows = omdb.getObjects(oc, person, new QueryOptions());
                    assertThat(rows).hasSize(1);
                    assertThat(((ValueObject) rows.iterator().next()).getString("firstName")).isEqualTo("Ada");
                } finally {
                    omdb.releaseConnection(oc);
                }
            });
    }
}

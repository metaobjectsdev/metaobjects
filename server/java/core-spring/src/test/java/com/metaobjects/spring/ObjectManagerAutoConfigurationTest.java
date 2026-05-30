package com.metaobjects.spring;

import com.metaobjects.manager.ObjectConnection;
import com.metaobjects.manager.db.ObjectManagerDB;
import org.junit.Test;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DataSourceUtils;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabaseBuilder;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabaseType;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import javax.sql.DataSource;
import java.sql.Connection;

import static org.assertj.core.api.Assertions.assertThat;

public class ObjectManagerAutoConfigurationTest {

    private static DataSource derby() {
        return new EmbeddedDatabaseBuilder()
            .setType(EmbeddedDatabaseType.DERBY)
            .setName("omdbAutoConfigTest")
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
                    Connection bound = DataSourceUtils.getConnection(ds);
                    ObjectConnection oc = omdb.getConnection();
                    assertThat(oc.getDatastoreConnection()).isSameAs(bound);
                    omdb.releaseConnection(oc);
                    return null;
                });
            });
    }
}

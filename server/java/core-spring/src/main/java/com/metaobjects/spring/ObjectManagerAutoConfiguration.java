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

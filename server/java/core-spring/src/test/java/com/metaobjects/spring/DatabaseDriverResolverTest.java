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

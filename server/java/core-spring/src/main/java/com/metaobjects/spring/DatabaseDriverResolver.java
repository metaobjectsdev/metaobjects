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

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

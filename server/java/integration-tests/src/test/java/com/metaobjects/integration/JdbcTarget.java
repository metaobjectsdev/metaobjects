package com.metaobjects.integration;

/** A database the query scenarios run against: what {@link PostgresContainer} and {@link MySqlContainer} both expose. */
public interface JdbcTarget {
    String jdbcUrl();
    String username();
    String password();
}

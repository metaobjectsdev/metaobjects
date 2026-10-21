package com.metaobjects.integration.api;

import com.metaobjects.integration.SqliteDatabase;
import com.metaobjects.integration.JdbcTarget;
import com.metaobjects.integration.ScenarioEngine;
import org.junit.jupiter.api.DisplayName;

/** The report api-contract corpus, GENERATED controllers over an OMDB repository on SQLite (embedded, no docker). */
@DisplayName("API contract report - GENERATED Spring controllers over OMDB on Sqlite")
final class ReportOmdbSqliteApiContractConformanceTest extends ReportOmdbApiContractLane {

    private SqliteDatabase database;

    @Override ScenarioEngine engine() { return ScenarioEngine.SQLITE; }

    @Override JdbcTarget openDatabase() {
        database = new SqliteDatabase();
        return database;
    }

    @Override void closeDatabase() {
        if (database != null) database.close();
    }
}

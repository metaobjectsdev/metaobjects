package com.metaobjects.integration.api;

import com.metaobjects.integration.MySqlContainer;
import com.metaobjects.integration.JdbcTarget;
import com.metaobjects.integration.ScenarioEngine;
import org.junit.jupiter.api.DisplayName;

/** The report api-contract corpus, GENERATED controllers over an OMDB repository on MySql (throwaway docker container; needs docker). */
@DisplayName("API contract report - GENERATED Spring controllers over OMDB on MySql")
final class ReportOmdbMySqlApiContractConformanceTest extends ReportOmdbApiContractLane {

    private MySqlContainer database;

    @Override ScenarioEngine engine() { return ScenarioEngine.MYSQL; }

    @Override JdbcTarget openDatabase() {
        database = new MySqlContainer();
        return database;
    }

    @Override void closeDatabase() {
        if (database != null) database.close();
    }
}

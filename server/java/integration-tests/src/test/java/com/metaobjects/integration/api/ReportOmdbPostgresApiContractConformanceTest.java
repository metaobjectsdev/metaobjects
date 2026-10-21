package com.metaobjects.integration.api;

import com.metaobjects.integration.PostgresContainer;
import com.metaobjects.integration.JdbcTarget;
import com.metaobjects.integration.ScenarioEngine;
import org.junit.jupiter.api.DisplayName;

/** The report api-contract corpus, GENERATED controllers over an OMDB repository on Postgres (throwaway docker container; needs docker). */
@DisplayName("API contract report - GENERATED Spring controllers over OMDB on Postgres")
final class ReportOmdbPostgresApiContractConformanceTest extends ReportOmdbApiContractLane {

    private PostgresContainer database;

    @Override ScenarioEngine engine() { return ScenarioEngine.POSTGRES; }

    @Override JdbcTarget openDatabase() {
        database = new PostgresContainer();
        return database;
    }

    @Override void closeDatabase() {
        if (database != null) database.close();
    }
}

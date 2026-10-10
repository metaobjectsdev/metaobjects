package com.metaobjects.integration;

import com.metaobjects.integration.Scenarios.QueryScenario;
import com.metaobjects.manager.db.DatabaseDriver;
import com.metaobjects.manager.db.driver.MySQLDriver;
import com.metaobjects.manager.db.driver.PostgresDriver;

import java.util.Map;
import java.util.regex.Pattern;

/**
 * The SQL engine a persistence scenario runs on. Postgres is the corpus' own engine: the scenario
 * YAML holds its seed SQL and its wire-form {@code expect}. Another engine runs the same scenarios
 * against its own TS-produced schema artifact ({@code canonical/schema.<engine>.sql}), with the
 * seed re-spelled for it and the engine driver's spelling of a value mapped onto the corpus' wire
 * form. Spelling only: a wrong VALUE still fails the comparison, and no {@code expect} is loosened.
 */
public enum ScenarioEngine {
    POSTGRES("postgres", "\"") {
        @Override public DatabaseDriver newDriver() { return new PostgresDriver(); }
        @Override public String seed(QueryScenario s) { return s.seedData(); }
    },
    MYSQL("mysql", "`") {
        @Override public DatabaseDriver newDriver() { return new MySQLDriver(); }
        @Override public String seed(QueryScenario s) {
            Map<String, String> own = s.seedDataEngine();
            if (own != null && own.get("mysql") != null) return own.get("mysql");
            return s.seedData() == null ? null : toMysqlSeed(s.seedData());
        }
    };

    private final String id;
    private final String quote;

    ScenarioEngine(String id, String quote) { this.id = id; this.quote = quote; }

    /** The schema artifact name under the corpus' {@code canonical/}. */
    public String schemaArtifact() { return "canonical/schema." + id + ".sql"; }
    /** The identifier quote the engine uses. */
    public String quote() { return quote; }

    public abstract DatabaseDriver newDriver();
    /** The scenario's seed SQL spelled for this engine, or null. */
    public abstract String seed(QueryScenario scenario);

    private static final Pattern UTC_INSTANT = Pattern.compile("'(\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?)Z'");

    /**
     * Postgres-quoted seed SQL to MySQL. Walks the text once so a double quote INSIDE a
     * single-quoted string (a JSON payload) is left alone and only a double-quoted identifier is
     * rewritten; a UTC instant literal loses its {@code Z} (a DATETIME holds the UTC wall clock).
     */
    static String toMysqlSeed(String seed) {
        StringBuilder out = new StringBuilder(seed.length());
        boolean inString = false;
        boolean inIdent = false;
        for (int i = 0; i < seed.length(); i++) {
            char c = seed.charAt(i);
            if (inString) {
                out.append(c);
                if (c == '\'') {
                    if (i + 1 < seed.length() && seed.charAt(i + 1) == '\'') { out.append('\''); i++; }
                    else inString = false;
                }
            } else if (inIdent) {
                if (c == '"') { out.append('`'); inIdent = false; } else out.append(c);
            } else if (c == '\'') {
                inString = true;
                out.append(c);
            } else if (c == '"') {
                inIdent = true;
                out.append('`');
            } else {
                out.append(c);
            }
        }
        return UTC_INSTANT.matcher(out).replaceAll("'$1'");
    }

    /** The statements of a script: split on a {@code ;} at the end of a line (no body carries one mid-line). */
    static java.util.List<String> splitStatements(String script) {
        StringBuilder sb = new StringBuilder();
        for (String line : script.split("\n", -1)) {
            if (!line.trim().startsWith("--")) sb.append(line).append('\n');
        }
        java.util.List<String> out = new java.util.ArrayList<>();
        for (String stmt : sb.toString().split(";[ \\t]*(?:\\n|$)")) {
            if (!stmt.isBlank()) out.add(stmt.trim());
        }
        return out;
    }
}

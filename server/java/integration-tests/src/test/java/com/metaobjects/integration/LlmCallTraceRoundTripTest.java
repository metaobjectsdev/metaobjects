package com.metaobjects.integration;

import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.loader.ai.LlmTraceFieldDeriver;
import com.metaobjects.loader.uri.URIHelper;
import com.metaobjects.manager.ObjectConnection;
import com.metaobjects.manager.db.ObjectManagerDB;
import com.metaobjects.manager.db.ai.LlmCallInput;
import com.metaobjects.manager.db.ai.LlmCallRecorder;
import com.metaobjects.manager.db.ai.LlmTraceRowBuilder;
import com.metaobjects.manager.db.ai.ObjectManagerDbLlmCallRecorder;
import com.metaobjects.manager.db.driver.PostgresDriver;
import com.metaobjects.object.MetaObject;
import com.metaobjects.object.value.ValueObject;
import com.metaobjects.registry.MetaDataLoaderRegistry;
import com.metaobjects.registry.ObjectClassRegistry;
import com.metaobjects.registry.ServiceRegistryFactory;
import org.junit.jupiter.api.Test;

import javax.sql.DataSource;
import java.io.PrintWriter;
import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.Date;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicReference;
import java.util.logging.Logger;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Real-Postgres round-trip oracle for the AI-trace recorder (Slice 1, Java port).
 *
 * <p>Proves that a typed LLM-call trace persists and reads back through OMDB
 * against a live Postgres: a trace entity extending the SHIPPED
 * {@code metaobjects::ai::LlmCallBase} (loaded from {@code library/ai/llm-call.yaml})
 * with an explicit typed {@code voResponse} ({@code field.object} +
 * {@code @objectRef} + {@code @dbType:jsonb}). Asserts BOTH the raw envelope
 * (the 18 LlmCallBase fields, raw {@code llmRequest}/{@code llmResponse}) AND the
 * typed {@code voResponse} jsonb column round-trip as the bound typed VO.</p>
 *
 * <p>Mirrors {@link RuntimeReturnTypeTest}: a {@link PostgresContainer} (docker-CLI,
 * no testcontainers lib) + {@link PostgresDriver} + OMDB, schema provisioned by
 * explicit DDL (ADR-0015: OMDB is pure data-access). {@code field.uuid} columns
 * require native Postgres {@code uuid} binding, so this is a PG (not Derby) test.</p>
 *
 * <p>NOT part of the default Maven reactor build — run via
 * {@code mvn -f server/java/integration-tests/pom.xml test} or
 * {@code scripts/integration-test.sh java}. Requires Docker.</p>
 */
final class LlmCallTraceRoundTripTest {

    /** Public mutable POJO bound to metaobjects::ai::GreetingResponse. */
    public static final class GreetingResponse {
        private String greeting;
        private int score;
        public GreetingResponse() {}
        public GreetingResponse(String greeting, int score) { this.greeting = greeting; this.score = score; }
        public String getGreeting() { return greeting; }
        public void setGreeting(String greeting) { this.greeting = greeting; }
        public int getScore() { return score; }
        public void setScore(int score) { this.score = score; }
    }

    private static final String ENTITY = "metaobjects::ai::GreetingCall";

    @Test
    void typedTraceRoundTripsThroughPostgres() throws Exception {
        try (PostgresContainer pg = new PostgresContainer()) {

            // Bind the typed jsonb VO so the codec read path returns a GreetingResponse.
            ObjectClassRegistry reg = new ObjectClassRegistry();
            reg.register(() -> Map.of("metaobjects::ai::GreetingResponse", GreetingResponse.class));
            ObjectClassRegistry.setGlobal(reg);

            // Load the SHIPPED library/ai/llm-call.yaml (LlmCallBase) + the test
            // trace entity from one loader (deferred extends resolution merges them).
            MetaDataLoader loader = loadAiTraceMetadata();
            MetaDataLoaderRegistry registry =
                new MetaDataLoaderRegistry(ServiceRegistryFactory.getDefault());
            registry.registerLoader(loader);

            ObjectManagerDB omdb = new ObjectManagerDB();
            omdb.setDatabaseDriver(new PostgresDriver());
            omdb.setDataSource(dataSource(pg));
            omdb.init();

            provisionSchema(pg);

            MetaObject mo = registry.findMetaObjectByName(ENTITY);
            assertNotNull(mo, "GreetingCall MetaObject not found");

            // --- build + record (raw envelope + typed voResponse together) ---
            String spanId = UUID.randomUUID().toString();
            String traceId = UUID.randomUUID().toString();
            String parentSpanId = UUID.randomUUID().toString();

            Map<String, Object> request = Map.of("prompt", "say hi", "temperature", 0.2);
            Date startedAt = new Date(1_700_000_000_000L);

            LlmCallInput input = new LlmCallInput(
                spanId, traceId, parentSpanId,
                "session-1", "greeting", "you are a greeter",
                startedAt, request, "{\"greeting\":\"hello\",\"score\":7}",
                "claude-x", "claude-x",
                12, 8, 1500L, 345, "stop",
                LlmCallInput.STATUS_OK, null);

            ObjectConnection oc = omdb.getConnection();
            try {
                LlmCallRecorder recorder = new ObjectManagerDbLlmCallRecorder(omdb, oc);
                ValueObject row = LlmTraceRowBuilder.buildLlmCallRow(mo, input);
                mo.getMetaField("voResponse").setObject(row, new GreetingResponse("hello", 7));
                recorder.record(row);

                // --- read back ---
                var rows = omdb.getObjects(oc, mo);
                assertEquals(1, rows.size(), "expected exactly one trace row");
                ValueObject loaded = (ValueObject) rows.iterator().next();

                // envelope
                assertEquals(spanId, loaded.getString("spanId"));
                assertEquals(traceId, loaded.getString("traceId"));
                assertEquals(parentSpanId, loaded.getString("parentSpanId"));
                assertEquals("session-1", loaded.getString("sessionId"));
                assertEquals("greeting", loaded.getString("callType"));
                assertEquals("you are a greeter", loaded.getString("system"));
                assertEquals("claude-x", loaded.getString("requestModel"));
                assertEquals("claude-x", loaded.getString("responseModel"));
                assertEquals(12, ((Number) loaded.getObject("inputTokens")).intValue());
                assertEquals(8, ((Number) loaded.getObject("outputTokens")).intValue());
                assertEquals(1500L, ((Number) loaded.getObject("costMinor")).longValue());
                assertEquals(345, ((Number) loaded.getObject("latencyMs")).intValue());
                assertEquals("stop", loaded.getString("finishReason"));
                assertEquals(LlmCallInput.STATUS_OK, loaded.getString("status"));
                assertNull(loaded.getObject("errorDetail"), "errorDetail should be null");
                assertNotNull(loaded.getObject("startedAt"), "startedAt should round-trip");
                assertInstanceOf(java.util.Date.class, loaded.getObject("startedAt"),
                    "startedAt (field.timestamp) should be a native temporal");

                // raw jsonb columns
                String rawReq = loaded.getString("llmRequest");
                assertNotNull(rawReq, "llmRequest present");
                assertTrue(rawReq.contains("prompt"), "llmRequest JSON-stringified");
                assertTrue(rawReq.contains("say hi"), "llmRequest carries the value");
                Object rawResp = loaded.getObject("llmResponse");
                assertNotNull(rawResp, "llmResponse present");
                assertTrue(rawResp.toString().contains("hello"), "llmResponse carries the model text");

                // typed voResponse jsonb round-trip
                Object vo = loaded.getObject("voResponse");
                assertNotNull(vo, "voResponse should not be null");
                assertInstanceOf(GreetingResponse.class, vo,
                    "voResponse should read back as the bound typed VO, got: " + vo.getClass().getName());
                GreetingResponse gr = (GreetingResponse) vo;
                assertEquals("hello", gr.getGreeting());
                assertEquals(7, gr.getScore());
            } finally {
                omdb.releaseConnection(oc);
                ObjectClassRegistry.resetGlobal();
            }
        }
    }

    /** The never-throw contract: a failing connection routes to onError, never propagates. */
    @Test
    void recorderNeverThrowsAndCallsOnError() {
        AtomicReference<Throwable> captured = new AtomicReference<>();

        ObjectManagerDB omdb = new ObjectManagerDB();
        omdb.setDatabaseDriver(new PostgresDriver());
        // No datasource/init: createObject will fail; the recorder must swallow + onError.

        ObjectConnection broken = new ObjectConnection() {
            @Override public Object getDatastoreConnection() { return null; }
            @Override public void setReadOnly(boolean state) {}
            @Override public boolean isReadOnly() { return false; }
            @Override public void setAutoCommit(boolean state) {}
            @Override public boolean getAutoCommit() { return true; }
            @Override public void commit() {}
            @Override public void rollback() {}
            @Override public void close() {}
            @Override public boolean isClosed() { return false; }
        };

        LlmCallRecorder recorder = new ObjectManagerDbLlmCallRecorder(omdb, broken, captured::set);
        assertDoesNotThrow(() -> recorder.record(new Object()),
            "recorder must never throw on a failing write");
        assertNotNull(captured.get(), "onError should have fired");
    }

    // -----------------------------------------------------------------------

    /**
     * Load the shipped {@code library/ai/llm-call.yaml} (real LlmCallBase) by file
     * URI, plus the test trace-entity resource. Demonstrates loading the shipped
     * AI library metadata in a Java test (Java has no {@code libraries:} loader
     * option wired yet, so the library YAML is loaded directly as a source).
     */
    private static MetaDataLoader loadAiTraceMetadata() {
        Path libraryYaml = findRepoFile("library/ai/llm-call.yaml");
        URI libUri = URIHelper.toURI("model:file:" + libraryYaml.toAbsolutePath());
        URI entityUri = URIHelper.toURI("model:resource:meta.ai-trace.yaml");
        // Wire the AI-trace deriver as a preFreeze hook: voRequest/voResponse are
        // NOT authored in the fixture — they are derived in-load from the prompt's
        // @payloadRef/@responseRef, so the OMDB runtime sees the typed jsonb
        // columns (Slice 3, the metadata-driven-runtime divergence from TS).
        return MetaDataLoader.fromUris("test-ai-trace", List.of(libUri, entityUri),
            null, LlmTraceFieldDeriver::deriveTraceFields);
    }

    /** Walk up from the working dir to locate a repo-relative file. */
    private static Path findRepoFile(String relative) {
        Path cur = Paths.get("").toAbsolutePath();
        while (cur != null) {
            Path candidate = cur.resolve(relative);
            if (Files.isRegularFile(candidate)) return candidate;
            cur = cur.getParent();
        }
        throw new IllegalStateException("Could not locate " + relative
            + " from " + Paths.get("").toAbsolutePath());
    }

    private static void provisionSchema(PostgresContainer pg) throws SQLException {
        try (Connection c = open(pg); Statement s = c.createStatement()) {
            s.execute(
                "CREATE TABLE llm_call (\n"
                    + "  \"traceId\" uuid,\n"
                    + "  \"spanId\" uuid PRIMARY KEY,\n"
                    + "  \"parentSpanId\" uuid,\n"
                    + "  \"sessionId\" varchar(128),\n"
                    + "  \"callType\" varchar(64),\n"
                    + "  \"system\" varchar(256),\n"
                    + "  \"requestModel\" varchar(128),\n"
                    + "  \"responseModel\" varchar(128),\n"
                    + "  \"inputTokens\" integer,\n"
                    + "  \"outputTokens\" integer,\n"
                    + "  \"costMinor\" bigint,\n"
                    + "  \"latencyMs\" integer,\n"
                    + "  \"finishReason\" varchar(64),\n"
                    + "  \"status\" varchar(16),\n"
                    + "  \"errorDetail\" varchar(2000),\n"
                    + "  \"startedAt\" timestamp,\n"
                    + "  \"llmRequest\" jsonb,\n"
                    + "  \"llmResponse\" jsonb,\n"
                    + "  \"voRequest\" jsonb,\n"
                    + "  \"voResponse\" jsonb\n"
                    + ")");
        }
    }

    private static DataSource dataSource(PostgresContainer pg) {
        return new DataSource() {
            @Override public Connection getConnection() throws SQLException { return open(pg); }
            @Override public Connection getConnection(String u, String p) throws SQLException { return open(pg); }
            @Override public PrintWriter getLogWriter() { return null; }
            @Override public void setLogWriter(PrintWriter out) {}
            @Override public void setLoginTimeout(int seconds) {}
            @Override public int getLoginTimeout() { return 0; }
            @Override public Logger getParentLogger() { return Logger.getLogger("integration-tests"); }
            @Override public <T> T unwrap(Class<T> iface) { return null; }
            @Override public boolean isWrapperFor(Class<?> iface) { return false; }
        };
    }

    /**
     * Open a connection with {@code stringtype=unspecified} so pgjdbc lets the
     * typed-jsonb codec path bind JSON text via setString into the native
     * {@code jsonb} columns (Postgres rejects a plain varchar→jsonb otherwise).
     */
    private static Connection open(PostgresContainer pg) throws SQLException {
        String url = pg.jdbcUrl() + "?stringtype=unspecified";
        return DriverManager.getConnection(url, pg.username(), pg.password());
    }
}

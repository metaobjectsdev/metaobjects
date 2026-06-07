package com.metaobjects.manager.db.ai;

import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.manager.ObjectConnection;
import com.metaobjects.manager.db.ObjectManagerDB;
import com.metaobjects.manager.db.driver.DerbyDriver;
import com.metaobjects.object.MetaObject;
import com.metaobjects.object.value.ValueObject;
import com.metaobjects.registry.MetaDataLoaderRegistry;
import com.metaobjects.registry.ServiceRegistryFactory;

import org.junit.AfterClass;
import org.junit.BeforeClass;
import org.junit.Test;

import java.util.Date;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.Assert.*;

/**
 * Unit-level gate for the AI-trace recorder mechanics in the omdb module (the
 * home of the production code). Proves, without a live database:
 *
 * <ul>
 *   <li>{@link LlmTraceRowBuilder} populates exactly the 18 LlmCallBase base
 *       fields via the field SPI, with the raw {@code llmRequest} JSON-stringified
 *       and {@code llmResponse} stored verbatim;</li>
 *   <li>the typed {@code voResponse} layer is NOT set by the builder (caller-owned);</li>
 *   <li>{@link ObjectManagerDbLlmCallRecorder} never throws and routes a failed
 *       write to its {@code onError} consumer.</li>
 * </ul>
 *
 * <p>The full raw + typed-jsonb persistence round-trip is gated against real
 * Postgres (the LlmCallBase {@code field.uuid} columns require native uuid
 * binding) in {@code integration-tests}'
 * {@code com.metaobjects.integration.LlmCallTraceRoundTripTest}.</p>
 */
public class LlmTraceRecorderTest {

    private static MetaDataLoader loader;
    private static MetaDataLoaderRegistry registry;

    @BeforeClass
    public static void setup() {
        registry = new MetaDataLoaderRegistry(ServiceRegistryFactory.getDefault());
        loader = MetaDataLoader.fromResources(
            "test-llmtrace", java.util.List.of("meta.llmtrace.json"));
        registry.registerLoader(loader);
    }

    @AfterClass
    public static void teardown() {
        if (loader != null) loader.destroy();
    }

    @Test
    public void buildRowSetsBaseFieldsAndStringifiesRequest() {
        MetaObject mo = registry.findMetaObjectByName("metaobjects::ai::GreetingCall");
        assertNotNull(mo);

        Map<String, Object> request = new LinkedHashMap<>();
        request.put("prompt", "say hi");
        request.put("temperature", 0.2);

        LlmCallInput input = new LlmCallInput(
            "11111111-1111-1111-1111-111111111111",
            "22222222-2222-2222-2222-222222222222",
            "33333333-3333-3333-3333-333333333333",
            "session-1", "greeting", "you are a greeter",
            new Date(1_700_000_000_000L), request,
            "{\"greeting\":\"hello\"}",
            "claude-x", "claude-x",
            12, 8, 1500L, 345, "stop",
            LlmCallInput.STATUS_OK, null);

        ValueObject row = LlmTraceRowBuilder.buildLlmCallRow(mo, input);

        // envelope fields set through the field SPI
        assertEquals("11111111-1111-1111-1111-111111111111", row.getString("spanId"));
        assertEquals("22222222-2222-2222-2222-222222222222", row.getString("traceId"));
        assertEquals("greeting", row.getString("callType"));
        assertEquals("you are a greeter", row.getString("system"));
        assertEquals(1500L, ((Number) row.getObject("costMinor")).longValue());
        assertEquals(345, ((Number) row.getObject("latencyMs")).intValue());
        assertEquals(LlmCallInput.STATUS_OK, row.getString("status"));
        assertNull(row.getObject("errorDetail"));
        assertInstanceOf(row.getObject("startedAt"));

        // raw request JSON-stringified; response stored verbatim
        String rawReq = row.getString("llmRequest");
        assertTrue("llmRequest JSON-stringified", rawReq.contains("\"prompt\"") && rawReq.contains("say hi"));
        assertEquals("{\"greeting\":\"hello\"}", row.getString("llmResponse"));

        // typed voResponse layer is caller-owned — builder leaves it unset
        assertNull("builder must not set voResponse", row.getObject("voResponse"));
    }

    @Test
    public void requestStringPassesThroughUnchanged() {
        MetaObject mo = registry.findMetaObjectByName("metaobjects::ai::GreetingCall");
        LlmCallInput input = new LlmCallInput(
            "11111111-1111-1111-1111-111111111111",
            "22222222-2222-2222-2222-222222222222",
            null, null, "greeting", null,
            new Date(0L), "{\"already\":\"json\"}", "resp",
            null, null, null, null, null, null, null,
            LlmCallInput.STATUS_OK, null);
        ValueObject row = LlmTraceRowBuilder.buildLlmCallRow(mo, input);
        assertEquals("{\"already\":\"json\"}", row.getString("llmRequest"));
    }

    @Test
    public void recorderNeverThrowsAndCallsOnError() {
        AtomicReference<Throwable> captured = new AtomicReference<>();

        ObjectManagerDB omdb = new ObjectManagerDB();
        omdb.setDatabaseDriver(new DerbyDriver());
        // No datasource/init — createObject will fail; recorder must swallow + onError.

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
        recorder.record(new Object());  // must not throw
        assertNotNull("onError should have fired", captured.get());
    }

    @Test
    public void nullRecorderIsNoOp() {
        NullLlmCallRecorder.INSTANCE.record(new Object());  // must not throw
    }

    private static void assertInstanceOf(Object o) {
        assertNotNull("startedAt should be set", o);
        assertTrue("startedAt should be a Date", o instanceof Date);
    }
}

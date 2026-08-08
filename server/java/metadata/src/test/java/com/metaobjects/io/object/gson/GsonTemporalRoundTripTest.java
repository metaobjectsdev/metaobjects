package com.metaobjects.io.object.gson;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.metaobjects.field.MetaField;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.object.MetaObject;
import com.metaobjects.object.value.ValueObject;
import com.metaobjects.test.proxy.fruitbasket.Apple;
import com.metaobjects.test.proxy.fruitbasket.Orange;
import org.junit.Assert;
import org.junit.Before;
import org.junit.Test;

import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.util.Arrays;
import java.util.Date;

/**
 * #275 — {@code MetaObjectSerializer.writeField}'s {@code case DATE:} handed back the
 * <em>containing</em> object to {@code context.serialize(vo)}. Since
 * {@code MetaObjectGsonInitializer} registers the serializer against the VO's own class,
 * that re-dispatches to the same serializer for the same instance: unbounded recursion,
 * {@link StackOverflowError}, on every {@code field.date}/{@code field.timestamp} write —
 * even when the value is {@code null}, since the branch never read the field.
 *
 * <p>Pins the fix described by {@code fixtures/persistence-conformance/normalization.md}
 * (the cross-port wire-form contract) as implemented by
 * {@link com.metaobjects.io.json.TemporalWireFormat}.
 */
public class GsonTemporalRoundTripTest {

    private static final String TEMPORAL_TYPE = "test::temporal::TemporalThing";

    protected MetaDataLoader fruitLoader;
    protected MetaDataLoader temporalLoader;

    @Before
    public void initLoaders() throws ClassNotFoundException {
        fruitLoader = MetaDataLoader.fromResources("gson-temporal-fruit", Arrays.asList(
                "com/metaobjects/loader/simple/fruitbasket-proxy-metadata.json"
        ));
        temporalLoader = MetaDataLoader.fromResources("gson-temporal-values", Arrays.asList(
                "com/metaobjects/io/object/gson/temporal-metadata.json"
        ));
    }

    private static Date utc(int y, int mo, int d, int h, int mi, int s, int ms) {
        return Date.from(LocalDateTime.of(y, mo, d, h, mi, s, ms * 1_000_000)
                .toInstant(ZoneOffset.UTC));
    }

    private ValueObject newTemporal() {
        MetaObject mo = temporalLoader.getMetaObjectByName(TEMPORAL_TYPE);
        return (ValueObject) mo.newInstance();
    }

    private MetaField temporalField(String name) {
        return temporalLoader.getMetaObjectByName(TEMPORAL_TYPE).getMetaField(name);
    }

    // -----------------------------------------------------------------------
    // Step 1 — RED: the crash pin.
    // -----------------------------------------------------------------------

    @Test
    public void orangeWithPickedDateSet_serializesWithoutRecursion() throws ClassNotFoundException {
        Gson gson = MetaObjectGsonInitializer.getBuilderWithAdapters(fruitLoader).create();

        Orange o = fruitLoader.newObjectInstance(Orange.class);
        o.setId(1L);
        o.setName("orange");
        o.setPickedDate(utc(2026, 6, 3, 14, 30, 0, 123));

        JsonObject obj = gson.toJsonTree(o).getAsJsonObject();
        Assert.assertEquals("2026-06-03", obj.get("pickedDate").getAsString());
    }

    @Test
    public void orangeWithNullPickedDate_serializesJsonNullWithoutRecursion() throws ClassNotFoundException {
        // serializeNulls(): both toJson (String) AND toJsonTree route their custom-serializer
        // output through a JsonWriter (a real one, or the JsonTreeWriter toJsonTree uses
        // internally), and JsonWriter#nullValue() silently drops a deferred member name when
        // serializeNulls is false (the GsonBuilder default) -- true for EVERY nullable field in
        // this serializer, not something specific to DATE (see
        // appleWithNoTemporalFields_serializesToExactPreChangeString below, which pins that
        // default-omission behavior unchanged). Opt in here to observe our own
        // jsonObject.add(name, JsonNull.INSTANCE) directly.
        Gson gson = MetaObjectGsonInitializer.getBuilderWithAdapters(fruitLoader).serializeNulls().create();

        Orange o = fruitLoader.newObjectInstance(Orange.class);
        o.setId(2L);
        o.setName("orange-no-date");
        // pickedDate deliberately left null: pre-fix this ALSO recurses, since the buggy
        // branch never read the field value before calling context.serialize(vo).

        JsonObject obj = gson.toJsonTree(o).getAsJsonObject();
        Assert.assertTrue(obj.get("pickedDate").isJsonNull());
    }

    // -----------------------------------------------------------------------
    // Step 2 — RED: timestamp + @localTime coverage, every fraction vector.
    // -----------------------------------------------------------------------

    @Test
    public void dateField_writesCalendarDateOnly_ignoringTimeOfDay() {
        Gson gson = MetaObjectGsonInitializer.getBuilderWithAdapters(temporalLoader).create();

        ValueObject vo = newTemporal();
        temporalField("eventDate").setDate(vo, utc(2026, 6, 3, 14, 30, 0, 123));

        JsonObject obj = gson.toJsonTree(vo).getAsJsonObject();
        Assert.assertEquals("2026-06-03", obj.get("eventDate").getAsString());
    }

    @Test
    public void timestampField_writesUtcInstant_withFractionRules() {
        Gson gson = MetaObjectGsonInitializer.getBuilderWithAdapters(temporalLoader).create();

        assertCreatedAt(gson, 123, "2026-06-03T14:30:00.123Z");
        assertCreatedAt(gson, 120, "2026-06-03T14:30:00.12Z");
        assertCreatedAt(gson, 100, "2026-06-03T14:30:00.1Z");
        assertCreatedAt(gson, 0,   "2026-06-03T14:30:00Z");
    }

    private void assertCreatedAt(Gson gson, int ms, String expected) {
        ValueObject vo = newTemporal();
        temporalField("createdAt").setDate(vo, utc(2026, 6, 3, 14, 30, 0, ms));

        JsonObject obj = gson.toJsonTree(vo).getAsJsonObject();
        Assert.assertEquals("ms=" + ms, expected, obj.get("createdAt").getAsString());
    }

    @Test
    public void localTimeTimestampField_writesNaiveWallClock_noZ_withFractionRules() {
        Gson gson = MetaObjectGsonInitializer.getBuilderWithAdapters(temporalLoader).create();

        assertLocalCreatedAt(gson, 123, "2026-06-03T14:30:00.123");
        assertLocalCreatedAt(gson, 120, "2026-06-03T14:30:00.12");
        assertLocalCreatedAt(gson, 100, "2026-06-03T14:30:00.1");
        assertLocalCreatedAt(gson, 0,   "2026-06-03T14:30:00");
    }

    private void assertLocalCreatedAt(Gson gson, int ms, String expected) {
        ValueObject vo = newTemporal();
        temporalField("localCreatedAt").setDate(vo, utc(2026, 6, 3, 14, 30, 0, ms));

        JsonObject obj = gson.toJsonTree(vo).getAsJsonObject();
        Assert.assertEquals("ms=" + ms, expected, obj.get("localCreatedAt").getAsString());
    }

    // -----------------------------------------------------------------------
    // Step 3 — RED: legacy epoch-millis read (the LONG coercion path DATE already shared).
    // -----------------------------------------------------------------------

    @Test
    public void pickedDate_readsLegacyEpochMillisNumber() {
        Gson gson = MetaObjectGsonInitializer.getBuilderWithAdapters(fruitLoader).create();

        String json = "{\"@type\":\"simple::fruitbasket::Orange\",\"id\":1,\"name\":\"orange\","
                + "\"pickedDate\":1750000000000}";

        Orange o = (Orange) gson.fromJson(json, Orange.class);

        Assert.assertEquals(1750000000000L, o.getPickedDate().getTime());
    }

    // -----------------------------------------------------------------------
    // Step 4 — RED: tolerant ISO string read, all three wire forms + a clear error on garbage.
    // -----------------------------------------------------------------------

    @Test
    public void createdAt_readsInstantForm_withZ() {
        Gson gson = MetaObjectGsonInitializer.getBuilderWithAdapters(temporalLoader).create();

        String json = "{\"@type\":\"" + TEMPORAL_TYPE + "\",\"createdAt\":\"2026-06-03T14:30:00.123Z\"}";
        ValueObject vo = (ValueObject) gson.fromJson(json, ValueObject.class);

        Date expected = utc(2026, 6, 3, 14, 30, 0, 123);
        Assert.assertEquals(expected, temporalField("createdAt").getDate(vo));
    }

    @Test
    public void createdAt_readsLocalDateTimeForm_noZ() {
        Gson gson = MetaObjectGsonInitializer.getBuilderWithAdapters(temporalLoader).create();

        String json = "{\"@type\":\"" + TEMPORAL_TYPE + "\",\"createdAt\":\"2026-06-03T14:30:00.123\"}";
        ValueObject vo = (ValueObject) gson.fromJson(json, ValueObject.class);

        Date expected = utc(2026, 6, 3, 14, 30, 0, 123);
        Assert.assertEquals(expected, temporalField("createdAt").getDate(vo));
    }

    @Test
    public void eventDate_readsDateOnlyForm_atMidnightUtc() {
        Gson gson = MetaObjectGsonInitializer.getBuilderWithAdapters(temporalLoader).create();

        String json = "{\"@type\":\"" + TEMPORAL_TYPE + "\",\"eventDate\":\"2026-06-03\"}";
        ValueObject vo = (ValueObject) gson.fromJson(json, ValueObject.class);

        Date expected = utc(2026, 6, 3, 0, 0, 0, 0);
        Assert.assertEquals(expected, temporalField("eventDate").getDate(vo));
    }

    @Test
    public void createdAt_garbageString_throwsClearErrorNamingFieldAndForms() {
        Gson gson = MetaObjectGsonInitializer.getBuilderWithAdapters(temporalLoader).create();

        String json = "{\"@type\":\"" + TEMPORAL_TYPE + "\",\"createdAt\":\"not-a-date\"}";

        try {
            gson.fromJson(json, ValueObject.class);
            Assert.fail("Expected an exception for an unparseable temporal value");
        } catch (Throwable t) {
            String all = collectMessages(t);
            Assert.assertTrue("message should name the field, was: " + all, all.contains("createdAt"));
            Assert.assertTrue("message should name accepted forms, was: " + all, all.contains("YYYY-MM-DD"));
        }
    }

    private static String collectMessages(Throwable t) {
        StringBuilder sb = new StringBuilder();
        while (t != null) {
            if (t.getMessage() != null) sb.append(t.getMessage()).append(" | ");
            t = t.getCause();
        }
        return sb.toString();
    }

    // -----------------------------------------------------------------------
    // Step 6 — round-trip + no-churn pins.
    // -----------------------------------------------------------------------

    @Test
    public void writeReadWrite_isByteIdenticalOnSecondWrite() {
        Gson gson = MetaObjectGsonInitializer.getBuilderWithAdapters(temporalLoader).create();

        ValueObject vo = newTemporal();
        temporalField("eventDate").setDate(vo, utc(2026, 6, 3, 0, 0, 0, 0));
        temporalField("createdAt").setDate(vo, utc(2026, 6, 3, 14, 30, 0, 123));
        temporalField("localCreatedAt").setDate(vo, utc(2026, 6, 3, 14, 30, 0, 120));

        String firstWrite = gson.toJson(vo);
        ValueObject roundTripped = (ValueObject) gson.fromJson(firstWrite, ValueObject.class);
        String secondWrite = gson.toJson(roundTripped);

        Assert.assertEquals(firstWrite, secondWrite);
    }

    @Test
    public void appleWithNoTemporalFields_serializesToExactPreChangeString() throws ClassNotFoundException {
        Gson gson = MetaObjectGsonInitializer.getBuilderWithAdapters(fruitLoader).create();

        Apple f = fruitLoader.newObjectInstance(Apple.class);
        f.setId(1L);
        f.setName("apple");

        String s = gson.toJson(f);

        // Apple has no temporal field, so this class's change must not move this string by
        // one byte. Captured from the UNFIXED (pre-#275) production code (see task report):
        // null-valued fields (basketId/length/weight/inBasket/orchard/worms are all unset)
        // are omitted entirely -- default GsonBuilder#serializeNulls is false, a pre-existing,
        // universal convention for every field type in this serializer, not something DATE-specific.
        Assert.assertEquals(
                "{\"@type\":\"simple::fruitbasket::Apple\",\"id\":1,\"name\":\"apple\"}",
                s);
    }
}

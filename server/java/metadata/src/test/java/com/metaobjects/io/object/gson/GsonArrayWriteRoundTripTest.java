package com.metaobjects.io.object.gson;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.metaobjects.field.MetaField;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.object.MetaObject;
import com.metaobjects.object.value.ValueObject;
import org.junit.Assert;
import org.junit.Before;
import org.junit.Test;

import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.util.Arrays;
import java.util.Date;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Sibling defect to #275, found while fixing it: {@code MetaObjectSerializer.writeField} has no
 * {@code isArrayType()} check on any primitive branch, unlike {@code MetaObjectDeserializer}
 * (which does, symmetrically, on the read side). Every primitive branch unconditionally called a
 * scalar accessor ({@code mf.getBoolean(vo)}, {@code mf.getInt(vo)}, ...), each of which is
 * {@code DataConverter.toX(getObjectAttribute(obj))} — for an array-valued field the raw stored
 * attribute is a {@code List}, and {@code DataConverter.toX} has no {@code List} case for most
 * primitive types, so it falls through to the bracketed native {@code List.toString()} (or, for
 * STRING, a comma-join) — silent round-trip corruption. Fixed by the write-side {@code isArrayType()}
 * dispatch added in {@code MetaObjectSerializer.writeField}.
 *
 * <p>The sibling STORAGE-layer defect this class also exercises (the #275 carry-forward unit):
 * {@code MetaField.setObject(Object,Object)} — the method backing {@code setBoolean}/{@code
 * setInt}/{@code setLong}/{@code setDouble}/{@code setStringArray}, and called directly by {@code
 * MetaObjectDeserializer}'s array-read branches — used to convert via {@code
 * DataConverter.toType(getDataType(), value)}, the field's SCALAR (not effective/array) type, so a
 * {@code List} was corrupted before {@code setObjectAttribute}'s own instanceof check rejected it.
 * Now fixed: {@code setObject} converts via {@code getEffectiveDataType()}, which is the
 * array-equivalent type for an {@code isArray} field and a strict no-op for every scalar field.
 * {@code DataConverter} also gained a {@code DATE_ARRAY} case ({@code toDateArray}), so {@code
 * field.date}/{@code field.timestamp} array fields now have a working storage path end to end.
 * Array fields here are populated via {@link ValueObject}'s {@code Map<String,Object>} interface
 * ({@code vo.put(name, list)}, routing through {@code DataObjectBase._setObjectAttribute}) —
 * that path already converted via the field's EFFECTIVE (array) data type even before this fix, so
 * it exercises the SAME storage layer {@code MetaField.setObject} now also correctly reaches.
 */
public class GsonArrayWriteRoundTripTest {

    private static final String ARRAY_TYPE = "test::arrays::ArrayThing";

    protected MetaDataLoader arrayLoader;

    @Before
    public void initLoader() throws ClassNotFoundException {
        arrayLoader = MetaDataLoader.fromResources("gson-array-write-values", Arrays.asList(
                "com/metaobjects/io/object/gson/array-primitive-metadata.json"
        ));
    }

    private static Date utc(int y, int mo, int d, int h, int mi, int s, int ms) {
        return Date.from(LocalDateTime.of(y, mo, d, h, mi, s, ms * 1_000_000)
                .toInstant(ZoneOffset.UTC));
    }

    private MetaObject arrayMetaObject() {
        return arrayLoader.getMetaObjectByName(ARRAY_TYPE);
    }

    private ValueObject newArrayThing() {
        return (ValueObject) arrayMetaObject().newInstance();
    }

    private MetaField arrayField(String name) {
        return arrayMetaObject().getMetaField(name);
    }

    // -----------------------------------------------------------------------
    // Step 1 — the comma-join pin (STRING).
    // -----------------------------------------------------------------------

    @Test
    public void stringArray_writesProperJsonArray_notCommaJoinedString() {
        Gson gson = MetaObjectGsonInitializer.getBuilderWithAdapters(arrayLoader).create();

        ValueObject vo = newArrayThing();
        vo.put("tags", Arrays.asList("a", "b"));

        JsonObject obj = gson.toJsonTree(vo).getAsJsonObject();
        JsonElement el = obj.get("tags");

        Assert.assertTrue("expected a JSON array, was: " + el, el.isJsonArray());
        JsonArray arr = el.getAsJsonArray();
        Assert.assertEquals(2, arr.size());
        Assert.assertEquals("a", arr.get(0).getAsString());
        Assert.assertEquals("b", arr.get(1).getAsString());
    }

    // -----------------------------------------------------------------------
    // Step 2 — round trip for the other touched primitive branches.
    // -----------------------------------------------------------------------

    @Test
    public void intArray_writesProperJsonArray() {
        Gson gson = MetaObjectGsonInitializer.getBuilderWithAdapters(arrayLoader).create();

        ValueObject vo = newArrayThing();
        vo.put("counts", Arrays.asList(1, 2, 3));

        JsonObject obj = gson.toJsonTree(vo).getAsJsonObject();
        JsonElement el = obj.get("counts");

        Assert.assertTrue("expected a JSON array, was: " + el, el.isJsonArray());
        JsonArray arr = el.getAsJsonArray();
        Assert.assertEquals(3, arr.size());
        Assert.assertEquals(1, arr.get(0).getAsInt());
        Assert.assertEquals(2, arr.get(1).getAsInt());
        Assert.assertEquals(3, arr.get(2).getAsInt());
    }

    @Test
    public void longArray_writesProperJsonArray() {
        Gson gson = MetaObjectGsonInitializer.getBuilderWithAdapters(arrayLoader).create();

        ValueObject vo = newArrayThing();
        vo.put("bigCounts", Arrays.asList(10L, 20L));

        JsonObject obj = gson.toJsonTree(vo).getAsJsonObject();
        JsonElement el = obj.get("bigCounts");

        Assert.assertTrue("expected a JSON array, was: " + el, el.isJsonArray());
        JsonArray arr = el.getAsJsonArray();
        Assert.assertEquals(2, arr.size());
        Assert.assertEquals(10L, arr.get(0).getAsLong());
        Assert.assertEquals(20L, arr.get(1).getAsLong());
    }

    @Test
    public void booleanArray_writesProperJsonArray() {
        Gson gson = MetaObjectGsonInitializer.getBuilderWithAdapters(arrayLoader).create();

        ValueObject vo = newArrayThing();
        vo.put("flags", Arrays.asList(true, false, true));

        JsonObject obj = gson.toJsonTree(vo).getAsJsonObject();
        JsonElement el = obj.get("flags");

        Assert.assertTrue("expected a JSON array, was: " + el, el.isJsonArray());
        JsonArray arr = el.getAsJsonArray();
        Assert.assertEquals(3, arr.size());
        Assert.assertTrue(arr.get(0).getAsBoolean());
        Assert.assertFalse(arr.get(1).getAsBoolean());
        Assert.assertTrue(arr.get(2).getAsBoolean());
    }

    @Test
    public void doubleArray_writesProperJsonArray() {
        Gson gson = MetaObjectGsonInitializer.getBuilderWithAdapters(arrayLoader).create();

        ValueObject vo = newArrayThing();
        vo.put("amounts", Arrays.asList(1.5, 2.25));

        JsonObject obj = gson.toJsonTree(vo).getAsJsonObject();
        JsonElement el = obj.get("amounts");

        Assert.assertTrue("expected a JSON array, was: " + el, el.isJsonArray());
        JsonArray arr = el.getAsJsonArray();
        Assert.assertEquals(2, arr.size());
        Assert.assertEquals(1.5, arr.get(0).getAsDouble(), 0.0001);
        Assert.assertEquals(2.25, arr.get(1).getAsDouble(), 0.0001);
    }

    // -----------------------------------------------------------------------
    // Step 2b — null-array-itself pin (C3), extended from DATE (Step 3 below already covered
    // it) to every other touched type: the whole field is JSON null, not an empty/absent array.
    //
    // .serializeNulls() is required here: these branches write via context.serialize(...), and
    // Gson's default (serializeNulls==false) DROPS a JsonObject member whose value is
    // JsonNull.INSTANCE when the tree is re-written by the outer toJsonTree() pass -- unrelated
    // to this task's storage fix, just Gson's ordinary null-suppression default. The DATE branch
    // below doesn't need this because its null-array-itself pin calls writeField() directly
    // against a raw JsonObject, bypassing that outer re-write pass entirely.
    // -----------------------------------------------------------------------

    @Test
    public void stringArray_nullArrayItself_writesJsonNullForWholeField() {
        Gson gson = MetaObjectGsonInitializer.getBuilderWithAdapters(arrayLoader).serializeNulls().create();

        ValueObject vo = newArrayThing();
        vo.put("tags", null);

        JsonObject obj = gson.toJsonTree(vo).getAsJsonObject();
        JsonElement el = obj.get("tags");

        Assert.assertTrue("expected JSON null for the whole field, was: " + el, el.isJsonNull());
    }

    @Test
    public void intArray_nullArrayItself_writesJsonNullForWholeField() {
        Gson gson = MetaObjectGsonInitializer.getBuilderWithAdapters(arrayLoader).serializeNulls().create();

        ValueObject vo = newArrayThing();
        vo.put("counts", null);

        JsonObject obj = gson.toJsonTree(vo).getAsJsonObject();
        JsonElement el = obj.get("counts");

        Assert.assertTrue("expected JSON null for the whole field, was: " + el, el.isJsonNull());
    }

    @Test
    public void longArray_nullArrayItself_writesJsonNullForWholeField() {
        Gson gson = MetaObjectGsonInitializer.getBuilderWithAdapters(arrayLoader).serializeNulls().create();

        ValueObject vo = newArrayThing();
        vo.put("bigCounts", null);

        JsonObject obj = gson.toJsonTree(vo).getAsJsonObject();
        JsonElement el = obj.get("bigCounts");

        Assert.assertTrue("expected JSON null for the whole field, was: " + el, el.isJsonNull());
    }

    @Test
    public void booleanArray_nullArrayItself_writesJsonNullForWholeField() {
        Gson gson = MetaObjectGsonInitializer.getBuilderWithAdapters(arrayLoader).serializeNulls().create();

        ValueObject vo = newArrayThing();
        vo.put("flags", null);

        JsonObject obj = gson.toJsonTree(vo).getAsJsonObject();
        JsonElement el = obj.get("flags");

        Assert.assertTrue("expected JSON null for the whole field, was: " + el, el.isJsonNull());
    }

    @Test
    public void doubleArray_nullArrayItself_writesJsonNullForWholeField() {
        Gson gson = MetaObjectGsonInitializer.getBuilderWithAdapters(arrayLoader).serializeNulls().create();

        ValueObject vo = newArrayThing();
        vo.put("amounts", null);

        JsonObject obj = gson.toJsonTree(vo).getAsJsonObject();
        JsonElement el = obj.get("amounts");

        Assert.assertTrue("expected JSON null for the whole field, was: " + el, el.isJsonNull());
    }

    // -----------------------------------------------------------------------
    // Step 3 — DATE array, write side in isolation. field.date/field.timestamp isArray DOES
    // have a working storage path now (DataConverter.toDateArray backs DATE_ARRAY; see the
    // full-pipeline round trips in Step 3b below). These tests still call
    // MetaObjectSerializer.writeField DIRECTLY (same package; protected access) against a plain
    // Map-backed "value object", read via AbstractObjectRepresentation.getValue's Map branch (a
    // raw, unconverted get) -- isolating the WRITE-side formatting logic from storage entirely,
    // the same isolation technique used before the storage fix, kept because it targets a
    // narrower unit than the full round trip.
    // -----------------------------------------------------------------------

    private JsonObject writeDatesField(List<?> dates) {
        MetaObject mo = arrayMetaObject();
        MetaField mf = arrayField("dates");
        Map<String, Object> vo = new HashMap<>();
        vo.put("dates", dates);

        JsonObject jsonObject = new JsonObject();
        new MetaObjectSerializer(mo).writeField(mo, mf, vo, jsonObject, null);
        return jsonObject;
    }

    @Test
    public void dateArray_writesJsonArrayOfWireFormStrings() {
        JsonObject obj = writeDatesField(Arrays.asList(
                utc(2026, 6, 3, 0, 0, 0, 0),
                utc(2026, 7, 4, 0, 0, 0, 0)));
        JsonElement el = obj.get("dates");

        Assert.assertTrue("expected a JSON array, was: " + el, el.isJsonArray());
        JsonArray arr = el.getAsJsonArray();
        Assert.assertEquals(2, arr.size());
        Assert.assertEquals("2026-06-03", arr.get(0).getAsString());
        Assert.assertEquals("2026-07-04", arr.get(1).getAsString());
    }

    @Test
    public void dateArray_withNonDateConvertibleElement_convertsViaDataConverter() {
        // C1: MetaObjectSerializer's DATE-array element loop routes each element through
        // DataConverter.toDate(o) rather than a hard (Date) cast -- so a non-Date element that
        // toDate CAN convert (e.g. a Long epoch-millis value, same as the scalar DATE branch
        // would accept) converts instead of throwing a bare ClassCastException.
        JsonObject obj = writeDatesField(Arrays.asList(
                utc(2026, 6, 3, 0, 0, 0, 0),
                utc(2026, 7, 4, 0, 0, 0, 0).getTime()));
        JsonArray arr = obj.get("dates").getAsJsonArray();

        Assert.assertEquals(2, arr.size());
        Assert.assertEquals("2026-06-03", arr.get(0).getAsString());
        Assert.assertEquals("2026-07-04", arr.get(1).getAsString());
    }

    @Test
    public void dateArray_withNullElement_writesJsonNullAtThatPosition() {
        JsonObject obj = writeDatesField(Arrays.asList(utc(2026, 6, 3, 0, 0, 0, 0), null));
        JsonArray arr = obj.get("dates").getAsJsonArray();

        Assert.assertEquals(2, arr.size());
        Assert.assertEquals("2026-06-03", arr.get(0).getAsString());
        Assert.assertTrue("expected JSON null at index 1, was: " + arr.get(1), arr.get(1).isJsonNull());
    }

    @Test
    public void dateArray_nullArrayItself_writesJsonNullForWholeField() {
        JsonObject obj = writeDatesField(null);
        JsonElement el = obj.get("dates");

        Assert.assertTrue("expected JSON null for the whole field, was: " + el, el.isJsonNull());
    }

    // -----------------------------------------------------------------------
    // Step 3b — DATE array (field.date) and TIMESTAMP array (field.timestamp, plain and
    // @localTime) through the REAL Gson pipeline end to end: vo.put populates via the storage
    // layer this task fixes (DataConverter.toDateArray backing DATE_ARRAY), gson.toJson writes,
    // gson.fromJson reads back through MetaObjectDeserializer's own array-read branch. Before
    // this fix vo.put("dates", list) itself threw UnsupportedOperationException (DATE_ARRAY was
    // unimplemented), so this path -- including the deserializer's DATE-array READ branch -- was
    // untestable dead code (C4/C5/A6).
    // -----------------------------------------------------------------------

    @Test
    public void dateArray_roundTripsThroughFullGsonPipeline() {
        Gson gson = MetaObjectGsonInitializer.getBuilderWithAdapters(arrayLoader).create();

        ValueObject vo = newArrayThing();
        List<Date> dates = Arrays.asList(
                utc(2026, 6, 3, 0, 0, 0, 0),
                utc(2026, 7, 4, 0, 0, 0, 0));
        vo.put("dates", dates);

        String json = gson.toJson(vo);
        Assert.assertTrue("expected wire-form date strings, was: " + json,
                json.contains("\"2026-06-03\"") && json.contains("\"2026-07-04\""));

        ValueObject result = (ValueObject) gson.fromJson(json, ValueObject.class);
        Assert.assertEquals(dates, result.get("dates"));
    }

    @Test
    public void timestampArray_roundTripsThroughFullGsonPipeline() {
        Gson gson = MetaObjectGsonInitializer.getBuilderWithAdapters(arrayLoader).create();

        ValueObject vo = newArrayThing();
        List<Date> timestamps = Arrays.asList(
                utc(2026, 6, 3, 14, 30, 0, 123),
                utc(2026, 7, 4, 0, 0, 0, 0));
        vo.put("timestamps", timestamps);

        String json = gson.toJson(vo);
        Assert.assertTrue("expected tz-aware wire-form timestamp strings, was: " + json,
                json.contains("\"2026-06-03T14:30:00.123Z\"") && json.contains("\"2026-07-04T00:00:00Z\""));

        ValueObject result = (ValueObject) gson.fromJson(json, ValueObject.class);
        Assert.assertEquals(timestamps, result.get("timestamps"));
    }

    @Test
    public void localTimestampArray_roundTripsThroughFullGsonPipeline() {
        Gson gson = MetaObjectGsonInitializer.getBuilderWithAdapters(arrayLoader).create();

        ValueObject vo = newArrayThing();
        List<Date> timestamps = Arrays.asList(
                utc(2026, 6, 3, 14, 30, 0, 123),
                utc(2026, 7, 4, 0, 0, 0, 0));
        vo.put("localTimestamps", timestamps);

        String json = gson.toJson(vo);
        Assert.assertTrue("expected naive wall-clock wire-form strings (no trailing Z), was: " + json,
                json.contains("\"2026-06-03T14:30:00.123\"") && json.contains("\"2026-07-04T00:00:00\""));

        ValueObject result = (ValueObject) gson.fromJson(json, ValueObject.class);
        Assert.assertEquals(timestamps, result.get("localTimestamps"));
    }

    // -----------------------------------------------------------------------
    // Step 5 — round trip through the existing (unmodified) MetaObjectDeserializer.
    //
    // Previously BLOCKED by a separate, pre-existing defect, now fixed: MetaObjectDeserializer's
    // own array-read branches populate the field via MetaField.setStringArray/setObject/
    // setObjectArray -- and MetaField.setObject(Object,Object) used to convert via
    // DataConverter.toType(getDataType(), value), the field's SCALAR type, not its EFFECTIVE
    // (array) type, corrupting a List before setObjectAttribute's own instanceof-against-List
    // check rejected it. setObject now converts via getEffectiveDataType(), so these round-trip.
    // -----------------------------------------------------------------------

    @Test
    public void stringArray_roundTripsThroughDeserializer() {
        Gson gson = MetaObjectGsonInitializer.getBuilderWithAdapters(arrayLoader).create();

        ValueObject vo = newArrayThing();
        List<String> tags = Arrays.asList("a", "b");
        vo.put("tags", tags);
        String json = gson.toJson(vo);

        ValueObject result = (ValueObject) gson.fromJson(json, ValueObject.class);
        Assert.assertEquals(tags, result.get("tags"));
    }

    @Test
    public void longArray_roundTripsThroughDeserializer() {
        Gson gson = MetaObjectGsonInitializer.getBuilderWithAdapters(arrayLoader).create();

        ValueObject vo = newArrayThing();
        List<Long> bigCounts = Arrays.asList(10L, 20L);
        vo.put("bigCounts", bigCounts);
        String json = gson.toJson(vo);

        // Gson's context.deserialize(el, List.class) widens JSON numbers to Double by default
        // (absent generic type info -- the pre-existing, separately out-of-scope numeric-array
        // read widening the brief itself calls out and this task does not redesign). setObject
        // now routes that List<Double> through DataConverter.toLongArray, which maps each
        // element back through DataConverter.toLong (10.0 -> 10L), so the widening is invisible
        // here: the round trip still lands on List<Long>, not List<Double>.
        ValueObject result = (ValueObject) gson.fromJson(json, ValueObject.class);
        Assert.assertEquals(bigCounts, result.get("bigCounts"));
    }

    // -----------------------------------------------------------------------
    // Step 6 — no-churn pins: every SCALAR (non-array) field of every touched type
    // still serializes byte-identically to before this change. DECIMAL (untouched
    // branch) also stays byte-identical.
    // -----------------------------------------------------------------------

    @Test
    public void scalarFields_serializeUnaffectedByArraySupport() {
        Gson gson = MetaObjectGsonInitializer.getBuilderWithAdapters(arrayLoader).create();

        ValueObject vo = newArrayThing();
        arrayField("label").setString(vo, "solo");
        arrayField("count").setInt(vo, 7);
        arrayField("bigCount").setLong(vo, 70L);
        arrayField("flag").setBoolean(vo, true);
        arrayField("amount").setDouble(vo, 3.5);
        arrayField("day").setDate(vo, utc(2026, 6, 3, 0, 0, 0, 0));
        arrayField("price").setDecimal(vo, new java.math.BigDecimal("19.99"));

        JsonObject obj = gson.toJsonTree(vo).getAsJsonObject();

        Assert.assertEquals("solo", obj.get("label").getAsString());
        Assert.assertEquals(7, obj.get("count").getAsInt());
        Assert.assertEquals(70L, obj.get("bigCount").getAsLong());
        Assert.assertTrue(obj.get("flag").getAsBoolean());
        Assert.assertEquals(3.5, obj.get("amount").getAsDouble(), 0.0001);
        Assert.assertEquals("2026-06-03", obj.get("day").getAsString());
        Assert.assertEquals(new java.math.BigDecimal("19.99"), obj.get("price").getAsBigDecimal());
    }
}

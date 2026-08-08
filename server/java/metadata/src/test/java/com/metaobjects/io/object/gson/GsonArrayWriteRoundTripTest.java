package com.metaobjects.io.object.gson;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.metaobjects.InvalidValueException;
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
 * STRING, a comma-join) — silent round-trip corruption.
 *
 * <p><b>Test-setup note:</b> {@code MetaField.setObject(Object,Object)} (the method backing
 * {@code setBoolean}/{@code setInt}/{@code setLong}/{@code setDouble}/{@code setStringArray}) is
 * itself broken for an {@code isArray} field — it converts via {@code DataConverter.toType(
 * getDataType(), value)}, the field's SCALAR (not effective/array) type, so a {@code List} is
 * corrupted before {@code setObjectAttribute}'s own instanceof check rejects it. This is a
 * separate, pre-existing, out-of-scope defect (see the "discovered but out of scope" tests below)
 * — NOT fixed here. It means the standard {@code mf.setX(vo, list)} entry points cannot be used to
 * build array-valued fixtures. Instead, array fields here are populated via {@link ValueObject}'s
 * own {@code Map<String,Object>} interface ({@code vo.put(name, list)}), which routes through
 * {@code DataObjectBase._setObjectAttribute} — a DIFFERENT storage path that correctly converts
 * via the field's EFFECTIVE (array) data type — for every type this task's write-side fix covers
 * EXCEPT {@code field.date}/{@code field.timestamp}, whose {@code DATE_ARRAY} conversion is wholly
 * unimplemented in {@code DataConverter} (see the DATE tests, which instead call {@code
 * MetaObjectSerializer.writeField} directly against a plain {@code Map}-backed value object,
 * sidestepping the storage layer entirely to isolate the WRITE-side logic under test).
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
    // Step 3 — DATE array. field.date/field.timestamp isArray has NO working storage path
    // ANYWHERE in this codebase today (DataConverter.toType has no DATE_ARRAY case, hit
    // unconditionally by AbstractObjectRepresentation.setValue regardless of entry point --
    // see the class Javadoc). So these tests call MetaObjectSerializer.writeField DIRECTLY
    // (same package; protected access) against a plain Map-backed "value object", which is
    // read via AbstractObjectRepresentation.getValue's Map branch (a raw, unconverted get) --
    // isolating the WRITE-side logic under test from that separate, out-of-scope defect.
    // -----------------------------------------------------------------------

    private JsonObject writeDatesField(List<Date> dates) {
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
    // Step 5 — round trip through the existing (unmodified) MetaObjectDeserializer.
    //
    // BLOCKED by a separate, pre-existing, out-of-scope defect: MetaObjectDeserializer's own
    // array-read branches populate the field via MetaField.setStringArray/setObject/setObjectArray
    // -- and MetaField.setObject(Object,Object) converts via DataConverter.toType(getDataType(),
    // value), the field's SCALAR type, not its EFFECTIVE (array) type -- so a List is corrupted
    // (STRING: comma-joined to "a,b"; numeric types: bracketed toString() fed to a parser) BEFORE
    // setObjectAttribute's own instanceof-against-List check rejects it. This affects every
    // BOOLEAN/BYTE/SHORT/INT/LONG/FLOAT/DOUBLE/STRING isArray field via MetaField.setObject, and
    // separately affects DATE via DataConverter's wholly-unimplemented DATE_ARRAY case. It is
    // NOT specific to Gson or to this task's write-side fix -- it would break ANY caller trying to
    // populate an isArray primitive field through MetaField's typed setters, deserializer included.
    // Out of scope per the brief's Stop-and-escalate clause (fixing it requires touching MetaField
    // and/or DataConverter, not MetaObjectSerializer.writeField). Pinned here, not fixed, as
    // evidence + a regression guard for whenever that separate defect is addressed.
    // -----------------------------------------------------------------------

    @Test
    public void stringArray_roundTripThroughDeserializer_blockedByPreexistingSetterBug() {
        Gson gson = MetaObjectGsonInitializer.getBuilderWithAdapters(arrayLoader).create();

        ValueObject vo = newArrayThing();
        vo.put("tags", Arrays.asList("a", "b"));
        String json = gson.toJson(vo);

        try {
            gson.fromJson(json, ValueObject.class);
            Assert.fail("Expected the pre-existing MetaField.setObject scalar-dataType bug to "
                    + "throw; if this now succeeds, that separate defect has been fixed and this "
                    + "test should be replaced with a real round-trip assertion.");
        } catch (InvalidValueException e) {
            Assert.assertTrue(e.getMessage(), e.getMessage().contains("expected class"));
        }
    }

    @Test
    public void longArray_roundTripThroughDeserializer_blockedByPreexistingSetterBug() {
        Gson gson = MetaObjectGsonInitializer.getBuilderWithAdapters(arrayLoader).create();

        ValueObject vo = newArrayThing();
        vo.put("bigCounts", Arrays.asList(10L, 20L));
        String json = gson.toJson(vo);

        try {
            gson.fromJson(json, ValueObject.class);
            Assert.fail("Expected the pre-existing MetaField.setObject scalar-dataType bug to "
                    + "throw; if this now succeeds, that separate defect has been fixed and this "
                    + "test should be replaced with a real round-trip assertion.");
        } catch (RuntimeException e) {
            // NumberFormatException from DataConverter.toLong(list.toString()) -- see class Javadoc.
            Assert.assertNotNull(e.getMessage());
        }
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

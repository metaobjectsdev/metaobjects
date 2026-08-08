package com.metaobjects.io.object.gson;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.metaobjects.field.MetaField;
import com.metaobjects.io.object.json.JsonObjectReader;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.object.MetaObject;
import com.metaobjects.object.value.ValueObject;
import com.metaobjects.test.proxy.fruitbasket.Apple;
import org.junit.Assert;
import org.junit.Before;
import org.junit.Test;

import java.io.StringReader;
import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.util.Arrays;
import java.util.Date;

/**
 * #275 follow-on -- two Gson adapter-wiring bugs found tracing the registration path while
 * fixing the DATE-recursion crash (see {@link GsonTemporalRoundTripTest}). Neither is the
 * DATE bug; both are pre-existing wiring defects in the same package that happen to mask each
 * other, so they land together in one commit (see the plan/task brief for the full ordering
 * argument -- fixing either alone, in the wrong order, either changes nothing observable or
 * strictly regresses).
 *
 * <p><b>Bug 1</b> -- {@link com.metaobjects.io.object.json.JsonObjectReader#read(MetaObject)}
 * <em>reads</em> JSON via {@code gson().fromJson(...)} but registered its builder with
 * {@link MetaObjectGsonInitializer#addSerializersToBuilder} (the write-side registration)
 * instead of {@link MetaObjectGsonInitializer#addDeserializersToBuilder}.
 *
 * <p><b>Bug 2</b> -- {@link MetaObjectGsonInitializer}'s {@code addSerializer}/
 * {@code addDeserializer} capability flags are dead code at the "multiple classes" and
 * "otherwise" (specific-class) registration sites -- both {@code if} checks are present but
 * commented out, so both sites always register BOTH a serializer and a deserializer no matter
 * what the caller asked for. Only the interface-registration site (the first {@code if} block)
 * honors the flags.
 *
 * <p>Empirically, at commit 94a9f400 (pre-fix), Bug 2's masking hides Bug 1's effect ONLY for
 * MetaObjects that resolve to a concrete class and route through one of the two masked sites
 * (e.g. {@code test::temporal::TemporalThing}, a plain {@code object.value} with no
 * {@code @object} attr, defaulting to {@link ValueObject}). It does NOT mask Bug 1 for a
 * proxy/interface-backed MetaObject like {@code Apple} -- {@code Apple.class} is an interface,
 * so its registration goes through the ALREADY-correctly-gated interface site, which is
 * unaffected by Bug 2. Confirmed directly: calling
 * {@code new JsonObjectReader(fruitLoader, reader).read(appleMetaObject)} on unfixed 94a9f400
 * throws {@code com.google.gson.JsonIOException: Interfaces can't be instantiated! Register an
 * InstanceCreator or a TypeAdapter for this type. Interface name:
 * com.metaobjects.test.proxy.fruitbasket.Apple} -- Bug 1 breaks this TODAY, unmasked.
 */
public class GsonWiringBugsTest {

    private static final String TEMPORAL_TYPE = "test::temporal::TemporalThing";

    protected MetaDataLoader fruitLoader;
    protected MetaDataLoader temporalLoader;

    @Before
    public void initLoaders() throws ClassNotFoundException {
        fruitLoader = MetaDataLoader.fromResources("wiring-bugs-fruit", Arrays.asList(
                "com/metaobjects/loader/simple/fruitbasket-proxy-metadata.json"
        ));
        temporalLoader = MetaDataLoader.fromResources("wiring-bugs-temporal", Arrays.asList(
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
    // Bug 2 -- the "otherwise" (specific-class) site. TemporalThing has no @object attr, so it
    // defaults to ValueObject.class, a concrete class that no other MetaObject in this loader
    // shares -- hasMultipleClasses() is false, routing registration through the "otherwise"
    // branch (MetaObjectGsonInitializer.java, the second commented-out block).
    //
    // Confirmed pre-fix: MetaObjectGsonInitializer.addDeserializersToBuilder(temporalLoader,
    // new GsonBuilder()).create().toJson(vo) produced {"@type":"test::temporal::TemporalThing"}
    // -- our custom MetaObjectSerializer's signature output -- proving a serializer was wired
    // in even though only a deserializer was requested. This is the load-bearing pin: it fails
    // if the addSerializer/addDeserializer flags go dead again.
    // -----------------------------------------------------------------------

    @Test
    public void addDeserializersToBuilder_specificClassSite_deserializerIsPresent() {
        Gson gson = MetaObjectGsonInitializer.addDeserializersToBuilder(temporalLoader, new GsonBuilder()).create();

        String json = "{\"@type\":\"" + TEMPORAL_TYPE + "\",\"eventDate\":\"2026-06-03\"}";
        ValueObject vo = (ValueObject) gson.fromJson(json, ValueObject.class);

        Assert.assertEquals(utc(2026, 6, 3, 0, 0, 0, 0), temporalField("eventDate").getDate(vo));
    }

    @Test
    public void addDeserializersToBuilder_specificClassSite_doesNotAlsoRegisterASerializer() {
        Gson gson = MetaObjectGsonInitializer.addDeserializersToBuilder(temporalLoader, new GsonBuilder()).create();

        ValueObject vo = newTemporal();
        temporalField("eventDate").setDate(vo, utc(2026, 6, 3, 0, 0, 0, 0));

        // MetaObjectSerializer's signature output is "@type"-prefixed (see GsonAdapterTest,
        // GsonTemporalRoundTripTest). With no serializer wired, Gson falls back to its own
        // built-in handling for ValueObject (a Map implementation) or reflection -- neither
        // ever emits a literal "@type" key.
        String out = gson.toJson(vo);
        Assert.assertFalse("expected no MetaObjectSerializer wired for a deserializers-only "
                + "builder, got: " + out, out.contains("@type"));
    }

    // -----------------------------------------------------------------------
    // Bug 2 -- the "multiple classes" site (MetaObjectGsonInitializer.java, the first
    // commented-out block). Two DIFFERENT MetaObjects (TemporalThing, and Money from the
    // existing meta.entityvalue.json fixture) both lack an @object attr and both default to
    // ValueObject.class, so hasMultipleClasses() is true for each -- distinct code path from
    // the "otherwise" site above (a shared, loader-scoped adapter keyed by the common class,
    // not an mo-specific one).
    // -----------------------------------------------------------------------

    @Test
    public void addDeserializersToBuilder_multipleClassesSite_deserializerIsPresentSerializerIsNot()
            throws ClassNotFoundException {
        MetaDataLoader combo = MetaDataLoader.fromResources("wiring-bugs-multi", Arrays.asList(
                "com/metaobjects/io/object/gson/temporal-metadata.json",
                "com/metaobjects/object/meta.entityvalue.json"
        ));
        MetaObject temporalThing = combo.getMetaObjectByName(TEMPORAL_TYPE);
        MetaObject money = combo.getMetaObjectByName("myapp::commerce::Money");
        // Sanity: confirms this loader combination really does exercise the "multiple classes"
        // branch (both share ValueObject.class) rather than silently degrading to "otherwise".
        Assert.assertEquals(temporalThing.getObjectClass(), money.getObjectClass());

        Gson gson = MetaObjectGsonInitializer.addDeserializersToBuilder(combo, new GsonBuilder()).create();

        String json = "{\"@type\":\"myapp::commerce::Money\",\"cents\":500}";
        ValueObject vo = (ValueObject) gson.fromJson(json, ValueObject.class);
        Assert.assertEquals(Long.valueOf(500L), money.getMetaField("cents").getLong(vo));

        ValueObject vo2 = (ValueObject) money.newInstance();
        money.getMetaField("cents").setLong(vo2, 250L);
        String out = gson.toJson(vo2);
        Assert.assertFalse("expected no MetaObjectSerializer wired for a deserializers-only "
                + "builder, got: " + out, out.contains("@type"));
    }

    // -----------------------------------------------------------------------
    // Bug 1 -- JsonObjectReader.read(MetaObject) directly, on the existing Apple proxy
    // fixture. Apple.class is an interface (mo.getObjectClass() == Apple.class, per
    // ProxyObjectAdapter), so its registration goes through the interface site -- which
    // already correctly honors the addSerializer/addDeserializer flags and is NOT affected by
    // Bug 2. That makes this pin unmasked: pre-fix it throws
    // "com.google.gson.JsonIOException: Interfaces can't be instantiated!" (confirmed above);
    // post-fix (JsonObjectReader asks addDeserializersToBuilder for a real deserializer) it
    // must succeed regardless of Bug 2's state.
    // -----------------------------------------------------------------------

    @Test
    public void jsonObjectReader_read_onApple_directCall_roundTrips() throws Exception {
        MetaObject mo = fruitLoader.getMetaObjectByName("simple::fruitbasket::Apple");
        // "worms" deliberately omitted: the Apple fixture declares it as field.int in metadata
        // but the Apple interface's setWorms(Short) takes a Short -- a pre-existing type
        // mismatch in this fixture, unrelated to the two bugs this test targets.
        String json = "{\"@type\":\"simple::fruitbasket::Apple\",\"id\":1,\"name\":\"apple\","
                + "\"orchard\":\"north forty\"}";

        JsonObjectReader reader = new JsonObjectReader(fruitLoader, new StringReader(json));
        Apple a = (Apple) reader.read(mo);
        reader.close();

        Assert.assertEquals(Long.valueOf(1L), a.getId());
        Assert.assertEquals("apple", a.getName());
        Assert.assertEquals("north forty", a.getOrchard());
    }

    // -----------------------------------------------------------------------
    // Regression: JsonObjectReader.read(MetaObject) on a concrete-class ("otherwise" site)
    // MetaObject must keep working once it asks for a real (not masked-in) deserializer.
    // -----------------------------------------------------------------------

    @Test
    public void jsonObjectReader_read_onTemporalThing_directCall_roundTrips() throws Exception {
        MetaObject mo = temporalLoader.getMetaObjectByName(TEMPORAL_TYPE);
        String json = "{\"@type\":\"" + TEMPORAL_TYPE + "\",\"eventDate\":\"2026-06-03\"}";

        JsonObjectReader reader = new JsonObjectReader(temporalLoader, new StringReader(json));
        ValueObject vo = (ValueObject) reader.read(mo);
        reader.close();

        Assert.assertEquals(utc(2026, 6, 3, 0, 0, 0, 0), temporalField("eventDate").getDate(vo));
    }
}

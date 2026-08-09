package com.metaobjects.io.object.gson;

import com.metaobjects.io.json.TemporalWireFormat;
import com.google.gson.*;

import java.lang.reflect.Type;
import java.text.DateFormat;
import java.text.ParseException;
import java.util.Date;

/**
 * Canonical {@code java.util.Date} wire form for every Gson path that does NOT go through
 * {@link MetaObjectSerializer} — i.e. any {@code Date} Gson reaches by plain reflection.
 *
 * <p><b>The gap this closes.</b> {@link MetaObjectGsonInitializer} registers
 * {@link MetaObjectSerializer}/{@link MetaObjectDeserializer} against each {@link
 * com.metaobjects.object.MetaObject}'s declared {@code @object} class. A value object bound to a
 * hand-written POJO through {@link com.metaobjects.registry.ObjectClassRegistry} is therefore
 * serialized by Gson's DEFAULT reflection instead, and its {@code Date} properties took Gson's
 * built-in adapter. That emitted a localized {@code DateFormat.DEFAULT} string — e.g.
 * {@code "Jun 3, 2026, 10:30:00 AM"} — which is:
 * <ul>
 *   <li><b>locale-dependent</b> — the same instant serializes differently per JVM default locale;</li>
 *   <li><b>timezone-dependent</b> — rendered in the JVM's local zone, not UTC, so the stored text
 *       depends on where the process runs;</li>
 *   <li><b>millisecond-lossy</b> — {@code .123} is discarded, so even a Java-only round-trip
 *       does not return the original instant;</li>
 *   <li><b>unreadable by the other ports</b> — TS/Python/C#/Kotlin all expect the ISO form
 *       defined in {@code fixtures/persistence-conformance/normalization.md}.</li>
 * </ul>
 * The visible blast radius is an OMDB {@code @storage:jsonb} column holding a POJO-bound value
 * object with a temporal field (see {@code GenericSQLDriver#serializeJsonb}). This is the same
 * defect class as #275, on the one path #275 did not reach.
 *
 * <p><b>Write:</b> always {@link TemporalWireFormat#formatInstant} (the {@code ...Z} instant).
 * Field context is unavailable here, so the {@code field.date} and {@code @localTime} shapes
 * cannot be reproduced — a POJO-bound temporal property is written as a full instant. That is a
 * deliberate, documented narrowing: it is lossless and portable, where the previous behavior was
 * neither. A value object that needs the exact per-field shape should stay on the
 * metadata-driven path (no POJO binding), which consults its {@link
 * com.metaobjects.field.MetaField} and calls {@link TemporalWireFormat#format}.
 *
 * <p><b>Read:</b> {@link TemporalWireFormat#parse} first (all three canonical shapes), then a
 * fallback through Gson's own former default ({@link DateFormat#getDateTimeInstance()}) so rows
 * already written in the legacy localized format still load. Write canonical, read tolerant.
 *
 * <p>This adapter never sees a {@code Date} on the metadata-driven path: {@link
 * MetaObjectSerializer}'s {@code DATE} branch formats and calls {@code addProperty} itself rather
 * than delegating to {@code context.serialize}, so that output is unaffected.
 */
public final class TemporalGsonAdapter implements JsonSerializer<Date>, JsonDeserializer<Date> {

    @Override
    public JsonElement serialize(Date src, Type type, JsonSerializationContext context) {
        if (src == null) return JsonNull.INSTANCE;
        return new JsonPrimitive(TemporalWireFormat.formatInstant(src));
    }

    @Override
    public Date deserialize(JsonElement json, Type type, JsonDeserializationContext context) {
        if (json == null || json.isJsonNull()) return null;
        String s = json.getAsString();
        try {
            return TemporalWireFormat.parse(s);
        } catch (IllegalArgumentException canonicalMiss) {
            // Legacy: a value written before this adapter existed, in Gson's default
            // localized form. Best-effort so old rows still read; millisecond precision
            // was already lost when it was written and cannot be recovered here.
            try {
                return DateFormat.getDateTimeInstance().parse(s);
            } catch (ParseException legacyMiss) {
                throw new JsonParseException(
                    "Cannot parse temporal value [" + s + "] as either the canonical wire form "
                    + "or the legacy localized form", canonicalMiss);
            }
        }
    }
}

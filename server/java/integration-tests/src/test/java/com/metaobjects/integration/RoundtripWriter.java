package com.metaobjects.integration;

import com.metaobjects.field.BooleanField;
import com.metaobjects.field.CurrencyField;
import com.metaobjects.field.DateField;
import com.metaobjects.field.DecimalField;
import com.metaobjects.field.DoubleField;
import com.metaobjects.field.EnumField;
import com.metaobjects.field.FloatField;
import com.metaobjects.field.InetField;
import com.metaobjects.field.IntegerField;
import com.metaobjects.field.LongField;
import com.metaobjects.field.MetaField;
import com.metaobjects.field.ObjectField;
import com.metaobjects.field.StringField;
import com.metaobjects.field.TimeField;
import com.metaobjects.field.TimestampField;
import com.metaobjects.field.UriField;
import com.metaobjects.field.UuidField;
import com.metaobjects.integration.Scenarios.QuerySpec;
import com.metaobjects.manager.ObjectConnection;
import com.metaobjects.manager.QueryOptions;
import com.metaobjects.manager.db.ObjectManagerDB;
import com.metaobjects.manager.exp.Expression;
import com.metaobjects.object.MetaObject;
import com.metaobjects.object.value.ValueObject;
import com.metaobjects.util.MetaDataUtil;

import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.ZoneOffset;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Executes an {@code op: roundtrip} scenario against the OMDB runtime — the WRITE gate.
 *
 * <p>Every other query scenario seeds via raw SQL and only READS. {@code op: roundtrip}
 * INSERTs the scenario's {@code insert:} row through the OMDB write path
 * ({@link ObjectManagerDB#createObject} — NOT raw SQL), reads it back BY PRIMARY KEY, and
 * returns the read-back as a field-keyed row with the PK dropped (server-/runtime-generated,
 * non-deterministic). It therefore exercises the WRITE codec + the read path together — the
 * structural complement to the read gate, and the gate that catches the Java timestamp-write
 * hazard ({@code setObject(java.util.Date)} rejected by pgjdbc), native-uuid WRITE, and the
 * currency/enum generic-codec fallback. Mirrors the C# {@code RoundtripWriter} and the TS
 * reference runner.</p>
 *
 * <p>Each entity is bound to {@link ValueObject} (see {@code QueryScenarioTests.beforeAll}),
 * so we author the row into a ValueObject, coercing each {@code insert:} value from its YAML
 * authoring form to the field's native in-process type.</p>
 */
final class RoundtripWriter {

    private RoundtripWriter() {}

    /**
     * INSERT the spec's {@code insert:} row via OMDB, read it back by PK, and return the
     * read-back as a field-keyed row map with the PK removed (or {@code null} when the
     * read-back found nothing — which the assertion surfaces).
     */
    static Map<String, Object> execute(ObjectManagerDB omdb, ObjectConnection conn, MetaObject mc,
                                       QuerySpec spec, Map<String, Integer> columnSqlTypes) throws Exception {
        if (spec.insert() == null) {
            throw new AssertionError("op:roundtrip / " + spec.name()
                + " requires an `insert` block (the row to write)");
        }

        // 1. Author the insert row into a ValueObject, coercing each field to its native type.
        ValueObject vo = (ValueObject) mc.newInstance();
        applyValues(mc, vo, spec.insert());

        // 2. INSERT via the OMDB runtime write path (the write codecs run here). The PK is left
        //    unset: identity.primary @generation:uuid → OMDB mints the uuid app-side on insert.
        omdb.createObject(conn, vo);

        // 3. Capture the PK OMDB populated, then read the row back BY PK (a fresh DB SELECT, so
        //    the read codec runs — not an in-memory echo of what we wrote).
        MetaField<?> pkField = primaryKeyField(mc);
        Object pkValue = vo.get(pkField.getName());

        Collection<?> rows = omdb.getObjects(conn, mc,
            new QueryOptions(new Expression(pkField.getName(), pkValue, Expression.EQUAL)));
        if (rows.isEmpty()) return null;
        Object readBack = rows.iterator().next();

        // 4. Project to a field-keyed wire row (reusing the read-path normalizer), DROP the PK.
        Map<String, Object> row = ObjectManagerDbAdapter.toRowMapForRoundtrip(mc, readBack, columnSqlTypes);
        row.remove(pkField.getName());
        return row;
    }

    // -----------------------------------------------------------------------
    // Field / key resolution
    // -----------------------------------------------------------------------

    /**
     * The single primary-key field of {@code mc} (package-visible so {@link ObjectManagerDbAdapter}
     * can resolve the PK for {@code op: update} / {@code op: delete}).
     */
    static MetaField<?> primaryKey(MetaObject mc) {
        return primaryKeyField(mc);
    }

    /**
     * Apply a field-keyed authoring map (the {@code op: update} {@code data:} block, or any
     * coercion-needing row) onto a ValueObject, coercing each value to the field's native type —
     * the same WRITE coercion {@code op: roundtrip} uses on INSERT, so the UPDATE write path
     * re-encodes every subtype identically. Package-visible for {@link ObjectManagerDbAdapter}.
     */
    static void applyValues(MetaObject mc, ValueObject vo, Map<String, Object> values) {
        for (Map.Entry<String, Object> e : values.entrySet()) {
            setNative(vo, findField(mc, e.getKey()), e.getValue());
        }
    }

    private static MetaField<?> findField(MetaObject mc, String name) {
        for (MetaField<?> mf : mc.getMetaFields()) {
            if (mf.getName().equals(name)) return mf;
        }
        throw new AssertionError("op:roundtrip: entity '" + mc.getShortName()
            + "' has no field named '" + name + "'");
    }

    /** The single primary-key field, from the entity's {@code identity.primary}. */
    private static MetaField<?> primaryKeyField(MetaObject mc) {
        var primary = mc.getPrimaryIdentity();
        if (primary == null) {
            throw new AssertionError("op:roundtrip: entity '" + mc.getShortName()
                + "' has no primary identity");
        }
        if (primary.getFields().size() != 1) {
            throw new AssertionError("op:roundtrip: entity '" + mc.getShortName()
                + "' requires a single-column primary key");
        }
        return findField(mc, primary.getFields().get(0));
    }

    // -----------------------------------------------------------------------
    // YAML authoring form → native in-process value (the WRITE coercion)
    // -----------------------------------------------------------------------

    /**
     * Coerce the YAML-parsed authoring value to the field's native in-process type and set it
     * on the ValueObject. Scalars from SnakeYAML arrive as String/Integer/Long/Double/Boolean;
     * a nested mapping (the {@code @objectRef} jsonb value object) arrives as a {@code Map}.
     */
    @SuppressWarnings("unchecked")
    private static void setNative(ValueObject vo, MetaField<?> mf, Object raw) {
        String name = mf.getName();
        if (raw == null) { vo.setObject(name, null); return; }

        if (mf instanceof StringField || mf instanceof EnumField) {
            vo.setString(name, raw.toString());
        } else if (mf instanceof UriField || mf instanceof InetField) {
            // field.uri / field.inet are String-backed scalars (DataTypes.STRING). Author the URI /
            // IP string verbatim; OMDB's StringCodec (uri → text column) / InetCodec (inet →
            // setObject(.., Types.OTHER)) handles the bind, and InetCodec's rs.getString reads the
            // inet column's NATIVE wire form on read-back (bare address, no ::text cast → no /32|/128
            // mask, and Postgres returns the compressed canonical IPv6).
            vo.setString(name, raw.toString());
        } else if (mf instanceof UuidField) {
            // Author the upper-case UUID string; the write codec binds a java.util.UUID and the
            // read codec returns it lowercase-canonical (the cross-port contract).
            vo.setString(name, raw.toString());
        } else if (mf instanceof IntegerField) {
            vo.setInt(name, ((Number) asNumber(raw)).intValue());
        } else if (mf instanceof LongField || mf instanceof CurrencyField) {
            vo.setLong(name, ((Number) asNumber(raw)).longValue());
        } else if (mf instanceof DoubleField) {
            vo.setDouble(name, ((Number) asNumber(raw)).doubleValue());
        } else if (mf instanceof FloatField) {
            vo.setFloat(name, ((Number) asNumber(raw)).floatValue());
        } else if (mf instanceof DecimalField) {
            // The decimal authoring form is a quoted string ("123.456") for exact fidelity.
            vo.setObject(name, new BigDecimal(raw.toString()));
        } else if (mf instanceof BooleanField) {
            vo.setBoolean(name, asBoolean(raw));
        } else if (mf instanceof DateField) {
            // "YYYY-MM-DD" → a midnight-UTC java.util.Date (DateCodec stores via setTimestamp).
            LocalDate d = LocalDate.parse(raw.toString());
            vo.setDate(name, java.util.Date.from(d.atStartOfDay(ZoneOffset.UTC).toInstant()));
        } else if (mf instanceof TimeField) {
            // "HH:mm:ss[.fff]" → LocalTime (the TimeCodec write form).
            vo.setObject(name, LocalTime.parse(raw.toString()));
        } else if (mf instanceof TimestampField) {
            // Trailing "Z" → an absolute instant (TIMESTAMPTZ); no "Z" → wall-clock TIMESTAMP.
            // Both surface as a java.util.Date for the TimestampCodec; the codec routes the
            // tz-aware column to an OffsetDateTime bind (see JdbcCodecs.TimestampCodec).
            String s = raw.toString();
            Instant instant = s.endsWith("Z")
                ? Instant.parse(s)
                : java.time.LocalDateTime.parse(s).toInstant(ZoneOffset.UTC);
            vo.setDate(name, java.util.Date.from(instant));
        } else if (mf instanceof ObjectField && mf.isArrayType() && raw instanceof java.util.List<?> list) {
            // An @isArray @objectRef jsonb column → a List<ValueObject> the jsonb write path
            // serializes as a JSON array (each element built from its nested authoring map, like
            // the single-VO branch below). setObjectArray (NOT setObject) so the array shape is
            // preserved through the OMDB write codec.
            java.util.List<ValueObject> elements = new java.util.ArrayList<>();
            for (Object element : list) {
                elements.add(buildValueObject((ObjectField) mf, (Map<String, Object>) element));
            }
            vo.setObjectArray(name, elements);
        } else if (mf instanceof ObjectField && raw instanceof Map<?, ?> map) {
            // The @objectRef jsonb value object → a ValueObject the jsonb write path serializes.
            vo.setObject(name, buildValueObject((ObjectField) mf, (Map<String, Object>) map));
        } else {
            throw new AssertionError("op:roundtrip: no insert coercion for field '" + name
                + "' of type " + mf.getClass().getSimpleName());
        }
    }

    /** Build the referenced value object (e.g. {@code Settings}) from a nested authoring map. */
    @SuppressWarnings("unchecked")
    private static ValueObject buildValueObject(ObjectField mf, Map<String, Object> map) {
        MetaObject ref = MetaDataUtil.getObjectRef(mf);
        ValueObject child = (ValueObject) ref.newInstance();
        for (Map.Entry<String, Object> e : map.entrySet()) {
            MetaField<?> childField = findField(ref, e.getKey());
            setNative(child, childField, e.getValue());
        }
        return child;
    }

    private static Number asNumber(Object raw) {
        if (raw instanceof Number n) return n;
        return new BigDecimal(raw.toString());
    }

    private static Boolean asBoolean(Object raw) {
        if (raw instanceof Boolean b) return b;
        return Boolean.valueOf(raw.toString());
    }
}

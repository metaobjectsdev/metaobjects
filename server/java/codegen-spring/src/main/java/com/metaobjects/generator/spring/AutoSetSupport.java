package com.metaobjects.generator.spring;

import com.metaobjects.field.DateField;
import com.metaobjects.field.MetaField;
import com.metaobjects.field.TimeField;
import com.metaobjects.field.TimestampField;
import com.metaobjects.object.MetaObject;

import java.util.ArrayList;
import java.util.List;

/**
 * Issue #203 — cross-port {@code field.timestamp @autoSet: onCreate|onUpdate} CRUD stamping.
 *
 * <p>{@code @autoSet} declares "the CRUD layer owns this timestamp; the caller does not."
 * A {@code field.[date,time,timestamp]} marked {@code @autoSet: onCreate} is stamped with
 * {@code now()} on insert; {@code @autoSet: onUpdate} is stamped on every write. The
 * generated CRUD honors this so adopters stop hand-writing {@code now()} in every
 * repository (the TS port already stamps via Zod transforms; this is the Java parity).</p>
 *
 * <p>Contract (from issue #203):</p>
 * <ul>
 *   <li><b>insert</b> stamps EVERY {@code onCreate} AND {@code onUpdate} column with
 *       {@code now()} — the model value is ignored (a fresh row's {@code updated_at}
 *       equals its {@code created_at}).</li>
 *   <li><b>update(model)</b> stamps {@code onUpdate} columns with {@code now()} and
 *       SKIPS {@code onCreate} entirely (never rewrites {@code created_at} — the latent
 *       lost-update bug).</li>
 *   <li><b>patch</b> stamps {@code onUpdate} on every partial update (so a PATCH still
 *       bumps {@code updated_at}).</li>
 *   <li><b>insertPreserving(model)</b> — an escape hatch that writes the {@code @autoSet}
 *       columns verbatim from the model (import / restore / replication). Emitted only for
 *       entities that declare {@code @autoSet} fields.</li>
 * </ul>
 *
 * <p>The {@code now()} expression is keyed off the COLUMN's temporal Java type (not the
 * parameter's), so this generalizes to any temporal type: {@code field.timestamp} →
 * {@code java.time.Instant} / {@code java.time.LocalDateTime}, {@code field.date} →
 * {@code java.time.LocalDate}, {@code field.time} → {@code java.time.LocalTime} — each of
 * which exposes a static {@code now()}.</p>
 */
public final class AutoSetSupport {

    private AutoSetSupport() { /* no instances */ }

    /** {@code @autoSet: onCreate} — stamp on insert only. Cross-port value ({@code AUTO_SET_ON_CREATE}). */
    public static final String AUTO_SET_ON_CREATE = "onCreate";

    /** {@code @autoSet: onUpdate} — stamp on every write. Cross-port value ({@code AUTO_SET_ON_UPDATE}). */
    public static final String AUTO_SET_ON_UPDATE = "onUpdate";

    /**
     * Resolving read of {@code @autoSet} on {@code field} (it may be inherited via
     * {@code extends} from a shared base entity's {@code createdAt}/{@code updatedAt}) —
     * the trimmed policy string, or {@code null} when absent. Uses the resolving accessor
     * ({@link MetaField#getMetaAttr(String)}), NOT own-only, per ADR-0039.
     */
    public static String policy(MetaField<?> field) {
        if (!field.hasMetaAttr(MetaField.ATTR_AUTO_SET)) return null;
        Object raw = field.getMetaAttr(MetaField.ATTR_AUTO_SET).getValue();
        return raw == null ? null : String.valueOf(raw).trim();
    }

    /** True iff {@code field} carries {@code @autoSet: onCreate} or {@code onUpdate}. */
    public static boolean isAutoSet(MetaField<?> field) {
        String p = policy(field);
        return AUTO_SET_ON_CREATE.equals(p) || AUTO_SET_ON_UPDATE.equals(p);
    }

    /** True iff {@code field} carries {@code @autoSet: onUpdate}. */
    public static boolean isOnUpdate(MetaField<?> field) {
        return AUTO_SET_ON_UPDATE.equals(policy(field));
    }

    /**
     * The {@code now()} expression keyed off the column's temporal Java type — e.g.
     * {@code "java.time.Instant.now()"} — or {@code null} when {@code field} is not a
     * stampable temporal column (only {@code field.[date,time,timestamp]}, non-array).
     * A non-temporal / array {@code @autoSet} field (a metadata error the loader rejects)
     * is defensively treated as un-stampable so codegen never emits {@code String.now()}.
     */
    public static String nowExpr(MetaField<?> field) {
        if (field.isArrayType()) return null;
        if (field instanceof TimestampField || field instanceof DateField || field instanceof TimeField) {
            return SpringTypeMapper.javaTypeName(field) + ".now()";
        }
        return null;
    }

    /**
     * The DTO component fields of {@code entity} carrying a STAMPABLE {@code @autoSet}
     * (onCreate OR onUpdate) marker, in declared order — the fields {@code stampForInsert}
     * overwrites with {@code now()}. Reuses {@link SpringDtoGenerator#dtoComponentFields}
     * so the set matches the DTO record's component order exactly.
     */
    public static List<MetaField> stampFields(MetaObject entity) {
        List<MetaField> out = new ArrayList<>();
        for (MetaField field : SpringDtoGenerator.dtoComponentFields(entity)) {
            if (isAutoSet(field) && nowExpr(field) != null) out.add(field);
        }
        return out;
    }

    /**
     * The DTO component fields of {@code entity} carrying {@code @autoSet: onUpdate}, in
     * declared order — the fields stamped on update / patch ({@code onCreate} is skipped).
     */
    public static List<MetaField> onUpdateFields(MetaObject entity) {
        List<MetaField> out = new ArrayList<>();
        for (MetaField field : SpringDtoGenerator.dtoComponentFields(entity)) {
            if (isOnUpdate(field) && nowExpr(field) != null) out.add(field);
        }
        return out;
    }

    /** True iff {@code entity} declares at least one stampable {@code @autoSet} field. */
    public static boolean hasAutoSetFields(MetaObject entity) {
        return !stampFields(entity).isEmpty();
    }

    /** True iff {@code entity} declares at least one {@code @autoSet: onUpdate} field. */
    public static boolean hasOnUpdateFields(MetaObject entity) {
        return !onUpdateFields(entity).isEmpty();
    }
}

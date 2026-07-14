package com.metaobjects.generator.spring;

import com.metaobjects.field.MetaField;
import com.metaobjects.generator.util.GeneratorUtil;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.object.MetaObject;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * FR-017 Tier 4 — codegen-side descriptor for a table-per-hierarchy (TPH) base, for the
 * Spring generators. Mirrors the C# {@code TphPlanBuilder} / Python {@code tph_plan.py} /
 * TS {@code tph-discriminator.ts}.
 *
 * <p>An {@code object.entity} carrying {@code @discriminator} is the TPH base; concrete
 * entities that {@code extends} it and declare {@code @discriminatorValue} are its subtypes,
 * all sharing ONE physical table (single-table inheritance). This plan is the single source
 * of truth the TPH-aware Spring generators (controller / DTO / repository) read, so the
 * route-segment rule and subtype set never drift between emitted artifacts.</p>
 *
 * <p>The per-subtype REST route segment is the {@code @discriminatorValue} lowercased
 * (derived in exactly one place — {@link #routeSegment(String)}).</p>
 */
public final class TphPlan {

    private TphPlan() {}

    /** One concrete subtype bound to a TPH base. */
    public record Subtype(MetaObject entity, String value, String routeSegment) {}

    /** The polymorphic shape of a TPH base: discriminator field + name-sorted subtypes. */
    public record Plan(MetaObject base, String discriminatorField, List<Subtype> subtypes) {}

    /**
     * The per-subtype REST route segment for a discriminator value — the ONE place this rule
     * lives: the value lowercased ({@code "Bridge"} → {@code bridge},
     * {@code "PriorAuth"} → {@code priorauth}).
     */
    public static String routeSegment(String discriminatorValue) {
        return discriminatorValue.toLowerCase(Locale.ROOT);
    }

    /**
     * The nearest {@code @discriminator}-bearing ancestor (or self), walking {@code extends}.
     * ADR-0039: this IS the super-resolution walk — {@code @discriminator}/
     * {@code @discriminatorValue} are declaration-layer TPH markers (never inherited into
     * an effective form), so each hop is read own-only while the loop does the resolving.
     */
    private static MetaObject discriminatorRoot(MetaObject obj) {
        for (MetaObject cursor = obj; cursor != null; cursor = cursor.getSuperObject()) {
            if (cursor.hasMetaAttr(MetaObject.ATTR_DISCRIMINATOR, false)) return cursor;
        }
        return null;
    }

    /**
     * The discriminator FIELD NAME governing {@code obj} — the {@code @discriminator} attr value on
     * the nearest discriminator-bearing ancestor (or self), or {@code null} when {@code obj} is not
     * part of a TPH hierarchy. ADR-0039: {@code @discriminator} is a declaration-layer marker read
     * own-only per hop; {@link #discriminatorRoot} does the resolving super-walk. Used by the FR-036
     * TPH per-subtype patch to drop the immutable discriminator from the settable set.
     */
    public static String discriminatorFieldOf(MetaObject obj) {
        MetaObject root = discriminatorRoot(obj);
        if (root == null) return null;
        return root.getMetaAttr(MetaObject.ATTR_DISCRIMINATOR, false).getValueAsString();
    }

    /**
     * True when {@code obj} is a concrete TPH subtype: it declares {@code @discriminatorValue}
     * (own attr) and (transitively) extends a {@code @discriminator}-bearing base. Such an entity
     * emits NO standalone controller/repository — it is folded into the base's single table.
     */
    public static boolean isTphSubtype(MetaObject obj) {
        // ADR-0039: @discriminatorValue is a declaration-layer marker — each concrete
        // subtype declares its OWN value; it is never inherited. KEPT own-only.
        if (!obj.hasMetaAttr(MetaObject.ATTR_DISCRIMINATOR_VALUE, false)) return false;
        MetaObject root = discriminatorRoot(obj);
        return root != null && root != obj;
    }

    /**
     * The {@link Plan} for a discriminator base, or {@code null} when {@code base} is not a
     * discriminator base (no {@code @discriminator}, or no concrete subtypes extending it).
     */
    public static Plan planFor(MetaObject base, MetaDataLoader loader) {
        // ADR-0039: @discriminator/@discriminatorValue are declaration-layer TPH markers,
        // never inherited into an effective form — read own-only. (`base` here is already
        // the discriminator-bearing node resolved via discriminatorRoot's super walk.)
        if (!base.hasMetaAttr(MetaObject.ATTR_DISCRIMINATOR, false)) return null;
        String discField = base.getMetaAttr(MetaObject.ATTR_DISCRIMINATOR, false).getValueAsString();
        if (discField == null || discField.isEmpty()) return null;

        List<Subtype> subtypes = new ArrayList<>();
        for (MetaObject obj : loader.getMetaObjects()) {
            if (obj == base) continue;
            if (!MetaObject.SUBTYPE_ENTITY.equals(obj.getSubType())) continue;
            if (GeneratorUtil.isAbstract(obj)) continue;
            // ADR-0039: @discriminatorValue is declaration-layer — each subtype declares
            // its own; never inherited. KEPT own-only.
            if (!obj.hasMetaAttr(MetaObject.ATTR_DISCRIMINATOR_VALUE, false)) continue;
            String value = obj.getMetaAttr(MetaObject.ATTR_DISCRIMINATOR_VALUE, false).getValueAsString();
            if (value == null || value.isEmpty()) continue;

            // Walk the extends chain looking for `base`.
            boolean found = false;
            for (MetaObject cursor = obj.getSuperObject(); cursor != null; cursor = cursor.getSuperObject()) {
                if (cursor == base) { found = true; break; }
            }
            if (!found) continue;
            subtypes.add(new Subtype(obj, value, routeSegment(value)));
        }
        if (subtypes.isEmpty()) return null;
        subtypes.sort(Comparator.comparing(s -> s.entity().getName()));
        return new Plan(base, discField, subtypes);
    }

    /** True when {@code obj} carries {@code @discriminator} AND has at least one concrete subtype. */
    public static boolean isTphBase(MetaObject obj, MetaDataLoader loader) {
        return planFor(obj, loader) != null;
    }

    /**
     * The subtype-only fields folded into the base's single TPH table, deduplicated by name
     * across subtypes in name-sorted subtype order. Each is emitted by the caller as a nullable
     * (no-validation) column — a row of any other subtype stores NULL there, even when the field
     * is {@code @required}. Base fields are excluded (already on the base DTO/table). Mirrors C#
     * {@code CollectSubtypeFields}.
     */
    public static List<MetaField> collectSubtypeFields(MetaObject base, MetaDataLoader loader) {
        Plan plan = planFor(base, loader);
        if (plan == null) return List.of();
        Set<String> baseNames = new HashSet<>();
        for (MetaField f : base.getMetaFields()) baseNames.add(f.getName());
        Set<String> seen = new HashSet<>();
        List<MetaField> out = new ArrayList<>();
        for (Subtype st : plan.subtypes()) {
            for (MetaField f : st.entity().getMetaFields()) {
                if (baseNames.contains(f.getName())) continue; // base column — already emitted
                if (!seen.add(f.getName())) continue;          // shared subtype column — emit once
                out.add(f);
            }
        }
        return out;
    }
}

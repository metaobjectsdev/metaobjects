package com.metaobjects.origin;

import com.metaobjects.MetaData;
import com.metaobjects.attr.MetaAttribute;
import com.metaobjects.registry.MetaDataRegistry;

import java.util.Set;

/**
 * Abstract base origin metadata — field-level provenance (Project E).
 *
 * <p>An {@code origin} is a child of a {@code field}: it declares where the
 * field's value comes from. Concrete subtypes:</p>
 * <ul>
 *   <li>{@link PassthroughOrigin} ({@code origin.passthrough}) — the field's value
 *       is sourced directly from a cross-entity field reference (e.g. a projection
 *       that forwards {@code Program.title}).</li>
 *   <li>{@link AggregateOrigin} ({@code origin.aggregate}) — the field's value is
 *       computed by aggregating values over a relationship path (count / sum / avg
 *       / min / max).</li>
 *   <li>{@link CollectionOrigin} ({@code origin.collection}) — the (array) field's
 *       value is a relationship-derived array of nested view-objects (FR-004 R4).</li>
 * </ul>
 *
 * <p>This Java port mirrors the TypeScript reference
 * ({@code server/typescript/packages/metadata/src/persistence/origin/}) and the
 * C# port ({@code server/csharp/MetaObjects/Persistence/Origin/}).</p>
 *
 * <p>Per-subtype required-attribute checks live in
 * {@link com.metaobjects.loader.ValidationPhase#validateOrigins} (own-only, eager-throw),
 * matching the source/relationship validation pattern.</p>
 */
public abstract class MetaOrigin extends MetaData {

    // === TYPE AND SUBTYPE CONSTANTS ===

    /** Origin type constant — MetaOrigin owns this concept. */
    public static final String TYPE_ORIGIN = "origin";

    /** Abstract base origin subtype — never instantiate directly. */
    public static final String SUBTYPE_BASE = "base";

    // === ATTRIBUTE NAME CONSTANTS ===

    /**
     * Passthrough origin: dotted Entity.field reference identifying the source
     * value this projection field passes through (e.g. {@code "Program.title"}).
     * Required on {@code origin.passthrough}.
     */
    public static final String ATTR_FROM = "from";

    /**
     * Dotted relationship path. On {@code origin.passthrough} it is optional and
     * identifies the path to reach the source entity (e.g. {@code "Program.weeks"}).
     * On {@code origin.aggregate} and {@code origin.collection} it is required and
     * identifies the relationship path the aggregate / collection walks
     * (e.g. {@code "Program.weeks"} or {@code "Program.weeks.workouts"}).
     */
    public static final String ATTR_VIA = "via";

    /**
     * Aggregate function applied over the relationship path. Required on
     * {@code origin.aggregate}. Must be one of {@link #AGGREGATE_FUNCTIONS}.
     */
    public static final String ATTR_AGG = "agg";

    /**
     * Dotted Entity.field reference identifying the column being aggregated
     * (e.g. {@code "Week.durationMinutes"}). Required on {@code origin.aggregate}.
     */
    public static final String ATTR_OF = "of";

    // === AGGREGATE FUNCTION VOCABULARY ===

    public static final String AGG_COUNT = "count";
    public static final String AGG_SUM   = "sum";
    public static final String AGG_AVG   = "avg";
    public static final String AGG_MIN   = "min";
    public static final String AGG_MAX   = "max";

    /**
     * Closed set of valid {@code @agg} values. Used by
     * {@link com.metaobjects.loader.ValidationPhase} for enum-membership checks.
     */
    public static final Set<String> AGGREGATE_FUNCTIONS = Set.of(
        AGG_COUNT, AGG_SUM, AGG_AVG, AGG_MIN, AGG_MAX
    );

    // -----------------------------------------------------------------------
    // Constructor
    // -----------------------------------------------------------------------

    protected MetaOrigin(String subType, String name) {
        super(TYPE_ORIGIN, subType, name);
    }

    // -----------------------------------------------------------------------
    // Type registration
    // -----------------------------------------------------------------------

    /**
     * Register the abstract {@code origin.base} type. Declares the union of attrs
     * across all concrete subtypes as optional; per-subtype required-checks are
     * enforced in {@link com.metaobjects.loader.ValidationPhase} (post-load, own-only).
     *
     * <p>Called by {@link OriginTypesMetaDataProvider}.</p>
     */
    public static void registerTypes(MetaDataRegistry registry) {
        registry.registerType(MetaOrigin.class, def -> {
            def.type(TYPE_ORIGIN).subType(SUBTYPE_BASE)
               .description("Abstract base origin metadata — field-level provenance (passthrough / aggregate / collection)")
               .inheritsFrom(MetaData.TYPE_METADATA, MetaData.SUBTYPE_BASE)
               // Accept any attr child (for extensibility from service providers)
               .optionalChild(MetaAttribute.TYPE_ATTR, "*", "*");

            // SP-G Unit 6a: the per-subtype attrs (@from / @via / @agg / @of) are
            // declared on the CONCRETE subtypes (AggregateOrigin / CollectionOrigin /
            // PassthroughOrigin), each carrying exactly its own set with the correct
            // required-ness — matching the cross-port canonical (origin.base is
            // attr-free; no cross-leak between concrete origins). The dedicated
            // ValidationPhase#validateOrigins pass continues to enforce path semantics.
        });
    }

    // -----------------------------------------------------------------------
    // Accessors
    // -----------------------------------------------------------------------

    /** Returns the raw value of {@code @from}, or {@code null} if absent. */
    public String getFrom() {
        return hasMetaAttr(ATTR_FROM)
            ? getMetaAttr(ATTR_FROM).getValueAsString()
            : null;
    }

    /** Returns the raw value of {@code @via}, or {@code null} if absent. */
    public String getVia() {
        return hasMetaAttr(ATTR_VIA)
            ? getMetaAttr(ATTR_VIA).getValueAsString()
            : null;
    }

    /** Returns the raw value of {@code @agg}, or {@code null} if absent. */
    public String getAgg() {
        return hasMetaAttr(ATTR_AGG)
            ? getMetaAttr(ATTR_AGG).getValueAsString()
            : null;
    }

    /** Returns the raw value of {@code @of}, or {@code null} if absent. */
    public String getOf() {
        return hasMetaAttr(ATTR_OF)
            ? getMetaAttr(ATTR_OF).getValueAsString()
            : null;
    }

    @Override
    public String toString() {
        return String.format("%s[%s:%s]{from=%s, via=%s, agg=%s, of=%s}",
            getClass().getSimpleName(),
            getType(),
            getSubType(),
            getFrom(),
            getVia(),
            getAgg(),
            getOf());
    }
}

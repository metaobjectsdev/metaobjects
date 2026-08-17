/*
 * Copyright 2004 Doug Mealing LLC dba Meta Objects
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
package com.metaobjects.query;

import com.metaobjects.field.BooleanField;
import com.metaobjects.field.CurrencyField;
import com.metaobjects.field.DateField;
import com.metaobjects.field.DecimalField;
import com.metaobjects.field.DoubleField;
import com.metaobjects.field.EnumField;
import com.metaobjects.field.FloatField;
import com.metaobjects.field.IntegerField;
import com.metaobjects.field.LongField;
import com.metaobjects.field.StringField;
import com.metaobjects.field.TimeField;
import com.metaobjects.field.TimestampField;
import com.metaobjects.field.UuidField;
import com.metaobjects.field.UriField;
import com.metaobjects.field.InetField;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Set;

/**
 * The canonical, single-source per-field-subtype filter-operator band
 * (FR-009 §5) for the JVM ports.
 *
 * <p>This is the ONE definition of "which operators are legal for a field of
 * subtype X". Both the loader's validation path
 * ({@code com.metaobjects.loader.ValidationPhase}) and the codegen-spring
 * filter-allowlist generator
 * ({@code com.metaobjects.generator.spring.SpringFilterAllowlistGenerator})
 * reference it, so the two can never drift. Mirrors the TS
 * {@code query-constants.ts OPS_BY_SUBTYPE} and the C#
 * {@code QueryConstants.OPS_BY_SUBTYPE}; the cross-port
 * {@code fixtures/conformance/filter-ops-matrix} gate asserts every subtype's
 * band is byte-identical across all five ports.</p>
 *
 * <p>Bands (canonical operator order):</p>
 * <ul>
 *   <li>{@code string} / {@code enum} → {@code eq, ne, in, like, isNull}</li>
 *   <li>{@code uuid} → {@code eq, ne, in, isNull} (identity comparison only —
 *       no {@code like}, no ordering)</li>
 *   <li>{@code int}/{@code long}/{@code double}/{@code float}/{@code decimal}/
 *       {@code currency}/{@code date}/{@code time}/{@code timestamp} →
 *       {@code eq, ne, gt, gte, lt, lte, in, isNull}</li>
 *   <li>{@code boolean} → {@code eq, isNull}</li>
 *   <li>any other subtype (e.g. {@code object}) → empty band (not filterable)</li>
 * </ul>
 */
public final class FilterOps {

    private FilterOps() {}

    // Filter operators — the 9-operator vocabulary (FR-009). Kept as named
    // constants so the bands below never inline a literal.
    public static final String FILTER_OP_EQ      = "eq";
    public static final String FILTER_OP_NE      = "ne";
    public static final String FILTER_OP_GT      = "gt";
    public static final String FILTER_OP_GTE     = "gte";
    public static final String FILTER_OP_LT      = "lt";
    public static final String FILTER_OP_LTE     = "lte";
    public static final String FILTER_OP_IN      = "in";
    public static final String FILTER_OP_LIKE    = "like";
    public static final String FILTER_OP_IS_NULL = "isNull";

    /** Insertion-ordered set so callers that emit/serialize see canonical order. */
    private static Set<String> ordered(String... ops) {
        Set<String> out = new LinkedHashSet<>(ops.length);
        Collections.addAll(out, ops);
        return Collections.unmodifiableSet(out);
    }

    /** {@code string} / {@code enum} band. */
    public static final Set<String> OPS_STRING =
        ordered(FILTER_OP_EQ, FILTER_OP_NE, FILTER_OP_IN, FILTER_OP_LIKE, FILTER_OP_IS_NULL);

    /** {@code uuid} band — identity comparison only. */
    public static final Set<String> OPS_UUID =
        ordered(FILTER_OP_EQ, FILTER_OP_NE, FILTER_OP_IN, FILTER_OP_IS_NULL);

    /** Numeric / currency / temporal band. */
    public static final Set<String> OPS_NUMERIC =
        ordered(FILTER_OP_EQ, FILTER_OP_NE, FILTER_OP_GT, FILTER_OP_GTE,
                FILTER_OP_LT, FILTER_OP_LTE, FILTER_OP_IN, FILTER_OP_IS_NULL);

    /** {@code boolean} band. */
    public static final Set<String> OPS_BOOLEAN =
        ordered(FILTER_OP_EQ, FILTER_OP_IS_NULL);

    /**
     * The canonical {@code subtype → op-band} map. Iteration order is the
     * canonical field-subtype order; each band is in canonical operator order.
     */
    public static final Map<String, Set<String>> OPS_BY_SUBTYPE;
    static {
        Map<String, Set<String>> m = new LinkedHashMap<>();
        m.put(StringField.SUBTYPE_STRING, OPS_STRING);
        m.put(EnumField.SUBTYPE_ENUM, OPS_STRING);
        m.put(UuidField.SUBTYPE_UUID, OPS_UUID);
        // ADR-0036/0037 Wave 3 — uri is free-text-comparable (string band, incl. like);
        // inet is identity-comparison-only (uuid band — no like, no ordering).
        m.put(UriField.SUBTYPE_URI, OPS_STRING);
        m.put(InetField.SUBTYPE_INET, OPS_UUID);
        m.put(IntegerField.SUBTYPE_INT, OPS_NUMERIC);
        m.put(LongField.SUBTYPE_LONG, OPS_NUMERIC);
        m.put(DoubleField.SUBTYPE_DOUBLE, OPS_NUMERIC);
        m.put(FloatField.SUBTYPE_FLOAT, OPS_NUMERIC);
        m.put(DecimalField.SUBTYPE_DECIMAL, OPS_NUMERIC);
        m.put(CurrencyField.SUBTYPE_CURRENCY, OPS_NUMERIC);
        m.put(DateField.SUBTYPE_DATE, OPS_NUMERIC);
        m.put(TimeField.SUBTYPE_TIME, OPS_NUMERIC);
        m.put(TimestampField.SUBTYPE_TIMESTAMP, OPS_NUMERIC);
        m.put(BooleanField.SUBTYPE_BOOLEAN, OPS_BOOLEAN);
        OPS_BY_SUBTYPE = Collections.unmodifiableMap(m);
    }

    /**
     * The op band for {@code subType}, or an empty set when the subtype has no
     * band (i.e. is not filterable). Mirrors the TS
     * {@code OPS_BY_SUBTYPE[subType] ?? []} behaviour.
     */
    public static Set<String> opsForSubType(String subType) {
        if (subType == null) return Collections.emptySet();
        return OPS_BY_SUBTYPE.getOrDefault(subType, Collections.emptySet());
    }

    /** True iff {@code subType} has a (non-empty) filter-operator band. */
    public static boolean supportsFiltering(String subType) {
        return subType != null && OPS_BY_SUBTYPE.containsKey(subType);
    }

    /**
     * The int-backed-{@code enum} band: the {@code enum} band minus {@code like}.
     * Hoisted so the narrowing is one named constant rather than a set filtered at
     * every call site.
     */
    public static final Set<String> OPS_ENUM_INT_BACKED =
        ordered(FILTER_OP_EQ, FILTER_OP_NE, FILTER_OP_IN, FILTER_OP_IS_NULL);

    /**
     * The filter-operator band for a FIELD — the entry point every consumer that has
     * a field in hand must use (loader validation, the codegen-spring allowlist
     * generator, the cross-port {@code field.filter-ops} capability).
     *
     * <p>Identical to {@link #opsForSubType} except for ONE case: an int-backed
     * {@code field.enum} (one declaring {@code @intValueMap}, design D5) persists as
     * an INTEGER column, so {@code like} — a substring match — is dropped.
     * {@code eq}/{@code ne}/{@code in} survive because the member symbol encodes to
     * its integer before it reaches SQL; {@code like} has no such encoding, and an
     * unencoded {@code LIKE 'DRAFT'} against an integer column is a request-time
     * type error.</p>
     *
     * <p>{@link #opsForSubType} cannot express this — it only ever sees the subtype
     * {@code "enum"} — and is deliberately left unchanged for the one caller that
     * genuinely has no field: {@code ExpressionAttribute}'s declared operand type.</p>
     *
     * <p>ADR-0039: {@code hasMetaAttr(String)} defaults to {@code includeParentData =
     * true}, so this read RESOLVES through {@code extends}. That is load-bearing, not
     * incidental: post-#246 the map lives on a shared root-level abstract declaration
     * and consuming fields INHERIT it, so an own-only read would see it absent on
     * exactly the shape adopters are steered toward and wrongly keep {@code like}.</p>
     *
     * <p>Cross-port: {@code fixtures/conformance/filter-ops-matrix} pins
     * {@code fEnum} vs {@code fEnumInt} in all five ports.</p>
     */
    public static Set<String> opsForField(com.metaobjects.field.MetaField field) {
        if (field == null) return Collections.emptySet();
        if (EnumField.SUBTYPE_ENUM.equals(field.getSubType())
                && field.hasMetaAttr(EnumField.ATTR_INT_VALUE_MAP)) {
            return OPS_ENUM_INT_BACKED;
        }
        return opsForSubType(field.getSubType());
    }
}

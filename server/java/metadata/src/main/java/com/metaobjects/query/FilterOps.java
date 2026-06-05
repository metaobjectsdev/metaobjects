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
}

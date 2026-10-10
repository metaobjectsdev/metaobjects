/*
 * Copyright 2026 Doug Mealing LLC dba Meta Objects
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
package com.metaobjects.reporting;

import com.metaobjects.MetaData;

import java.util.List;
import java.util.Map;

/**
 * Base node class for {@code type = "measure"} (FR-044). Concrete subtypes are
 * {@link AggregateMeasure} ({@code measure.aggregate}) and {@link RatioMeasure}
 * ({@code measure.ratio}). Accessors are RESOLVING (ADR-0039).
 */
@SuppressWarnings("serial")
public abstract class MetaMeasure extends MetaData {

    protected MetaMeasure(String subType, String name) {
        super(ReportingConstants.TYPE_MEASURE, subType, name);
    }

    /** True for {@code measure.ratio}; false for {@code measure.aggregate}. */
    public boolean isRatio() {
        return ReportingConstants.MEASURE_SUBTYPE_RATIO.equals(getSubType());
    }

    /** The aggregate function ({@code measure.aggregate} only), or {@code null} when absent
     *  or outside the closed set. */
    public String getAgg() {
        String v = ReportingAttrs.optionalString(this, ReportingConstants.ATTR_AGG);
        return v != null && ReportingConstants.MEASURE_AGGS.contains(v) ? v : null;
    }

    /** True when {@code @distinct} is set (legal only with {@code @agg: count}). */
    public boolean isDistinct() {
        return ReportingAttrs.isTrue(this, ReportingConstants.ATTR_DISTINCT);
    }

    /** The {@code Entity.field} references in {@code @of}: a bare string is one column, a
     *  list is the tuple form. */
    public List<String> getOfColumns() {
        return ReportingAttrs.stringList(this, ReportingConstants.ATTR_OF);
    }

    /** Name of a segment declared on the same entity; combines with {@code @filter} by AND. */
    public String getSegmentName() {
        return ReportingAttrs.optionalString(this, ReportingConstants.ATTR_SEGMENT);
    }

    /** The canonical row-scope filter, when one is declared. */
    public Map<String, Object> getFilter() {
        return ReportingAttrs.filterMap(this, ReportingConstants.ATTR_FILTER);
    }

    /**
     * {@code @default}: the integer this measure reads when it would otherwise be null
     * (loader rules M7/M8 decide where it is legal). {@code null} when none is declared or
     * the value is not an integer. Resolving (ADR-0039), so an inherited measure keeps it.
     */
    public Long getDefaultValue() {
        if (!hasMetaAttr(ReportingConstants.ATTR_DEFAULT)) return null;
        Object v = getMetaAttr(ReportingConstants.ATTR_DEFAULT).getValue();
        if (v instanceof Integer || v instanceof Long || v instanceof Short || v instanceof Byte) {
            return ((Number) v).longValue();
        }
        return null;
    }

    /** Name of the {@code measure.aggregate} sibling used as the numerator ({@code measure.ratio} only). */
    public String getNumerator() {
        return ReportingAttrs.optionalString(this, ReportingConstants.ATTR_NUMERATOR);
    }

    /** Name of the {@code measure.aggregate} sibling used as the denominator ({@code measure.ratio} only). */
    public String getDenominator() {
        return ReportingAttrs.optionalString(this, ReportingConstants.ATTR_DENOMINATOR);
    }
}

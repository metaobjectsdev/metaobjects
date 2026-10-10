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

import java.util.List;
import java.util.regex.Pattern;

/**
 * FR-044 reporting vocabulary constants — type names, subtypes, attr keys and the
 * closed sets the registry records through {@code allowedValues}.
 *
 * <p>{@code dimension}, {@code measure} and {@code segment} are children of
 * {@code object.entity} only (never root-level), and {@code object.report} (registered
 * with the other object subtypes, see {@code MetaObject.SUBTYPE_REPORT}) references them
 * by name. Mirrors the TS {@code reporting-constants.ts}.</p>
 */
public final class ReportingConstants {

    private ReportingConstants() {
    }

    // ------------------------------------------------------------------
    // Types
    // ------------------------------------------------------------------

    public static final String TYPE_DIMENSION = "dimension";
    public static final String TYPE_MEASURE = "measure";
    public static final String TYPE_SEGMENT = "segment";

    // ------------------------------------------------------------------
    // Subtypes
    // ------------------------------------------------------------------

    /** Groups by a column value as-is (no grain, no truncation). */
    public static final String DIMENSION_SUBTYPE_ATTRIBUTE = "attribute";
    /** Groups by a date/timestamp column truncated to a grain. */
    public static final String DIMENSION_SUBTYPE_TIME = "time";

    /** One aggregate over the declaring entity's own rows. */
    public static final String MEASURE_SUBTYPE_AGGREGATE = "aggregate";
    /** A quotient of two {@code measure.aggregate} siblings. {@code measure.derived} is
     *  deliberately NOT registered: it waits for FR-037 R5. */
    public static final String MEASURE_SUBTYPE_RATIO = "ratio";

    /** A named, reusable row filter — the only concrete segment subtype. */
    public static final String SEGMENT_SUBTYPE_FILTER = "filter";

    // ------------------------------------------------------------------
    // Attrs on dimension / measure / segment nodes
    // ------------------------------------------------------------------

    /** Dotted {@code Entity.field} reference(s) naming the grouped / aggregated column(s). */
    public static final String ATTR_OF = "of";
    /** Optional dotted to-one relationship path from the owning entity to the {@code @of} entity. */
    public static final String ATTR_VIA = "via";
    /** The grains a {@code dimension.time} supports. */
    public static final String ATTR_GRAINS = "grains";
    /** The aggregate function of a {@code measure.aggregate}. */
    public static final String ATTR_AGG = "agg";
    /** Count distinct values (legal only with {@code @agg: count}). */
    public static final String ATTR_DISTINCT = "distinct";
    /** Row scope (an attr.filter) on a {@code measure.aggregate} or {@code segment.filter}. */
    public static final String ATTR_FILTER = "filter";
    /** Name of a segment declared on the same entity. */
    public static final String ATTR_SEGMENT = "segment";
    /** {@code measure.ratio} operand names. */
    public static final String ATTR_NUMERATOR = "numerator";
    public static final String ATTR_DENOMINATOR = "denominator";
    /**
     * The integer a {@code measure.aggregate} / {@code measure.ratio} reads when it would
     * otherwise be null (an attr.int). Same name as a field's {@code @default}, a different
     * registration: a field's is an untyped string re-read by the field's subtype.
     */
    public static final String ATTR_DEFAULT = "default";

    // ------------------------------------------------------------------
    // Closed sets — mirrored by allowedValues in spec/metamodel/reporting.json.
    // Order is part of the contract (the registry manifest records it).
    // ------------------------------------------------------------------

    /** Weeks start on Monday (ISO-8601) in every lowering. */
    public static final String GRAIN_HOUR = "hour";
    public static final String GRAIN_DAY = "day";
    public static final String GRAIN_WEEK = "week";
    public static final String GRAIN_MONTH = "month";
    public static final String GRAIN_QUARTER = "quarter";
    public static final String GRAIN_YEAR = "year";
    public static final List<String> TIME_GRAINS = List.of(
            GRAIN_HOUR, GRAIN_DAY, GRAIN_WEEK, GRAIN_MONTH, GRAIN_QUARTER, GRAIN_YEAR);

    public static final String AGG_COUNT = "count";
    public static final String AGG_SUM = "sum";
    public static final String AGG_AVG = "avg";
    public static final String AGG_MIN = "min";
    public static final String AGG_MAX = "max";
    public static final List<String> MEASURE_AGGS = List.of(AGG_COUNT, AGG_SUM, AGG_AVG, AGG_MIN, AGG_MAX);

    /** Separator in an {@code object.report} {@code @dimensions} item: {@code name} or {@code name:grain}. */
    public static final String REPORT_DIMENSION_GRAIN_SEPARATOR = ":";

    // ------------------------------------------------------------------
    // Relative-date filter values (spec §4 R4; rules F1/F2)
    // ------------------------------------------------------------------

    /**
     * The single key of a relative-date filter value: {@code { now: "<ISO-8601 duration>" }}
     * means "the current time plus that duration", evaluated when the view is queried.
     * Legal only in the {@code @filter} of a {@code segment}, {@code measure.aggregate} or
     * {@code object.report}.
     */
    public static final String FILTER_RELATIVE_NOW = "now";

    /**
     * A signed ISO-8601 duration ({@code -P7D}, {@code P1Y2M}, {@code -PT12H}). The lookaheads
     * refuse the degenerate {@code P} and {@code PT} forms. Use with {@code matches()} so the
     * whole value must match (the same pattern text as the TS reference).
     */
    public static final Pattern ISO_DURATION_RE = Pattern.compile(
            "^[+-]?P(?!$)(\\d+Y)?(\\d+M)?(\\d+W)?(\\d+D)?(T(?=\\d)(\\d+H)?(\\d+M)?(\\d+S)?)?$");
}

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
import com.metaobjects.util.MetaDataUtil;
import com.metaobjects.object.MetaObject;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * Free accessors over an {@code object.report} node (FR-044), used by the loader's report
 * validation and by the Plan 2 lowering, so the {@code name:grain} parse and the
 * derived-field-name rule have exactly one definition in this port. Mirrors the TS
 * {@code report-accessors.ts}. Reads are RESOLVING (ADR-0039).
 */
public final class ReportAccessors {

    private ReportAccessors() {
    }

    /** One {@code @dimensions} item: {@code name}, or {@code name:grain} ({@code grain} is
     *  {@code null} when the item carries no separator). */
    public record ReportDimensionItem(String name, String grain) {
    }

    /** The {@code @from} entity reference of a report, or {@code null}. */
    public static String reportFrom(MetaData report) {
        return ReportingAttrs.optionalString(report, MetaObject.ATTR_REPORT_FROM);
    }

    /** The {@code @dimensions} items, each {@code name} or {@code name:grain} (split at the first separator). */
    public static List<ReportDimensionItem> reportDimensionItems(MetaData report) {
        List<ReportDimensionItem> out = new ArrayList<>();
        for (String raw : ReportingAttrs.stringList(report, MetaObject.ATTR_REPORT_DIMENSIONS)) {
            int i = raw.indexOf(ReportingConstants.REPORT_DIMENSION_GRAIN_SEPARATOR);
            out.add(i == -1
                    ? new ReportDimensionItem(raw, null)
                    : new ReportDimensionItem(raw.substring(0, i),
                            raw.substring(i + ReportingConstants.REPORT_DIMENSION_GRAIN_SEPARATOR.length())));
        }
        return out;
    }

    /** The {@code @measures} items AS WRITTEN: each a bare measure {@code name}, or a dotted
     *  {@code Entity.name} (loader rule R3). Use {@link #reportMeasureItemName} for the measure name. */
    public static List<String> reportMeasureNames(MetaData report) {
        return ReportingAttrs.stringList(report, MetaObject.ATTR_REPORT_MEASURES);
    }

    /**
     * The measure a {@code @measures} item names: the segment after its LAST {@code .}
     * ({@code total}, {@code Sale.total} and {@code acme::shop::Sale.total} all name
     * {@code total}). It is also the derived report field's name. The part before that
     * {@code .}, when present, is an entity qualifier ({@link #reportMeasureItemOwner}).
     */
    public static String reportMeasureItemName(String item) {
        int dot = item.lastIndexOf(MetaDataUtil.CHILD_REF_SEPARATOR);
        return dot == -1 ? item : item.substring(dot + MetaDataUtil.CHILD_REF_SEPARATOR.length());
    }

    /** The entity qualifier of a dotted {@code @measures} item ({@code Sale} in
     *  {@code Sale.total}), or {@code null} for a bare item. Loader rule R3: it names
     *  {@code @from} or an entity {@code @from} extends. */
    public static String reportMeasureItemOwner(String item) {
        int dot = item.lastIndexOf(MetaDataUtil.CHILD_REF_SEPARATOR);
        return dot == -1 ? null : item.substring(0, dot);
    }

    /** The derived report field for a dimension item: {@code name} (attribute) or
     *  {@code name + Capitalized(grain)} (time), e.g. {@code purchasedAtDay}. */
    public static String reportDerivedFieldName(ReportDimensionItem item) {
        String grain = item.grain();
        if (grain == null || grain.isEmpty()) return item.name();
        return item.name() + grain.substring(0, 1).toUpperCase(Locale.ROOT) + grain.substring(1);
    }
}

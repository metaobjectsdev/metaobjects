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

import com.metaobjects.registry.MetaDataRegistry;
import com.metaobjects.registry.MetaDataTypeProvider;
import com.metaobjects.registry.spec.SpecMetamodelReader;

import java.util.Map;

/**
 * Reporting Types MetaData provider (FR-044).
 *
 * <p>Registers the entity-member reporting vocabulary: {@code dimension.attribute},
 * {@code dimension.time}, {@code measure.aggregate}, {@code measure.ratio} and
 * {@code segment.filter}. {@code object.report} is an object subtype and is registered by
 * this pack too (the object-types provider no longer registers it). {@code measure.derived} (R13) is
 * FR-037 R5's first arithmetic wave.</p>
 *
 * <p>Depends on {@code core-types} for {@code metadata.base} inheritance.</p>
 */
public class ReportingTypesMetaDataProvider implements MetaDataTypeProvider {

    @Override
    public void registerTypes(MetaDataRegistry registry) {
        AttributeDimension.registerTypes(registry);
        TimeDimension.registerTypes(registry);
        AggregateMeasure.registerTypes(registry);
        RatioMeasure.registerTypes(registry);
        DerivedMeasure.registerTypes(registry);
        FilterSegment.registerTypes(registry);
        com.metaobjects.object.ReportMetaObject.registerTypes(registry);
        // The rules that admit these types on types core owns (dimension/measure/segment under
        // object.entity) and the @segment attr on origin.aggregate/origin.first ride in
        // reporting.json under the pack's logical id: leaving the pack out leaves none of them.
        registry.applyProviderExtends(SpecMetamodelReader.load(), LOGICAL_ID, Map.of());
    }

    /** The pack's cross-port logical id, the {@code provider} of reporting.json. */
    public static final String LOGICAL_ID = "metaobjects-reporting";

    @Override
    public String getProviderId() {
        return "reporting-types";
    }

    @Override
    public String[] getDependencies() {
        return new String[]{"core-types", "object-types", "origin-types"};
    }

    @Override
    public String getDescription() {
        return "Reporting Types (dimension, measure, segment) — FR-044 declared reporting";
    }
}

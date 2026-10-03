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

/**
 * Reporting Types MetaData provider (FR-044).
 *
 * <p>Registers the entity-member reporting vocabulary: {@code dimension.attribute},
 * {@code dimension.time}, {@code measure.aggregate}, {@code measure.ratio} and
 * {@code segment.filter}. {@code object.report} is an object subtype and is registered by
 * the object-types provider beside {@code object.projection}. {@code measure.derived} is
 * deliberately absent (it waits for FR-037 R5).</p>
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
        FilterSegment.registerTypes(registry);
    }

    @Override
    public String getProviderId() {
        return "reporting-types";
    }

    @Override
    public String[] getDependencies() {
        return new String[]{"core-types"};
    }

    @Override
    public String getDescription() {
        return "Reporting Types (dimension, measure, segment) — FR-044 declared reporting";
    }
}

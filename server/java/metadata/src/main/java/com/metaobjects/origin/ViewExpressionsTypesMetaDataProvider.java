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
package com.metaobjects.origin;

import com.metaobjects.registry.MetaDataRegistry;
import com.metaobjects.registry.MetaDataTypeProvider;
import com.metaobjects.registry.spec.SpecMetamodelReader;

import java.util.Map;

/**
 * View-expressions pack (rc.21 part B): {@code origin.function} and the projection attrs
 * {@code @union} / {@code @unionAll} / {@code @grain} / {@code @grainOrdinal}. It is its own
 * provider so a project can leave it out; it is in the default bundle, so every existing model
 * loads unchanged. The types and attrs are registered so a strict load accepts them; the shape
 * rules run in TypeScript and C#, and only the TypeScript view emitter lowers them.
 *
 * <p>The projection attrs are data-driven from {@code spec/metamodel/view-expressions.json},
 * read under the pack's logical id {@value #LOGICAL_ID}.</p>
 */
public class ViewExpressionsTypesMetaDataProvider implements MetaDataTypeProvider {

    /** The pack's cross-port logical id, the {@code provider} of view-expressions.json. */
    public static final String LOGICAL_ID = "metaobjects-view-expressions";

    @Override
    public void registerTypes(MetaDataRegistry registry) {
        FunctionOrigin.registerTypes(registry);
        registry.applyProviderExtends(SpecMetamodelReader.load(), LOGICAL_ID, Map.of());
    }

    @Override
    public String getProviderId() {
        return "view-expressions-types";
    }

    @Override
    public String[] getDependencies() {
        return new String[]{"origin-types", "object-types"};
    }

    @Override
    public String getDescription() {
        return "View-expressions pack (origin.function; @union/@unionAll/@grain/@grainOrdinal on object.projection)";
    }
}

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
package com.metaobjects.presentation.ui;

import com.metaobjects.registry.MetaDataRegistry;
import com.metaobjects.registry.MetaDataTypeProvider;
import com.metaobjects.registry.spec.SpecMetamodelReader;

import java.util.Map;

/**
 * FR-033 — the {@code metaobjects-ui} concern provider.
 *
 * <p>Re-homes the UI / presentation metamodel attrs out of the CORE type classes
 * and into a data-driven concern provider that reads the embedded
 * {@code spec/metamodel/ui.json} {@code extends} directives — matching TS + Python.
 * It owns:</p>
 * <ul>
 *   <li>{@code field.*}: {@code @filterable}, {@code @sortable},
 *       {@code @sortableDefaultOrder} (Project D filter/sort layer).</li>
 *   <li>{@code view.currency}: {@code @locale}.</li>
 *   <li>{@code layout.dataGrid}: {@code @pageSize}, {@code @defaultSortField},
 *       {@code @defaultSortOrder}, {@code @filterable}, {@code @filter},
 *       {@code @columns}.</li>
 * </ul>
 *
 * <p>Depends on {@code field-types} / {@code view-types} / {@code layout-types} so
 * those subtypes are registered before this provider extends them.</p>
 */
public class UiTypesMetaDataProvider implements MetaDataTypeProvider {

    /** The provider name — matches {@code ui.json}'s {@code "provider"} field. */
    public static final String PROVIDER_ID = "metaobjects-ui";

    @Override
    public void registerTypes(MetaDataRegistry registry) {
        // Wildcards expand to the currently-registered subtypes of the type (the
        // field.* wildcard hits every concrete field subtype — matching how the
        // re-homed attrs were previously snapshotted from field.base). Passing an
        // empty expansion map triggers that registered-subtype fallback.
        registry.applyProviderExtends(SpecMetamodelReader.load(), PROVIDER_ID, Map.of());
    }

    @Override
    public String getProviderId() {
        return PROVIDER_ID;
    }

    @Override
    public String[] getDependencies() {
        return new String[]{"field-types", "view-types", "layout-types"};
    }

    @Override
    public String getDescription() {
        return "MetaObjects UI / presentation concern attrs (filterable/sortable, view.currency @locale, layout.dataGrid) — FR-033";
    }
}

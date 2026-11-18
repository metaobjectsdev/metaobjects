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
 * The {@code metaobjects-ui-web} concern provider.
 *
 * <p>Registers the web presentation view attrs declared in the embedded
 * {@code spec/metamodel/ui-web.json} {@code extends} directives:
 * {@code view.textarea @rows} and the {@code view.image} control's
 * {@code @aspectRatio} / {@code @maxEdge} / {@code @store} / {@code @accept} /
 * {@code @maxBytes}. They are cross-port vocabulary only TypeScript implements so
 * far: Java (and Kotlin, which shares this registry) registers them so a shared
 * model loads strictly here, and acts on none of them. Mirrors the TS
 * {@code uiWebProvider}, the C# {@code UiWebMetaDataProvider} and Python.</p>
 */
public class UiWebTypesMetaDataProvider implements MetaDataTypeProvider {

    /** The provider name — matches {@code ui-web.json}'s {@code "provider"} field. */
    public static final String PROVIDER_ID = "metaobjects-ui-web";

    @Override
    public void registerTypes(MetaDataRegistry registry) {
        // Exact subtypes only (view.textarea / view.image): no wildcard to expand.
        registry.applyProviderExtends(SpecMetamodelReader.load(), PROVIDER_ID, Map.of());
    }

    @Override
    public String getProviderId() {
        return PROVIDER_ID;
    }

    @Override
    public String[] getDependencies() {
        return new String[]{"view-types"};
    }

    @Override
    public String getDescription() {
        return "Web presentation view attrs — @rows (view.textarea) and the view.image control attrs. "
                + "Cross-port vocabulary only TypeScript implements so far; Java loads and type-checks them.";
    }
}

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
package com.metaobjects.api;

import com.metaobjects.registry.MetaDataRegistry;
import com.metaobjects.registry.MetaDataTypeProvider;
import com.metaobjects.transition.ActionTransition;

/**
 * Business-rules Types MetaData provider (ADR-0030, ADR-0066): the declared API surface
 * ({@code api.*}, {@code operation.*}, {@code binding.*}) and lifecycle moves
 * ({@code transition.*}, a child of {@code field.enum}). The cross-node rules live in
 * {@code loader/RulesValidation}.
 */
public class RulesTypesMetaDataProvider implements MetaDataTypeProvider {

    @Override
    public void registerTypes(MetaDataRegistry registry) {
        OperationalApi.registerTypes(registry);
        CommandOperation.registerTypes(registry);
        RestBinding.registerTypes(registry);
        ActionTransition.registerTypes(registry);
    }

    @Override
    public String getProviderId() {
        return "rules-types";
    }

    @Override
    public String[] getDependencies() {
        return new String[]{"core-types"};
    }

    @Override
    public String getDescription() {
        return "Business-rules Types (api, operation, binding, transition) — ADR-0066";
    }
}

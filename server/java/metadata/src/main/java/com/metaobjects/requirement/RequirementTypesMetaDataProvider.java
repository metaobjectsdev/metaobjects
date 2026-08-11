/*
 * Copyright 2003 Doug Mealing LLC dba Meta Objects
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
package com.metaobjects.requirement;

import com.metaobjects.registry.MetaDataRegistry;
import com.metaobjects.registry.MetaDataTypeProvider;

/**
 * Requirement Types MetaData provider.
 *
 * <p>Registers the two {@code requirement.*} subtypes — the capability ledger as
 * REGISTERED metamodel vocabulary (requirements-as-metadata ruling, Amendment 3):
 * {@code requirement.functional} (checked by EXISTENCE) and
 * {@code requirement.architectural} (checked by UNIVERSALITY, the opposite polarity).</p>
 *
 * <p>Depends on {@code core-types} for {@code metadata.base} inheritance.</p>
 */
public class RequirementTypesMetaDataProvider implements MetaDataTypeProvider {

    @Override
    public void registerTypes(MetaDataRegistry registry) {
        FunctionalRequirement.registerTypes(registry);
        ArchitecturalRequirement.registerTypes(registry);
    }

    @Override
    public String getProviderId() {
        return "requirement-types";
    }

    @Override
    public String[] getDependencies() {
        return new String[]{"core-types"};
    }

    @Override
    public String getDescription() {
        return "Requirement Types (functional, architectural) — the capability ledger as metadata";
    }
}

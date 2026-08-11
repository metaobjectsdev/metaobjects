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

import com.metaobjects.MetaData;
import com.metaobjects.attr.MetaAttribute;
import com.metaobjects.attr.StringAttribute;
import com.metaobjects.registry.MetaDataRegistry;

/**
 * How the system is built, applied uniformly across the model
 * ({@code requirement.architectural}).
 *
 * <p>Its check is UNIVERSALITY: it fails when something VIOLATES it — the opposite
 * polarity to {@link FunctionalRequirement}. It carries NO {@code @level} and no parent:
 * levels come from object-in-focus decomposition, and an architectural requirement is
 * object-independent by definition. It therefore also admits no nested requirement
 * children.</p>
 */
public class ArchitecturalRequirement extends MetaRequirement {

    /** Create a {@code requirement.architectural} node with the given name. */
    public ArchitecturalRequirement(String name) {
        super(SUBTYPE_ARCHITECTURAL, name);
    }

    /**
     * Register the {@code requirement.architectural} type in the given registry.
     * Called by {@link RequirementTypesMetaDataProvider}.
     *
     * <p>The type/attr DESCRIPTIONS + the {@code @status} {@code allowedValues} are
     * sourced from the shared {@code spec/metamodel/requirement.json} by
     * {@code MetaDataRegistry.applySpecDescriptions} (FR-033) — never hand-copied.</p>
     */
    public static void registerTypes(MetaDataRegistry registry) {
        registry.registerType(ArchitecturalRequirement.class, def -> {
            def.type(TYPE_REQUIREMENT).subType(SUBTYPE_ARCHITECTURAL)
               .description("How the system is built, applied uniformly across the model.")
               .inheritsFrom(MetaData.TYPE_METADATA, MetaData.SUBTYPE_BASE);

            def.requiredAttributeWithConstraints(ATTR_STATUS)
               .ofType(StringAttribute.SUBTYPE_STRING)
               .withEnum(STATUS_LIVE, STATUS_PARTIAL, STATUS_ABANDONED, STATUS_SUPERSEDED);

            def.requiredAttributeWithConstraints(ATTR_STATEMENT)
               .ofType(StringAttribute.SUBTYPE_STRING).asSingle();

            def.requiredAttributeWithConstraints(ATTR_VIOLATION)
               .ofType(StringAttribute.SUBTYPE_STRING).asSingle();

            def.optionalAttributeWithConstraints(ATTR_IMPLEMENTED_BY)
               .ofType(StringAttribute.SUBTYPE_STRING).asArray();

            def.optionalAttributeWithConstraints(ATTR_SUPERSEDED_BY)
               .ofType(StringAttribute.SUBTYPE_STRING).asSingle();

            // ACCEPTS ANY CHILD ATTRIBUTES (for extensibility from service providers)
            def.optionalChild(MetaAttribute.TYPE_ATTR, "*", "*");
        });
    }
}

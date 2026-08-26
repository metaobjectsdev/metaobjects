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
import com.metaobjects.attr.IntAttribute;
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

            // OPTIONAL here, unlike on a functional requirement where it is required.
            // ABSENT means a flat, object-independent policy -- the original and still
            // the default form. PRESENT opts the node into a levelled tree, e.g. an
            // ISO/IEC 25010 characteristic at L1 and its sub-characteristic at L2 over
            // the non-functional set. Levelling is opt-in precisely so that adding a
            // taxonomy on top of existing flat policies does not invalidate them.
            def.optionalAttributeWithConstraints(ATTR_LEVEL)
               .ofType(IntAttribute.SUBTYPE_INT).asSingle();

            def.requiredAttributeWithConstraints(ATTR_STATUS)
               .ofType(StringAttribute.SUBTYPE_STRING)
               .withEnum(STATUS_PLANNED, STATUS_LIVE, STATUS_PARTIAL, STATUS_RETIRED);

            def.optionalAttributeWithConstraints(ATTR_DISPOSITION)
               .ofType(StringAttribute.SUBTYPE_STRING)
               .withEnum(DISPOSITION_ACCEPTED, DISPOSITION_DEFERRED);

            def.optionalAttributeWithConstraints(ATTR_TRACKED_BY)
               .ofType(StringAttribute.SUBTYPE_STRING).asArray();

            def.requiredAttributeWithConstraints(ATTR_STATEMENT)
               .ofType(StringAttribute.SUBTYPE_STRING).asSingle();

            def.requiredAttributeWithConstraints(ATTR_COUNTEREXAMPLE)
               .ofType(StringAttribute.SUBTYPE_STRING).asSingle();

            // @supersededBy: FR-039. Declared BEFORE @implementedBy to match the
            // canonical spec's child order, which the registry manifest emits verbatim.
            def.optionalAttributeWithConstraints(ATTR_SUPERSEDED_BY)
               .ofType(StringAttribute.SUBTYPE_STRING).asSingle();

            def.optionalAttributeWithConstraints(ATTR_IMPLEMENTED_BY)
               .ofType(StringAttribute.SUBTYPE_STRING).asArray();

            // Hierarchy IS nesting, on BOTH subtypes. Declaring the requirement child
            // rule on `functional` only was an omission, not a design: it made an
            // architectural node nestable under a FUNCTIONAL parent but never under
            // another architectural one, so a quality taxonomy could not be expressed.
            def.optionalChild(TYPE_REQUIREMENT, "*", "*");

            // NO any-attr wildcard -- see FunctionalRequirement. ADR-0023 closed the
            // open-attr policy in all ports; extensibility is by registration.
        });
    }
}

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
import com.metaobjects.attr.IntAttribute;
import com.metaobjects.attr.MetaAttribute;
import com.metaobjects.attr.StringAttribute;
import com.metaobjects.registry.MetaDataRegistry;

/**
 * What the product does for a user, stated as one violable claim
 * ({@code requirement.functional}).
 *
 * <p>Its check is EXISTENCE: it fails when NOTHING implements it. Hierarchy is NESTING —
 * an L1 solution contains its L2 segments, which contain L3 services, and so on down to
 * the levels that reference the model. Only L4 (an object) and L5 (a member) carry
 * {@code @implementedBy}; L1-L3 are organisational and never reference the model.</p>
 */
public class FunctionalRequirement extends MetaRequirement {

    /** Create a {@code requirement.functional} node with the given name. */
    public FunctionalRequirement(String name) {
        super(SUBTYPE_FUNCTIONAL, name);
    }

    /**
     * Register the {@code requirement.functional} type in the given registry.
     * Called by {@link RequirementTypesMetaDataProvider}.
     *
     * <p>The type/attr DESCRIPTIONS + the {@code @status} {@code allowedValues} are
     * sourced from the shared {@code spec/metamodel/requirement.json} by
     * {@code MetaDataRegistry.applySpecDescriptions} (FR-033) — never hand-copied here.
     * The NESTED {@code requirement} child rule likewise comes from that spec file's
     * structural children (FR-033 B2a), which is what makes hierarchy nesting.</p>
     */
    public static void registerTypes(MetaDataRegistry registry) {
        registry.registerType(FunctionalRequirement.class, def -> {
            def.type(TYPE_REQUIREMENT).subType(SUBTYPE_FUNCTIONAL)
               .description("What the product does for a user, stated as one violable claim.")
               .inheritsFrom(MetaData.TYPE_METADATA, MetaData.SUBTYPE_BASE);

            // @level: required — 1 solution / 2 segment / 3 service / 4 object / 5 member.
            def.requiredAttributeWithConstraints(ATTR_LEVEL)
               .ofType(IntAttribute.SUBTYPE_INT).asSingle();

            // @status: required, closed enum. This is the whole point of registering the
            // ledger as metadata — a typo'd status is refused by the LOADER, not by a
            // hand-written string comparison in one CLI.
            def.requiredAttributeWithConstraints(ATTR_STATUS)
               .ofType(StringAttribute.SUBTYPE_STRING)
               .withEnum(STATUS_PLANNED, STATUS_LIVE, STATUS_PARTIAL);

            def.optionalAttributeWithConstraints(ATTR_DISPOSITION)
               .ofType(StringAttribute.SUBTYPE_STRING)
               .withEnum(DISPOSITION_ACCEPTED, DISPOSITION_DEFERRED);

            def.optionalAttributeWithConstraints(ATTR_TRACKED_BY)
               .ofType(StringAttribute.SUBTYPE_STRING).asArray();

            def.requiredAttributeWithConstraints(ATTR_STATEMENT)
               .ofType(StringAttribute.SUBTYPE_STRING).asSingle();

            def.requiredAttributeWithConstraints(ATTR_VIOLATION)
               .ofType(StringAttribute.SUBTYPE_STRING).asSingle();

            def.optionalAttributeWithConstraints(ATTR_IMPLEMENTED_BY)
               .ofType(StringAttribute.SUBTYPE_STRING).asArray();

            // Hierarchy IS nesting: a requirement contains its child requirements.
            // (The strict cardinality — min 0 / max unbounded — is applied from
            // spec/metamodel/requirement.json by applyStrictStructuralChildren.)
            def.optionalChild(TYPE_REQUIREMENT, "*", "*");

            // NO any-attr wildcard. ADR-0023 closed the open-attr policy "in all ports":
            // an undeclared attribute is ERR_UNKNOWN_ATTR. Extensibility is by REGISTRATION
            // -- a consumer ships its own provider and declares its attrs (ADR-0011's own
            // chartered mechanism is registry.extend with declared attributes, never
            // undeclared ones) -- or uses the registered attr.properties bag. A wildcard
            // here would also swallow a TYPO'd core attr, silently, on this port only.
        });
    }
}

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
package com.metaobjects.validator;

import com.metaobjects.attr.StringAttribute;
import com.metaobjects.registry.MetaDataRegistry;

import static com.metaobjects.validator.MetaValidator.TYPE_VALIDATOR;
import static com.metaobjects.validator.MetaValidator.SUBTYPE_BASE;

/**
 * Cardinality of presence — at least one of the named fields ({@code @fields})
 * must be present (NOT NULL). Entity-scoped; references fields by name (the same
 * {@code @fields}-by-name pattern as {@code identity.*}). DB-enforced, so
 * {@link #validate} is a no-op in the JVM.
 */
@SuppressWarnings("serial")
public class AtLeastOneValidator extends MetaValidator {

    public final static String SUBTYPE_AT_LEAST_ONE = "atLeastOne";

    /** Candidate field names; at least one must be present. */
    public final static String ATTR_FIELDS = "fields";

    public static void registerTypes(MetaDataRegistry registry) {
        registry.registerType(AtLeastOneValidator.class, def -> {
            def.type(TYPE_VALIDATOR).subType(SUBTYPE_AT_LEAST_ONE)
               .description("Presence cardinality — at least one of @fields must be present")
               .inheritsFrom(TYPE_VALIDATOR, SUBTYPE_BASE);

            def.requiredAttributeWithConstraints(ATTR_FIELDS).ofType(StringAttribute.SUBTYPE_STRING).asArray();
        });
    }

    public AtLeastOneValidator(String name) {
        super(SUBTYPE_AT_LEAST_ONE, name);
    }

    /** DB-enforced (CONSTRAINT CHECK); no JVM-side runtime validation. */
    public void validate(Object object, Object value) {
    }
}

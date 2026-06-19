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
 * Biconditional presence — the target field ({@code @field}) is present (NOT
 * NULL) if and only if the gating field ({@code @when}) equals {@code @equals}.
 * Models paired flag/companion-column invariants, e.g. used_at present iff
 * is_used=true. Stricter than {@link RequiredWhenValidator} (also forbids the
 * field when the condition is false). Entity-scoped; references fields by name.
 * DB-enforced, so {@link #validate} is a no-op in the JVM.
 */
@SuppressWarnings("serial")
public class PresentIffValidator extends MetaValidator {

    public final static String SUBTYPE_PRESENT_IFF = "presentIff";

    /** Field whose presence is governed by the condition. */
    public final static String ATTR_FIELD = "field";
    /** Gating field. */
    public final static String ATTR_WHEN = "when";
    /** Gating value; @field is present exactly when @when equals this. */
    public final static String ATTR_EQUALS = "equals";

    public static void registerTypes(MetaDataRegistry registry) {
        registry.registerType(PresentIffValidator.class, def -> {
            def.type(TYPE_VALIDATOR).subType(SUBTYPE_PRESENT_IFF)
               .description("Biconditional presence (@field present iff @when = @equals)")
               .inheritsFrom(TYPE_VALIDATOR, SUBTYPE_BASE);

            def.requiredAttributeWithConstraints(ATTR_FIELD).ofType(StringAttribute.SUBTYPE_STRING).asSingle();
            def.requiredAttributeWithConstraints(ATTR_WHEN).ofType(StringAttribute.SUBTYPE_STRING).asSingle();
            def.requiredAttributeWithConstraints(ATTR_EQUALS).ofType(StringAttribute.SUBTYPE_STRING).asSingle();
        });
    }

    public PresentIffValidator(String name) {
        super(SUBTYPE_PRESENT_IFF, name);
    }

    /** DB-enforced (CONSTRAINT CHECK); no JVM-side runtime validation. */
    public void validate(Object object, Object value) {
    }
}

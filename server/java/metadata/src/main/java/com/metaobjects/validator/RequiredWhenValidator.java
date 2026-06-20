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
 * One-directional conditional presence — when the gating field ({@code @when})
 * equals {@code @equals}, the target field ({@code @field}) must be present
 * (NOT NULL); otherwise it is unconstrained. Mirrors JSON Schema
 * dependentRequired. Entity-scoped; references fields by name. DB-enforced, so
 * {@link #validate} is a no-op in the JVM.
 */
@SuppressWarnings("serial")
public class RequiredWhenValidator extends MetaValidator {

    public final static String SUBTYPE_REQUIRED_WHEN = "requiredWhen";

    /** Field that becomes required when the condition holds. */
    public final static String ATTR_FIELD = "field";
    /** Gating field whose value triggers the requirement. */
    public final static String ATTR_WHEN = "when";
    /** Gating value; when @when equals this, @field must be present. */
    public final static String ATTR_EQUALS = "equals";

    public static void registerTypes(MetaDataRegistry registry) {
        registry.registerType(RequiredWhenValidator.class, def -> {
            def.type(TYPE_VALIDATOR).subType(SUBTYPE_REQUIRED_WHEN)
               .description("One-directional conditional presence (required when @when = @equals)")
               .inheritsFrom(TYPE_VALIDATOR, SUBTYPE_BASE);

            def.requiredAttributeWithConstraints(ATTR_FIELD).ofType(StringAttribute.SUBTYPE_STRING).asSingle();
            def.requiredAttributeWithConstraints(ATTR_WHEN).ofType(StringAttribute.SUBTYPE_STRING).asSingle();
            def.requiredAttributeWithConstraints(ATTR_EQUALS).ofType(StringAttribute.SUBTYPE_STRING).asSingle();
        });
    }

    public RequiredWhenValidator(String name) {
        super(SUBTYPE_REQUIRED_WHEN, name);
    }

    /** DB-enforced (CONSTRAINT CHECK); no JVM-side runtime validation. */
    public void validate(Object object, Object value) {
    }
}

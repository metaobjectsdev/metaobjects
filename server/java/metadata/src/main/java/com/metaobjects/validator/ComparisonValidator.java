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
 * Cross-field ordering validator — requires two sibling fields of the owning
 * entity stand in a relational order ({@code @left @op @right}), e.g.
 * {@code current_hp <= max_hp}. Entity-scoped; references fields by name. The
 * rule is derived by each backend (SQL CHECK, cross-field assertion); nothing
 * raw is stored. DB-enforced, so {@link #validate} is a no-op in the JVM.
 */
@SuppressWarnings("serial")
public class ComparisonValidator extends MetaValidator {

    public final static String SUBTYPE_COMPARISON = "comparison";

    /** Name of the left-hand field of the owning entity. */
    public final static String ATTR_LEFT = "left";
    /** Relational operator: gt/gte/lt/lte/ne/eq. */
    public final static String ATTR_OP = "op";
    /** Name of the right-hand field of the owning entity. */
    public final static String ATTR_RIGHT = "right";

    public static void registerTypes(MetaDataRegistry registry) {
        registry.registerType(ComparisonValidator.class, def -> {
            def.type(TYPE_VALIDATOR).subType(SUBTYPE_COMPARISON)
               .description("Cross-field ordering validator (@left @op @right)")
               .inheritsFrom(TYPE_VALIDATOR, SUBTYPE_BASE);

            def.requiredAttributeWithConstraints(ATTR_LEFT).ofType(StringAttribute.SUBTYPE_STRING).asSingle();
            def.requiredAttributeWithConstraints(ATTR_OP).ofType(StringAttribute.SUBTYPE_STRING)
               .withEnum("gt", "gte", "lt", "lte", "ne", "eq");
            def.requiredAttributeWithConstraints(ATTR_RIGHT).ofType(StringAttribute.SUBTYPE_STRING).asSingle();
        });
    }

    public ComparisonValidator(String name) {
        super(SUBTYPE_COMPARISON, name);
    }

    /** DB-enforced (CONSTRAINT CHECK); no JVM-side runtime validation. */
    public void validate(Object object, Object value) {
    }
}

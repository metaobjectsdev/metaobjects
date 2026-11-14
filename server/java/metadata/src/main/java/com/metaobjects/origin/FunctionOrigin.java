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
package com.metaobjects.origin;

import com.metaobjects.attr.StringAttribute;
import com.metaobjects.registry.MetaDataRegistry;

/**
 * rc.21 part B (U10) — {@code origin.function}: a value computed by a database function the
 * project owns, named ({@code @function}, {@code @schema}) and typed by its argument fields
 * ({@code @args}). Registered so a strict load accepts it; the call rules run in TypeScript
 * and C#, and only the TypeScript view emitter lowers it.
 */
public class FunctionOrigin extends MetaOrigin {

    /** Function origin subtype constant. */
    public static final String SUBTYPE_FUNCTION = "function";
    public static final String ATTR_FUNCTION = "function";
    public static final String ATTR_SCHEMA = "schema";
    public static final String ATTR_ARGS = "args";
    public static final String ATTR_PARAMS = "params";
    public static final String ATTR_RETURNS = "returns";

    public FunctionOrigin(String name) {
        super(SUBTYPE_FUNCTION, name);
    }

    /** Register the concrete {@code origin.function} subtype with the registry. */
    public static void registerTypes(MetaDataRegistry registry) {
        registry.registerType(FunctionOrigin.class, def -> {
            def.type(TYPE_ORIGIN).subType(SUBTYPE_FUNCTION)
               .description("Function origin — a value computed by a database function the project owns")
               .inheritsFrom(TYPE_ORIGIN, SUBTYPE_BASE);
            def.requiredAttributeWithConstraints(ATTR_FUNCTION)
               .ofType(StringAttribute.SUBTYPE_STRING).asSingle();
            def.optionalAttributeWithConstraints(ATTR_SCHEMA)
               .ofType(StringAttribute.SUBTYPE_STRING).asSingle();
            def.optionalAttributeWithConstraints(ATTR_ARGS)
               .ofType(StringAttribute.SUBTYPE_STRING).asArray();
            def.optionalAttributeWithConstraints(ATTR_PARAMS)
               .ofType(StringAttribute.SUBTYPE_STRING).asArray();
            def.requiredAttributeWithConstraints(ATTR_RETURNS)
               .ofType(StringAttribute.SUBTYPE_STRING).asSingle();
        });
    }
}

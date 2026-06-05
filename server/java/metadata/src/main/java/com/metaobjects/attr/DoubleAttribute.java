/*
 * Copyright 2002 Doug Mealing LLC dba Meta Objects
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
package com.metaobjects.attr;

import com.metaobjects.DataTypes;
import com.metaobjects.registry.MetaDataRegistry;

import static com.metaobjects.attr.MetaAttribute.TYPE_ATTR;
import static com.metaobjects.attr.MetaAttribute.SUBTYPE_BASE;

/**
 * A Double Attribute with provider-based registration.
 */
@SuppressWarnings("serial")
public class DoubleAttribute extends MetaAttribute<Double> {

    public final static String SUBTYPE_DOUBLE = "double";

    /**
     * Register this type with the MetaDataRegistry (called by provider)
     */
    public static void registerTypes(MetaDataRegistry registry) {
        registry.registerType(DoubleAttribute.class, def -> def
            .type(TYPE_ATTR).subType(SUBTYPE_DOUBLE)
            .description("Double attribute for floating-point numeric metadata")
            .inheritsFrom(TYPE_ATTR, SUBTYPE_BASE)
        );
    }

    /**
     * Constructs the Double MetaAttribute
     */
    public DoubleAttribute(String name) {
        super(SUBTYPE_DOUBLE, name, DataTypes.DOUBLE);
    }

    /**
     * Manually create a Double MetaAttribute with a value
     */
    public static DoubleAttribute create(String name, Double value) {
        DoubleAttribute a = new DoubleAttribute(name);
        a.setValue(value);
        return a;
    }
}
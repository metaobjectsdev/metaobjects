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
 * A Long Attribute with provider-based registration.
 */
@SuppressWarnings("serial")
public class LongAttribute extends MetaAttribute<Long> {

    public final static String SUBTYPE_LONG = "long";

    /**
     * Register this type with the MetaDataRegistry (called by provider)
     */
    public static void registerTypes(MetaDataRegistry registry) {
        registry.registerType(LongAttribute.class, def -> def
            .type(TYPE_ATTR).subType(SUBTYPE_LONG)
            .description("Long attribute for large integer numeric metadata")
            .inheritsFrom(TYPE_ATTR, SUBTYPE_BASE)
        );
    }

    /**
     * Constructs the Integer MetaAttribute
     */
    public LongAttribute(String name ) {
        super( SUBTYPE_LONG, name, DataTypes.LONG);
    }

    /**
     * Manually create an Integer MetaAttribute with a value
     */
    public static LongAttribute create(String name, Long value ) {
        LongAttribute a = new LongAttribute( name );
        a.setValue( value );
        return a;
    }
}

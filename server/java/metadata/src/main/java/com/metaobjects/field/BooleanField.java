/*
 * Copyright 2004 Doug Mealing LLC dba Meta Objects
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
package com.metaobjects.field;

import com.metaobjects.*;
import com.metaobjects.attr.StringAttribute;
import com.metaobjects.registry.MetaDataRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import static com.metaobjects.field.MetaField.TYPE_FIELD;
import static com.metaobjects.field.MetaField.SUBTYPE_BASE;

/**
 * A Boolean Field with unified registry registration and child requirements.
 *
 * @version 6.0
 * @author Doug Mealing
 */
@SuppressWarnings("serial")
public class BooleanField extends PrimitiveField<Boolean> {

    private static final Logger log = LoggerFactory.getLogger(BooleanField.class);

    public final static String SUBTYPE_BOOLEAN = "boolean";


    public BooleanField(String name ) {
        super( SUBTYPE_BOOLEAN, name, DataTypes.BOOLEAN );
    }

    /**
     * Register BooleanField type with the registry (called by provider)
     */
    public static void registerTypes(MetaDataRegistry registry) {
        registry.registerType(BooleanField.class, def -> def
            .type(TYPE_FIELD).subType(SUBTYPE_BOOLEAN)
            .description("Boolean field for true/false values")
            .inheritsFrom(TYPE_FIELD, SUBTYPE_BASE)
        );
    }

    /**
     * Manually Create a Boolean Field
     * @param name Name of the field
     * @param defaultValue Default value for the field
     * @return New BooleanField
     */
    public static BooleanField create( String name, Boolean defaultValue ) {
        BooleanField f = new BooleanField( name );
        if ( defaultValue != null ) {
            f.addMetaAttr(StringAttribute.create( ATTR_DEFAULT_VALUE, defaultValue.toString() ));
        }
        return f;
    }
}

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

import com.metaobjects.DataTypes;
import com.metaobjects.object.MetaObject;
import com.metaobjects.util.MetaDataUtil;
import com.metaobjects.registry.MetaDataRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import static com.metaobjects.field.MetaField.TYPE_FIELD;
import static com.metaobjects.field.MetaField.SUBTYPE_BASE;

/**
 * An Object Field with unified registry registration and child requirements.
 *
 * @version 6.0
 * @author Doug Mealing
 */
public class ObjectField extends MetaField<Object>
{
    private static final Logger log = LoggerFactory.getLogger(ObjectField.class);

    public final static String SUBTYPE_OBJECT = "object";
    public final static String ATTR_OBJECTREF = MetaObject.ATTR_OBJECT_REF;
    /** Persistence-side storage shape for owned-object data. Cross-port values: flattened / jsonb / subdocument. */
    public final static String ATTR_STORAGE = "storage";

    /**
     * Register ObjectField type using the standardized registerTypes() pattern.
     * This method registers the object field type that inherits from field.base.
     *
     * @param registry The MetaDataRegistry to register with
     */
    public static void registerTypes(MetaDataRegistry registry) {
        try {
            registry.registerType(ObjectField.class, def -> {
                def.type(TYPE_FIELD).subType(SUBTYPE_OBJECT)
                   .description("Object field with object reference support")

                   // INHERIT FROM BASE FIELD.
                   // @objectRef + @storage are now declared on field.base (SP-G
                   // cross-port logical vocabulary — every field subtype carries
                   // them), so ObjectField inherits both via the snapshot rather
                   // than re-declaring them here.
                   .inheritsFrom(TYPE_FIELD, SUBTYPE_BASE);
            });

            log.debug("Registered ObjectField type with unified registry");
        } catch (Exception e) {
            log.error("Failed to register ObjectField type with unified registry", e);
        }
    }

    public ObjectField( String name ) {
        super( SUBTYPE_OBJECT, name, DataTypes.OBJECT );
    }

    /**
     * Manually Create an Object Filed
     * @param name Name of the field
     * @return New ObjectField
     */
    public static ObjectField create( String name ) {
        ObjectField f = new ObjectField( name );
        return f;
    }

    /**
     * Return the referenced MetaObject
     */
    public MetaObject getObjectRef() {
        return MetaDataUtil.getObjectRef(this);
    }
}

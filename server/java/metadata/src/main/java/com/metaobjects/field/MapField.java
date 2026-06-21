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
 * An open-keyed map field — a {@code Map<String, V>} stored in a single jsonb
 * column. Keys are always strings (the JSON-object constraint); the value type
 * is set by EXACTLY ONE of {@code @valueType} (a scalar field subtype) or
 * {@code @objectRef} (a value-object). It is the map analog of {@link ObjectField}
 * and shares its {@link DataTypes#OBJECT} data type.
 *
 * <p>Cross-port parity: TypeScript MapField, Python MapField, C# MapField.</p>
 *
 * @version 6.0
 * @author Doug Mealing
 */
public class MapField extends MetaField<Object>
{
    private static final Logger log = LoggerFactory.getLogger(MapField.class);

    public final static String SUBTYPE_MAP = "map";
    /** Scalar value subtype for a scalar-valued map (mutually exclusive with @objectRef). */
    public final static String ATTR_VALUE_TYPE = "valueType";
    /** Value-object reference for a value-object-valued map (mutually exclusive with @valueType). */
    public final static String ATTR_OBJECTREF = MetaObject.ATTR_OBJECT_REF;

    /**
     * Register MapField type using the standardized registerTypes() pattern.
     * This method registers the map field type that inherits from field.base.
     *
     * @param registry The MetaDataRegistry to register with
     */
    public static void registerTypes(MetaDataRegistry registry) {
        try {
            registry.registerType(MapField.class, def -> {
                def.type(TYPE_FIELD).subType(SUBTYPE_MAP)
                   .description("Open-keyed map field with scalar or value-object values")

                   // INHERIT FROM BASE FIELD.
                   // @valueType + @objectRef are declared on field.base (the SP-G
                   // cross-port logical vocabulary — every field subtype carries
                   // them), so MapField inherits both via the snapshot rather than
                   // re-declaring them here. FR-033 strict-attr scoping keeps exactly
                   // @valueType + @objectRef on field.map (per spec/metamodel/field.json),
                   // so the manifest byte-matches the frozen registry fixture.
                   .inheritsFrom(TYPE_FIELD, SUBTYPE_BASE);
            });

            log.debug("Registered MapField type with unified registry");
        } catch (Exception e) {
            log.error("Failed to register MapField type with unified registry", e);
        }
    }

    public MapField( String name ) {
        super( SUBTYPE_MAP, name, DataTypes.OBJECT );
    }

    /**
     * Manually create a Map Field.
     * @param name Name of the field
     * @return New MapField
     */
    public static MapField create( String name ) {
        MapField f = new MapField( name );
        return f;
    }

    /**
     * Return the referenced MetaObject for a value-object-valued map
     * (set via {@code @objectRef}), or null for a scalar-valued map.
     */
    public MetaObject getObjectRef() {
        return MetaDataUtil.getObjectRef(this);
    }
}

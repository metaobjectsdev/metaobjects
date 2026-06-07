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
import com.metaobjects.attr.IntAttribute;
import com.metaobjects.attr.StringAttribute;
// Constraint registration now handled by consolidated MetaDataRegistry
import com.metaobjects.registry.MetaDataRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * A String Field with unified registry registration and child requirements.
 *
 * @version 6.0
 * @author Doug Mealing
 */
public class StringField extends PrimitiveField<String> {

    private static final Logger log = LoggerFactory.getLogger(StringField.class);

    // === SUBTYPE CONSTANT ===
    /** String field subtype constant */
    public static final String SUBTYPE_STRING = "string";

    // === STRING-SPECIFIC ATTRIBUTE NAME CONSTANTS ===
    /** Pattern validation attribute for string fields */
    public static final String ATTR_PATTERN = "pattern";

    /** Maximum length attribute for string fields */
    public static final String ATTR_MAX_LENGTH = "maxLength";

    /** Minimum length attribute for string fields */
    public static final String ATTR_MIN_LENGTH = "minLength";

    public StringField( String name ) {
        super( SUBTYPE_STRING, name, DataTypes.STRING );
    }

    // Unified registry self-registration
    /**
     * Register StringField type using the standardized registerTypes() pattern.
     * This method registers the string field type that inherits from field.base.
     *
     * @param registry The MetaDataRegistry to register with
     */
    public static void registerTypes(MetaDataRegistry registry) {
        try {
            registry.registerType(StringField.class, def -> {
                def.type(TYPE_FIELD).subType(SUBTYPE_STRING)
                   .description("String field with pattern validation that supports validator children")

                   // INHERIT FROM BASE FIELD
                   .inheritsFrom(TYPE_FIELD, SUBTYPE_BASE);

                // STRING-SPECIFIC ATTRIBUTES WITH FLUENT CONSTRAINTS
                // maxLength is the one canonical (cross-port) string attr. Field-level
                // validation (pattern / min-length) is expressed via validator CHILD
                // nodes (validator.regex @pattern, validator.length @min/@max) — the
                // cross-port form. The redundant field-level @pattern / @minLength
                // registrations were dropped in SP-G Unit 6c (validation already emits
                // from validator children per the SP-C validator-parity work).
                def.optionalAttributeWithConstraints(ATTR_MAX_LENGTH)
                   .ofType(IntAttribute.SUBTYPE_INT)
                   .asSingle();
            });

            if (log != null) {
                log.debug("Registered StringField type with fluent constraint builder (auto-generated constraints)");
            }

        } catch (Exception e) {
            if (log != null) {
                log.error("Failed to register StringField type with unified registry", e);
            }
        }
    }

    /**
     * Manually Create a StringField
     * @param name Name of the field
     * @param defaultValue Default value for the field
     * @return New StringField
     */
    public static StringField create( String name, String defaultValue ) {
        StringField f = new StringField( name );
        if ( defaultValue != null ) {
            f.addMetaAttr(StringAttribute.create( ATTR_DEFAULT_VALUE, defaultValue ));
        }
        return f;
    }
}

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

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * A String Attribute with provider-based registration.
 */
public class StringAttribute extends MetaAttribute<String> {

    public final static String SUBTYPE_STRING = "string";

    /**
     * Constructs the String MetaAttribute
     */
    public StringAttribute(String name ) {
        super( SUBTYPE_STRING, name, DataTypes.STRING);
    }

    /**
     * Universal @isArray support - handles both single strings and string arrays
     */
    @Override
    public void setValueAsString(String value) {
        if (isArrayType()) {
            // Array mode: Parse comma-delimited format like StringArrayAttribute
            if (value == null) {
                setValueAsObjectDirect(null);
                return;
            }

            // Empty string should result in empty list, not null
            if (value.trim().isEmpty()) {
                setValueAsObjectDirect(new ArrayList<>());
                return;
            }

            // Parse comma-delimited format: "id,name,email" or single value "id"
            if (value.contains(",")) {
                // Comma-delimited: id,name,email
                String[] items = value.split(",");
                List<String> list = new ArrayList<>();
                for (String item : items) {
                    String trimmed = item.trim();
                    if (!trimmed.isEmpty()) {
                        list.add(trimmed);
                    }
                }
                setValueAsObjectDirect(list);
            } else {
                // Single value
                setValueAsObjectDirect(Arrays.asList(value.trim()));
            }
        } else {
            // Single value mode: Standard string handling
            setValueAsObject(value);
        }
    }

    /**
     * Array mode holding exactly one element, kept WHOLE even when it contains a comma.
     *
     * <p>The comma-delimited {@link #setValueAsString} path splits every comma, which is
     * right for a JSON array the parser flattened but wrong for a canonical bare string
     * authored for an array attr: the TS reference wraps {@code "a,b"} as the single item
     * {@code ["a,b"]} (normalizeStringArrayAttr), it does not split it.</p>
     *
     * @param value the single element (trimmed, as the single-value path trims)
     */
    public void setSingleElementArray(String value) {
        setArray(true);
        List<String> one = new ArrayList<>();
        one.add(value == null ? null : value.trim());
        setValueAsObjectDirect(one);
    }

    /**
     * Direct value setting that bypasses DataConverter when in array mode
     */
    private void setValueAsObjectDirect(Object value) {
        if (isArrayType()) {
            // In array mode, store the List directly without type conversion
            try {
                java.lang.reflect.Field valueField = MetaAttribute.class.getDeclaredField("value");
                valueField.setAccessible(true);
                valueField.set(this, value);
            } catch (Exception e) {
                // Fallback to regular setValueAsObject if reflection fails
                setValueAsObject(value);
            }
        } else {
            setValueAsObject(value);
        }
    }

    /**
     * Register this type with the MetaDataRegistry (called by provider)
     */
    public static void registerTypes(MetaDataRegistry registry) {
        registry.registerType(StringAttribute.class, def -> def
            .type(TYPE_ATTR).subType(SUBTYPE_STRING)
            .description("String attribute value")
            .inheritsFrom(TYPE_ATTR, SUBTYPE_BASE)
        );
    }

    /**
     * Manually create a String MetaAttribute with a value
     */
    public static StringAttribute create(String name, String value ) {
        StringAttribute a = new StringAttribute( name );
        a.setValue( value );
        return a;
    }
}

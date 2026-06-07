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
import com.metaobjects.constraint.PlacementConstraint;
import com.metaobjects.registry.MetaDataRegistry;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import static com.metaobjects.field.MetaField.TYPE_FIELD;
import static com.metaobjects.field.MetaField.SUBTYPE_BASE;
import static com.metaobjects.attr.MetaAttribute.TYPE_ATTR;

/**
 * A Timestamp Field with unified registry registration and child requirements.
 * Extends DateField to provide timestamp-specific functionality.
 *
 * @version 6.0
 * @author Doug Mealing
 */
public class TimestampField extends PrimitiveField<java.util.Date> {

    private static final Logger log = LoggerFactory.getLogger(TimestampField.class);

    public final static String SUBTYPE_TIMESTAMP = "timestamp";
    public final static String ATTR_PRECISION = "precision";
    public final static String ATTR_DATE_FORMAT = "dateFormat";
    public final static String ATTR_MIN_DATE = "minDate";
    public final static String ATTR_MAX_DATE = "maxDate";

    
    /**
     * Register TimestampField type with the registry (called by provider)
     */
    public static void registerTypes(MetaDataRegistry registry) {
        registry.registerType(TimestampField.class, def -> {
            def.type(TYPE_FIELD).subType(SUBTYPE_TIMESTAMP)
               .description("Timestamp field with date/time and precision validation")
               .inheritsFrom(TYPE_FIELD, SUBTYPE_BASE);

            // precision is the one canonical (cross-port) timestamp attr.
            def.optionalAttributeWithConstraints(ATTR_PRECISION)
               .ofType(IntAttribute.SUBTYPE_INT)
               .asSingle();

            // The field-level @dateFormat (presentation) and @minDate/@maxDate (range)
            // attrs had no canonical peer and no consumer (codegen / runtime / loader)
            // — vestigial. Range validation is expressed via a validator child
            // (validator.numeric @min/@max); dropped SP-G Unit 6c.
        });
    }

    public TimestampField(String name) {
        super(SUBTYPE_TIMESTAMP, name, DataTypes.DATE);  // Use DataTypes.DATE since timestamps are date-based
    }

    /**
     * Manually Create a TimestampField
     * @param name Name of the field
     * @return New TimestampField
     */
    public static TimestampField create(String name) {
        return new TimestampField(name);
    }

    /**
     * Create a TimestampField with a default precision
     * @param name Name of the field
     * @param precision Timestamp precision (e.g., 3 for milliseconds)
     * @return New TimestampField
     */
    public static TimestampField create(String name, int precision) {
        TimestampField field = new TimestampField(name);
        field.addMetaAttr(com.metaobjects.attr.IntAttribute.create(ATTR_PRECISION, precision));
        return field;
    }
}
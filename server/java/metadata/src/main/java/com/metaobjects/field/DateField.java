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
// Constraint registration now handled by consolidated MetaDataRegistry
import com.metaobjects.registry.MetaDataRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.Date;


/**
 * A Date Field with unified registry registration and child requirements.
 *
 * @version 6.0
 * @author Doug Mealing
 */
@SuppressWarnings("serial")
public class DateField extends PrimitiveField<Date> {

    private static final Logger log = LoggerFactory.getLogger(DateField.class);

    public final static String SUBTYPE_DATE     = "date";
    public final static String ATTR_DATE_FORMAT = "dateFormat";
    public final static String ATTR_FORMAT = "format";
    public final static String ATTR_MIN_DATE = "minDate";
    public final static String ATTR_MAX_DATE = "maxDate";


    public DateField( String name ) {
        super( SUBTYPE_DATE, name, DataTypes.DATE );
    }

    /**
     * Register DateField type and constraints with the registry (called by provider)
     */
    public static void registerTypes(MetaDataRegistry registry) {
        registry.registerType(DateField.class, def -> {
            def.type(TYPE_FIELD).subType(SUBTYPE_DATE)
               .description("Date field")
               .inheritsFrom(TYPE_FIELD, SUBTYPE_BASE);

            // No date-specific per-field attrs in the cross-port vocabulary: the
            // field-level @format/@dateFormat (presentation) and @minDate/@maxDate
            // (range) attrs had no canonical peer and no consumer (codegen / runtime /
            // loader) — vestigial. Range validation is expressed via a validator child
            // (validator.numeric @min/@max); dropped SP-G Unit 6c.
        });

        if (log != null) {
            log.debug("Registered DateField type with unified registry (auto-generated constraints)");
        }
    }

    /**
     * Manually Create a Date Filed
     * @param name Name of the field
     * @return New DateField
     */
    public static DateField create( String name ) {
        DateField f = new DateField( name );
        return f;
    }
}

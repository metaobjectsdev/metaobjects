/*
 * Copyright 2004 Doug Mealing LLC dba Meta Objects. All Rights Reserved.
 *
 * This software is the proprietary information of Doug Mealing LLC dba Meta Objects.
 * Use is subject to license terms.
 */
package com.metaobjects.field;

import com.metaobjects.DataTypes;
import com.metaobjects.attr.IntAttribute;
import com.metaobjects.registry.MetaDataRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * A Short Field — narrow signed-integer field (16-bit). Carries only the universal
 * cross-port logical field attrs inherited from {@code field.base} (matches the
 * registry-conformance canonical, which declares no short-specific attrs).
 *
 * @version 6.0
 * @author Doug Mealing
 */
@SuppressWarnings("serial")
public class ShortField extends PrimitiveField<Short> {

    private static final Logger log = LoggerFactory.getLogger(ShortField.class);

    public final static String SUBTYPE_SHORT = "short";

    public ShortField(String name) {
        super(SUBTYPE_SHORT, name, DataTypes.SHORT);
    }

    /**
     * Register ShortField type with the registry. Inherits all attrs from field.base.
     *
     * @param registry The MetaDataRegistry to register with
     */
    public static void registerTypes(MetaDataRegistry registry) {
        try {
            registry.registerType(ShortField.class, def -> def
                .type(TYPE_FIELD).subType(SUBTYPE_SHORT)
                .description("Short field (16-bit signed integer)")
                .inheritsFrom(TYPE_FIELD, SUBTYPE_BASE));

            if (log != null) {
                log.debug("Registered ShortField type with unified registry");
            }
        } catch (Exception e) {
            if (log != null) {
                log.error("Failed to register ShortField type with unified registry", e);
            }
        }
    }

    public static ShortField create(String name, Short defaultValue) {
        ShortField f = new ShortField(name);
        if (defaultValue != null) {
            f.addMetaAttr(IntAttribute.create(ATTR_DEFAULT_VALUE, defaultValue.intValue()));
        }
        return f;
    }
}

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
 * A Byte Field — narrow signed-integer field (8-bit). Carries only the universal
 * cross-port logical field attrs inherited from {@code field.base} (matches the
 * registry-conformance canonical, which declares no byte-specific attrs).
 *
 * @version 6.0
 * @author Doug Mealing
 */
@SuppressWarnings("serial")
public class ByteField extends PrimitiveField<Byte> {

    private static final Logger log = LoggerFactory.getLogger(ByteField.class);

    public final static String SUBTYPE_BYTE = "byte";

    public ByteField(String name) {
        super(SUBTYPE_BYTE, name, DataTypes.BYTE);
    }

    /**
     * Register ByteField type with the registry. Inherits all attrs from field.base.
     *
     * @param registry The MetaDataRegistry to register with
     */
    public static void registerTypes(MetaDataRegistry registry) {
        try {
            registry.registerType(ByteField.class, def -> def
                .type(TYPE_FIELD).subType(SUBTYPE_BYTE)
                .description("Byte field (8-bit signed integer)")
                .inheritsFrom(TYPE_FIELD, SUBTYPE_BASE));

            if (log != null) {
                log.debug("Registered ByteField type with unified registry");
            }
        } catch (Exception e) {
            if (log != null) {
                log.error("Failed to register ByteField type with unified registry", e);
            }
        }
    }

    public static ByteField create(String name, Byte defaultValue) {
        ByteField f = new ByteField(name);
        if (defaultValue != null) {
            f.addMetaAttr(IntAttribute.create(ATTR_DEFAULT_VALUE, defaultValue.intValue()));
        }
        return f;
    }
}

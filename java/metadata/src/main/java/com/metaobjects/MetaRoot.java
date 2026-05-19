/*
 * Copyright 2003 Doug Mealing LLC dba Meta Objects. All Rights Reserved.
 *
 * This software is the proprietary information of Doug Mealing LLC dba Meta Objects.
 * Use is subject to license terms.
 */
package com.metaobjects;

import com.metaobjects.field.MetaField;
import com.metaobjects.object.MetaObject;

import java.util.List;

/**
 * MetaRoot — the tree-root node for a loaded metadata document.
 *
 * <p>Type: {@code metadata}, subType: {@code root}. Mirrors the TypeScript
 * {@code MetaRoot} class; extends {@link MetaData} directly with no model
 * wrapper or metaOf() indirection.</p>
 *
 * <p>This class is purely additive in H3a Task 2. Nothing produces or registers
 * a MetaRoot yet; that wiring happens in a later task.</p>
 *
 * @author Doug Mealing
 * @version 6.0.0
 * @since H3a
 * @see MetaData#TYPE_METADATA
 * @see MetaData#SUBTYPE_ROOT
 */
public class MetaRoot extends MetaData {

    /**
     * Constructs a MetaRoot with the given fully-qualified name.
     *
     * @param name the fully-qualified name of this root node (e.g. the package
     *             or document identifier)
     */
    public MetaRoot(String name) {
        super(TYPE_METADATA, SUBTYPE_ROOT, name);
    }

    /**
     * Returns all {@code object} children of this root node.
     *
     * @return list of MetaObject children; empty list if none
     */
    public List<MetaObject> objects() {
        return useCache("objects()", () -> getChildren(MetaObject.class, false));
    }

    /**
     * Returns all {@code field} children of this root node.
     * Root-level fields are rare but legal (e.g. shared abstract id fields).
     *
     * @return list of MetaField children; empty list if none
     */
    public List<MetaField> fields() {
        return useCache("fields()", () -> getChildren(MetaField.class, false));
    }

    /**
     * Finds an {@code object} child by name.
     *
     * @param name the object name to look up
     * @return the matching MetaObject, or {@code null} if not found
     */
    public MetaObject findObject(String name) {
        return useCache("findObject()", name, n -> {
            try {
                return getChild(n, MetaObject.class, false);
            } catch (MetaDataNotFoundException e) {
                return null;
            }
        });
    }
}

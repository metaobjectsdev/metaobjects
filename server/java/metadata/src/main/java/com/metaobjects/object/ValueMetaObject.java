package com.metaobjects.object;

import com.metaobjects.object.value.ValueObject;

/**
 * object.value — a value object (no identity). Map-backed (ValueObject) by default.
 */
@SuppressWarnings("serial")
public class ValueMetaObject extends AbstractObjectRepresentation {
    public ValueMetaObject(String name) { super(MetaObject.SUBTYPE_VALUE, name); }
    protected ValueMetaObject(String subType, String name) { super(subType, name); }
    @Override protected Class<?> getDefaultObjectClass() { return ValueObject.class; }
}

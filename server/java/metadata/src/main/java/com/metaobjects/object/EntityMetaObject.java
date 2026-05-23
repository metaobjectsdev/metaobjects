package com.metaobjects.object;

import com.metaobjects.object.value.ValueObject;

/**
 * object.entity — a persistent record (has identity). Value access uses the inherited
 * reflection/map hybrid: reflection when a Java class is bound, map (ValueObject) when not.
 */
@SuppressWarnings("serial")
public class EntityMetaObject extends AbstractObjectRepresentation {
    public EntityMetaObject(String name) { super(MetaObject.SUBTYPE_ENTITY, name); }
    protected EntityMetaObject(String subType, String name) { super(subType, name); }
    @Override protected Class<?> getDefaultObjectClass() { return ValueObject.class; }
}

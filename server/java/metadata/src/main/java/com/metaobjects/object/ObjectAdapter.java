package com.metaobjects.object;

import com.metaobjects.field.MetaField;

/**
 * Java-only extension seam for a custom object representation (e.g. a dynamic proxy).
 * Selected per object node via the {@code @objectAdapter} attribute (a class FQN), which the
 * MetaObject instantiates (no-arg ctor) and delegates to. NOT portable; never in the conformance
 * corpus. The narrow successor to the retired {@code @javaRuntime}. See ADR-0005 (amendment).
 */
public interface ObjectAdapter {
    /** Create a new runtime instance for {@code mo}. */
    Object newInstance(MetaObject mo);
    /** Read field {@code f} from runtime object {@code obj}. */
    Object getValue(MetaObject mo, MetaField f, Object obj);
    /** Write {@code value} to field {@code f} on runtime object {@code obj}. */
    void setValue(MetaObject mo, MetaField f, Object obj, Object value);
}

package com.metaobjects.object.value;

import com.metaobjects.object.data.DataObjectBase;
import com.metaobjects.registry.SharedRegistryTestBase;
import org.junit.Test;

import static org.junit.Assert.*;

/**
 * Verifies the cached per-field value-holder primitive on ValueObjectBase.
 *
 * The valueObject codegen flavor emits typed accessors that bind a field's
 * holder ONCE (via {@code valueHolder(name)}) and read/write through it
 * directly, avoiding a {@code get(name)}/{@code set(name,v)} map lookup on
 * every accessor call. This test pins the three properties that primitive
 * must satisfy: stable per field name, current (not a snapshot), and
 * bidirectional with the backing map.
 */
public class ValueObjectHolderTest extends SharedRegistryTestBase {

    @Test
    public void testHolderIsStablePerFieldName() {
        ValueObject vo = new ValueObject("holderTest");

        DataObjectBase.Value h1 = vo.valueHolder("x");
        DataObjectBase.Value h2 = vo.valueHolder("x");

        assertSame("valueHolder must return the same instance for the same field", h1, h2);
    }

    @Test
    public void testHolderWriteVisibleViaMap() {
        ValueObject vo = new ValueObject("holderTest");

        DataObjectBase.Value h1 = vo.valueHolder("x");
        h1.setValue("hello");

        assertEquals("holder write must be visible via the map", "hello", vo.get("x"));
    }

    @Test
    public void testMapWriteVisibleViaHolder() {
        ValueObject vo = new ValueObject("holderTest");

        DataObjectBase.Value h1 = vo.valueHolder("x");
        vo.put("x", "world");

        assertEquals("map write must be visible via the cached holder (current, not snapshot)",
                "world", h1.getValue());
    }
}

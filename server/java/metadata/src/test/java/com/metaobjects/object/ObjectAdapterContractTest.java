package com.metaobjects.object;

import com.metaobjects.field.MetaField;
import org.junit.Test;
import static org.junit.Assert.*;

public class ObjectAdapterContractTest {
    static class StubAdapter implements ObjectAdapter {
        public Object newInstance(MetaObject mo) { return new java.util.HashMap<String,Object>(); }
        @SuppressWarnings("unchecked")
        public Object getValue(MetaObject mo, MetaField f, Object obj) { return ((java.util.Map<String,Object>)obj).get(f.getName()); }
        @SuppressWarnings("unchecked")
        public void setValue(MetaObject mo, MetaField f, Object obj, Object v) { ((java.util.Map<String,Object>)obj).put(f.getName(), v); }
    }
    @Test public void adapter_is_a_3_method_strategy() {
        ObjectAdapter a = new StubAdapter();
        Object o = a.newInstance(null);
        assertNotNull(o);
    }
}

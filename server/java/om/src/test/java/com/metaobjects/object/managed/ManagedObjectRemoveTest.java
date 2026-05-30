package com.metaobjects.object.managed;

import com.metaobjects.field.StringField;
import com.metaobjects.object.MetaObject;
import org.junit.Assert;
import org.junit.Before;
import org.junit.Test;

/**
 * Regression test for {@link ManagedObject#remove(Object)} which previously read the
 * prior field value from the field-name key String instead of from {@code this}.
 */
public class ManagedObjectRemoveTest {

    private MetaObject metaObject;

    @Before
    public void setUp() {
        metaObject = new ManagedMetaObject("RemoveTestEntity");
        metaObject.addMetaField(new StringField("name"));
    }

    @Test
    public void removeReturnsPriorValueAndClearsField() {
        ManagedObject obj = new ManagedObject();
        obj.setMetaData(metaObject);

        obj.put("name", "Test Me");
        Assert.assertEquals("precondition: value is set", "Test Me", obj.get("name"));

        Object removed = obj.remove("name");

        Assert.assertEquals("remove() returns the prior value read from this", "Test Me", removed);
        Assert.assertNull("field is cleared after remove()", obj.get("name"));
    }
}

package com.metaobjects.relationship;

import com.metaobjects.attr.StringAttribute;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

/**
 * Verifies the Tier-1 cross-language alignment rename {@code @targetObject → @objectRef}.
 *
 * <p>The TS reference and the shared conformance corpus use {@code @objectRef} for the
 * relationship target. This test pins the new Java vocabulary: the attribute literal,
 * the constant name, and the accessor method.</p>
 */
public class ObjectRefAttrTest {

    @Test
    public void attrConstantIsObjectRef() {
        // The literal MUST be "objectRef" — Tier-1 vocabulary contract.
        assertEquals("Relationship target attr literal must be 'objectRef'",
            "objectRef", MetaRelationship.ATTR_OBJECT_REF);
    }

    @Test
    public void getObjectRefReturnsAttrValue() throws Exception {
        AssociationRelationship rel = new AssociationRelationship("x");
        StringAttribute attr = new StringAttribute(MetaRelationship.ATTR_OBJECT_REF);
        attr.setValueAsString("Target");
        rel.addChild(attr);

        assertEquals("getObjectRef() must read the @objectRef attr", "Target", rel.getObjectRef());
    }

    @Test
    public void getObjectRefDefaultsToNullWhenUnset() {
        AssociationRelationship rel = new AssociationRelationship("x");
        assertNull("getObjectRef() must be null when @objectRef is not present", rel.getObjectRef());
    }
}

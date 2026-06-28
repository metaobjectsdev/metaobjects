package com.metaobjects.generator.template;

import org.junit.Test;
import static org.junit.Assert.*;

public class OutputPatternTest {

    @Test public void nameAndPackage() {
        assertEquals("acme/sales/orderService.java",
            OutputPattern.expand("{package}/{name}Service.java", "order", "acme::sales"));
    }

    @Test public void pascalName() {
        assertEquals("OrderLine.kt", OutputPattern.expand("{Name}.kt", "order_line", null));
    }

    @Test public void literalPassthrough() {
        assertEquals("registry.kt", OutputPattern.expand("registry.kt", null, null));
    }

    @Test public void emptyPackageCollapses() {
        assertEquals("x.java", OutputPattern.expand("{package}/{name}.java", "x", ""));
    }

    @Test(expected = IllegalArgumentException.class) public void unknownPlaceholder() {
        OutputPattern.expand("{bogus}.java", "x", "p");
    }

    @Test(expected = IllegalArgumentException.class) public void nameWithoutNameVar() {
        OutputPattern.expand("{name}.java", null, "p");
    }
}

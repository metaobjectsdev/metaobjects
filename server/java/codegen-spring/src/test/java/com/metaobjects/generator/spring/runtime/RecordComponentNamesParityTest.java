package com.metaobjects.generator.spring.runtime;

import com.metaobjects.generator.util.JavaIdentifiers;
import org.junit.Test;

import java.lang.reflect.Field;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

import static org.junit.Assert.assertEquals;

/**
 * The generation-time rule ({@link JavaIdentifiers}, which names a record component) and the
 * run-time rule ({@link RecordComponentNames}, which the generated PATCH handler uses to find
 * that component again) must give the same answer for every name. They are two copies on
 * purpose — the runtime one is JDK-only so {@code mvn metaobjects:eject} can hand it to an
 * adopter — and this test is what keeps them one rule.
 */
public class RecordComponentNamesParityTest {

    @SuppressWarnings("unchecked")
    private static Set<String> staticSet(Class<?> owner, String name) throws Exception {
        Field f = owner.getDeclaredField(name);
        f.setAccessible(true);
        return (Set<String>) f.get(null);
    }

    @Test
    public void theReservedSetsAreIdentical() throws Exception {
        assertEquals(staticSet(JavaIdentifiers.class, "KEYWORDS"), RecordComponentNames.KEYWORDS);
        assertEquals(staticSet(JavaIdentifiers.class, "OBJECT_NO_ARG_METHODS"),
                RecordComponentNames.OBJECT_NO_ARG_METHODS);
    }

    @Test
    public void everyNameEscapesTheSameWay() throws Exception {
        Set<String> names = new LinkedHashSet<>();
        names.addAll(staticSet(JavaIdentifiers.class, "KEYWORDS"));
        names.addAll(staticSet(JavaIdentifiers.class, "OBJECT_NO_ARG_METHODS"));
        names.addAll(List.of("equals", "var", "record", "yield", "name", "notify_", "Class", ""));
        for (String n : names) {
            assertEquals("isReserved(" + n + ")",
                    JavaIdentifiers.isIllegalMemberName(n), RecordComponentNames.isReserved(n));
            assertEquals("escape(" + n + ")",
                    JavaIdentifiers.escapeMember(n), RecordComponentNames.escape(n));
        }
    }
}

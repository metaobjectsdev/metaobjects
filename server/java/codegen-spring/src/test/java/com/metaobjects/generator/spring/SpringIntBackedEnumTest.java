package com.metaobjects.generator.spring;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import javax.tools.JavaCompiler;
import javax.tools.ToolProvider;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.Assert.*;

/**
 * An int-backed {@code field.enum} ({@code @intValueMap}) generates its declared mapping
 * (adopter estate finding F24). The Java port emitted the enum's symbols and nothing else, so
 * a hand-written repository had to restate a map the metadata declares — and the obvious
 * {@code ordinal()} version is wrong: ordinals are 0,1,2 while the declared map is 0,5,9.
 */
public class SpringIntBackedEnumTest {

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    private static Map<String, Integer> declared() {
        Map<String, Integer> m = new LinkedHashMap<>();
        m.put("DRAFT", 0);
        m.put("PUBLISHED", 5);
        m.put("ARCHIVED", 9);
        return m;
    }

    @Test
    public void aStringBackedEnumIsUnchanged() {
        assertEquals("public enum Level { LOW, HIGH }",
            SpringTypeMapper.enumDeclaration("Level", List.of("LOW", "HIGH"), null));
    }

    @Test
    public void anIntBackedEnumMapsBothWaysAndRefusesAnUnmappedValue() throws Exception {
        String decl = SpringTypeMapper.enumDeclaration(
            "Status", List.of("DRAFT", "PUBLISHED", "ARCHIVED"), declared());
        Path src = tmp.newFolder("src").toPath();
        Path out = tmp.newFolder("out").toPath();
        Path file = src.resolve("Status.java");
        Files.writeString(file, decl + "\n");
        JavaCompiler javac = ToolProvider.getSystemJavaCompiler();
        assertEquals("generated enum must compile", 0,
            javac.run(null, null, null, "-d", out.toString(), file.toString()));

        try (URLClassLoader cl = new URLClassLoader(new URL[]{ out.toUri().toURL() }, null)) {
            Class<?> status = cl.loadClass("Status");
            Method fromDb = status.getMethod("fromDbValue", int.class);
            Method dbValue = status.getMethod("dbValue");
            Object published = fromDb.invoke(null, 5);
            assertEquals("PUBLISHED", ((Enum<?>) published).name());
            Object archived = Enum.valueOf(status.asSubclass(Enum.class), "ARCHIVED");
            assertEquals("the DECLARED value, not the ordinal", 9, dbValue.invoke(archived));
            try {
                fromDb.invoke(null, 1);
                fail("an unmapped stored value must throw");
            } catch (InvocationTargetException e) {
                assertTrue(e.getCause() instanceof IllegalArgumentException);
                assertTrue(e.getCause().getMessage().contains("unmapped stored value 1"));
            }
        }
    }
}

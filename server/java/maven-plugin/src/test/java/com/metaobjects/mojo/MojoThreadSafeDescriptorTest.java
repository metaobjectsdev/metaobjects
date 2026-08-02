package com.metaobjects.mojo;

import org.junit.Test;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

/**
 * #233 — the reactor-bound mojos (generate/verify/docs) must declare
 * {@code threadSafe = true} now that the shared-state deadlock is fixed.
 *
 * <p>{@code @Mojo} is {@link java.lang.annotation.RetentionPolicy#CLASS}, so it is not
 * reflectable at runtime; this reads the generated plugin descriptor
 * ({@code META-INF/maven/plugin.xml}, produced by maven-plugin-plugin at
 * {@code process-classes}, i.e. before tests run) off the classpath.</p>
 */
public class MojoThreadSafeDescriptorTest {

    private static String descriptor() throws Exception {
        try (InputStream in = MojoThreadSafeDescriptorTest.class.getClassLoader()
                .getResourceAsStream("META-INF/maven/plugin.xml")) {
            assertNotNull("plugin.xml descriptor must be generated before tests run", in);
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        }
    }

    private static void assertThreadSafe(String xml, String goal) {
        // Isolate the <mojo> block whose <goal> is this goal, then assert threadSafe.
        Matcher m = Pattern.compile("<mojo>(?:(?!</mojo>).)*?<goal>" + goal
                + "</goal>(?:(?!</mojo>).)*?</mojo>", Pattern.DOTALL).matcher(xml);
        assertTrue("no <mojo> block for goal '" + goal + "'", m.find());
        assertTrue("goal '" + goal + "' must declare <threadSafe>true</threadSafe>",
                m.group().contains("<threadSafe>true</threadSafe>"));
    }

    @Test
    public void generateVerifyDocsAreThreadSafe() throws Exception {
        String xml = descriptor();
        assertThreadSafe(xml, "generate");
        assertThreadSafe(xml, "verify");
        assertThreadSafe(xml, "docs");
    }
}

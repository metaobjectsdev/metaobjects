package com.metaobjects.generator.direct.metadata;

import com.metaobjects.generator.GeneratorTestBase;
import com.metaobjects.generator.direct.metadata.ai.MetaDataAIDocumentationWriter;
import com.metaobjects.generator.direct.metadata.html.MetaDataHtmlDocumentationWriter;
import org.junit.Test;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.TimeZone;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;

/**
 * Adopter report G10, in the documentation writers: output generated twice from the same
 * registry must be byte-identical, so regenerating an unchanged model rewrites no file. Both
 * writers stamped the time of the run: the HTML header carried
 * {@code Generated <yyyy-MM-dd HH:mm>} and the AI JSON a {@code generationTimestamp} in epoch
 * milliseconds.
 *
 * <p>The two runs must differ by more than each stamp's resolution. A pause covers the
 * millisecond one. The HTML one read the local wall clock to the minute, so the second run
 * moves the JVM's default zone by five and a half hours instead of waiting out a minute: the
 * local time that stamp rendered changes in both its hour and its minute.
 */
public class DocumentationOutputIsStableTest extends GeneratorTestBase {

    private interface Generation {
        byte[] run() throws Exception;
    }

    private static byte[][] twiceAcrossAClockChange(Generation generation) throws Exception {
        TimeZone original = TimeZone.getDefault();
        try {
            TimeZone.setDefault(TimeZone.getTimeZone("UTC"));
            byte[] first = generation.run();
            Thread.sleep(50);
            TimeZone.setDefault(TimeZone.getTimeZone("Asia/Kolkata"));
            return new byte[][] { first, generation.run() };
        } finally {
            TimeZone.setDefault(original);
        }
    }

    private byte[] html() throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        MetaDataHtmlDocumentationWriter writer = new MetaDataHtmlDocumentationWriter(getSharedLoader(), out)
                .withTitle("Stable Documentation")
                .withVersion("1.2.3")
                .withInheritance(true)
                .withExamples(true)
                .withExtensionGuide(true);
        writer.writeHtml();
        writer.close();
        return out.toByteArray();
    }

    private static byte[] aiJson() throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        MetaDataAIDocumentationWriter writer = new MetaDataAIDocumentationWriter(null, out);
        writer.withVersion("1.2.3")
              .withInheritance(true)
              .withImplementationDetails(true)
              .withExtensionGuidance(true)
              .withCrossLanguageInfo(true);
        writer.writeJson();
        writer.close();
        return out.toByteArray();
    }

    private static String text(byte[] bytes) {
        return new String(bytes, StandardCharsets.UTF_8);
    }

    @Test
    public void htmlDocumentationIsIdenticalAcrossRuns() throws Exception {
        byte[][] runs = twiceAcrossAClockChange(this::html);
        assertFalse("the writer wrote nothing", runs[0].length == 0);
        assertEquals(text(runs[0]), text(runs[1]));
    }

    @Test
    public void aiDocumentationIsIdenticalAcrossRuns() throws Exception {
        byte[][] runs = twiceAcrossAClockChange(DocumentationOutputIsStableTest::aiJson);
        assertFalse("the writer wrote nothing", runs[0].length == 0);
        assertEquals(text(runs[0]), text(runs[1]));
    }
}

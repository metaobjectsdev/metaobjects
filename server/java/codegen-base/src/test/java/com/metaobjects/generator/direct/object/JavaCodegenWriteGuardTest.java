package com.metaobjects.generator.direct.object;

import com.metaobjects.generator.direct.object.javacode.ExtractorCodeGenerator;
import com.metaobjects.generator.direct.object.javacode.JavaObjectCodeGenerator;
import com.metaobjects.loader.InMemoryStringSource;
import com.metaobjects.loader.LoaderOptions;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.registry.ObjectClassRegistry;
import org.junit.After;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

/**
 * The marker floor for the two Java emitters that were still writing raw.
 *
 * <p>{@code docs/features/own-your-codegen.md} claims that on Java and Kotlin "every
 * generator writes through one guard that refuses any existing file carrying no
 * {@code GENERATED} marker". The Kotlin half of that was false for six KotlinPoet sites;
 * the JAVA half was false for these two, which build their source as a {@code StringBuilder}
 * — complete with a {@code GENERATED} header — and then wrote it with a raw
 * {@code Files.write}, an unconditional overwrite.
 *
 * <p>Both emit the marker already, so guarding them is safe: their own output stays
 * overwritable and only a file somebody took ownership of is refused.
 *
 * <p>Deliberately NOT covered here, because they cannot carry a marker and guarding them
 * would freeze them after the first run: the {@code META-INF/services} registration (its
 * whole content is a provider FQN), {@code TemplateScopeGenerator}, {@code DocsMojo}, and
 * {@code MustacheTemplateGenerator}. See {@code GeneratedFileWriter}'s class javadoc.
 */
public class JavaCodegenWriteGuardTest {

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    @After
    public void resetRegistry() {
        ObjectClassRegistry.resetGlobal();
    }

    /** The guard's own header shape — the documented ownership gesture is deleting this line. */
    private static final Pattern MARKER_LINE =
        Pattern.compile("^[ \\t]*(?://+|/\\*+|\\*+)[ \\t]*GENERATED\\b");

    private static String stripMarkerLines(String src) {
        return src.lines()
            .filter(line -> !MARKER_LINE.matcher(line).find())
            .collect(Collectors.joining("\n"));
    }

    // === ExtractorCodeGenerator ============================================

    private Path emitExtractor(Path outDir) throws Exception {
        new ExtractorCodeGenerator()
            .emit(outDir.toFile(), "acme.demo", "Answer", "acme::demo::Answer");
        return outDir.resolve("acme/demo/AnswerExtractor.java");
    }

    @Test
    public void extractorMarksItsOutputSoASecondRunRewritesIt() throws Exception {
        // Guards the freeze: if the emitted content lacked the marker, guarding it would make
        // the first run write and every run after refuse, silently and with a green build.
        Path out = tmp.newFolder("ext-rewrite").toPath();
        Path file = emitExtractor(out);
        String generated = Files.readString(file);

        Files.writeString(file, generated + "\n// stale line from an earlier run\n");
        emitExtractor(out);

        assertEquals("a second run must overwrite this toolchain's own output",
            generated, Files.readString(file));
    }

    @Test
    public void extractorRefusesAFileWhoseMarkerWasDeleted() throws Exception {
        Path out = tmp.newFolder("ext-owned").toPath();
        Path file = emitExtractor(out);
        String generated = Files.readString(file);

        String owned = stripMarkerLines(generated) + "\n// hand-owned — do not regenerate\n";
        assertTrue("fixture bug — nothing was stripped", !owned.equals(generated));
        Files.writeString(file, owned);

        emitExtractor(out);
        assertEquals("deleting the marker must take ownership permanently",
            owned, Files.readString(file));
    }

    @Test
    public void extractorNeverClobbersAHandWrittenFile() throws Exception {
        Path out = tmp.newFolder("ext-handwritten").toPath();
        Path file = out.resolve("acme/demo/AnswerExtractor.java");
        Files.createDirectories(file.getParent());
        String mine = "package acme.demo;\n\n// written by hand, never generated\npublic final class AnswerExtractor {}\n";
        Files.writeString(file, mine);

        emitExtractor(out);
        assertEquals("a marker-less file at a generated path must be left untouched",
            mine, Files.readString(file));
    }

    // === JavaObjectCodeGenerator's binding provider =========================

    private static final String META = "{ \"metadata.root\": {"
        + "  \"package\": \"acme::payload\","
        + "  \"children\": ["
        + "    { \"object.value\": { \"name\": \"Answer\", \"children\": ["
        + "      { \"field.string\": { \"name\": \"title\" } }"
        + "    ]}}"
        + "  ]"
        + "}}";

    private MetaDataLoader loadMeta() {
        MetaDataLoader loader = new MetaDataLoader(
            LoaderOptions.create(false, false, true),
            MetaDataLoader.SUBTYPE_MANUAL, "write-guard");
        loader.init();
        loader.load(List.of(new InMemoryStringSource(META, "write-guard/meta.json")));
        return loader;
    }

    private Path emitProvider(Path outDir) {
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", outDir.toString());
        args.put("type", "class");
        args.put("flavor", "pojoAware");

        JavaObjectCodeGenerator generator = new JavaObjectCodeGenerator();
        generator.setArgs(args);
        generator.execute(loadMeta());
        return outDir.resolve("com/metaobjects/generated/GeneratedObjectClassBindingProvider.java");
    }

    @Test
    public void bindingProviderMarksItsOutputSoASecondRunRewritesIt() throws Exception {
        Path out = tmp.newFolder("prov-rewrite").toPath();
        Path file = emitProvider(out);
        assertTrue("expected a generated provider at " + file, Files.exists(file));
        String generated = Files.readString(file);

        Files.writeString(file, generated + "\n// stale line from an earlier run\n");
        emitProvider(out);

        assertEquals("a second run must overwrite this toolchain's own output",
            generated, Files.readString(file));
    }

    @Test
    public void bindingProviderRefusesAFileWhoseMarkerWasDeleted() throws Exception {
        Path out = tmp.newFolder("prov-owned").toPath();
        Path file = emitProvider(out);
        String generated = Files.readString(file);

        String owned = stripMarkerLines(generated) + "\n// hand-owned — do not regenerate\n";
        assertTrue("fixture bug — nothing was stripped", !owned.equals(generated));
        Files.writeString(file, owned);

        emitProvider(out);
        assertEquals("deleting the marker must take ownership permanently",
            owned, Files.readString(file));
    }

    @Test
    public void bindingProviderNeverClobbersAHandWrittenFile() throws Exception {
        Path out = tmp.newFolder("prov-handwritten").toPath();
        Path file = out.resolve("com/metaobjects/generated/GeneratedObjectClassBindingProvider.java");
        Files.createDirectories(file.getParent());
        String mine = "package com.metaobjects.generated;\n\n// my own provider\npublic final class GeneratedObjectClassBindingProvider {}\n";
        Files.writeString(file, mine);

        emitProvider(out);
        assertEquals("a marker-less file at a generated path must be left untouched",
            mine, Files.readString(file));
    }
}

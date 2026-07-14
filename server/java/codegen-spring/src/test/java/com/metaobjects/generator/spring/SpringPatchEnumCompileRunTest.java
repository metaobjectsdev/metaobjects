package com.metaobjects.generator.spring;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.metaobjects.loader.MetaDataLoader;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import javax.tools.DiagnosticCollector;
import javax.tools.JavaCompiler;
import javax.tools.JavaFileObject;
import javax.tools.ToolProvider;

import java.io.File;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

/**
 * FR-035: gate the generated {@code <Entity>Patch}'s handling of an INLINE
 * {@code field.enum}. The enum is declared NESTED in the {@code <Entity>Dto}
 * record body, so the sibling {@code <Entity>Patch} must reference it as
 * {@code <Entity>Dto.<EnumName>} — an unqualified name would not compile. This
 * test generates the DTO + Patch for a Widget entity carrying an inline enum,
 * compiles them TOGETHER (which convicts a mis-qualified enum type in the Patch's
 * accessor + {@code TypeReference}), then binds a patch body carrying the enum
 * value through the compiled {@code fromJson} and reads it back.
 */
public class SpringPatchEnumCompileRunTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String PKG = "acme.widget";

    private static final String META = """
        { "metadata.root": { "package": "acme::widget", "children": [
          { "object.entity": { "name": "Widget", "children": [
            { "source.rdb":    { "@table": "widgets" } },
            { "field.long":    { "name": "id" } },
            { "field.string":  { "name": "name", "@required": true } },
            { "field.enum":    { "name": "status", "@values": ["ACTIVE", "INACTIVE"] } },
            { "identity.primary": { "name": "id", "@fields": "id", "@generation": "increment" } }
          ]}}
        ]}}
        """;

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    @Test
    public void generatedPatchQualifiesInlineEnumAndBinds() throws Exception {
        Path srcDir = tmp.newFolder("src").toPath();
        Path classesDir = tmp.newFolder("classes").toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(
            tmp.newFolder("fx").toPath(), "widget", META);

        // SpringDtoGenerator emits BOTH WidgetDto (with the nested enum) and WidgetPatch.
        runGenerator(new SpringDtoGenerator(), loader, srcDir);
        compile(srcDir, classesDir);

        // Bind a patch body that sets the inline-enum field, and read it back through the
        // compiled fromJson + accessor — proving the WidgetDto.<Enum> type resolves at runtime.
        try (URLClassLoader cl = new URLClassLoader(
                new URL[]{ classesDir.toUri().toURL() }, getClass().getClassLoader())) {
            Class<?> patchClass = cl.loadClass(PKG + ".WidgetPatch");
            JsonNode body = MAPPER.readTree("{\"status\":\"ACTIVE\"}");
            Object patch = patchClass.getMethod("fromJson", JsonNode.class, ObjectMapper.class)
                .invoke(null, body, MAPPER);
            assertEquals("status present", Boolean.TRUE, patchClass.getMethod("hasStatus").invoke(patch));
            Object status = patchClass.getMethod("status").invoke(patch);
            assertNotNull("status bound to the enum", status);
            assertEquals("ACTIVE", status.toString());
            assertTrue("status is a WidgetDto-nested enum", status.getClass().isEnum());
            // An omitted field is untouched.
            assertEquals("name omitted", Boolean.FALSE, patchClass.getMethod("hasName").invoke(patch));
        }
    }

    private static void runGenerator(Object generator, MetaDataLoader loader, Path outDir) {
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", outDir.toString());
        ((com.metaobjects.generator.direct.MultiFileDirectGeneratorBase<?>) generator).setArgs(args);
        ((com.metaobjects.generator.direct.MultiFileDirectGeneratorBase<?>) generator).execute(loader);
    }

    private static void compile(Path srcDir, Path classesDir) throws Exception {
        List<File> sources;
        try (Stream<Path> s = Files.walk(srcDir)) {
            sources = s.filter(p -> p.toString().endsWith(".java")).map(Path::toFile)
                       .collect(Collectors.toList());
        }
        assertTrue("expected generated .java sources", !sources.isEmpty());
        JavaCompiler javac = ToolProvider.getSystemJavaCompiler();
        assertNotNull("JDK required — getSystemJavaCompiler() returned null", javac);
        String cp = System.getProperty("java.class.path");
        DiagnosticCollector<JavaFileObject> diags = new DiagnosticCollector<>();
        var fm = javac.getStandardFileManager(diags, null, StandardCharsets.UTF_8);
        List<String> opts = List.of("-classpath", cp, "-d", classesDir.toString());
        boolean ok = javac.getTask(null, fm, diags, opts, null,
            fm.getJavaFileObjectsFromFiles(sources)).call();
        if (!ok) {
            StringBuilder sb = new StringBuilder("generated sources failed to compile:\n");
            for (var d : diags.getDiagnostics()) {
                sb.append("  ").append(d.getKind()).append(": ").append(d.getMessage(null)).append('\n');
            }
            fail(sb.toString());
        }
    }
}

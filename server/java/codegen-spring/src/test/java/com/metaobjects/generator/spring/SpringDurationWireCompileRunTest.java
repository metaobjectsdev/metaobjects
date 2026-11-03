package com.metaobjects.generator.spring;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.metaobjects.config.WireFormat;
import com.metaobjects.loader.MetaDataLoader;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import javax.tools.DiagnosticCollector;
import javax.tools.JavaCompiler;
import javax.tools.JavaFileObject;
import javax.tools.ToolProvider;

import java.io.File;
import java.lang.reflect.InvocationTargetException;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

/**
 * {@code field.duration}, end to end over GENERATED code: the DTO, the value-object record and the
 * Patch type a duration as {@code java.time.Duration}, write the canonical ISO-8601 string and read
 * the accepted form only — whatever the host ObjectMapper's JavaTimeModule would do — and the
 * allowlist gives a duration the identity-comparison band (eq/ne/in/isNull).
 */
public class SpringDurationWireCompileRunTest {

    private static final String PKG = "acme.ops";

    private static final String META = """
        { "metadata.root": { "package": "acme::ops", "children": [
          { "object.value": { "name": "Window", "children": [
            { "field.duration": { "name": "span", "@required": true } }
          ]}},
          { "object.entity": { "name": "Job", "children": [
            { "source.rdb":     { "@table": "jobs" } },
            { "field.long":     { "name": "id" } },
            { "field.duration": { "name": "holdFor", "@required": true, "@filterable": true } },
            { "field.duration": { "name": "retries", "isArray": true } },
            { "field.decimal":  { "name": "cost", "@precision": 12, "@scale": 2 } },
            { "field.object":   { "name": "window", "@objectRef": "Window", "@storage": "jsonb" } },
            { "identity.primary": { "name": "id", "@fields": "id", "@generation": "increment" } }
          ]}}
        ]}}
        """;

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    @Test
    public void canonicalStringWireUnderBothDecimalModes() throws Exception {
        for (WireFormat.Decimals decimals : WireFormat.Decimals.values()) {
            run(decimals, new ObjectMapper());
            run(decimals, new ObjectMapper().findAndRegisterModules()); // a host mapper (JavaTimeModule when present)
        }
    }

    private void run(WireFormat.Decimals decimals, ObjectMapper mapper) throws Exception {
        Path srcDir = tmp.newFolder().toPath();
        Path classesDir = tmp.newFolder().toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(tmp.newFolder().toPath(), "ops", META);
        loader.getRoot().setWireFormat(new WireFormat(decimals, WireFormat.NullMembers.OMIT));
        runGenerator(new SpringDtoGenerator(), loader, srcDir);
        runGenerator(new SpringValueObjectGenerator(), loader, srcDir);
        runGenerator(new SpringFilterAllowlistGenerator(), loader, srcDir);
        compile(srcDir, classesDir);

        String dtoSrc = Files.readString(srcDir.resolve("acme/ops/JobDto.java"));
        assertTrue(dtoSrc, dtoSrc.contains("@JsonSerialize(using = CanonicalDurationSerializer.class) "
            + "@JsonDeserialize(using = CanonicalDurationDeserializer.class) java.time.Duration holdFor"));
        assertTrue(dtoSrc, dtoSrc.contains("@JsonSerialize(contentUsing = CanonicalDurationSerializer.class)"));

        try (URLClassLoader cl = new URLClassLoader(
                new URL[]{ classesDir.toUri().toURL() }, getClass().getClassLoader())) {
            Class<?> dto = cl.loadClass(PKG + ".JobDto");

            // Read the accepted form, write the canonical one (a negative span keeps ONE sign;
            // Duration.toString() would write PT-1M-30S).
            Object job = mapper.readValue(
                "{\"holdFor\":\"-PT90S\",\"retries\":[\"P1D\",\"PT0.5S\"],\"window\":{\"span\":\"PT5400S\"}}", dto);
            assertEquals(Duration.ofSeconds(-90), dto.getMethod("holdFor").invoke(job));
            JsonNode out = mapper.valueToTree(job);
            assertEquals("-PT1M30S", out.get("holdFor").asText());
            assertEquals("PT24H", out.get("retries").get(0).asText());
            assertEquals("PT0.5S", out.get("retries").get(1).asText());
            assertEquals("PT1H30M", out.get("window").get("span").asText());

            // Refused at bind (Spring maps it to 400): calendar spans, a clock, a number of seconds,
            // and the looser forms Duration.parse itself takes.
            for (String bad : new String[]{"\"P1M\"", "\"1:30:00\"", "5400", "\"pt1h\"", "\"PT1.5H\"", "\"PT-1H\""}) {
                try {
                    mapper.readValue("{\"holdFor\":" + bad + "}", dto);
                    fail("must refuse " + bad);
                } catch (com.fasterxml.jackson.core.JsonProcessingException expected) {
                    // refused
                }
                try {
                    mapper.readValue("{\"window\":{\"span\":" + bad + "}}", dto);
                    fail("a value object must refuse " + bad);
                } catch (com.fasterxml.jackson.core.JsonProcessingException expected) {
                    // refused
                }
            }

            // The Patch binds the same strict rule, scalar and per array element.
            Class<?> patch = cl.loadClass(PKG + ".JobPatch");
            java.lang.reflect.Method fromJson = patch.getMethod("fromJson", JsonNode.class, ObjectMapper.class);
            Object p = fromJson.invoke(null, mapper.readTree("{\"holdFor\":\"P1DT2H\",\"retries\":[\"PT1S\"]}"), mapper);
            assertEquals(Duration.ofHours(26), patch.getMethod("holdFor").invoke(p));
            assertEquals(List.of(Duration.ofSeconds(1)), patch.getMethod("retries").invoke(p));
            for (String bad : new String[]{"{\"holdFor\":\"P1W\"}", "{\"holdFor\":90}", "{\"holdFor\":null}",
                    "{\"retries\":[\"P1Y\"]}", "{\"retries\":[null]}", "{\"retries\":\"PT1S\"}"}) {
                try {
                    fromJson.invoke(null, mapper.readTree(bad), mapper);
                    fail("a Patch must refuse " + bad);
                } catch (InvocationTargetException e) {
                    assertEquals(bad, "PatchValidationException", e.getCause().getClass().getSimpleName());
                }
            }

            // The filter band: identity comparison only (a text column cannot order ISO strings).
            Class<?> allow = cl.loadClass(PKG + ".JobFilterAllowlist");
            @SuppressWarnings("unchecked")
            Map<String, Set<String>> ops = (Map<String, Set<String>>) allow.getField("OPS_BY_FIELD").get(null);
            assertEquals(Set.of("eq", "ne", "in", "isNull"), ops.get("holdFor"));
            assertFalse(ops.get("holdFor").contains("gt"));
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
        List<String> opts = List.of("-classpath", cp, "-parameters", "-d", classesDir.toString());
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

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
import java.math.BigDecimal;
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
 * ADR-0019 Amendment 1 (decimal wire rule), end to end over GENERATED code: the DTO writes a
 * decimal as the W1 canonical string and reads W2 strictly, the Patch refuses a malformed
 * decimal, the value-object record carries the same binding, and the allowlist names its
 * decimal fields so the filter parser compares operands exactly.
 */
public class SpringDecimalWireCompileRunTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String PKG = "acme.ledger";

    private static final String META = """
        { "metadata.root": { "package": "acme::ledger", "children": [
          { "object.value": { "name": "Price", "children": [
            { "field.decimal": { "name": "net", "@precision": 12, "@scale": 2 } }
          ]}},
          { "object.value": { "name": "Tier", "children": [
            { "field.decimal": { "name": "amount", "@precision": 12, "@scale": 4 } }
          ]}},
          { "object.value": { "name": "Pricing", "children": [
            { "field.map": { "name": "tiers", "@objectRef": "Tier" } }
          ]}},
          { "object.entity": { "name": "Entry", "children": [
            { "source.rdb":    { "@table": "entries" } },
            { "field.long":    { "name": "id" } },
            { "field.decimal": { "name": "amount", "@precision": 20, "@scale": 10, "@filterable": true } },
            { "field.string":  { "name": "label", "@filterable": true } },
            { "field.decimal": { "name": "tiers", "isArray": true, "@precision": 12, "@scale": 2 } },
            { "field.object":  { "name": "price", "@objectRef": "Price", "@storage": "jsonb" } },
            { "field.map":     { "name": "tierMap", "@objectRef": "Tier", "@storage": "jsonb" } },
            { "field.object":  { "name": "pricing", "@objectRef": "Pricing", "@storage": "jsonb" } },
            { "field.object":  { "name": "prices", "@objectRef": "Price", "isArray": true, "@storage": "jsonb" } },
            { "identity.primary": { "name": "id", "@fields": "id", "@generation": "increment" } }
          ]}}
        ]}}
        """;

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    @Test
    public void generatedDtoPatchAndAllowlistFollowTheDecimalWireRule() throws Exception {
        Path srcDir = tmp.newFolder("src").toPath();
        Path classesDir = tmp.newFolder("classes").toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(tmp.newFolder("fx").toPath(), "ledger", META);
        runGenerator(new SpringDtoGenerator(), loader, srcDir);
        runGenerator(new SpringValueObjectGenerator(), loader, srcDir);
        runGenerator(new SpringFilterAllowlistGenerator(), loader, srcDir);
        compile(srcDir, classesDir);

        String dtoSrc = Files.readString(srcDir.resolve("acme/ledger/EntryDto.java"));
        assertTrue(dtoSrc, dtoSrc.contains("@JsonSerialize(using = CanonicalDecimalSerializer.class)"));

        try (URLClassLoader cl = new URLClassLoader(
                new URL[]{ classesDir.toUri().toURL() }, getClass().getClassLoader())) {
            // W1: the DTO writes the canonical string, whatever scale the engine returned.
            Class<?> dto = cl.loadClass(PKG + ".EntryDto");
            Object entry = dto.getMethod("builder").invoke(null);
            entry = entry.getClass().getMethod("amount", java.math.BigDecimal.class)
                .invoke(entry, new BigDecimal("12345678901234567.8900000000"));
            Object built = entry.getClass().getMethod("build").invoke(entry);
            JsonNode written = MAPPER.valueToTree(built);
            assertEquals("12345678901234567.89", written.get("amount").asText());
            assertTrue("a string, never a number", written.get("amount").isTextual());

            // W2: a string or a number reads exactly; garbage is refused.
            Object read = MAPPER.readValue("{\"amount\":\"1e-7\"}", dto);
            assertEquals(0, new BigDecimal("0.0000001").compareTo(
                (BigDecimal) dto.getMethod("amount").invoke(read)));
            try {
                MAPPER.readValue("{\"amount\":\"\"}", dto);
                fail("an empty string must be refused, not coerced to null");
            } catch (com.fasterxml.jackson.core.JsonProcessingException expected) {
                // Spring maps this to 400
            }

            // The Patch refuses a malformed decimal and binds a number exactly.
            Class<?> patchClass = cl.loadClass(PKG + ".EntryPatch");
            Object patch = patchClass.getMethod("fromJson", JsonNode.class, ObjectMapper.class)
                .invoke(null, MAPPER.readTree("{\"amount\":0.1}"), MAPPER);
            assertEquals(0, new BigDecimal("0.1").compareTo((BigDecimal) patchClass.getMethod("amount").invoke(patch)));
            try {
                patchClass.getMethod("fromJson", JsonNode.class, ObjectMapper.class)
                    .invoke(null, MAPPER.readTree("{\"amount\":\"NaN\"}"), MAPPER);
                fail("NaN must be refused");
            } catch (java.lang.reflect.InvocationTargetException e) {
                assertEquals("PatchValidationException", e.getCause().getClass().getSimpleName());
            }

            // A decimal ARRAY in a Patch gets the same strict rule per element.
            Object tiers = patchClass.getMethod("fromJson", JsonNode.class, ObjectMapper.class)
                .invoke(null, MAPPER.readTree("{\"tiers\":[\"1.50\",2]}"), MAPPER);
            @SuppressWarnings("unchecked")
            java.util.List<BigDecimal> bound = (java.util.List<BigDecimal>) patchClass.getMethod("tiers").invoke(tiers);
            assertEquals(2, bound.size());
            assertEquals(0, new BigDecimal("1.5").compareTo(bound.get(0)));
            for (String bad : new String[]{"{\"tiers\":[\"NaN\"]}", "{\"tiers\":[\"\"]}",
                    "{\"tiers\":[null]}", "{\"tiers\":\"1\"}"}) {
                try {
                    patchClass.getMethod("fromJson", JsonNode.class, ObjectMapper.class)
                        .invoke(null, MAPPER.readTree(bad), MAPPER);
                    fail("a malformed decimal array must be refused: " + bad);
                } catch (java.lang.reflect.InvocationTargetException e) {
                    assertEquals("PatchValidationException", e.getCause().getClass().getSimpleName());
                }
            }

            // The value object carries the same binding.
            Class<?> price = cl.loadClass(PKG + ".Price");
            Object p = MAPPER.readValue("{\"net\":\"9.50\"}", price);
            assertEquals("9.5", MAPPER.valueToTree(p).get("net").asText());

            // C1: a decimal inside a jsonb value object follows the top-level rule: a string or a
            // JSON number read exactly, canonical string out, range-checked against the VO field's
            // own @precision/@scale with nothing rounded.
            Object num = MAPPER.readValue("{\"net\":1234567890.12}", price);
            assertEquals("1234567890.12", MAPPER.valueToTree(num).get("net").asText());
            Object canon = MAPPER.readValue("{\"net\":\"1.5000\"}", price);
            assertEquals("1.5", MAPPER.valueToTree(canon).get("net").asText());
            for (String bad : new String[]{"{\"net\":\"1.234\"}", "{\"net\":1.234}",
                    "{\"net\":\"12345678901\"}", "{\"net\":\"NaN\"}", "{\"net\":\"\"}"}) {
                try {
                    MAPPER.readValue(bad, price);
                    fail("a value outside the VO field's declared range must be refused: " + bad);
                } catch (com.fasterxml.jackson.core.JsonProcessingException expected) {
                    // Spring maps this to 400 validation
                }
            }
            // The same through the entity's single and array-of-VO jsonb members.
            Object withVo = MAPPER.readValue(
                "{\"price\":{\"net\":\"2.50\"},\"prices\":[{\"net\":3},{\"net\":\"4.10\"}]}", dto);
            JsonNode voOut = MAPPER.valueToTree(withVo);
            assertEquals("2.5", voOut.get("price").get("net").asText());
            assertEquals("3", voOut.get("prices").get(0).get("net").asText());
            assertEquals("4.1", voOut.get("prices").get(1).get("net").asText());
            try {
                MAPPER.readValue("{\"prices\":[{\"net\":\"1.001\"}]}", dto);
                fail("an excess-scale decimal inside an array-of-VO element must be refused");
            } catch (com.fasterxml.jackson.core.JsonProcessingException expected) {
                // Spring maps this to 400 validation
            }
            // The PATCH path binds the VO through the same record.
            try {
                patchClass.getMethod("fromJson", JsonNode.class, ObjectMapper.class)
                    .invoke(null, MAPPER.readTree("{\"price\":{\"net\":\"1.001\"}}"), MAPPER);
                fail("a PATCH VO with an excess-scale decimal must be refused");
            } catch (java.lang.reflect.InvocationTargetException e) {
                assertEquals("PatchValidationException", e.getCause().getClass().getSimpleName());
            }

            // C1 on a field.map of value objects: the rule applies to EACH map value; a key named
            // "amount" is just a key (never matched with Tier's member), at top level and nested.
            JsonNode mapOut = MAPPER.valueToTree(MAPPER.readValue(
                "{\"tierMap\":{\"amount\":{\"amount\":\"1.5000\"},\"gold\":{\"amount\":2.50}},"
                + "\"pricing\":{\"tiers\":{\"amount\":{\"amount\":100},\"silver\":{\"amount\":\"0.25\"}}}}", dto));
            assertEquals("1.5", mapOut.get("tierMap").get("amount").get("amount").asText());
            assertEquals("2.5", mapOut.get("tierMap").get("gold").get("amount").asText());
            assertEquals("100", mapOut.get("pricing").get("tiers").get("amount").get("amount").asText());
            assertEquals("0.25", mapOut.get("pricing").get("tiers").get("silver").get("amount").asText());
            for (String bad : new String[]{"{\"tierMap\":{\"gold\":{\"amount\":\"0.12345\"}}}",
                    "{\"tierMap\":{\"amount\":{\"amount\":0.12345}}}",
                    "{\"pricing\":{\"tiers\":{\"amount\":{\"amount\":\"0.12345\"}}}}"}) {
                try {
                    MAPPER.readValue(bad, dto);
                    fail("an excess-scale decimal inside a map value must be refused: " + bad);
                } catch (com.fasterxml.jackson.core.JsonProcessingException expected) {
                    // Spring maps this to 400 validation
                }
            }
            for (String bad : new String[]{"{\"tierMap\":{\"gold\":{\"amount\":\"0.12345\"}}}",
                    "{\"pricing\":{\"tiers\":{\"amount\":{\"amount\":\"0.12345\"}}}}"}) {
                try {
                    patchClass.getMethod("fromJson", JsonNode.class, ObjectMapper.class)
                        .invoke(null, MAPPER.readTree(bad), MAPPER);
                    fail("a PATCH map value with an excess-scale decimal must be refused: " + bad);
                } catch (java.lang.reflect.InvocationTargetException e) {
                    assertEquals("PatchValidationException", e.getCause().getClass().getSimpleName());
                }
            }

            // The allowlist names its decimal fields.
            Class<?> allow = cl.loadClass(PKG + ".EntryFilterAllowlist");
            assertEquals(java.util.Set.of("amount"), allow.getField("DECIMAL_FIELDS").get(null));
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

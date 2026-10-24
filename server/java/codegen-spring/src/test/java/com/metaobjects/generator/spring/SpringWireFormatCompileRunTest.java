package com.metaobjects.generator.spring;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.metaobjects.config.WireFormat;
import com.metaobjects.loader.MetaDataLoader;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.math.BigDecimal;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

/**
 * ADR-0019 Amendment 2, end to end over GENERATED code: the {@code wire} setting chooses the
 * OUTPUT form. The default (native) is Jackson's own behaviour as the host ObjectMapper
 * configures it (Spring Boot's default mapper writes a BigDecimal with {@code toString()}, so a
 * scale-2 value is {@code 12.50} and a tiny value is {@code 1E-7}); {@code decimals: string}
 * writes the W1 canonical string; {@code nullMembers: omit} leaves a value object's null member
 * out and {@code emit} writes it as {@code null}. The input rules (W2/W3) hold in every mode.
 */
public class SpringWireFormatCompileRunTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String PKG = "acme.wire";

    private static final String META = """
        { "metadata.root": { "package": "acme::wire", "children": [
          { "object.value": { "name": "Price", "children": [
            { "field.decimal": { "name": "net", "@precision": 12, "@scale": 2 } },
            { "field.string":  { "name": "note" } }
          ]}},
          { "object.entity": { "name": "Item", "children": [
            { "source.rdb":    { "@table": "items" } },
            { "field.long":    { "name": "id" } },
            { "field.decimal": { "name": "amount", "@precision": 20, "@scale": 10 } },
            { "field.decimal": { "name": "tiers", "isArray": true, "@precision": 12, "@scale": 2 } },
            { "field.object":  { "name": "price", "@objectRef": "Price", "@storage": "jsonb" } },
            { "identity.primary": { "name": "id", "@fields": "id", "@generation": "increment" } }
          ]}}
        ]}}
        """;

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    private interface Check { void run(Path srcDir, ClassLoader cl) throws Exception; }

    private void generate(WireFormat wire, Check check) throws Exception {
        Path srcDir = tmp.newFolder().toPath();
        Path classesDir = tmp.newFolder().toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(tmp.newFolder().toPath(), "wire", META);
        if (wire != null) loader.getRoot().setWireFormat(wire);
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", srcDir.toString());
        for (var g : List.of(new SpringDtoGenerator(), new SpringValueObjectGenerator())) {
            g.setArgs(args);
            g.execute(loader);
        }
        SpringTestFixtures.compileGenerated(srcDir, classesDir);
        try (URLClassLoader cl = new URLClassLoader(
                new URL[]{ classesDir.toUri().toURL() }, getClass().getClassLoader())) {
            check.run(srcDir, cl);
        }
    }

    /** An ItemDto holding amount 12.50, tiers [1.50, 0.0000001] and a Price whose note is null. */
    private static String writtenBytes(ClassLoader cl) throws Exception {
        Class<?> priceClass = cl.loadClass(PKG + ".Price");
        Object price = priceClass.getMethod("builder").invoke(null);
        price = price.getClass().getMethod("net", BigDecimal.class).invoke(price, new BigDecimal("12.50"));
        price = price.getClass().getMethod("build").invoke(price);
        Class<?> dto = cl.loadClass(PKG + ".ItemDto");
        Object b = dto.getMethod("builder").invoke(null);
        Class<?> bc = b.getClass();
        b = bc.getMethod("amount", BigDecimal.class).invoke(b, new BigDecimal("12.50"));
        b = bc.getMethod("tiers", List.class).invoke(b, List.of(new BigDecimal("1.50"), new BigDecimal("0.0000001")));
        b = bc.getMethod("price", priceClass).invoke(b, price);
        return MAPPER.writeValueAsString(bc.getMethod("build").invoke(b));
    }

    @Test
    public void theDefaultIsJacksonsOwnShape() throws Exception {
        generate(null, (src, cl) -> {
            String dtoSrc = Files.readString(src.resolve("acme/wire/ItemDto.java"));
            assertFalse(dtoSrc, dtoSrc.contains("CanonicalDecimalSerializer"));
            assertTrue("the strict READ side stays", dtoSrc.contains("CanonicalDecimalDeserializer"));
            assertFalse(Files.readString(src.resolve("acme/wire/Price.java")).contains("JsonInclude"));

            String raw = writtenBytes(cl);
            JsonNode out = MAPPER.readTree(raw);
            // Jackson (and Spring Boot's default mapper) writes a BigDecimal as a number, toString() form.
            assertTrue("a JSON number", out.get("amount").isNumber());
            assertTrue(raw, raw.contains("\"amount\":12.50,"));
            assertTrue(raw, raw.contains("\"tiers\":[1.50,1E-7]"));
            assertTrue(out.get("tiers").get(0).isNumber());
            // A value object's null member is written null, key present.
            assertTrue(out.get("price").has("note"));
            assertTrue(out.get("price").get("note").isNull());
            assertTrue(raw, raw.contains("\"net\":12.50"));
            assertTrue(raw, raw.contains("\"note\":null"));

            // Input rules hold under native: a string or a number reads, garbage and over-scale refuse.
            Class<?> dto = cl.loadClass(PKG + ".ItemDto");
            MAPPER.readValue("{\"amount\":\"1e-7\"}", dto);
            MAPPER.readValue("{\"amount\":12.5}", dto);
            for (String bad : new String[]{"{\"amount\":\"\"}", "{\"amount\":\"NaN\"}",
                    "{\"price\":{\"net\":\"1.001\"}}", "{\"price\":{\"net\":1.001}}"}) {
                try {
                    MAPPER.readValue(bad, dto);
                    fail("must be refused under native: " + bad);
                } catch (com.fasterxml.jackson.core.JsonProcessingException expected) {
                    // Spring maps this to 400 validation
                }
            }
        });
    }

    @Test
    public void stringAndOmitGiveTheCanonicalCrossPortForm() throws Exception {
        generate(new WireFormat(WireFormat.Decimals.STRING, WireFormat.NullMembers.OMIT), (src, cl) -> {
            String raw = writtenBytes(cl);
            JsonNode out = MAPPER.readTree(raw);
            assertEquals("12.5", out.get("amount").asText());
            assertTrue(out.get("amount").isTextual());
            assertEquals("[\"1.5\",\"0.0000001\"]", MAPPER.writeValueAsString(out.get("tiers")));
            assertEquals("12.5", out.get("price").get("net").asText());
            assertFalse("a null member is omitted", out.get("price").has("note"));
        });
    }

    @Test
    public void emitWritesTheNullMemberLikeNative() throws Exception {
        generate(new WireFormat(WireFormat.Decimals.NATIVE, WireFormat.NullMembers.EMIT), (src, cl) -> {
            String raw = writtenBytes(cl);
            JsonNode out = MAPPER.readTree(raw);
            assertTrue(out.get("price").has("note"));
            assertTrue(out.get("price").get("note").isNull());
            assertTrue(out.get("amount").isNumber());
        });
    }
}

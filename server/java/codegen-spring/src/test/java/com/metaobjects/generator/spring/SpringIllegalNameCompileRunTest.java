package com.metaobjects.generator.spring;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.metaobjects.loader.MetaDataLoader;
import jakarta.validation.Validation;
import jakarta.validation.Validator;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.net.URL;
import java.net.URLClassLoader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.Map;
import java.util.stream.Stream;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

/**
 * The escape for a field name Java reserves ({@code notify}, {@code toString}, …) has to
 * reach every place the name becomes a Java METHOD, not just the record component that
 * declares it.
 *
 * <p>{@link IllegalRecordComponentNameTest} pins the naming helper and stops there, and the
 * three declaration sites were routed through it — but the emitters that CALL the accessor
 * were not. Two shapes get past a green build:
 *
 * <ul>
 *   <li><b>A hard compile error.</b> {@code stampForInsert} rebuilt the record as
 *       {@code new SettingsDto(…, dto.notify(), …)}, which binds to {@code Object.notify()}
 *       — a real {@code void} method — where a value is required.</li>
 *   <li><b>A silent override, which is worse.</b> {@code <Entity>Patch} is a plain CLASS,
 *       not a record, so {@code public String toString() { return (String) assigned.get(…); }}
 *       COMPILES: it overrides {@code Object.toString()}, and every log line, debugger and
 *       {@code String.valueOf(patch)} in the adopter's app silently returns the patch's
 *       {@code toString} field instead. Nothing fails; the behaviour is just wrong.</li>
 * </ul>
 *
 * <p>The Java codegen-compile gate cannot see either one: the fitness corpus's only illegal
 * name is {@code Settings.notify} on an {@code object.value} with no {@code @autoSet} and no
 * patch. So this test carries its own fixture — an ENTITY (which gets a Patch) declaring both
 * an illegal boolean and an illegal String, plus the {@code @autoSet} columns that make the
 * stamping helpers emit at all — and compiles what comes out.
 */
public class SpringIllegalNameCompileRunTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String PKG = "acme.prefs";

    /**
     * Three arms, because Java rejects these names for two different reasons and an emitter
     * that handles one still breaks on the other:
     * <ul>
     *   <li>{@code notify} — the corpus's real case, and a hard compile error.</li>
     *   <li>{@code toString} — the one that does NOT stop the build: a {@code String}-typed
     *       accessor legally overrides {@code Object.toString()}.</li>
     *   <li>{@code class} — a KEYWORD, so it is a parse error rather than an override
     *       problem. A record component has no {@code get}/{@code is} prefix to shield it,
     *       which makes the record emitters MORE exposed to this than the POJO writer that
     *       first hit it (see {@code JavaAccessorNameCollisionTest}).</li>
     * </ul>
     */
    private static final String META = """
        { "metadata.root": { "package": "acme::prefs", "children": [
          { "object.entity": { "name": "Settings", "children": [
            { "source.rdb":      { "@table": "settings" } },
            { "field.long":      { "name": "id" } },
            { "field.boolean":   { "name": "notify" } },
            { "field.string":    { "name": "toString", "@maxLength": 20 } },
            { "field.string":    { "name": "class" } },
            { "field.string":    { "name": "theme", "@required": true } },
            { "field.timestamp": { "name": "createdAt", "@autoSet": "onCreate" } },
            { "field.timestamp": { "name": "updatedAt", "@autoSet": "onUpdate" } },
            { "identity.primary": { "name": "id", "@fields": "id", "@generation": "increment" } }
          ]}}
        ]}}
        """;

    /**
     * A TPH hierarchy carrying the same illegal names. The per-subtype create handler validates
     * field by field with a LITERAL property name, so it is the one place both halves of the
     * escape — the string and the accessor — appear on one line.
     */
    private static final String TPH_META = """
        { "metadata.root": { "package": "acme::auth", "children": [
          { "object.entity": { "name": "Auth", "@discriminator": "type", "children": [
            { "source.rdb":       { "@table": "auths" } },
            { "field.long":       { "name": "id" } },
            { "field.enum":       { "name": "type", "@values": ["Bridge"] } },
            { "field.boolean":    { "name": "notify" } },
            { "field.string":     { "name": "reference", "@required": true, "@maxLength": 80 } },
            { "identity.primary": { "name": "id", "@fields": "id", "@generation": "increment" } }
          ]}},
          { "object.entity": { "name": "BridgeAuth", "extends": "Auth", "@discriminatorValue": "Bridge", "children": [
            { "field.int": { "name": "quantity", "@required": true } }
          ]}}
        ]}}
        """;

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    @Test
    public void theDtoTierCompilesAndKeepsItsWireNames() throws Exception {
        Path srcDir = tmp.newFolder("src").toPath();
        Path classesDir = tmp.newFolder("classes").toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(
            tmp.newFolder("fx").toPath(), "settings", META);

        // Emits SettingsDto (record + stamping helpers) and SettingsPatch (plain class).
        runGenerator(new SpringDtoGenerator(), loader, srcDir);
        SpringTestFixtures.compileGenerated(srcDir, classesDir);

        try (URLClassLoader cl = new URLClassLoader(
                new URL[]{ classesDir.toUri().toURL() }, getClass().getClassLoader())) {
            Class<?> dtoClass = cl.loadClass(PKG + ".SettingsDto");
            Class<?> patchClass = cl.loadClass(PKG + ".SettingsPatch");

            // --- the wire contract is untouched by the escape -------------------------
            JsonNode body = MAPPER.readTree(
                "{\"id\":1,\"notify\":true,\"toString\":\"dark\",\"class\":\"algebra\"}");
            Object dto = MAPPER.treeToValue(body, dtoClass);
            assertEquals("notify bound from its DECLARED wire name",
                Boolean.TRUE, dtoClass.getMethod("notify_").invoke(dto));
            assertEquals("toString bound from its DECLARED wire name",
                "dark", dtoClass.getMethod("toString_").invoke(dto));
            assertEquals("the escaped component still serializes as `notify`",
                Boolean.TRUE, MAPPER.valueToTree(dto).get("notify").asBoolean());
            assertEquals("a KEYWORD-named field binds from its declared wire name too",
                "algebra", dtoClass.getMethod("class_").invoke(dto));
            assertEquals("and serializes back as `class`",
                "algebra", MAPPER.valueToTree(dto).get("class").asText());

            // --- the stamping helper copies the escaped components through ------------
            Object stamped = dtoClass.getMethod("stampForInsert", dtoClass).invoke(null, dto);
            assertEquals("stampForInsert copies a non-@autoSet illegal-named field through",
                Boolean.TRUE, dtoClass.getMethod("notify_").invoke(stamped));
            assertNotNull("stampForInsert stamped the onCreate column",
                dtoClass.getMethod("createdAt").invoke(stamped));

            // --- the Patch keeps Object's own toString ---------------------------------
            Object patch = patchClass.getMethod("fromJson", JsonNode.class, ObjectMapper.class)
                .invoke(null, body, MAPPER);
            assertEquals(Boolean.TRUE, patchClass.getMethod("hasNotify").invoke(patch));
            assertEquals(Boolean.TRUE, patchClass.getMethod("notify_").invoke(patch));
            assertEquals(Boolean.TRUE, patchClass.getMethod("hasToString").invoke(patch));
            assertEquals("dark", patchClass.getMethod("toString_").invoke(patch));
            assertEquals(Boolean.TRUE, patchClass.getMethod("hasClass").invoke(patch));
            assertEquals("algebra", patchClass.getMethod("class_").invoke(patch));
            // The silent one: an unescaped accessor would make this return "dark".
            assertTrue("Object.toString() must not be hijacked by a field named toString, got: "
                + patch, patch.toString().startsWith(PKG + ".SettingsPatch@"));
            assertEquals("an omitted field is untouched",
                Boolean.FALSE, patchClass.getMethod("hasTheme").invoke(patch));
        }
    }

    @Test
    public void beanValidationResolvesTheEscapedPropertyName() throws Exception {
        // The generated TPH create handler validates field by field with
        // validator.validateValue(<Sub>Dto.class, "<property>", value), and the property name
        // is a STRING. Hibernate Validator resolves a record's property by its COMPONENT name,
        // so the escape has to reach that string too — an unescaped "notify" is not a property
        // of the generated record and validateValue throws IllegalArgumentException.
        Path srcDir = tmp.newFolder("src").toPath();
        Path classesDir = tmp.newFolder("classes").toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(
            tmp.newFolder("fx").toPath(), "settings", META);
        runGenerator(new SpringDtoGenerator(), loader, srcDir);
        SpringTestFixtures.compileGenerated(srcDir, classesDir);

        try (URLClassLoader cl = new URLClassLoader(
                new URL[]{ classesDir.toUri().toURL() }, getClass().getClassLoader())) {
            Class<?> dtoClass = cl.loadClass(PKG + ".SettingsDto");
            Validator validator = Validation.buildDefaultValidatorFactory().getValidator();

            // The name the generator must emit into that string.
            String property = SpringNaming.recordComponentName("toString");
            assertTrue("a legal value passes",
                validator.validateValue(erased(dtoClass), property, "dark").isEmpty());
            // And the constraint carried by the escaped component is still enforced.
            assertTrue("@maxLength 20 is still enforced on the escaped component",
                !validator.validateValue(erased(dtoClass), property, "x".repeat(21)).isEmpty());

            try {
                validator.validateValue(erased(dtoClass), "toString", "dark");
                fail("the DECLARED name is not a property of the generated record — if this "
                    + "stops throwing, the escape is no longer needed in that string");
            } catch (IllegalArgumentException expected) {
                assertTrue(expected.getMessage(), expected.getMessage().contains("toString"));
            }
        }
    }

    /**
     * The generated CONTROLLER, asserted by string search rather than by compiling — it imports
     * Spring, which {@code codegen-spring} deliberately does not depend on (the codegen-compile
     * gate excludes this tier for the same reason, and the api-contract lane boots it instead).
     * Matches the style of {@link SpringControllerGeneratorTest}.
     */
    @Test
    public void theVanillaPatchLoopNamesTheValidationPropertyCorrectly() throws Exception {
        String src = generateController(META, "settings", "SettingsController.java");

        // The keys of assignedValues() are the DECLARED wire names, so the loop has to translate
        // before naming a Bean Validation property — the run-time half of the escape.
        assertTrue("the PATCH loop must escape each assigned key before validating it\n" + src,
            src.contains("validateValue(SettingsDto.class, RecordComponentNames.escape(__e.getKey())"));
        assertTrue("and import the rule it calls",
            src.contains("import com.metaobjects.generator.spring.runtime.RecordComponentNames;"));
        assertFalse("no raw key may reach validateValue — it throws IllegalArgumentException",
            src.contains("validateValue(SettingsDto.class, __e.getKey()"));
    }

    @Test
    public void theTphCreateEscapesBothThePropertyStringAndTheAccessor() throws Exception {
        String src = generateController(TPH_META, "auth", "AuthController.java");

        assertTrue("both halves escape on the per-subtype create line\n" + src,
            src.contains("validateValue(acme.auth.BridgeAuthDto.class, \"notify_\", dto.notify_())"));
        assertFalse("an unescaped accessor binds to Object.notify() and will not compile",
            src.contains("dto.notify()"));
        assertFalse("an unescaped property string is not a property of the record",
            src.contains("\"notify\", dto."));
    }

    private String generateController(String meta, String fixtureName, String file) throws Exception {
        Path srcDir = tmp.newFolder("ctrl-" + fixtureName + "-" + file).toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(
            tmp.newFolder("fx-" + fixtureName + "-" + file).toPath(), fixtureName, meta);
        runGenerator(new SpringControllerGenerator(), loader, srcDir);
        try (Stream<Path> s = Files.walk(srcDir)) {
            Path found = s.filter(x -> x.getFileName().toString().equals(file)).findFirst()
                .orElseThrow(() -> new AssertionError("no " + file + " was generated"));
            return Files.readString(found, StandardCharsets.UTF_8);
        }
    }

    @SuppressWarnings("unchecked")
    private static <T> Class<T> erased(Class<?> c) {
        return (Class<T>) c;
    }

    private static void runGenerator(Object generator, MetaDataLoader loader, Path outDir) {
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", outDir.toString());
        ((com.metaobjects.generator.direct.MultiFileDirectGeneratorBase<?>) generator).setArgs(args);
        ((com.metaobjects.generator.direct.MultiFileDirectGeneratorBase<?>) generator).execute(loader);
    }
}

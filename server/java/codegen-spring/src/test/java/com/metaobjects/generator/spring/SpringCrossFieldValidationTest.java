package com.metaobjects.generator.spring;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.metaobjects.loader.MetaDataLoader;
import jakarta.validation.Validation;
import jakarta.validation.Validator;
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
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

/**
 * Entity-scoped cross-field validators hold on the full {@code <Entity>Dto} and leave the partial
 * {@code <Entity>Patch} alone (a partial body cannot see the merged row, so the DB CHECK stays the
 * enforcement there). The full verdict table is gated by {@code ValidationConformanceTest} against
 * the shared corpus; this test covers what the corpus does not: a validator naming a field the
 * entity lacks is skipped (the DTO still compiles and the other rules still run), and an entity
 * declaring no cross-field validator accepts the same body. Oracle: the validators' declared
 * meaning — {@code startsAt lte endsAt} rejects 3 > 1.
 */
public class SpringCrossFieldValidationTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String VIOLATES_COMPARISON =
        "{\"startsAt\":3,\"endsAt\":1,\"kind\":\"OTHER\",\"subject\":\"s\"}";
    private static final String SATISFIES_ALL =
        "{\"startsAt\":1,\"endsAt\":3,\"kind\":\"BIRTH\",\"subject\":\"s\"}";

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    private static String model(boolean withValidators) {
        String validators = withValidators ? """
            , { "validator.comparison":   { "name": "startsBeforeEnds", "@left": "startsAt", "@op": "lte", "@right": "endsAt" } },
              { "validator.requiredWhen": { "name": "birthNeedsSubject", "@field": "subject", "@when": "kind", "@equals": "BIRTH" } },
              { "validator.requiredWhen": { "name": "ghost", "@field": "nope", "@when": "kind", "@equals": "OTHER" } }
            """ : "";
        return """
            { "metadata.root": { "package": "acme::ev", "children": [
              { "object.entity": { "name": "Ev", "children": [
                { "source.rdb":   { "@table": "evs" } },
                { "field.long":   { "name": "id" } },
                { "field.int":    { "name": "startsAt" } },
                { "field.int":    { "name": "endsAt" } },
                { "field.string": { "name": "kind" } },
                { "field.string": { "name": "subject" } },
                { "identity.primary": { "name": "id", "@fields": "id", "@generation": "increment" } }
                """ + validators + """
              ]}}
            ]}}
            """;
    }

    private Path gen(boolean withValidators) throws Exception {
        MetaDataLoader loader = SpringTestFixtures.loadFixture(
            tmp.newFolder().toPath(), "ev", model(withValidators));
        Path out = tmp.newFolder().toPath();
        SpringDtoGenerator g = new SpringDtoGenerator();
        g.setArgs(Map.of("outputDir", out.toString()));
        g.execute(loader);
        return out;
    }

    /** Violation count Bean Validation reports for {@code json} bound to the compiled {@code EvDto}. */
    private int violations(boolean withValidators, String json) throws Exception {
        Path src = gen(withValidators);
        Path classes = tmp.newFolder().toPath();
        compile(src, classes);
        try (URLClassLoader cl = new URLClassLoader(new URL[]{ classes.toUri().toURL() }, getClass().getClassLoader())) {
            Object dto = MAPPER.readValue(json, cl.loadClass("acme.ev.EvDto"));
            Validator validator = Validation.buildDefaultValidatorFactory().getValidator();
            return validator.validate(dto).size();
        }
    }

    @Test
    public void dtoEnforcesResolvableRulesAndSkipsAValidatorOnAMissingField() throws Exception {
        assertEquals(1, violations(true, VIOLATES_COMPARISON));
        assertEquals(0, violations(true, SATISFIES_ALL));
        assertEquals(1, violations(true, "{\"startsAt\":1,\"endsAt\":3,\"kind\":\"BIRTH\"}"));
    }

    @Test
    public void entityWithoutCrossFieldValidatorsAcceptsTheSameBody() throws Exception {
        assertEquals(0, violations(false, VIOLATES_COMPARISON));
    }

    @Test
    public void patchIsUnchangedByCrossFieldValidators() throws Exception {
        String withV = Files.readString(gen(true).resolve("acme/ev/EvPatch.java"));
        String without = Files.readString(gen(false).resolve("acme/ev/EvPatch.java"));
        assertEquals("the generated PATCH body must not change", without, withV);
    }

    private static void compile(Path srcDir, Path classesDir) throws Exception {
        List<File> sources;
        try (Stream<Path> s = Files.walk(srcDir)) {
            sources = s.filter(p -> p.toString().endsWith(".java")).map(Path::toFile).collect(Collectors.toList());
        }
        assertTrue("expected generated .java sources", !sources.isEmpty());
        JavaCompiler javac = ToolProvider.getSystemJavaCompiler();
        assertNotNull("JDK required — getSystemJavaCompiler() returned null", javac);
        DiagnosticCollector<JavaFileObject> diags = new DiagnosticCollector<>();
        var fm = javac.getStandardFileManager(diags, null, StandardCharsets.UTF_8);
        List<String> opts = List.of("-classpath", System.getProperty("java.class.path"), "-d", classesDir.toString());
        if (!javac.getTask(null, fm, diags, opts, null, fm.getJavaFileObjectsFromFiles(sources)).call()) {
            StringBuilder sb = new StringBuilder("generated sources failed to compile:\n");
            for (var d : diags.getDiagnostics()) sb.append("  ").append(d.getMessage(null)).append('\n');
            fail(sb.toString());
        }
    }
}

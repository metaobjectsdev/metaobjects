package com.metaobjects.generator.spring;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.metaobjects.loader.MetaDataLoader;
import jakarta.validation.Validation;
import jakarta.validation.Validator;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import org.springframework.http.ResponseEntity;

import javax.tools.DiagnosticCollector;
import javax.tools.JavaCompiler;
import javax.tools.JavaFileObject;
import javax.tools.ToolProvider;

import java.io.File;
import java.lang.reflect.Method;
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
 * A TPH subtype's cross-field validators hold on its per-subtype POST. That handler binds the
 * annotation-free union body and validates it per property against the subtype DTO, which
 * never reaches a class-level {@code @AssertTrue} rule, so the generated controller evaluates
 * the rules itself. The oracle is the validator's own declared meaning (FR-036's CHECK
 * semantics): {@code requiredWhen(note, kind = BIRTH)} rejects a BIRTH body with no note and
 * accepts every other body; a rule gated on the discriminator reads the route's pinned value,
 * so it applies even when the body omits the discriminator.
 */
public class GeneratedTphCrossFieldCompileRunTest {

    private static final String PKG = "acme.ev";
    private static final ObjectMapper MAPPER = new ObjectMapper();

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    private static final String FIXTURE = """
        { "metadata.root": { "package": "acme::ev", "children": [
          { "object.entity": { "name": "Event", "@discriminator": "type", "children": [
            { "source.rdb":   { "@table": "events" } },
            { "field.long":   { "name": "id" } },
            { "field.string": { "name": "type", "@required": true, "@maxLength": 20 } },
            { "field.string": { "name": "kind" } },
            { "identity.primary": { "@fields": "id", "@generation": "increment" } }
          ] } },
          { "object.entity": { "name": "BirthEvent", "extends": "Event", "@discriminatorValue": "Birth", "children": [
            { "field.string": { "name": "note" } },
            { "validator.requiredWhen": { "name": "birthNeedsNote", "@field": "note", "@when": "kind", "@equals": "BIRTH" } }
          ] } },
          { "object.entity": { "name": "DeathEvent", "extends": "Event", "@discriminatorValue": "Death", "children": [
            { "field.string": { "name": "subject" } },
            { "validator.requiredWhen": { "name": "deathNeedsSubject", "@field": "subject", "@when": "type", "@equals": "Death" } }
          ] } }
        ] } }
        """;

    @Test
    public void perSubtypeCreateEnforcesTheSubtypesCrossFieldRules() throws Exception {
        Path srcDir = tmp.newFolder("src").toPath();
        Path classesDir = tmp.newFolder("classes").toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(tmp.newFolder("fx").toPath(), "tph-xf", FIXTURE);

        runGenerator(new SpringDtoGenerator(), loader, srcDir);
        runGenerator(new SpringRepositoryGenerator(), loader, srcDir);
        runGenerator(new SpringControllerGenerator(), loader, srcDir);
        runGenerator(new SpringFilterAllowlistGenerator(), loader, srcDir);
        Path pkgDir = srcDir.resolve(PKG.replace('.', '/'));
        Files.writeString(pkgDir.resolve("EchoEventRepository.java"), ECHO_REPO_IMPL);

        compile(srcDir, classesDir);

        try (URLClassLoader cl = new URLClassLoader(
                new URL[]{ classesDir.toUri().toURL() }, getClass().getClassLoader())) {
            Class<?> dtoClass = cl.loadClass(PKG + ".EventDto");
            Class<?> repoIface = cl.loadClass(PKG + ".EventRepository");
            Object repo = cl.loadClass(PKG + ".EchoEventRepository").getDeclaredConstructor().newInstance();
            Validator validator = Validation.buildDefaultValidatorFactory().getValidator();
            Object controller = cl.loadClass(PKG + ".EventController")
                .getDeclaredConstructor(repoIface, ObjectMapper.class, Validator.class)
                .newInstance(repo, MAPPER, validator);

            assertEquals(400, post(controller, dtoClass, "createBirth", "{\"kind\":\"BIRTH\"}"));
            assertEquals(201, post(controller, dtoClass, "createBirth", "{\"kind\":\"BIRTH\",\"note\":\"n\"}"));
            assertEquals(201, post(controller, dtoClass, "createBirth", "{\"kind\":\"OTHER\"}"));
            assertEquals(201, post(controller, dtoClass, "createBirth", "{}"));

            assertEquals(400, post(controller, dtoClass, "createDeath", "{}"));
            assertEquals(201, post(controller, dtoClass, "createDeath", "{\"subject\":\"s\"}"));
        }
    }

    private static int post(Object controller, Class<?> dtoClass, String handler, String json) throws Exception {
        Method m = controller.getClass().getMethod(handler, dtoClass);
        ResponseEntity<?> resp = (ResponseEntity<?>) m.invoke(controller, MAPPER.readValue(json, dtoClass));
        return resp.getStatusCode().value();
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
        DiagnosticCollector<JavaFileObject> diags = new DiagnosticCollector<>();
        var fm = javac.getStandardFileManager(diags, null, StandardCharsets.UTF_8);
        List<String> opts = List.of("-classpath", System.getProperty("java.class.path"), "-d", classesDir.toString());
        boolean ok = javac.getTask(null, fm, diags, opts, null, fm.getJavaFileObjectsFromFiles(sources)).call();
        if (!ok) {
            StringBuilder sb = new StringBuilder("generated sources failed to compile:\n");
            for (var d : diags.getDiagnostics()) {
                sb.append("  ").append(d.getKind()).append(": ").append(d.getMessage(null)).append('\n');
            }
            fail(sb.toString());
        }
    }

    /** A consumer-seam repository that persists nothing: create echoes the body back. */
    private static final String ECHO_REPO_IMPL = """
        package acme.ev;

        import com.metaobjects.generator.spring.runtime.FilterPredicate;
        import java.util.List;
        import java.util.Map;
        import java.util.Optional;

        public class EchoEventRepository implements EventRepository {
            @Override public EventDto createWithType(String discriminator, EventDto dto) { return dto; }
            @Override public List<EventDto> list(int limit, int offset, SortClause sort, List<FilterPredicate> f) { return List.of(); }
            @Override public long count(List<FilterPredicate> f) { return 0; }
            @Override public Optional<EventDto> findById(Long id) { return Optional.empty(); }
            @Override public Optional<EventDto> findByIdAndType(Long id, String discriminator) { return Optional.empty(); }
            @Override public List<EventDto> listByType(String discriminator, int limit, int offset, SortClause sort, List<FilterPredicate> f) { return List.of(); }
            @Override public Optional<EventDto> updateByIdAndType(Long id, String discriminator, EventDto dto) { return Optional.empty(); }
            @Override public Optional<EventDto> patchByIdAndType(Long id, String discriminator, Map<String, Object> assigned) { return Optional.empty(); }
            @Override public boolean deleteByIdAndType(Long id, String discriminator) { return false; }
        }
        """;
}

package com.metaobjects.generator.spring;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.registry.SharedRegistryTestBase;

import jakarta.validation.ConstraintViolation;
import jakarta.validation.Validation;
import jakarta.validation.Validator;
import jakarta.validation.ValidatorFactory;

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
import java.nio.file.Files;
import java.nio.file.Path;
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
 * SP-C validator-parity gate — the Java port of the shared
 * {@code fixtures/validation-conformance/} corpus.
 *
 * <p>Loads the single-source corpus ({@code meta.json} + {@code cases.json}),
 * generates the {@code Account} DTO via {@link SpringDtoGenerator}, compiles the
 * generated source in-memory, deserialises each corpus payload onto the
 * <em>generated</em> DTO, and validates it through a jakarta {@link Validator}.
 * {@code valid := violations.isEmpty()} must equal each case's {@code expectValid}
 * boolean — the same verdicts asserted by the TS / C# / Python runners.</p>
 */
public class ValidationConformanceTest extends SharedRegistryTestBase {

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private static Path repoRoot() {
        return Path.of(System.getProperty("user.dir")).resolve("../../..").normalize();
    }

    /** The message of the deepest cause — a Jackson bind failure wraps the deserializer's
     *  IllegalArgumentException, so the root carries the actionable "field.uri/…" reason. */
    private static String rootMessage(Throwable t) {
        Throwable cur = t;
        while (cur.getCause() != null && cur.getCause() != cur) cur = cur.getCause();
        return cur.getMessage();
    }

    @Test
    @SuppressWarnings("unchecked")
    public void generatedDtoEnforcesCorpusVerdicts() throws Exception {
        Path corpus = repoRoot().resolve("fixtures/validation-conformance");
        Path metaFile = corpus.resolve("meta.json");
        Path casesFile = corpus.resolve("cases.json");
        assertTrue("corpus meta.json must exist at " + metaFile, Files.exists(metaFile));
        assertTrue("corpus cases.json must exist at " + casesFile, Files.exists(casesFile));

        // 1. Load the corpus metadata.
        MetaDataLoader loader = SpringTestFixtures.loadFixture(
                tmp.newFolder().toPath(), "validationMeta", Files.readString(metaFile));

        // 2. Generate the Account DTO.
        Path gen = tmp.newFolder("gen-dto").toPath();
        SpringDtoGenerator generator = new SpringDtoGenerator();
        generator.setArgs(Map.of("outputDir", gen.toString()));
        generator.execute(loader);

        File dtoSrc = gen.resolve("acme/auth/AccountDto.java").toFile();
        assertTrue("AccountDto.java must be generated at " + dtoSrc, dtoSrc.isFile());

        // 3. Compile the generated source in-memory. -parameters so Jackson can bind
        //    record components by name from the corpus payload JSON.
        List<File> sources;
        try (Stream<Path> s = Files.walk(gen)) {
            sources = s.filter(p -> p.toString().endsWith(".java"))
                       .map(Path::toFile)
                       .collect(Collectors.toList());
        }
        JavaCompiler javac = ToolProvider.getSystemJavaCompiler();
        assertNotNull("JDK (not JRE) required — getSystemJavaCompiler() returned null", javac);

        Path classes = tmp.newFolder("classes-dto").toPath();
        DiagnosticCollector<JavaFileObject> diags = new DiagnosticCollector<>();
        var fm = javac.getStandardFileManager(diags, null, null);
        List<String> opts = List.of(
                "-classpath", System.getProperty("java.class.path"),
                "-parameters",
                "-d", classes.toString());
        boolean ok = javac.getTask(null, fm, diags, opts, null,
                fm.getJavaFileObjectsFromFiles(sources)).call();
        if (!ok) {
            StringBuilder sb = new StringBuilder("generated DTO failed to compile:\n");
            for (var d : diags.getDiagnostics()) {
                sb.append("  ").append(d.getKind()).append(": ").append(d.getMessage(null)).append('\n');
            }
            sb.append("\n=== AccountDto.java ===\n").append(Files.readString(dtoSrc.toPath()));
            fail(sb.toString());
        }

        // 4. Load the compiled DTO + drive each corpus case through a jakarta Validator.
        Map<String, Object> casesDoc = MAPPER.readValue(Files.readString(casesFile), Map.class);
        List<Map<String, Object>> cases = (List<Map<String, Object>>) casesDoc.get("cases");
        assertNotNull("cases.json must declare a 'cases' array", cases);
        assertFalse("cases array must be non-empty", cases.isEmpty());

        try (URLClassLoader cl = new URLClassLoader(
                new URL[]{ classes.toUri().toURL() }, getClass().getClassLoader());
             ValidatorFactory vf = Validation.buildDefaultValidatorFactory()) {

            Class<?> dtoCls = cl.loadClass("acme.auth.AccountDto");
            Validator validator = vf.getValidator();

            int passed = 0;
            StringBuilder failures = new StringBuilder();
            for (Map<String, Object> c : cases) {
                String name = String.valueOf(c.get("name"));
                Object payload = c.get("payload");
                boolean expectValid = Boolean.TRUE.equals(c.get("expectValid"));

                boolean actualValid;
                String detail;
                try {
                    Object dto = MAPPER.convertValue(payload, dtoCls);
                    Set<ConstraintViolation<Object>> violations = validator.validate(dto);
                    actualValid = violations.isEmpty();
                    detail = "violations=" + violations.stream()
                            .map(v -> v.getPropertyPath() + " " + v.getMessage())
                            .collect(Collectors.toList());
                } catch (IllegalArgumentException bindFailure) {
                    // #234: a native-typed field.uri/field.inet value that fails to deserialize is
                    // rejected at the wire tier (HTTP 400) — a bind failure IS an invalid verdict,
                    // exactly as the TS safeParse / Python construct paths fuse bind + validate.
                    actualValid = false;
                    detail = "bind-failure: " + rootMessage(bindFailure);
                }

                if (actualValid == expectValid) {
                    passed++;
                } else {
                    failures.append(String.format(
                            "  case '%s': expectValid=%s but generated DTO said valid=%s (%s)%n",
                            name, expectValid, actualValid, detail));
                }
            }
            if (failures.length() > 0) {
                fail("validation-conformance verdict mismatches (" + passed + "/" + cases.size()
                        + " passed):\n" + failures
                        + "\n=== AccountDto.java ===\n" + Files.readString(dtoSrc.toPath()));
            }
            assertEquals("all corpus cases must match the single-source verdict",
                    cases.size(), passed);
        }
    }
}

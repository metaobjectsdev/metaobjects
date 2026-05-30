package com.metaobjects.generator.spring;

import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.registry.SharedRegistryTestBase;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import javax.tools.DiagnosticCollector;
import javax.tools.JavaCompiler;
import javax.tools.JavaFileObject;
import javax.tools.ToolProvider;
import java.io.File;
import java.lang.reflect.Method;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import static org.junit.Assert.*;

/**
 * Gold-standard verification: generate the payload record + the parser-with-recover,
 * COMPILE them in-memory, load the parser, invoke the generated {@code recover(String)}
 * on DIRTY input, and assert the recovered record + report.
 *
 * <p>This proves the codegen produces working code — string-asserting the source only
 * proves shape. FR-010 Plan 2, Task 5.
 *
 * <p>Requires a JDK on the test classpath ({@link ToolProvider#getSystemJavaCompiler()}
 * must not return null). Maven runs on a JDK so this is the normal case; the test
 * asserts the precondition explicitly so a JRE-only environment gives a clear error.
 */
public class GeneratedRecoverCompileRunTest extends SharedRegistryTestBase {

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    @Test
    public void generatedRecoverRecoversFencedDirtyJson() throws Exception {
        // -----------------------------------------------------------------------
        // 1. Generate payload record + parser into a temp directory
        // -----------------------------------------------------------------------
        Path gen = tmp.newFolder("gen").toPath();
        Path ws  = tmp.newFolder("ws").toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(
                ws, "recover-cr", SpringTestFixtures.RECOVER_OUTPUT_FIXTURE);

        Map<String, String> args = new HashMap<>();
        args.put("outputDir", gen.toString());

        SpringPayloadGenerator payloadGen = new SpringPayloadGenerator();
        payloadGen.setArgs(args);
        payloadGen.execute(loader);

        SpringOutputParserGenerator parserGen = new SpringOutputParserGenerator();
        parserGen.setArgs(args);
        parserGen.execute(loader);

        // -----------------------------------------------------------------------
        // 2. Collect generated .java files
        // -----------------------------------------------------------------------
        List<File> sources;
        try (Stream<Path> s = Files.walk(gen)) {
            sources = s.filter(p -> p.toString().endsWith(".java"))
                       .map(Path::toFile)
                       .collect(Collectors.toList());
        }
        assertFalse("expected generated .java files under " + gen, sources.isEmpty());

        // -----------------------------------------------------------------------
        // 3. Compile in-memory
        // -----------------------------------------------------------------------
        JavaCompiler javac = ToolProvider.getSystemJavaCompiler();
        assertNotNull(
            "JDK (not JRE) required for this test — ToolProvider.getSystemJavaCompiler() returned null",
            javac);

        Path classes = tmp.newFolder("classes").toPath();
        String cp = System.getProperty("java.class.path");

        DiagnosticCollector<JavaFileObject> diags = new DiagnosticCollector<>();
        var fm = javac.getStandardFileManager(diags, null, null);
        List<String> opts = List.of("-classpath", cp, "-d", classes.toString());

        boolean compileOk = javac.getTask(null, fm, diags, opts, null,
                fm.getJavaFileObjectsFromFiles(sources)).call();

        if (!compileOk) {
            StringBuilder sb = new StringBuilder("generated sources failed to compile:\n");
            for (var d : diags.getDiagnostics()) {
                sb.append("  ").append(d.getKind()).append(": ").append(d.getMessage(null)).append('\n');
                if (d.getSource() != null) {
                    sb.append("    at ").append(d.getSource().getName())
                      .append(':').append(d.getLineNumber()).append('\n');
                }
            }
            // Print generated sources for diagnosis
            for (File src : sources) {
                sb.append("\n=== ").append(src.getName()).append(" ===\n");
                sb.append(Files.readString(src.toPath())).append('\n');
            }
            fail(sb.toString());
        }

        // -----------------------------------------------------------------------
        // 4. Load the parser class via a fresh URLClassLoader and invoke recover()
        // -----------------------------------------------------------------------
        //
        // Fixture: RECOVER_OUTPUT_FIXTURE declares:
        //   package acme::ai → outPkg "acme.ai.prompts"
        //   template.output name "AnswerOutput" → AnswerOutputParser / AnswerOutputPayload
        //   fields: text (String, required), confidence (enum HIGH/OK/LOW, alias medium→OK, required),
        //           note (String, optional)
        //
        // Dirty input: fenced JSON block containing confidence="medium" (an alias for "OK")
        // and no "note" field (the optional field).
        try (URLClassLoader cl = new URLClassLoader(
                new URL[]{ classes.toUri().toURL() },
                getClass().getClassLoader())) {

            Class<?> parserClass = cl.loadClass("acme.ai.prompts.AnswerOutputParser");
            Method recoverMethod = parserClass.getMethod("recover", String.class);

            // Dirty input: LLM preamble + fenced code block + trailing chatter.
            // confidence="medium" must be aliased to "OK" by the schema.
            // priority="banana" is off-vocab → FR-011 @coerceDefault folds it to "LOW" (DEFAULTED).
            // "note" is absent (optional) → should recover as null.
            String dirty = "Sure!\n```json\n{\"text\":\"hi\",\"confidence\":\"medium\","
                    + "\"priority\":\"banana\"}\n```\nDone.";
            Object result = recoverMethod.invoke(null, dirty);

            // result is RecoveryResult<AnswerOutputPayload>
            Object payload = result.getClass().getMethod("data").invoke(result);
            Object report  = result.getClass().getMethod("report").invoke(result);

            // Assert recovered field values
            Object text       = payload.getClass().getMethod("text").invoke(payload);
            Object confidence = payload.getClass().getMethod("confidence").invoke(payload);
            Object priority   = payload.getClass().getMethod("priority").invoke(payload);
            Object note       = payload.getClass().getMethod("note").invoke(payload);

            assertEquals("text component", "hi", text);
            assertEquals("confidence component — medium should be aliased to OK", "OK", confidence);
            assertEquals("priority component — off-vocab 'banana' should fold to @coerceDefault 'LOW'",
                    "LOW", priority);
            assertNull("note component — absent optional field should be null", note);

            // Assert report: no required fields were lost (priority is DEFAULTED, which satisfies required)
            boolean hasLostRequired = (boolean) report.getClass().getMethod("hasLostRequired").invoke(report);
            assertFalse("hasLostRequired must be false — text/confidence recovered, priority defaulted",
                    hasLostRequired);

            // FR-011: priority must classify as DEFAULTED (reached via @coerceDefault), not RECOVERED.
            @SuppressWarnings("unchecked")
            Map<String, Object> states =
                    (Map<String, Object>) report.getClass().getMethod("states").invoke(report);
            assertEquals("priority must classify DEFAULTED", "DEFAULTED",
                    String.valueOf(states.get("priority")));
        }
    }
}

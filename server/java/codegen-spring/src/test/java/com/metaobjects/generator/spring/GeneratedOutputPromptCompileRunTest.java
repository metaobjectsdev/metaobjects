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
 * Gold-standard compile-and-run proof: generate the payload record + the
 * OutputPrompt class, COMPILE them in-memory, load the class, invoke both
 * {@code renderFormat()} overloads, and assert the rendered fragment.
 *
 * <p>This proves the codegen produces working code — string-asserting the source
 * only proves shape. FR-010 Plan 3, Task 7.
 *
 * <p>Requires a JDK on the test classpath ({@link ToolProvider#getSystemJavaCompiler()}
 * must not return null). Maven runs on a JDK so this is the normal case.
 *
 * <p>Fixture: {@link SpringTestFixtures#PROMPT_VO_FIXTURE} — package {@code acme::ai},
 * template.output {@code AnswerOutput}, {@code @format: xml}, {@code @promptStyle: guide}.
 * Fields: {@code text} (string, required, @example hello), {@code confidence} (enum,
 * required, HIGH/OK/LOW, @enumDoc), {@code note} (string, optional).
 *
 * <p>Expected guide-style rendered XML fragment contains:
 * <ul>
 *   <li>The example skeleton with {@code <AnswerOutputPayload>} root (rootName = payload class name)</li>
 *   <li>Guide prose marker: {@code Respond exactly like this:}</li>
 *   <li>Required field marker: {@code (required)}</li>
 *   <li>No XML comments ({@code <!--} absent)</li>
 * </ul>
 *
 * <p>Inline-style override: invoking {@code renderFormat(PromptOverrides)} with
 * {@code PromptStyle.INLINE} must return a different (shorter) fragment without
 * the guide prose.
 */
public class GeneratedOutputPromptCompileRunTest extends SharedRegistryTestBase {

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    @Test
    public void generatedOutputPromptCompilesAndRenders() throws Exception {
        // -----------------------------------------------------------------------
        // 1. Generate payload record + prompt class into a temp directory
        // -----------------------------------------------------------------------
        Path gen = tmp.newFolder("gen").toPath();
        Path ws  = tmp.newFolder("ws").toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(
                ws, "prompt-cr", SpringTestFixtures.PROMPT_VO_FIXTURE);

        Map<String, String> args = new HashMap<>();
        args.put("outputDir", gen.toString());

        // Generate the payload record so the prompt class has something to reference
        // in the same package (same-package import, always safe to include).
        SpringPayloadGenerator payloadGen = new SpringPayloadGenerator();
        payloadGen.setArgs(args);
        payloadGen.execute(loader);

        SpringOutputPromptGenerator promptGen = new SpringOutputPromptGenerator();
        promptGen.setArgs(args);
        promptGen.execute(loader);

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

        // Confirm the prompt file is present
        boolean hasPrompt = sources.stream()
                .anyMatch(f -> f.getName().equals("AnswerOutputResponseFormat.java"));
        assertTrue("AnswerOutputResponseFormat.java must be among generated files; got: " + sources, hasPrompt);

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
        // 4. Load the prompt class and invoke renderFormat()
        // -----------------------------------------------------------------------
        //
        // Fixture: PROMPT_VO_FIXTURE — acme::ai → package acme.ai.prompts
        //   template.prompt "AnswerOutput" → AnswerOutputResponseFormat
        //   @format: xml, @promptStyle: guide
        //   rootName = "AnswerOutputPayload"
        //
        try (URLClassLoader cl = new URLClassLoader(
                new URL[]{ classes.toUri().toURL() },
                getClass().getClassLoader())) {

            Class<?> promptClass = cl.loadClass("acme.ai.prompts.AnswerOutputResponseFormat");

            // -----------------------------------------------------------------------
            // 4a. No-arg renderFormat() — guide style
            // -----------------------------------------------------------------------
            Method renderNoArg = promptClass.getMethod("renderFormat");
            String guideFragment = (String) renderNoArg.invoke(null);

            assertNotNull("renderFormat() must return a non-null string", guideFragment);
            assertFalse("renderFormat() must return a non-empty string", guideFragment.isEmpty());

            // Guide style wraps the example skeleton with explanatory prose
            assertTrue("guide fragment must contain 'Respond exactly like this:'; got:\n" + guideFragment,
                guideFragment.contains("Respond exactly like this:"));
            assertTrue("guide fragment must contain '(required)'; got:\n" + guideFragment,
                guideFragment.contains("(required)"));

            // @responseFormat: xml → skeleton uses the RESPONSE record as root element.
            // ADR-0052: the fragment describes the shape of the REPLY, so its root name is
            // AnswerOutputResponse (from @responseRef) — not the @payloadRef request record.
            assertTrue("guide fragment must contain '<AnswerOutputResponse>'; got:\n" + guideFragment,
                guideFragment.contains("<AnswerOutputResponse>"));
            assertTrue("guide fragment must contain '</AnswerOutputResponse>'; got:\n" + guideFragment,
                guideFragment.contains("</AnswerOutputResponse>"));

            // Comment-free — no XML comments emitted
            assertFalse("guide fragment must contain no XML comments; got:\n" + guideFragment,
                guideFragment.contains("<!--"));

            // -----------------------------------------------------------------------
            // 4b. renderFormat(PromptOverrides) with inline-style override — must differ
            // -----------------------------------------------------------------------
            //
            // Load PromptOverrides and PromptStyle from the test classpath (the installed
            // metaobjects-render jar) and construct PromptOverrides(INLINE, {}, {}).
            Class<?> promptStyleClass  = Class.forName("com.metaobjects.render.prompt.PromptStyle");
            Class<?> promptOverridesClass = Class.forName("com.metaobjects.render.prompt.PromptOverrides");

            Object inlineStyle = null;
            for (Object constant : promptStyleClass.getEnumConstants()) {
                if ("INLINE".equals(((Enum<?>) constant).name())) {
                    inlineStyle = constant;
                    break;
                }
            }
            assertNotNull("PromptStyle.INLINE constant not found", inlineStyle);

            Object inlineOverrides = promptOverridesClass
                    .getConstructor(promptStyleClass, Map.class, Map.class)
                    .newInstance(inlineStyle, Map.of(), Map.of());

            Method renderWithOverrides = promptClass.getMethod("renderFormat", promptOverridesClass);
            String inlineFragment = (String) renderWithOverrides.invoke(null, inlineOverrides);

            assertNotNull("renderFormat(PromptOverrides) must return non-null", inlineFragment);
            assertFalse("renderFormat(PromptOverrides) must return non-empty string", inlineFragment.isEmpty());

            // Inline style produces a shorter fragment without guide prose
            assertFalse("inline fragment must NOT contain 'Respond exactly like this:'; got:\n" + inlineFragment,
                inlineFragment.contains("Respond exactly like this:"));
            assertFalse("inline fragment must NOT contain 'Fill in each field'; got:\n" + inlineFragment,
                inlineFragment.contains("Fill in each field"));

            // The two styles must produce different output
            assertNotEquals("guide and inline fragments must differ", guideFragment, inlineFragment);

            // Comment-free
            assertFalse("inline fragment must contain no XML comments; got:\n" + inlineFragment,
                inlineFragment.contains("<!--"));
        }
    }
}

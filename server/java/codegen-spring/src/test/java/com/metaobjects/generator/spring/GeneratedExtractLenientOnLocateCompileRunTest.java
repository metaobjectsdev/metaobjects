package com.metaobjects.generator.spring;

import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.registry.SharedRegistryTestBase;
import com.metaobjects.render.extract.ExtractOptions;
import com.metaobjects.render.extract.Format;
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
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import static org.junit.Assert.*;

/**
 * #364 codegen pass-through proof — the GENERATED output parser's {@code opts} parameter is
 * {@code ExtractOptions} untouched, so the document-level {@code onLocate} hook must reach the
 * engine THROUGH the generated, javac-compiled {@code extractLenient(MetaDataLoader, String,
 * ExtractOptions)} overload, not just the hand-called render-package {@code Extract.extract}
 * tested in {@code ExtractTest.java}. Mirrors {@link GeneratedNestedExtractLenientCompileRunTest}'s
 * generate → compile → classload → invoke harness, reusing the same fixture.
 *
 * <p>{@code ExtractOptions} (and {@code OnLocate}/{@code Format}) are loaded by the JVM's normal
 * classpath — not generated — so the parent-first {@link URLClassLoader} delegation means the test
 * code and the generated+compiled parser class share the exact same {@code Class} object for them;
 * no reflection is needed to construct or pass the options.</p>
 */
public class GeneratedExtractLenientOnLocateCompileRunTest extends SharedRegistryTestBase {

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    @Test
    public void generatedExtractLenientThreadsOptsOnLocateToTheEngine() throws Exception {
        Path gen = tmp.newFolder("gen").toPath();
        Path ws  = tmp.newFolder("ws").toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(
                ws, "extract-onlocate-cr", SpringTestFixtures.EXTRACT_NESTED_FIXTURE);

        Map<String, String> args = new HashMap<>();
        args.put("outputDir", gen.toString());

        SpringValueObjectGenerator payloadGen = new SpringValueObjectGenerator();
        payloadGen.setArgs(args);
        payloadGen.execute(loader);

        SpringOutputParserGenerator parserGen = new SpringOutputParserGenerator();
        parserGen.setArgs(args);
        parserGen.execute(loader);

        List<File> sources;
        try (Stream<Path> s = Files.walk(gen)) {
            sources = s.filter(p -> p.toString().endsWith(".java"))
                       .map(Path::toFile)
                       .collect(Collectors.toList());
        }
        assertFalse("expected generated .java files under " + gen, sources.isEmpty());

        JavaCompiler javac = ToolProvider.getSystemJavaCompiler();
        assertNotNull("JDK (not JRE) required for this test", javac);

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
            }
            fail(sb.toString());
        }

        try (URLClassLoader cl = new URLClassLoader(
                new URL[]{ classes.toUri().toURL() }, getClass().getClassLoader())) {

            Class<?> parserClass = cl.loadClass("acme.ai.prompts.NestedAnswerParser");
            Method extractLenientWithOpts = parserClass.getMethod(
                    "extractLenient", MetaDataLoader.class, String.class, ExtractOptions.class);

            // The default locator would pick the FIRST fenced block (it carries the declared
            // `title` field, #363). onLocate picks the SECOND one instead, proving the option
            // flowed all the way through generated code into the render-package engine.
            String draft = "{\"title\":\"DRAFT\"}";
            String real = "{\"title\":\"Order #7\","
                    + "\"address\":{\"city\":\"Austin\",\"zip\":\"78701\"},"
                    + "\"items\":[{\"sku\":\"A1\",\"qty\":2}]}";
            String dirty = "```json\n" + draft + "\n```\nOn second thought:\n```json\n" + real + "\n```";

            ExtractOptions.OnLocate onLocate = (text, format) -> {
                assertEquals(Format.JSON, format);
                Matcher m = Pattern.compile("```json\\s*\\n([\\s\\S]*?)\\n```").matcher(text);
                String last = null;
                while (m.find()) last = m.group(1);
                return last;
            };
            ExtractOptions withHook = ExtractOptions.defaults().withOnLocate(onLocate);

            Object result = extractLenientWithOpts.invoke(null, loader, dirty, withHook);
            Object payload = result.getClass().getMethod("data").invoke(result);
            Object report  = result.getClass().getMethod("report").invoke(result);

            Object title = payload.getClass().getMethod("title").invoke(payload);
            assertEquals("onLocate's chosen block must win over the default locator's choice",
                    "Order #7", title);

            @SuppressWarnings("unchecked")
            List<Object> coercions =
                    (List<Object>) report.getClass().getMethod("coercions").invoke(report);
            boolean sawOnLocate = coercions.stream().anyMatch(c -> {
                try {
                    return "onLocate".equals(c.getClass().getMethod("kind").invoke(c));
                } catch (ReflectiveOperationException e) {
                    throw new RuntimeException(e);
                }
            });
            assertTrue("report must carry an onLocate coercion entry when the generated parser "
                    + "is given opts.onLocate", sawOnLocate);
        }
    }
}

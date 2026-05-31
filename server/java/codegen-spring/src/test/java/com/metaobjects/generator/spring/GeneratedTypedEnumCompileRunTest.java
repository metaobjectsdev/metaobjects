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
 * Typed-enums payload-VO proof (Java port): the STRICT {@code <Name>Payload} record types a
 * {@code field.enum} component as a generated nested Java {@code enum} (single → {@code Priority};
 * array → {@code List<Labels>}) instead of {@code String}, and the extract mapper coerces the
 * engine-validated member string via {@code <Payload>.<Enum>.valueOf(...)}.
 *
 * <p>Each test generates the payload record + the output parser, compiles them in-memory
 * ({@code render}/{@code om} on the test classpath), loads the parser, invokes the
 * runtime-delegating {@code extractLenient(loader, dirty)}, and asserts via reflection that:</p>
 * <ul>
 *   <li>the payload {@code priority} accessor's return type {@link Class#isEnum() is an enum}
 *       named {@code Priority}, with value the {@code HIGH} constant;</li>
 *   <li>{@code labels} is a {@code List} of the generated {@code Labels} enum, members [A, B];</li>
 *   <li>a shared abstract {@code field.enum} extended by two fields emits EXACTLY ONE nested
 *       {@code enum Priority} (named for the super), and both fields are typed {@code Priority}.</li>
 * </ul>
 *
 * <p><b>Java structural note.</b> Unlike the C#/Kotlin/TS/Python ports, the Java port has no
 * separate all-nullable {@code <Name>Extracted} string mirror — {@code <Name>Payload} is the
 * single typed record returned by both {@code parse(...)} and {@code extractLenient(...)}. So the
 * "lenient mirror stays string" cross-port note is N/A here; the value-constrained enum type is
 * shared, and the mapper coerces the string the engine produced. The engine ({@code render}/{@code om})
 * and the {@code extract-conformance} corpus are unchanged — only codegen types + coercion change.</p>
 */
public class GeneratedTypedEnumCompileRunTest extends SharedRegistryTestBase {

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    @Test
    public void strictPayloadEnumIsTypedAndArrayCoercesViaValueOf() throws Exception {
        Path gen = tmp.newFolder("gen-typed-enum").toPath();
        Path ws  = tmp.newFolder("ws-typed-enum").toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(
                ws, "typed-enum", SpringTestFixtures.TYPED_ENUM_FIXTURE);

        generate(loader, gen);
        Path classes = compile(gen);

        try (URLClassLoader cl = new URLClassLoader(
                new URL[]{ classes.toUri().toURL() }, getClass().getClassLoader())) {

            // The payload component types are the generated nested enums.
            Class<?> payloadClass = cl.loadClass("acme.ai.prompts.OrderPayload");
            Class<?> priorityReturn = payloadClass.getMethod("priority").getReturnType();
            assertTrue("strict priority component must be a generated enum, not String; was "
                    + priorityReturn, priorityReturn.isEnum());
            assertEquals("nested enum must be named <OwnerShort><FieldPascal> = OrderPayloadPriority",
                    "OrderPayloadPriority", priorityReturn.getSimpleName());

            Class<?> labelsEnum = cl.loadClass("acme.ai.prompts.OrderPayload$OrderPayloadLabels");
            assertTrue("Labels must be a generated enum", labelsEnum.isEnum());
            assertEquals("Labels members verbatim [A, B]",
                    List.of("A", "B"),
                    Stream.of(labelsEnum.getEnumConstants()).map(e -> ((Enum<?>) e).name())
                          .collect(Collectors.toList()));

            // Drive the runtime-delegating extract on dirty input and assert coerced enum values.
            Class<?> parserClass = cl.loadClass("acme.ai.prompts.OrderParser");
            Method extractLenient = parserClass.getMethod("extractLenient", MetaDataLoader.class, String.class);

            String dirty = "Sure!\n```json\n"
                    + "{\"title\":\"T1\",\"priority\":\"HIGH\",\"labels\":[\"A\",\"B\"]}\n```\nDone.";
            Object result = extractLenient.invoke(null, loader, dirty);
            Object payload = result.getClass().getMethod("data").invoke(result);

            // priority coerced to the HIGH enum constant (an enum instance, not a String).
            Object priority = payload.getClass().getMethod("priority").invoke(payload);
            assertNotNull("priority must populate", priority);
            assertTrue("priority must be an enum instance (valueOf coercion); was " + priority.getClass(),
                    priority.getClass().isEnum());
            assertEquals("priority must coerce to Priority.HIGH", "HIGH", ((Enum<?>) priority).name());

            // labels: a List of the generated Labels enum, coerced element-wise.
            Object labels = payload.getClass().getMethod("labels").invoke(payload);
            assertTrue("labels must be a List", labels instanceof List);
            List<?> labelList = (List<?>) labels;
            assertEquals("labels size", 2, labelList.size());
            assertTrue("each labels element must be a Labels enum instance",
                    labelList.stream().allMatch(e -> e != null && e.getClass().isEnum()));
            assertEquals("labels coerced element-wise via valueOf",
                    List.of("A", "B"),
                    labelList.stream().map(e -> ((Enum<?>) e).name()).collect(Collectors.toList()));

            // Never-throws contract: input missing BOTH enum fields must NOT NPE on valueOf(null)
            // — the scalar enum stays null and the enum array maps to an empty list.
            Object absent = extractLenient.invoke(null, loader, "{\"title\":\"T2\"}");
            Object absentPayload = absent.getClass().getMethod("data").invoke(absent);
            assertNull("absent scalar enum must stay null (null-safe valueOf), not throw",
                    absentPayload.getClass().getMethod("priority").invoke(absentPayload));
            Object absentLabels = absentPayload.getClass().getMethod("labels").invoke(absentPayload);
            assertTrue("absent enum array must map to an empty List (no NPE)",
                    absentLabels instanceof List && ((List<?>) absentLabels).isEmpty());
        }
    }

    @Test
    public void sharedAbstractEnumEmitsOneTypeNamedForSuperUsedByBothFields() throws Exception {
        Path gen = tmp.newFolder("gen-shared-enum").toPath();
        Path ws  = tmp.newFolder("ws-shared-enum").toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(
                ws, "shared-enum", SpringTestFixtures.SHARED_ENUM_FIXTURE);

        generate(loader, gen);

        // The source must declare EXACTLY ONE nested enum named for the super (Priority), not
        // <Owner><Field> (CurrentPriority / PreviousPriority).
        String src = Files.readString(gen.resolve("acme/orders/prompts/TicketPayload.java"));
        int firstDecl = src.indexOf("public enum Priority {");
        assertTrue("must emit a nested `public enum Priority`; saw:\n" + src, firstDecl >= 0);
        assertEquals("must emit EXACTLY ONE `enum Priority` (deduped); saw:\n" + src,
                firstDecl, src.lastIndexOf("public enum Priority {"));
        assertFalse("must NOT name the enum <Owner><Field>; saw:\n" + src,
                src.contains("public enum CurrentPriority")
                        || src.contains("public enum PreviousPriority"));

        Path classes = compile(gen);
        try (URLClassLoader cl = new URLClassLoader(
                new URL[]{ classes.toUri().toURL() }, getClass().getClassLoader())) {

            Class<?> payloadClass = cl.loadClass("acme.orders.prompts.TicketPayload");
            Class<?> current = payloadClass.getMethod("currentPriority").getReturnType();
            Class<?> previous = payloadClass.getMethod("previousPriority").getReturnType();
            assertTrue("currentPriority must be an enum", current.isEnum());
            assertEquals("both fields share ONE enum named Priority", "Priority", current.getSimpleName());
            assertSame("both fields must be typed by the SAME shared enum class", current, previous);
        }
    }

    // -----------------------------------------------------------------------------------------
    // shared harness
    // -----------------------------------------------------------------------------------------

    private static void generate(MetaDataLoader loader, Path gen) {
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", gen.toString());

        SpringPayloadGenerator payloadGen = new SpringPayloadGenerator();
        payloadGen.setArgs(args);
        payloadGen.execute(loader);

        SpringOutputParserGenerator parserGen = new SpringOutputParserGenerator();
        parserGen.setArgs(args);
        parserGen.execute(loader);
    }

    private Path compile(Path gen) throws Exception {
        List<File> sources;
        try (Stream<Path> s = Files.walk(gen)) {
            sources = s.filter(p -> p.toString().endsWith(".java"))
                       .map(Path::toFile)
                       .collect(Collectors.toList());
        }
        assertFalse("expected generated .java files under " + gen, sources.isEmpty());

        JavaCompiler javac = ToolProvider.getSystemJavaCompiler();
        assertNotNull("JDK (not JRE) required — getSystemJavaCompiler() returned null", javac);

        Path classes = tmp.newFolder("classes-" + gen.getFileName()).toPath();
        String cp = System.getProperty("java.class.path");
        DiagnosticCollector<JavaFileObject> diags = new DiagnosticCollector<>();
        var fm = javac.getStandardFileManager(diags, null, null);
        List<String> opts = List.of("-classpath", cp, "-d", classes.toString());

        boolean ok = javac.getTask(null, fm, diags, opts, null,
                fm.getJavaFileObjectsFromFiles(sources)).call();
        if (!ok) {
            StringBuilder sb = new StringBuilder("generated sources failed to compile:\n");
            for (var d : diags.getDiagnostics()) {
                sb.append("  ").append(d.getKind()).append(": ").append(d.getMessage(null)).append('\n');
                if (d.getSource() != null) {
                    sb.append("    at ").append(d.getSource().getName())
                      .append(':').append(d.getLineNumber()).append('\n');
                }
            }
            for (File src : sources) {
                sb.append("\n=== ").append(src.getName()).append(" ===\n");
                sb.append(Files.readString(src.toPath())).append('\n');
            }
            fail(sb.toString());
        }
        return classes;
    }
}

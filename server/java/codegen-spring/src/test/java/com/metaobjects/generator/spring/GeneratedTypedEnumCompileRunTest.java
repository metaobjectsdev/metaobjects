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
 * Typed-enums proof (Java port): the value object's own record — the payload a template
 * renders and the reply a responding prompt parses into (ADR-0056) — types a {@code field.enum}
 * component as a generated nested Java {@code enum} (single → {@code Priority}; array →
 * {@code List<Labels>}) instead of {@code String}, and the extract mapper coerces the
 * engine-validated member string via {@code <Vo>.<Enum>.valueOf(...)}.
 *
 * <p>Each test generates the value-object record + the output parser, compiles them in-memory
 * ({@code render}/{@code om} on the test classpath), loads the parser, invokes the
 * runtime-delegating {@code extractLenient(loader, dirty)}, and asserts via reflection that:</p>
 * <ul>
 *   <li>the record's {@code priority} accessor's return type {@link Class#isEnum() is an enum}
 *       named {@code <Owner><Field>}, with value the {@code HIGH} constant;</li>
 *   <li>{@code labels} is a {@code List} of the generated {@code Labels} enum, members [A, B];</li>
 *   <li>a shared abstract {@code field.enum} extended by two fields is ONE top-level
 *       {@code enum Priority} both fields are typed by; the DTO generator owns that file, and
 *       the value-object generator writes it only under {@code emitSharedEnums=true}.</li>
 * </ul>
 *
 * <p><b>Java structural note.</b> Unlike the C#/Kotlin/TS/Python ports, the Java port has no
 * separate all-nullable {@code <Name>Extracted} string mirror — the value object's record is
 * the single typed record returned by both {@code parse(...)} and {@code extractLenient(...)}.</p>
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
            Class<?> payloadClass = cl.loadClass("acme.ai.OrderPayload");
            Class<?> priorityReturn = payloadClass.getMethod("priority").getReturnType();
            assertTrue("strict priority component must be a generated enum, not String; was "
                    + priorityReturn, priorityReturn.isEnum());
            assertEquals("nested enum must be named <OwnerShort><FieldPascal> = OrderPayloadPriority",
                    "OrderPayloadPriority", priorityReturn.getSimpleName());

            Class<?> labelsEnum = cl.loadClass("acme.ai.OrderPayload$OrderPayloadLabels");
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

        // No DTO generator in this run, so the value-object generator is asked to write the
        // shared enum files it references (emitSharedEnums=true).
        generate(loader, gen, Map.of(Fr019SharedEnum.ARG_EMIT_SHARED_ENUMS, "true"));

        // The value object REFERENCES the shared declaration (ADR-0026 amendment: no condition on
        // the hosting object's subtype), so its record declares no enum of its own and the
        // shared type is emitted exactly once, as its own file.
        String src = Files.readString(gen.resolve("acme/orders/TicketPayload.java"));
        assertFalse("the record must reference the shared enum, not nest one; saw:\n" + src,
                src.contains("enum "));
        String shared = Files.readString(gen.resolve("acme/orders/Priority.java"));
        int firstDecl = shared.indexOf("public enum Priority {");
        assertTrue("must emit a standalone `public enum Priority`; saw:\n" + shared, firstDecl >= 0);
        assertEquals("must emit EXACTLY ONE `enum Priority`; saw:\n" + shared,
                firstDecl, shared.lastIndexOf("public enum Priority {"));

        Path classes = compile(gen);
        try (URLClassLoader cl = new URLClassLoader(
                new URL[]{ classes.toUri().toURL() }, getClass().getClassLoader())) {

            Class<?> payloadClass = cl.loadClass("acme.orders.TicketPayload");
            Class<?> current = payloadClass.getMethod("currentPriority").getReturnType();
            Class<?> previous = payloadClass.getMethod("previousPriority").getReturnType();
            assertTrue("currentPriority must be an enum", current.isEnum());
            assertEquals("both fields share ONE enum named Priority", "Priority", current.getSimpleName());
            assertSame("both fields must be typed by the SAME shared enum class", current, previous);
        }
    }

    @Test
    public void valueObjectRunWritesNoSharedEnumFileByDefault() throws Exception {
        Path gen = tmp.newFolder("gen-shared-enum-default").toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(
                tmp.newFolder("ws-shared-enum-default").toPath(), "shared-enum-default",
                SpringTestFixtures.SHARED_ENUM_FIXTURE);

        generate(loader, gen);

        // The DTO generator owns shared enum files; without the opt-in neither the
        // value-object nor the output-parser generator writes one.
        assertEquals("no Priority.java without emitSharedEnums", List.of(), filesNamed("Priority.java", gen));
        // The record still REFERENCES the shared type and nests no copy.
        String src = Files.readString(gen.resolve("acme/orders/TicketPayload.java"));
        assertTrue("record must be typed by the shared enum; saw:\n" + src, src.contains("Priority currentPriority"));
        assertFalse("record must not nest an enum; saw:\n" + src, src.contains("enum "));
    }

    /**
     * The DTO and value-object generators write to SEPARATE output directories, and a build
     * compiles both roots together (the Maven plugin registers each as a compile source root).
     * One shared enum is reached by an entity and by a value object: exactly one
     * {@code Priority.java} may exist across the two roots, or javac reports a duplicate class.
     */
    @Test
    public void splitOutputDirectoriesHoldOneSharedEnumFileAndCompileTogether() throws Exception {
        String fixture = """
            {
              "metadata.root": { "package": "acme::orders", "children": [
                { "field.enum": { "name": "Priority", "abstract": true, "@values": ["LOW","HIGH"] } },
                { "object.entity": { "name": "Ticket", "children": [
                    { "field.long": { "name": "id" } },
                    { "field.enum": { "name": "priority", "extends": "Priority" } },
                    { "source.rdb": { "@table": "tickets" } },
                    { "identity.primary": { "name": "pk", "@fields": ["id"] } }
                ] } },
                { "object.value": { "name": "TicketPayload", "children": [
                    { "field.enum": { "name": "priority", "extends": "Priority" } }
                ] } }
              ] }
            }
            """;
        MetaDataLoader loader = SpringTestFixtures.loadFixture(
                tmp.newFolder("ws-split").toPath(), "split-output-dirs", fixture);
        Path dtoOut = tmp.newFolder("gen-split-dto").toPath();
        Path voOut = tmp.newFolder("gen-split-vo").toPath();

        SpringDtoGenerator dtoGen = new SpringDtoGenerator();
        dtoGen.setArgs(Map.of("outputDir", dtoOut.toString()));
        dtoGen.execute(loader);
        SpringValueObjectGenerator voGen = new SpringValueObjectGenerator();
        voGen.setArgs(Map.of("outputDir", voOut.toString()));
        voGen.execute(loader);

        assertEquals("exactly one Priority.java, in the DTO generator's directory",
                List.of(dtoOut.resolve("acme/orders/Priority.java")), filesNamed("Priority.java", dtoOut, voOut));

        Path classes = compile(dtoOut, voOut);
        try (URLClassLoader cl = new URLClassLoader(
                new URL[]{ classes.toUri().toURL() }, getClass().getClassLoader())) {
            Class<?> viaDto = cl.loadClass("acme.orders.TicketDto").getMethod("priority").getReturnType();
            Class<?> viaVo = cl.loadClass("acme.orders.TicketPayload").getMethod("priority").getReturnType();
            assertEquals("acme.orders.Priority", viaDto.getName());
            assertSame("the DTO and the value object must be typed by the SAME enum class", viaDto, viaVo);
        }
    }

    // -----------------------------------------------------------------------------------------
    // shared harness
    // -----------------------------------------------------------------------------------------

    private static void generate(MetaDataLoader loader, Path gen) {
        generate(loader, gen, Map.of());
    }

    /** Value-object + output-parser run; {@code valueObjectArgs} are extra args for the former. */
    private static void generate(MetaDataLoader loader, Path gen, Map<String, String> valueObjectArgs) {
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", gen.toString());

        Map<String, String> payloadArgs = new HashMap<>(args);
        payloadArgs.putAll(valueObjectArgs);
        SpringValueObjectGenerator payloadGen = new SpringValueObjectGenerator();
        payloadGen.setArgs(payloadArgs);
        payloadGen.execute(loader);

        SpringOutputParserGenerator parserGen = new SpringOutputParserGenerator();
        parserGen.setArgs(args);
        parserGen.execute(loader);
    }

    private static List<Path> filesNamed(String fileName, Path... roots) throws Exception {
        List<Path> found = new java.util.ArrayList<>();
        for (Path root : roots) {
            try (Stream<Path> s = Files.walk(root)) {
                s.filter(p -> p.getFileName().toString().equals(fileName)).forEach(found::add);
            }
        }
        return found;
    }

    /** Compile every generated root TOGETHER, as a build with several source roots does. */
    private Path compile(Path... gens) throws Exception {
        List<File> sources = new java.util.ArrayList<>();
        for (Path gen : gens) {
            try (Stream<Path> s = Files.walk(gen)) {
                s.filter(p -> p.toString().endsWith(".java")).map(Path::toFile).forEach(sources::add);
            }
        }
        assertFalse("expected generated .java files under " + List.of(gens), sources.isEmpty());

        JavaCompiler javac = ToolProvider.getSystemJavaCompiler();
        assertNotNull("JDK (not JRE) required — getSystemJavaCompiler() returned null", javac);

        Path classes = tmp.newFolder("classes-" + gens[0].getFileName()).toPath();
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

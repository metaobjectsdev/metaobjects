package com.metaobjects.generator.spring;

import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.metaobjects.generator.GeneratorException;
import com.metaobjects.generator.requirement.RenderedTest;
import com.metaobjects.generator.requirement.RequirementTestArgs;
import com.metaobjects.generator.requirement.RequirementTestRenderer;
import com.metaobjects.generator.util.GeneratedFileWriter;
import com.metaobjects.loader.DirectorySource;
import com.metaobjects.loader.LoaderOptions;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.requirement.RequirementTestFilter;
import com.metaobjects.requirement.RequirementTestIdentities;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import org.slf4j.LoggerFactory;

import javax.tools.Diagnostic;
import javax.tools.DiagnosticCollector;
import javax.tools.JavaCompiler;
import javax.tools.JavaFileObject;
import javax.tools.StandardJavaFileManager;
import javax.tools.StandardLocation;
import javax.tools.ToolProvider;
import java.io.IOException;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeSet;
import java.util.stream.Stream;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

/**
 * {@link JUnitRequirementTestsGenerator}: the files it writes for the identity corpus's
 * {@code worked-example}, that the output COMPILES and behaves (a live test with no witness
 * fails, with one it passes), that author prose cannot break it, and every refusal and seam of
 * Table I. The repository's own tests are JUnit 4; the tests this generator WRITES are Jupiter.
 */
public class JUnitRequirementTestsGeneratorTest {

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    private static final String TEST_PACKAGE = "com.acme.req";
    private static final String WITNESS_CLASS = "com.acme.Witnesses";

    // ---------------------------------------------------------------- fixtures

    private static Path repoRoot() {
        for (Path p = Path.of("").toAbsolutePath(); p != null; p = p.getParent()) {
            if (Files.isDirectory(p.resolve("fixtures")) && Files.isDirectory(p.resolve("server"))) return p;
        }
        throw new IllegalStateException("repo root not found");
    }

    private static Path workedExampleInput() {
        return repoRoot().resolve("fixtures/requirement-test-identity-conformance/worked-example/input");
    }

    private static MetaDataLoader loadDir(Path dir) throws IOException {
        MetaDataLoader loader = new MetaDataLoader(LoaderOptions.create(false, false, true),
            MetaDataLoader.SUBTYPE_MANUAL, "requirement_tests_" + System.nanoTime());
        loader.init();
        loader.load(new DirectorySource(dir, new DirectorySource.Options()).expandToList());
        assertTrue("strict load: " + loader.getErrors(), loader.getErrors().isEmpty());
        return loader;
    }

    private MetaDataLoader loadYaml(String yaml) throws IOException {
        Path dir = tmp.newFolder().toPath();
        Files.writeString(dir.resolve("meta.shop.yaml"), yaml, StandardCharsets.UTF_8);
        return loadDir(dir);
    }

    private static String requirement(String name, int level, String status, String statement, String counterexample, String implementedBy) {
        return "    - requirement.functional:\n"
            + "        name: " + name + "\n        level: " + level + "\n        status: " + status + "\n"
            + "        statement: " + statement + "\n        counterexample: " + counterexample + "\n"
            + (implementedBy == null ? "" : "        implementedBy: [" + implementedBy + "]\n");
    }

    private static final String ORDER_ENTITY =
        "    - object.entity:\n        name: Order\n        children:\n"
        + "          - field.uuid: { name: id }\n          - field.string: { name: total }\n"
        + "          - identity.primary: { name: pk, fields: [id] }\n";

    private static String shop(String... requirements) {
        return "metadata:\n  package: acme::shop\n  children:\n" + ORDER_ENTITY + String.join("", requirements);
    }

    /** The args of a real run, with {@code warnUncovered} left at its default. */
    private Map<String, String> realArgs(Path out) {
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", out.toString());
        args.put("testPackage", TEST_PACKAGE);
        args.put("witnessClass", WITNESS_CLASS);
        return args;
    }

    /**
     * Runs {@code block} with the generator's logger diverted into a list, so a warning a test
     * provokes neither reaches the console nor goes unchecked: returns what was logged.
     */
    private static List<String> captureLog(Runnable block) {
        ch.qos.logback.classic.Logger logger =
            (ch.qos.logback.classic.Logger) LoggerFactory.getLogger(JUnitRequirementTestsGenerator.class);
        ListAppender<ILoggingEvent> appender = new ListAppender<>();
        appender.start();
        boolean wasAdditive = logger.isAdditive();
        logger.setAdditive(false);
        logger.addAppender(appender);
        try {
            block.run();
        } finally {
            logger.detachAppender(appender);
            logger.setAdditive(wasAdditive);
        }
        List<String> messages = new ArrayList<>();
        for (ILoggingEvent e : appender.list) messages.add(e.getFormattedMessage());
        return messages;
    }

    /** Runs {@code gen} over {@code loader} and returns what it logged. */
    private static List<String> logged(JUnitRequirementTestsGenerator gen, MetaDataLoader loader) {
        return captureLog(() -> gen.execute(loader));
    }

    private JUnitRequirementTestsGenerator generator(Path out, Map<String, String> extra) {
        Map<String, String> args = realArgs(out);
        // The worked example has an L3 requirement the default filter drops, so most tests would
        // log the uncovered warning. Only the tests that are about it switch it on.
        args.put("warnUncovered", "false");
        args.putAll(extra);
        JUnitRequirementTestsGenerator gen = new JUnitRequirementTestsGenerator();
        gen.setArgs(args);
        return gen;
    }

    private Path run(MetaDataLoader loader, Map<String, String> extra) throws IOException {
        Path out = tmp.newFolder().toPath();
        generator(out, extra).execute(loader);
        return out;
    }

    private static String read(Path out, String file) throws IOException {
        return Files.readString(out.resolve("com/acme/req").resolve(file), StandardCharsets.UTF_8);
    }

    private static TreeSet<String> files(Path out) throws IOException {
        TreeSet<String> names = new TreeSet<>();
        try (Stream<Path> s = Files.walk(out)) {
            s.filter(Files::isRegularFile).forEach(p -> names.add(out.relativize(p).toString().replace('\\', '/')));
        }
        return names;
    }

    // ---------------------------------------------------------------- compile and run

    private static final String WITNESS_NONE =
        "package com.acme;\npublic class Witnesses implements com.acme.req.Requirements_acme_shop_Witnesses {}\n";

    private static final String WITNESS_RECORDED =
        "package com.acme;\npublic class Witnesses implements com.acme.req.Requirements_acme_shop_Witnesses {\n"
        + "  @Override public void req_acme_shop_Orders_Recorded__object_entity() { }\n}\n";

    /** What the compiler said about a tree: whether it built, its diagnostics, and where the classes went. */
    private record Compiled(boolean ok, String errors, Path classes) {}

    /** Compile the generated tree plus hand-written sources with the real compiler; return a loader over the classes. */
    private URLClassLoader compile(Path generated, Map<String, String> handWritten) throws IOException {
        Compiled c = tryCompile(generated, handWritten);
        assertTrue("generated requirement tests failed to compile:\n" + c.errors(), c.ok());
        return new URLClassLoader(new URL[]{c.classes().toUri().toURL()}, getClass().getClassLoader());
    }

    private Compiled tryCompile(Path generated, Map<String, String> handWritten) throws IOException {
        List<java.io.File> sources = new ArrayList<>();
        try (Stream<Path> s = Files.walk(generated)) {
            s.filter(p -> p.toString().endsWith(".java")).forEach(p -> sources.add(p.toFile()));
        }
        Path hand = tmp.newFolder().toPath();
        for (Map.Entry<String, String> e : handWritten.entrySet()) {
            Path f = hand.resolve(e.getKey().replace('.', '/') + ".java");
            Files.createDirectories(f.getParent());
            Files.writeString(f, e.getValue(), StandardCharsets.UTF_8);
            sources.add(f.toFile());
        }
        Path classes = tmp.newFolder().toPath();
        JavaCompiler javac = ToolProvider.getSystemJavaCompiler();
        DiagnosticCollector<JavaFileObject> diagnostics = new DiagnosticCollector<>();
        try (StandardJavaFileManager fm = javac.getStandardFileManager(diagnostics, null, StandardCharsets.UTF_8)) {
            fm.setLocation(StandardLocation.CLASS_OUTPUT, List.of(classes.toFile()));
            boolean ok = javac.getTask(null, fm, diagnostics,
                List.of("-classpath", System.getProperty("java.class.path"), "-encoding", "UTF-8", "-Xlint:all", "-Werror"),
                null, fm.getJavaFileObjectsFromFiles(sources)).call();
            StringBuilder errs = new StringBuilder();
            for (Diagnostic<? extends JavaFileObject> d : diagnostics.getDiagnostics()) errs.append(d).append('\n');
            return new Compiled(ok, errs.toString(), classes);
        }
    }

    /** Invoke one generated test method; returns the AssertionError it threw, or null. */
    private static AssertionError invoke(ClassLoader cl, String testClass, String method) throws Exception {
        Class<?> c = cl.loadClass(TEST_PACKAGE + "." + testClass);
        Object instance = c.getDeclaredConstructor().newInstance();
        Method m = c.getDeclaredMethod(method);
        m.setAccessible(true);
        try {
            m.invoke(instance);
            return null;
        } catch (InvocationTargetException e) {
            if (e.getCause() instanceof AssertionError) return (AssertionError) e.getCause();
            throw e;
        }
    }

    // ---------------------------------------------------------------- the worked example

    @Test
    public void workedExampleEmitsTheWitnessInterfaceAndTheTestClassInTheTestPackage() throws Exception {
        Path out = run(loadDir(workedExampleInput()), Map.of());
        assertEquals(new TreeSet<>(List.of("com/acme/req/Requirements_acme_shop_Test.java",
            "com/acme/req/Requirements_acme_shop_Witnesses.java")), files(out));
    }

    @Test
    public void bothFilesNameTheWitnessClassInTheirHeader() throws Exception {
        Path out = run(loadDir(workedExampleInput()), Map.of());
        String iface = read(out, "Requirements_acme_shop_Witnesses.java");
        String test = read(out, "Requirements_acme_shop_Test.java");
        assertTrue(iface, iface.contains("// Witnesses are project-owned: implement this interface in com.acme.Witnesses"
            + " and override the members it has witnesses for, each annotated with @Override: a witness whose requirement"
            + " is retired or deleted then stops compiling instead of going stale silently.\n"));
        assertTrue(test, test.contains("// The witnesses are project-owned, in com.acme.Witnesses.\n"));
        assertTrue(iface, iface.startsWith("// GENERATED by metaobjects (requirement-tests). DO NOT EDIT: this file is rewritten whole.\n"));
    }

    @Test
    public void testsAreEmittedSortedByIdWhateverOrderTheyAreDeclaredIn() throws Exception {
        // Declared Zeta, Mid, Alpha, with Alpha's child after it: not in id order.
        MetaDataLoader loader = loadYaml(shop(
            requirement("Zeta", 4, "live", "Z.", "Z!", "Order"),
            requirement("Mid", 4, "live", "M.", "M!", "Order"),
            requirement("Alpha", 4, "live", "A.", "A!", "Order")));
        Path out = run(loader, Map.of());
        for (String file : List.of("Requirements_acme_shop_Test.java", "Requirements_acme_shop_Witnesses.java")) {
            String src = read(out, file);
            int alpha = src.indexOf("// acme::shop::Alpha [object.entity]");
            int mid = src.indexOf("// acme::shop::Mid [object.entity]");
            int zeta = src.indexOf("// acme::shop::Zeta [object.entity]");
            assertTrue(file + ": all three present", alpha >= 0 && mid >= 0 && zeta >= 0);
            assertTrue(file + ": Alpha, Mid, Zeta in that order", alpha < mid && mid < zeta);
        }
    }

    @Test
    public void theInterfaceHasAMemberForTheLiveTestAndNoneForTheSkippedOne() throws Exception {
        String iface = read(run(loadDir(workedExampleInput()), Map.of()), "Requirements_acme_shop_Witnesses.java");
        assertTrue(iface, iface.contains("default void req_acme_shop_Orders_Recorded__object_entity()"));
        assertFalse(iface, iface.contains("req_acme_shop_Orders_Refunded"));
        assertTrue(iface, iface.contains("package com.acme.req;"));
    }

    @Test
    public void theSkippedTestIsDisabledWithTheTableHReasonAndHasNoBody() throws Exception {
        String test = read(run(loadDir(workedExampleInput()), Map.of()), "Requirements_acme_shop_Test.java");
        assertTrue(test, test.contains("@Disabled(\"planned - not built yet\")\n    void req_acme_shop_Orders_Refunded() {\n    }"));
        assertTrue(test, test.contains("private final Requirements_acme_shop_Witnesses witnesses = new com.acme.Witnesses();"));
        assertTrue(test, test.contains("witnesses.req_acme_shop_Orders_Recorded__object_entity();"));
        // The comments above a test: id, statement, counterexample, status, claims, digest.
        assertTrue(test, test.contains("    // acme::shop::Orders.Recorded [object.entity]\n"
            + "    // An order is recorded when it is placed.\n"
            + "    // Counterexample: A placed order has no row.\n"
            + "    // Status: live\n"
            + "    // Claims: Order  (object.entity)\n"
            + "    // Digest: 2714aa3925a47959aa5e48ae39d80ed203fd4e2caa046a90aab9e04691d9881a\n"));
        assertTrue(test, test.contains("// Claims: (none)"));
    }

    @Test
    public void theOutputImportsOnlyJunitJupiterApiAndNothingFromMetaObjects() throws Exception {
        Path out = run(loadDir(workedExampleInput()), Map.of());
        for (String file : files(out)) {
            String src = Files.readString(out.resolve(file), StandardCharsets.UTF_8);
            for (String line : src.split("\n")) {
                if (line.startsWith("import ")) {
                    assertTrue(file + ": " + line, line.startsWith("import org.junit.jupiter.api."));
                }
            }
            assertFalse(file, src.contains("com.metaobjects"));
            assertFalse(file + " names the generator's own class", src.contains("JUnitRequirementTestsGenerator"));
        }
    }

    @Test
    public void outputCarriesTheGeneratedMarkerAndIsByteIdenticalOnARerun() throws Exception {
        MetaDataLoader loader = loadDir(workedExampleInput());
        Path a = run(loader, Map.of());
        Path b = run(loader, Map.of());
        for (String file : files(a)) {
            String src = Files.readString(a.resolve(file), StandardCharsets.UTF_8);
            assertTrue(file, GeneratedFileWriter.looksGenerated(src));
            assertEquals(src, Files.readString(b.resolve(file), StandardCharsets.UTF_8));
        }
    }

    @Test
    public void aLiveTestWithNoWitnessFailsNamingTheCounterexample() throws Exception {
        URLClassLoader cl = compile(run(loadDir(workedExampleInput()), Map.of()), Map.of(WITNESS_CLASS, WITNESS_NONE));
        AssertionError e = invoke(cl, "Requirements_acme_shop_Test", "req_acme_shop_Orders_Recorded__object_entity");
        assertNotNull("a live test must fail until a witness is written", e);
        assertTrue(e.getMessage(), e.getMessage().contains("unimplemented requirement:"));
        assertTrue(e.getMessage(), e.getMessage().contains("A placed order has no row."));
        assertEquals("unimplemented requirement: acme::shop::Orders.Recorded [object.entity] - write com.acme.Witnesses."
            + "req_acme_shop_Orders_Recorded__object_entity() so that it fails when: A placed order has no row.", e.getMessage());
    }

    @Test
    public void aLiveTestPassesWhenTheWitnessClassOverridesItAndASkippedTestRunsEmpty() throws Exception {
        URLClassLoader cl = compile(run(loadDir(workedExampleInput()), Map.of()), Map.of(WITNESS_CLASS, WITNESS_RECORDED));
        assertEquals(null, invoke(cl, "Requirements_acme_shop_Test", "req_acme_shop_Orders_Recorded__object_entity"));
        assertEquals(null, invoke(cl, "Requirements_acme_shop_Test", "req_acme_shop_Orders_Refunded"));
        // Without @Test JUnit discovers nothing and the adopter's build stays green.
        Class<?> testClass = cl.loadClass(TEST_PACKAGE + ".Requirements_acme_shop_Test");
        assertNotNull("the live test is a @Test", testClass.getDeclaredMethod("req_acme_shop_Orders_Recorded__object_entity")
            .getAnnotation(org.junit.jupiter.api.Test.class));
        assertNotNull("the skipped test is a @Test too", testClass.getDeclaredMethod("req_acme_shop_Orders_Refunded")
            .getAnnotation(org.junit.jupiter.api.Test.class));
    }

    @Test
    public void aRetiredTestSaysTheCapabilityMustStayRemoved() throws Exception {
        MetaDataLoader loader = loadYaml(shop(requirement("Gone", 4, "retired", "Old thing.", "Old thing returns.", null)));
        String test = read(run(loader, Map.of()), "Requirements_acme_shop_Test.java");
        assertTrue(test, test.contains("@Disabled(\"retired - the capability was deliberately removed; assert it stays removed\")"));
        // Every test of the package is skipped: no witness member and no Disabled-free import drift.
        assertFalse(read(run(loader, Map.of()), "Requirements_acme_shop_Witnesses.java").contains("default void"));
    }

    // ---------------------------------------------------------------- orphan witnesses

    /** A witness for the live Recorded test and, as a stale leftover, one for Gone, which the model retired. */
    private static String witnessWithStaleGone(String annotation) {
        return "package com.acme;\npublic class Witnesses implements com.acme.req.Requirements_acme_shop_Witnesses {\n"
            + "  @Override public void req_acme_shop_Recorded__object_entity() { }\n"
            + "  " + annotation + " public void req_acme_shop_Gone() { }\n}\n";
    }

    private Path retiredGoneModelOutput() throws IOException {
        return run(loadYaml(shop(
            requirement("Recorded", 4, "live", "S.", "C.", "Order"),
            requirement("Gone", 4, "retired", "Old thing.", "Old thing returns.", null))), Map.of());
    }

    @Test
    public void aStaleOverrideForARetiredRequirementStopsCompilingWhenItIsAnnotatedOverride() throws Exception {
        Path out = retiredGoneModelOutput();
        assertFalse("a retired requirement has no member", read(out, "Requirements_acme_shop_Witnesses.java").contains("req_acme_shop_Gone"));
        // Control: the same witness without the stale method builds, so the failure below is the stale member.
        Compiled control = tryCompile(out, Map.of(WITNESS_CLASS,
            "package com.acme;\npublic class Witnesses implements com.acme.req.Requirements_acme_shop_Witnesses {\n"
                + "  @Override public void req_acme_shop_Recorded__object_entity() { }\n}\n"));
        assertTrue(control.errors(), control.ok());

        Compiled stale = tryCompile(out, Map.of(WITNESS_CLASS, witnessWithStaleGone("@Override")));
        assertFalse("an @Override of a member the interface no longer has must not compile", stale.ok());
        assertTrue(stale.errors(), stale.errors().contains("Witnesses.java"));
    }

    @Test
    public void knownLimit_aStaleWitnessMethodWithoutOverrideStillCompilesSoTheHeaderAsksForTheAnnotation() throws Exception {
        // The drift signal exists only because the project annotates its witnesses. Without
        // @Override a stale method is an ordinary method; the generated header says so by
        // asking for the annotation, and this records the limit rather than hiding it.
        Compiled c = tryCompile(retiredGoneModelOutput(), Map.of(WITNESS_CLASS, witnessWithStaleGone("")));
        assertTrue(c.errors(), c.ok());
    }

    // ---------------------------------------------------------------- escaping

    @Test
    public void proseWithQuotesBackslashesNewlinesAndCommentTerminatorsStillCompilesAndIsCarried() throws Exception {
        String statement = "\"say \\\"hi\\\" to C:\\\\dir\\nsecond line */ end \\\\u000a not an escape\\rlone cr\"";
        String counterexample = "\"it breaks \\\"here\\\" at C:\\\\tmp\\nthen */ and \\\\u000a\"";
        MetaDataLoader loader = loadYaml(shop(requirement("Recorded", 4, "live", statement, counterexample, "Order")));
        Path out = run(loader, Map.of());
        URLClassLoader cl = compile(out, Map.of(WITNESS_CLASS, WITNESS_NONE));

        AssertionError e = invoke(cl, "Requirements_acme_shop_Test", "req_acme_shop_Recorded__object_entity");
        assertNotNull(e);
        String expectedCounterexample = "it breaks \"here\" at C:\\tmp\nthen */ and \\u000a";
        assertTrue(e.getMessage(), e.getMessage().endsWith("so that it fails when: " + expectedCounterexample));

        String test = read(out, "Requirements_acme_shop_Test.java");
        assertTrue(test, test.contains("// say \"hi\" to C:\\dir\n"));
        assertTrue(test, test.contains("    // second line * / end \\ u000a not an escape\n"));
        assertTrue(test, test.contains("    // lone cr\n"));
        assertTrue(test, test.contains("    // Counterexample: it breaks \"here\" at C:\\tmp\n    // then * / and \\ u000a\n"));
    }

    @Test
    public void carriageReturnsInACounterexampleAreEscapedInTheLiteralAndSplitInTheComment() throws Exception {
        // YAML escapes: CR LF, then a lone CR. A raw CR in a string literal would end the line.
        String counterexample = "\"first\\r\\nsecond\\rthird\"";
        MetaDataLoader loader = loadYaml(shop(requirement("Recorded", 4, "live", "S.", counterexample, "Order")));
        Path out = run(loader, Map.of());

        String iface = read(out, "Requirements_acme_shop_Witnesses.java");
        String test = read(out, "Requirements_acme_shop_Test.java");
        assertFalse("no raw CR reaches either file", iface.indexOf('\r') >= 0 || test.indexOf('\r') >= 0);
        assertTrue(iface, iface.contains("so that it fails when: first\\r\\nsecond\\rthird\");"));
        assertTrue(test, test.contains("    // Counterexample: first\n    // second\n    // third\n"));

        URLClassLoader cl = compile(out, Map.of(WITNESS_CLASS, WITNESS_NONE));
        AssertionError e = invoke(cl, "Requirements_acme_shop_Test", "req_acme_shop_Recorded__object_entity");
        assertNotNull(e);
        assertTrue(e.getMessage(), e.getMessage().endsWith("so that it fails when: first\r\nsecond\rthird"));
    }

    // ---------------------------------------------------------------- refusals

    @Test
    public void twoRequirementsWithOneWitnessKeyAreRefusedNamingBothAndTheCode() throws Exception {
        // A name cannot hold a dot, so Orders.Recorded is a requirement nested under Orders.
        MetaDataLoader loader = loadYaml(shop(
            requirement("Orders", 3, "live", "P.", "Q.", null)
                + "        children:\n          - requirement.functional:\n"
                + "              name: Recorded\n              level: 4\n              status: live\n"
                + "              statement: A.\n              counterexample: B.\n              implementedBy: [Order]\n",
            requirement("Orders_Recorded", 4, "live", "C.", "D.", "Order")));
        GeneratorException e = assertThrows(GeneratorException.class, () -> run(loader, Map.of()));
        assertTrue(e.getMessage(), e.getMessage().contains("ERR_REQUIREMENT_WITNESS_KEY_COLLISION"));
        assertTrue(e.getMessage(), e.getMessage().contains("acme::shop::Orders.Recorded [object.entity]"));
        assertTrue(e.getMessage(), e.getMessage().contains("acme::shop::Orders_Recorded [object.entity]"));
    }

    @Test
    public void anUnknownGrainIsRefusedWithAClearErrorWhateverTheModelHolds() throws Exception {
        for (MetaDataLoader loader : List.of(loadDir(workedExampleInput()), loadYaml(shop()))) {
            GeneratorException e = assertThrows(GeneratorException.class, () -> run(loader, Map.of("grain", "hybrid")));
            assertTrue(e.getMessage(), e.getMessage().contains("unknown requirement-test grain \"hybrid\""));
            assertTrue(e.getMessage(), e.getMessage().contains("\"concern\" or \"member\""));
        }
    }

    @Test
    public void aMissingWitnessClassOrTestPackageIsAClearError() throws Exception {
        MetaDataLoader loader = loadDir(workedExampleInput());
        for (String missing : List.of("witnessClass", "testPackage")) {
            Path out = tmp.newFolder().toPath();
            Map<String, String> args = new HashMap<>(Map.of("outputDir", out.toString(),
                "testPackage", TEST_PACKAGE, "witnessClass", WITNESS_CLASS));
            args.remove(missing);
            JUnitRequirementTestsGenerator bare = new JUnitRequirementTestsGenerator();
            bare.setArgs(args);
            GeneratorException e = assertThrows(GeneratorException.class, () -> bare.execute(loader));
            assertTrue(e.getMessage(), e.getMessage().contains("'" + missing + "'"));
            assertEquals("nothing is written when it refuses", new TreeSet<String>(), files(out));
        }
    }

    @Test
    public void aTestPackageOrWitnessClassThatIsNotAJavaNameIsRefusedRatherThanSplicedIntoSource() throws Exception {
        MetaDataLoader loader = loadDir(workedExampleInput());
        assertThrows(GeneratorException.class, () -> run(loader, Map.of("witnessClass", "com.acme.W(); System.exit(1")));
        assertThrows(GeneratorException.class, () -> run(loader, Map.of("testPackage", "com.acme;import x")));
    }

    @Test
    public void warnUncoveredMustBeTrueOrFalse() throws Exception {
        MetaDataLoader loader = loadDir(workedExampleInput());
        GeneratorException e = assertThrows(GeneratorException.class, () -> run(loader, Map.of("warnUncovered", "flase")));
        assertTrue(e.getMessage(), e.getMessage().contains("warnUncovered"));
    }

    // ---------------------------------------------------------------- grain, filter, renderer

    @Test
    public void memberGrainWritesOneTestPerResolvingReference() throws Exception {
        MetaDataLoader loader = loadYaml(shop(
            requirement("Recorded", 4, "live", "S.", "C.", "Order, acme::shop::Order.total")));
        String test = read(run(loader, Map.of("grain", "member")), "Requirements_acme_shop_Test.java");
        assertTrue(test, test.contains("void req_acme_shop_Recorded__Order()"));
        assertTrue(test, test.contains("void req_acme_shop_Recorded__acme_shop_Order_total()"));
        assertFalse(test, test.contains("object_entity"));
    }

    /** A filter that keeps everything, found by name. Public with a public constructor, as a project's would be. */
    public static class KeepEverything implements RequirementTestFilter {
        @Override
        public boolean include(RequirementTestIdentities.View view) {
            return true;
        }
    }

    @Test
    public void aFilterClassKeepsAnL3RequirementTheDefaultDropsAndItRendersWithUnitStar() throws Exception {
        MetaDataLoader loader = loadDir(workedExampleInput());
        Path withDefault = run(loader, Map.of());
        assertFalse(read(withDefault, "Requirements_acme_shop_Test.java").contains("req_acme_shop_Orders()"));
        Path out = tmp.newFolder().toPath();
        generator(out, Map.of("filter", KeepEverything.class.getName())).execute(loader);
        String test = read(out, "Requirements_acme_shop_Test.java");
        assertTrue(test, test.contains("// acme::shop::Orders [*]"));
        assertTrue(test, test.contains("void req_acme_shop_Orders()"));
    }

    @Test
    public void aFilterClassThatCannotBeLoadedIsAClearError() throws Exception {
        MetaDataLoader loader = loadDir(workedExampleInput());
        GeneratorException e = assertThrows(GeneratorException.class,
            () -> run(loader, Map.of("filter", "com.nowhere.NoSuchFilter")));
        assertTrue(e.getMessage(), e.getMessage().contains("'filter'"));
        assertTrue(e.getMessage(), e.getMessage().contains("com.nowhere.NoSuchFilter"));
        GeneratorException notAFilter = assertThrows(GeneratorException.class,
            () -> run(loader, Map.of("filter", "java.lang.String")));
        assertTrue(notAFilter.getMessage(), notAFilter.getMessage().contains("does not implement"));
    }

    /** A filter that exists and cannot be used: its static initialiser throws. */
    public static class ExplodingFilter implements RequirementTestFilter {
        static {
            if (true) throw new IllegalStateException("boom from the static initialiser");
        }

        @Override
        public boolean include(RequirementTestIdentities.View view) {
            return true;
        }
    }

    @Test
    public void aFilterThatIsFoundButFailsToLinkIsNotReportedAsMissing() throws Exception {
        MetaDataLoader loader = loadDir(workedExampleInput());
        GeneratorException e = assertThrows(GeneratorException.class,
            () -> run(loader, Map.of("filter", ExplodingFilter.class.getName())));
        assertTrue(e.getMessage(), e.getMessage().contains(ExplodingFilter.class.getName()));
        assertTrue(e.getMessage(), e.getMessage().contains("was found but could not be loaded"));
        assertFalse(e.getMessage(), e.getMessage().contains("not on the project's classpath"));
        assertTrue("the error is the cause: " + e.getCause(), e.getCause() instanceof LinkageError);
        assertTrue(String.valueOf(e.getCause().getCause()), e.getCause().getCause() instanceof IllegalStateException);
    }

    /** Records what it is given and replaces the Recorded test. */
    public static class RecordingRenderer implements RequirementTestRenderer {
        static final List<RequirementTestArgs> SEEN = new ArrayList<>();

        @Override
        public RenderedTest render(RequirementTestArgs args) {
            SEEN.add(args);
            if (!args.identity().path().equals("Orders.Recorded")) return null;
            return new RenderedTest(List.of("org.junit.jupiter.api.Assertions"),
                "@Test\nvoid " + args.identity().witnessKey() + "() {\n    Assertions.assertTrue(true, \"digest "
                    + args.identity().digest() + "\");\n}");
        }
    }

    @Test
    public void aRendererClassReplacesOneTestAndReceivesTheDigestWhileTheOthersKeepTheDefault() throws Exception {
        RecordingRenderer.SEEN.clear();
        Path out = run(loadDir(workedExampleInput()), Map.of("renderer", RecordingRenderer.class.getName()));
        String test = read(out, "Requirements_acme_shop_Test.java");
        assertTrue(test, test.contains("import org.junit.jupiter.api.Assertions;"));
        assertTrue(test, test.contains("    Assertions.assertTrue(true, \"digest 2714aa3925a47959aa5e48ae39d80ed203fd4e2caa046a90aab9e04691d9881a\");"));
        assertFalse("the replaced test lost its default body", test.contains("witnesses.req_acme_shop_Orders_Recorded__object_entity();"));
        assertTrue("the null-returning case keeps the default", test.contains("@Disabled(\"planned - not built yet\")"));

        assertEquals(2, RecordingRenderer.SEEN.size());
        RequirementTestArgs recorded = RecordingRenderer.SEEN.stream()
            .filter(a -> a.identity().path().equals("Orders.Recorded")).findFirst().orElseThrow();
        assertEquals("An order is recorded when it is placed.", recorded.statement());
        assertEquals("A placed order has no row.", recorded.counterexample());
        assertEquals("Order", recorded.targets().get(0).ref());
        assertEquals("object.entity", recorded.targets().get(0).concern());
        assertEquals("2714aa3925a47959aa5e48ae39d80ed203fd4e2caa046a90aab9e04691d9881a", recorded.identity().digest());
    }

    // ---------------------------------------------------------------- the uncovered warning

    /** A level 3 requirement {@code parent} holding a level 3 child, both excluded by the default filter. */
    private static String withChild(String parent, String child) {
        return requirement(parent, 3, "live", "P.", "Q.", null)
            + "        children:\n          - requirement.functional:\n"
            + "              name: " + child + "\n              level: 3\n              status: live\n"
            + "              statement: A.\n              counterexample: B.\n";
    }

    @Test
    public void excludedRequirementsProduceOneCappedWarningAndWarnUncoveredFalseSilencesIt() throws Exception {
        List<String> reqs = new ArrayList<>();
        for (int i = 1; i <= 7; i++) reqs.add(requirement("Area" + i, 3, "live", "S.", "C.", null));
        reqs.add(requirement("Recorded", 4, "live", "S.", "C.", "Order"));
        MetaDataLoader loader = loadYaml(shop(reqs.toArray(new String[0])));

        JUnitRequirementTestsGenerator gen = generator(tmp.newFolder().toPath(), Map.of("warnUncovered", "true"));
        // Table A: diagnostics name the PATH, never the package-qualified address, so the same
        // model gives the same names in every port.
        String message = "7 requirement(s) matched no filter and get no test. If that is deliberate, set "
            + "warnUncovered=false to silence this. Uncovered: Area1, Area2, Area3, Area4, Area5, and 2 more.";
        assertEquals(List.of(message), logged(gen, loader));
        assertEquals(List.of(message), gen.warnings());

        JUnitRequirementTestsGenerator quiet = generator(tmp.newFolder().toPath(), Map.of("warnUncovered", "false"));
        assertEquals(List.of(), logged(quiet, loader));
        assertEquals(List.of(), quiet.warnings());
    }

    @Test
    public void theUncoveredWarningIsOnByDefault() throws Exception {
        // No warnUncovered arg at all: the worked example's excluded L3 parent must be named.
        JUnitRequirementTestsGenerator gen = new JUnitRequirementTestsGenerator();
        gen.setArgs(realArgs(tmp.newFolder().toPath()));
        String message = "1 requirement(s) matched no filter and get no test. If that is deliberate, set "
            + "warnUncovered=false to silence this. Uncovered: Orders.";
        assertEquals(List.of(message), logged(gen, loadDir(workedExampleInput())));
        assertEquals(List.of(message), gen.warnings());
    }

    @Test
    public void aNestedExcludedRequirementIsNamedByItsDottedPathNotItsBareNameOrQualifiedAddress() throws Exception {
        MetaDataLoader loader = loadYaml(shop(
            requirement("Area1", 3, "live", "S.", "C.", null),
            withChild("Orders", "Placed"),
            requirement("Recorded", 4, "live", "S.", "C.", "Order")));
        JUnitRequirementTestsGenerator gen = generator(tmp.newFolder().toPath(), Map.of("warnUncovered", "true"));
        String message = "3 requirement(s) matched no filter and get no test. If that is deliberate, set "
            + "warnUncovered=false to silence this. Uncovered: Area1, Orders, Orders.Placed.";
        assertEquals(List.of(message), logged(gen, loader));
        assertEquals(List.of(message), gen.warnings());
    }

    // ---------------------------------------------------------------- nothing declared, nothing changes

    @Test
    public void aModelWithNoRequirementWritesNothingAndWarnsNothingEvenWithoutTheRequiredArgs() throws Exception {
        MetaDataLoader loader = loadYaml(shop());
        Path out = tmp.newFolder().toPath();
        JUnitRequirementTestsGenerator gen = new JUnitRequirementTestsGenerator();
        gen.setArgs(Map.of("outputDir", out.toString()));
        gen.execute(loader);
        assertEquals(new TreeSet<String>(), files(out));
        assertEquals(List.of(), gen.warnings());
    }

    // ---------------------------------------------------------------- stale files

    @Test
    public void staleFile_genNeverRemovesTheFilesOfAPackageThatLostItsLastRequirement_verifyReportsThemStaleInRepo() throws Exception {
        String billing = "metadata:\n  package: acme::billing\n  children:\n"
            + "    - object.entity:\n        name: Invoice\n        children:\n"
            + "          - field.uuid: { name: id }\n          - identity.primary: { name: pk, fields: [id] }\n"
            + requirement("Billed", 4, "live", "S.", "C.", "Invoice");
        Path dir = tmp.newFolder().toPath();
        Files.writeString(dir.resolve("meta.billing.yaml"), billing, StandardCharsets.UTF_8);
        Files.writeString(dir.resolve("meta.shop.yaml"),
            shop(requirement("Recorded", 4, "live", "S.", "C.", "Order")), StandardCharsets.UTF_8);

        Path out = tmp.newFolder().toPath();
        generator(out, Map.of()).execute(loadDir(dir));
        assertEquals(new TreeSet<>(List.of("com/acme/req/Requirements_acme_billing_Test.java",
            "com/acme/req/Requirements_acme_billing_Witnesses.java",
            "com/acme/req/Requirements_acme_shop_Test.java",
            "com/acme/req/Requirements_acme_shop_Witnesses.java")), files(out));

        // The billing package loses its requirement.
        Files.writeString(dir.resolve("meta.billing.yaml"), billing.substring(0, billing.indexOf("    - requirement.functional")), StandardCharsets.UTF_8);
        generator(out, Map.of()).execute(loadDir(dir));

        // What gen does, as for every Java generator: it does not delete. The two files stay,
        // untouched; `mvn metaobjects:verify` then reports each as [stale-in-repo] (proved through the real goals
        // in the maven-plugin module's RequirementTestsGeneratorMojoTest).
        assertEquals(new TreeSet<>(List.of("com/acme/req/Requirements_acme_billing_Test.java",
            "com/acme/req/Requirements_acme_billing_Witnesses.java",
            "com/acme/req/Requirements_acme_shop_Test.java",
            "com/acme/req/Requirements_acme_shop_Witnesses.java")), files(out));
    }

    // ---------------------------------------------------------------- project class loader

    @Test
    public void aFilterOnlyTheProjectClassLoaderCanSeeIsFoundOnceTheLoaderIsInjected() throws Exception {
        // Compile a filter into a directory that is on no ambient class path: the packaged
        // generator's own loader cannot see it, exactly as the plugin's cannot see a project class.
        Path src = tmp.newFolder().toPath();
        Path file = src.resolve("com/acme/ProjectOnlyFilter.java");
        Files.createDirectories(file.getParent());
        Files.writeString(file, "package com.acme;\npublic class ProjectOnlyFilter implements com.metaobjects.requirement.RequirementTestFilter {\n"
            + "  public boolean include(com.metaobjects.requirement.RequirementTestIdentities.View v) { return true; }\n}\n");
        Path classes = tmp.newFolder().toPath();
        JavaCompiler javac = ToolProvider.getSystemJavaCompiler();
        try (StandardJavaFileManager fm = javac.getStandardFileManager(null, null, StandardCharsets.UTF_8)) {
            fm.setLocation(StandardLocation.CLASS_OUTPUT, List.of(classes.toFile()));
            assertTrue(javac.getTask(null, fm, null, List.of("-classpath", System.getProperty("java.class.path")), null,
                fm.getJavaFileObjectsFromFiles(List.of(file.toFile()))).call());
        }
        MetaDataLoader loader = loadDir(workedExampleInput());
        Map<String, String> args = Map.of("filter", "com.acme.ProjectOnlyFilter");

        GeneratorException e = assertThrows(GeneratorException.class, () -> run(loader, args));
        assertTrue(e.getMessage(), e.getMessage().contains("com.acme.ProjectOnlyFilter"));

        try (URLClassLoader project = new URLClassLoader(new URL[]{classes.toUri().toURL()}, getClass().getClassLoader())) {
            Path out = tmp.newFolder().toPath();
            JUnitRequirementTestsGenerator gen = generator(out, args);
            gen.setProjectClassLoader(project);
            gen.execute(loader);
            assertTrue(read(out, "Requirements_acme_shop_Test.java").contains("// acme::shop::Orders [*]"));
        }
    }
}

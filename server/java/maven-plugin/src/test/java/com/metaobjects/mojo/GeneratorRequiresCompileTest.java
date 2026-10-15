package com.metaobjects.mojo;

import com.metaobjects.MetaDataException;
import com.metaobjects.generator.Generator;
import com.metaobjects.generator.GeneratorRegistry;
import com.metaobjects.loader.LoaderOptions;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.loader.uri.URIHelper;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.Node;
import org.w3c.dom.NodeList;

import javax.tools.Diagnostic;
import javax.tools.DiagnosticCollector;
import javax.tools.JavaCompiler;
import javax.tools.JavaFileObject;
import javax.tools.StandardJavaFileManager;
import javax.tools.StandardLocation;
import javax.tools.ToolProvider;
import javax.xml.parsers.DocumentBuilderFactory;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.IOException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

/**
 * The Java {@code requires} and the skill's pom example, proven by compiling what they generate.
 *
 * <p>The only {@code pom.xml} example the Java skill shipped listed the controller, DTO and
 * repository generators. On a real model that output did not compile ({@code LegFilterAllowlist}
 * and the value-object records were never written) and {@code mvn metaobjects:generate} exited 0.
 * Three proofs, each over the shared fitness corpus, each by the real compiler:
 * <ol>
 *   <li>Every generator's {@code requires} closure compiles: the registry's requirements are
 *       enough.</li>
 *   <li>The controller without its requirements does not compile, and the goal refuses it: the
 *       requirements are needed, and checked.</li>
 *   <li>The example in {@code agent-context/skills/metaobjects-codegen/references/java.md}, read
 *       from that file, passes the check and compiles with exactly its own arguments.</li>
 * </ol>
 * The Kotlin example compiles in {@code integration-tests-kotlin}, which has Exposed and Spring
 * on its classpath; here it is held to the same check.
 */
public class GeneratorRequiresCompileTest {

    @Rule
    public TemporaryFolder tempFolder = new TemporaryFolder();

    private Path repo;
    private Path canonical;
    private MetaDataLoader loader;

    @Before
    public void setUp() {
        repo = findRepo();
        canonical = repo.resolve("fixtures/persistence-conformance/canonical");
        URI uri = URIHelper.toURI("model:file:"
                + canonical.resolve("meta.fitness.json").toAbsolutePath().toString().replace('\\', '/'));
        loader = new MetaDataLoader(LoaderOptions.create(false, false, true),
                MetaDataLoader.SUBTYPE_MANUAL, "requires-compile-test");
        loader.setSourceURIs(List.of(uri));
        loader.init();
    }

    private static Path findRepo() {
        for (Path p = Path.of(System.getProperty("user.dir")).toAbsolutePath().normalize(); p != null; p = p.getParent()) {
            if (Files.isDirectory(p.resolve("fixtures/persistence-conformance/canonical"))) return p;
        }
        throw new IllegalStateException("could not locate the repository root");
    }

    private Map<String, String> args(Path outDir) {
        Map<String, String> a = new LinkedHashMap<>();
        a.put("outputDir", outDir.toString());
        a.put("packageName", "fitness");
        a.put("templateRoot", canonical.resolve("prompts").toString());
        // Read by the entity generator (JavaObjectCodeGenerator), ignored by the rest.
        a.put("type", "class");
        a.put("flavor", "pojoAware");
        return a;
    }

    /** {@code name} and everything it requires, transitively, in a stable order. */
    private static List<String> closure(String name) {
        Set<String> out = new LinkedHashSet<>();
        List<String> todo = new ArrayList<>(List.of(name));
        while (!todo.isEmpty()) {
            String n = todo.remove(0);
            if (out.add(n)) todo.addAll(GeneratorRegistry.get(n).requires());
        }
        return new ArrayList<>(out);
    }

    private Generator construct(String classname) throws Exception {
        return (Generator) Class.forName(classname).getDeclaredConstructor().newInstance();
    }

    private Path generate(List<String> stableNames) throws Exception {
        Path out = tempFolder.newFolder().toPath();
        for (String n : stableNames) {
            construct(GeneratorRegistry.get(n).classname()).setArgs(args(out)).execute(loader);
        }
        return out;
    }

    /** The Java generators whose output is Java the project compiles. */
    private static final List<String> COMPILED = List.of(
            "routes", "dto", "repository", "filter-allowlist", "value-object", "names",
            "output-parser", "output-prompt", "render-helper", "entity", "extractor");

    @Test
    public void everyRequiresClosureCompilesOverTheFitnessCorpus() throws Exception {
        for (String name : COMPILED) {
            List<String> run = closure(name);
            Path out = generate(run);
            assertEquals(name + ": the closure must pass the check", List.of(),
                    RequiresCheck.unmet(run.stream().map(n -> GeneratorRegistry.get(n).classname()).toList()));
            String errors = compileErrors(out);
            assertTrue(name + " with " + run + " does not compile:\n" + errors, errors.isEmpty());
        }
    }

    @Test
    public void theControllerAloneDoesNotCompileAndTheGoalRefusesIt() throws Exception {
        String controller = GeneratorRegistry.get("routes").classname();
        String errors = compileErrors(generate(List.of("routes")));
        assertFalse("the controller alone compiled, so its requires are not needed", errors.isEmpty());

        List<String> unmet = RequiresCheck.unmet(List.of(controller));
        assertEquals(1, unmet.size());
        assertTrue(unmet.get(0), unmet.get(0).startsWith(controller + " (\"routes\") needs \"dto\" ("
                + GeneratorRegistry.get("dto").classname() + "), \"repository\""));
        assertTrue(unmet.get(0), unmet.get(0).contains("\"filter-allowlist\""));

        MetaDataGeneratorMojo mojo = new MetaDataGeneratorMojo();
        try {
            mojo.refuseUnmetRequires(List.of(construct(controller)));
            fail("the goal ran a controller with none of its requirements");
        } catch (MetaDataException expected) {
            assertTrue(expected.getMessage(), expected.getMessage().contains("<allowUnmetRequires>"));
        }
        mojo.allowUnmetRequires = true;
        mojo.refuseUnmetRequires(List.of(construct(controller)));
    }

    @Test
    public void anOwnedCopyIsMatchedByItsSimpleNameAndAnUnknownGeneratorRequiresNothing() {
        assertEquals(1, RequiresCheck.unmet(List.of("com.acme.codegen.SpringControllerGenerator")).size());
        assertEquals(List.of(), RequiresCheck.unmet(List.of("com.acme.codegen.FieldListGenerator")));
        // Requirements are per port: Java's DTO does not satisfy a Kotlin controller.
        List<String> mixed = RequiresCheck.unmet(List.of(
                "com.metaobjects.generator.kotlin.KotlinSpringControllerGenerator",
                "com.metaobjects.generator.kotlin.KotlinEntityGenerator",
                GeneratorRegistry.get("filter-allowlist").classname()));
        assertEquals(1, mixed.size());
        assertTrue(mixed.get(0), mixed.get(0).contains("\"filter-allowlist\" (com.metaobjects.generator.kotlin."));
        assertTrue(mixed.get(0), mixed.get(0).contains("\"relations\""));
    }

    // ---------------------------------------------------------------------------------
    // The skill examples, read from the files an agent copies them out of
    // ---------------------------------------------------------------------------------

    private record Entry(String classname, Map<String, String> args) {
    }

    /** The {@code <generator>} entries of the one pom example in a skill reference. */
    private List<Entry> pomExample(String reference) throws Exception {
        String md = Files.readString(repo.resolve("agent-context/skills/metaobjects-codegen/references/" + reference),
                StandardCharsets.UTF_8);
        Matcher m = Pattern.compile("```xml\\n(.*?)```", Pattern.DOTALL).matcher(md);
        String pom = null;
        while (m.find()) {
            if (m.group(1).contains("metaobjects-maven-plugin") && m.group(1).contains("<generators>")) {
                assertTrue(reference + " has more than one pom example", pom == null);
                pom = m.group(1);
            }
        }
        assertTrue(reference + " has no pom example", pom != null);
        Document doc = DocumentBuilderFactory.newInstance().newDocumentBuilder()
                .parse(new ByteArrayInputStream(pom.getBytes(StandardCharsets.UTF_8)));
        NodeList generators = doc.getElementsByTagName("generator");
        List<Entry> out = new ArrayList<>();
        for (int i = 0; i < generators.getLength(); i++) {
            Element g = (Element) generators.item(i);
            String classname = g.getElementsByTagName("classname").item(0).getTextContent().trim();
            Map<String, String> args = new LinkedHashMap<>();
            NodeList argsEls = g.getElementsByTagName("args");
            if (argsEls.getLength() > 0) {
                for (Node a = argsEls.item(0).getFirstChild(); a != null; a = a.getNextSibling()) {
                    if (a instanceof Element e) args.put(e.getTagName(), e.getTextContent().trim());
                }
            }
            out.add(new Entry(classname, args));
        }
        assertFalse(reference + "'s pom example lists no generator", out.isEmpty());
        return out;
    }

    @Test
    public void theJavaSkillsPomExamplePassesTheCheckAndCompiles() throws Exception {
        List<Entry> example = pomExample("java.md");
        assertEquals(List.of(), RequiresCheck.unmet(example.stream().map(Entry::classname).toList()));

        Path buildDir = tempFolder.newFolder("target").toPath();
        for (Entry e : example) {
            Map<String, String> args = new LinkedHashMap<>();
            e.args().forEach((k, v) -> args.put(k, v.replace("${project.build.directory}", buildDir.toString())));
            construct(e.classname()).setArgs(args).execute(loader);
        }
        String errors = compileErrors(buildDir);
        assertTrue("the java.md pom example generates code that does not compile:\n" + errors, errors.isEmpty());
    }

    @Test
    public void theKotlinSkillsPomExamplePassesTheCheck() throws Exception {
        assertEquals(List.of(), RequiresCheck.unmet(pomExample("kotlin.md").stream().map(Entry::classname).toList()));
    }

    /**
     * Every {@code <generators>} list the repository ships for an adopter to copy (a doc, a skill,
     * an example pom) passes the check the goal makes, so copying one never gets a refused build.
     * The dated design records under {@code docs/superpowers/} quote poms as they were, and are not
     * examples.
     */
    @Test
    public void everyShippedGeneratorsListPassesTheCheck() throws IOException {
        Pattern block = Pattern.compile("<generators>(.*?)</generators>", Pattern.DOTALL);
        Pattern classname = Pattern.compile("<classname>\\s*([^<\\s]+)\\s*</classname>");
        Path superpowers = repo.resolve("docs/superpowers");
        List<String> failures = new ArrayList<>();
        int lists = 0;
        for (String root : List.of("docs", "examples", "agent-context")) {
            List<Path> files;
            try (Stream<Path> s = Files.walk(repo.resolve(root))) {
                files = s.filter(Files::isRegularFile)
                        .filter(p -> !p.startsWith(superpowers))
                        .filter(p -> p.toString().matches(".*\\.(md|xml|json|mustache)$"))
                        .filter(p -> !p.toString().contains("/node_modules/") && !p.toString().contains("/target/"))
                        .sorted().toList();
            }
            for (Path file : files) {
                Matcher m = block.matcher(Files.readString(file, StandardCharsets.UTF_8));
                while (m.find()) {
                    lists++;
                    List<String> classnames = new ArrayList<>();
                    Matcher c = classname.matcher(m.group(1));
                    while (c.find()) classnames.add(c.group(1));
                    for (String line : RequiresCheck.unmet(classnames)) failures.add(repo.relativize(file) + ": " + line);
                }
            }
        }
        assertTrue("found no <generators> list to check", lists > 0);
        assertEquals("a shipped <generators> list the goal refuses", List.of(), failures);
    }

    /** Compile every {@code .java} file under {@code root}; the errors, or "" when it compiles. */
    private String compileErrors(Path root) throws IOException {
        List<File> files = new ArrayList<>();
        try (Stream<Path> s = Files.walk(root)) {
            s.filter(p -> p.toString().endsWith(".java")).forEach(p -> files.add(p.toFile()));
        }
        assertFalse("nothing to compile under " + root, files.isEmpty());
        JavaCompiler javac = ToolProvider.getSystemJavaCompiler();
        DiagnosticCollector<JavaFileObject> diagnostics = new DiagnosticCollector<>();
        try (StandardJavaFileManager fm = javac.getStandardFileManager(diagnostics, null, StandardCharsets.UTF_8)) {
            fm.setLocation(StandardLocation.CLASS_OUTPUT, List.of(tempFolder.newFolder().getAbsoluteFile()));
            boolean ok = javac.getTask(null, fm, diagnostics,
                    List.of("-proc:none", "-classpath", System.getProperty("java.class.path")), null,
                    fm.getJavaFileObjectsFromFiles(files)).call();
            if (ok) return "";
            StringBuilder errs = new StringBuilder();
            for (Diagnostic<? extends JavaFileObject> d : diagnostics.getDiagnostics()) {
                if (d.getKind() == Diagnostic.Kind.ERROR) errs.append(d).append('\n');
            }
            return errs.toString();
        }
    }
}

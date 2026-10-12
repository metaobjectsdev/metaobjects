package com.metaobjects.mojo;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.metaobjects.generator.Generator;
import com.metaobjects.generator.GeneratorRegistry;
import com.metaobjects.generator.ProjectClassLoaderAware;
import com.metaobjects.loader.DirectorySource;
import com.metaobjects.loader.LoaderOptions;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.loader.uri.URIHelper;
import org.apache.maven.project.MavenProject;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import org.mockito.Mockito;

import javax.tools.Diagnostic;
import javax.tools.DiagnosticCollector;
import javax.tools.JavaCompiler;
import javax.tools.JavaFileObject;
import javax.tools.StandardJavaFileManager;
import javax.tools.StandardLocation;
import javax.tools.ToolProvider;
import java.io.ByteArrayInputStream;
import java.io.DataInputStream;
import java.io.File;
import java.io.IOException;
import java.lang.reflect.Modifier;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.jar.JarFile;
import java.util.jar.Manifest;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * The eject contract, asserted for the Java port (ADR-0034 Amendment 8).
 *
 * <p>Every stock generator can be ejected, and the owned copy holds its emit. Three assertions,
 * each driven by {@code fixtures/generator-registry-conformance/registry.json}:</p>
 * <ul>
 *   <li><b>Census.</b> Every concrete {@link Generator} on this plugin's classpath belongs to a
 *       registry entry, and the registry exposes exactly the names the shared file gives this
 *       port.</li>
 *   <li><b>Completeness.</b> Every registered generator ships eject source unless the shared
 *       file exempts it with a reason, and the reference sources the jars ship are exactly the
 *       ones the registry names.</li>
 *   <li><b>Depth.</b> Each generator, ejected ALONE by the real mojo into an empty project,
 *       compiles; references nothing in the generator packages outside the engine surface; and
 *       emits what the packaged generator emits.</li>
 * </ul>
 * <p>Where the contract does not hold yet, the shared file's {@code pending} list says so. A
 * pending entry that passes fails here, and so does a gap that is not listed.</p>
 *
 * <p>It lives in this module because this is where the eject mojo is, and the only module that
 * sees every codegen module at once.</p>
 */
public class EjectContractTest {

    private static final String PORT = "java";
    private static final String OWNED_PACKAGE = "com.acme.codegen";
    private static final String OWNED_RUNTIME_PACKAGE = "com.acme.runtime";

    @Rule
    public TemporaryFolder tempFolder = new TemporaryFolder();

    // ---------------------------------------------------------------------------------
    // the shared file
    // ---------------------------------------------------------------------------------

    private static Path repoRoot() {
        for (Path p = Path.of("").toAbsolutePath(); p != null; p = p.getParent()) {
            if (Files.isDirectory(p.resolve("fixtures")) && Files.isDirectory(p.resolve("server"))) return p;
        }
        throw new IllegalStateException("could not locate the repo root");
    }

    private static final Path MANIFEST_PATH =
            repoRoot().resolve("fixtures/generator-registry-conformance/registry.json");

    private static JsonObject manifest() {
        try {
            return JsonParser.parseString(Files.readString(MANIFEST_PATH, StandardCharsets.UTF_8)).getAsJsonObject();
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
    }

    private static List<String> strings(JsonElement array) {
        List<String> out = new ArrayList<>();
        for (JsonElement e : array.getAsJsonArray()) out.add(e.getAsString());
        return out;
    }

    /** The generators the shared file expects this port to expose. */
    private static Set<String> portSlice() {
        Set<String> out = new TreeSet<>();
        for (Map.Entry<String, JsonElement> g : manifest().getAsJsonObject("generators").entrySet()) {
            if (strings(g.getValue().getAsJsonObject().get("ports")).contains(PORT)) out.add(g.getKey());
        }
        return out;
    }

    private static boolean isExempt(String name) {
        return manifest().getAsJsonObject("generators").getAsJsonObject(name).get("eject").isJsonObject();
    }

    private static JsonArray allPending() {
        return manifest().getAsJsonObject("eject").getAsJsonArray("pending");
    }

    /** This port's pending entries for one assertion: generator to the union of what its
     *  entries list in {@code outside} (one entry per gap; empty for census and completeness). */
    private static Map<String, Set<String>> pending(String assertion) {
        Map<String, Set<String>> out = new TreeMap<>();
        for (JsonElement e : allPending()) {
            JsonObject p = e.getAsJsonObject();
            if (!PORT.equals(p.get("port").getAsString()) || !assertion.equals(p.get("assertion").getAsString())) continue;
            Set<String> outside = out.computeIfAbsent(p.get("generator").getAsString(), k -> new TreeSet<>());
            if (p.has("outside")) outside.addAll(strings(p.get("outside")));
        }
        return out;
    }

    /** {@code **} matches any run of characters, {@code *} one dotted segment. */
    private static Pattern glob(String pattern) {
        StringBuilder regex = new StringBuilder();
        Matcher m = Pattern.compile("\\*\\*|\\*|[^*]+").matcher(pattern);
        while (m.find()) {
            String part = m.group();
            regex.append(part.equals("**") ? ".*" : part.equals("*") ? "[^.]*" : Pattern.quote(part));
        }
        return Pattern.compile(regex.toString());
    }

    private static List<String> surface(String key) {
        return strings(manifest().getAsJsonObject("eject").getAsJsonObject("engineSurface")
                .getAsJsonObject(PORT).get(key));
    }

    /** True for a class that writes output: inside the generator packages, and not engine. */
    private static boolean outsideEngineSurface(String className) {
        return surface("codegenPackages").stream().anyMatch(p -> glob(p).matcher(className).matches())
                && surface("engine").stream().noneMatch(p -> glob(p).matcher(className).matches());
    }

    // ---------------------------------------------------------------------------------
    // the classpath
    // ---------------------------------------------------------------------------------

    /** Every classpath entry, with a launcher jar's manifest {@code Class-Path} expanded. */
    private static List<Path> classpath() throws IOException {
        List<Path> out = new ArrayList<>();
        for (String entry : System.getProperty("java.class.path").split(File.pathSeparator)) {
            Path path = Path.of(entry);
            out.add(path);
            if (!Files.isRegularFile(path)) continue;
            try (JarFile jar = new JarFile(path.toFile())) {
                Manifest mf = jar.getManifest();
                String classPath = mf == null ? null : mf.getMainAttributes().getValue("Class-Path");
                if (classPath == null) continue;
                for (String url : classPath.trim().split("\\s+")) {
                    out.add(url.startsWith("file:") ? Path.of(java.net.URI.create(url)) : path.resolveSibling(url));
                }
            }
        }
        return out;
    }

    /** Every resource path on the classpath under {@code prefix} (a directory or a jar). */
    private static Set<String> resourcesUnder(String prefix) throws IOException {
        Set<String> out = new TreeSet<>();
        for (Path entry : classpath()) {
            if (Files.isDirectory(entry)) {
                Path root = entry.resolve(prefix);
                if (!Files.isDirectory(root)) continue;
                try (Stream<Path> s = Files.walk(root)) {
                    s.filter(Files::isRegularFile)
                            .forEach(p -> out.add(entry.relativize(p).toString().replace(File.separatorChar, '/')));
                }
            } else if (Files.isRegularFile(entry) && entry.toString().endsWith(".jar")) {
                try (JarFile jar = new JarFile(entry.toFile())) {
                    jar.stream().filter(e -> !e.isDirectory() && e.getName().startsWith(prefix))
                            .forEach(e -> out.add(e.getName()));
                }
            }
        }
        return out;
    }

    private static final String GENERATOR_PACKAGE_PATH = "com/metaobjects/";

    /** Every concrete {@link Generator} class the plugin's classpath holds, test classes aside. */
    private static Set<String> generatorClasses() throws Exception {
        Set<String> out = new TreeSet<>();
        for (String resource : resourcesUnder(GENERATOR_PACKAGE_PATH)) {
            if (!resource.endsWith(".class") || resource.contains("$")) continue;
            String name = resource.substring(0, resource.length() - ".class".length()).replace('/', '.');
            Class<?> c;
            try {
                c = Class.forName(name, false, EjectContractTest.class.getClassLoader());
            } catch (LinkageError | ClassNotFoundException e) {
                continue;   // an optional dependency this classpath does not carry
            }
            URL from = c.getProtectionDomain().getCodeSource().getLocation();
            if (from.toString().contains("test-classes")) continue;
            if (Generator.class.isAssignableFrom(c) && !c.isInterface() && !Modifier.isAbstract(c.getModifiers())) {
                out.add(name);
            }
        }
        return out;
    }

    // ---------------------------------------------------------------------------------
    // census
    // ---------------------------------------------------------------------------------

    private static List<EjectSupport.Entry> javaEntries() {
        return EjectSupport.allEntries().stream()
                .filter(e -> e.port == EjectSupport.Port.JAVA).collect(Collectors.toList());
    }

    @Test
    public void censusEveryGeneratorClassBelongsToARegistryEntry() throws Exception {
        Set<String> registered = new TreeSet<>();
        for (EjectSupport.Entry e : EjectSupport.allEntries()) {
            // A generator's bases and writers are copied with it, and some are generators.
            if (e.classname != null) registered.add(e.classname);
            registered.addAll(e.sources());
        }
        // Kotlin names its classes by constructor, so its registry is asked for instances.
        com.metaobjects.generator.kotlin.GeneratorRegistryKt.getGENERATOR_REGISTRY().values()
                .forEach(info -> registered.add(info.getFactory().invoke().getClass().getName()));

        Set<String> found = generatorClasses();
        assertTrue("the classpath scan found too few generators to be believed: " + found, found.size() > 20);
        Set<String> unregistered = new TreeSet<>(found);
        unregistered.removeAll(registered);
        assertTrue("generator classes no registry entry names, so no catalog, eject goal or test sees them: "
                + unregistered + ". Register each in its port's GeneratorRegistry and in " + MANIFEST_PATH + ".",
                unregistered.isEmpty());
    }

    @Test
    public void censusTheRegistryExposesTheNamesTheSharedFileGivesThisPort() {
        Set<String> expected = portSlice();
        Set<String> actual = new TreeSet<>(GeneratorRegistry.list().keySet());
        Set<String> extra = new TreeSet<>(actual);
        extra.removeAll(expected);
        assertEquals("registered, but the shared file does not list it for java", Set.of(), extra);
        Set<String> missing = new TreeSet<>(expected);
        missing.removeAll(actual);
        assertEquals("expected in the Java registry by the shared file; a pending census entry must list each",
                pending("census").keySet(), missing);
    }

    // ---------------------------------------------------------------------------------
    // completeness
    // ---------------------------------------------------------------------------------

    @Test
    public void completenessEveryRegisteredGeneratorShipsEjectSourceUnlessExempt() {
        Set<String> waiting = pending("completeness").keySet();
        List<String> problems = new ArrayList<>();
        Set<String> registered = new TreeSet<>();
        for (EjectSupport.Entry e : javaEntries()) {
            registered.add(e.stableName);
            boolean ejectable = e.resourcePath != null;
            if (isExempt(e.stableName)) {
                if (ejectable) problems.add(e.stableName + ": exempt in the shared file but ejectable; drop the exemption");
                continue;
            }
            if (ejectable && waiting.contains(e.stableName)) {
                problems.add(e.stableName + ": ejectable now; remove its pending completeness entry");
            }
            if (!ejectable && !waiting.contains(e.stableName)) {
                problems.add(e.stableName + ": no eject source, and the shared file does not exempt it");
            }
        }
        for (String name : waiting) {
            if (!registered.contains(name)) {
                problems.add(name + ": pending completeness entry for a generator this port does not register");
            }
        }
        assertTrue(String.join("\n", problems), problems.isEmpty());
    }

    /** The pom include lists, read from what they produced: a reference source the registry
     *  does not name is shipped for nobody, and one it names and no jar ships cannot be ejected. */
    @Test
    public void completenessTheShippedReferenceSourcesAreExactlyTheOnesTheRegistryNames() throws IOException {
        String root = GeneratorRegistry.EJECT_RESOURCE_ROOT;
        Set<String> named = new TreeSet<>();
        for (EjectSupport.Entry e : javaEntries()) {
            if (e.resourcePath == null) continue;
            for (String classname : e.sources()) named.add(root + EjectSupport.simpleNameOf(classname) + ".java");
            for (String runtime : e.runtime) named.add(GeneratorRegistry.EJECT_RUNTIME_RESOURCE_ROOT + runtime + ".java");
        }
        for (String support : GeneratorRegistry.EJECT_SUPPORT) {
            named.add(GeneratorRegistry.EJECT_SUPPORT_RESOURCE_ROOT + support + ".java");
        }
        assertEquals(named, resourcesUnder(root));
    }

    // ---------------------------------------------------------------------------------
    // depth
    // ---------------------------------------------------------------------------------

    private static List<EjectSupport.Entry> ejectable() {
        return javaEntries().stream().filter(e -> e.resourcePath != null).collect(Collectors.toList());
    }

    /** Eject one generator by itself, through the real mojo, into an empty project. */
    private Path ejectAlone(String stableName) throws Exception {
        Path projectDir = tempFolder.newFolder().toPath();
        MavenProject project = Mockito.mock(MavenProject.class);
        Mockito.when(project.getBasedir()).thenReturn(projectDir.toFile());
        Mockito.when(project.getGroupId()).thenReturn("com.acme");
        Mockito.when(project.getArtifactId()).thenReturn("widgets");
        Mockito.when(project.getVersion()).thenReturn("1.0.0");
        Mockito.when(project.getDependencies()).thenReturn(List.of());
        MetaDataEjectMojo mojo = new MetaDataEjectMojo();
        mojo.project = project;
        mojo.names = stableName;
        mojo.port = PORT;
        mojo.execute();
        return projectDir;
    }

    /** Compile what eject wrote under {@code codegen/}, alone, against the published classpath. */
    private Path compileAlone(String stableName, Path projectDir) throws IOException {
        List<File> sources;
        try (Stream<Path> s = Files.walk(projectDir.resolve("codegen/src/main/java"))) {
            sources = s.filter(p -> p.toString().endsWith(".java")).map(Path::toFile).collect(Collectors.toList());
        }
        assertFalse(stableName + ": eject wrote no source", sources.isEmpty());
        Path classes = tempFolder.newFolder().toPath();
        JavaCompiler javac = ToolProvider.getSystemJavaCompiler();
        DiagnosticCollector<JavaFileObject> diagnostics = new DiagnosticCollector<>();
        try (StandardJavaFileManager fm = javac.getStandardFileManager(diagnostics, null, StandardCharsets.UTF_8)) {
            fm.setLocation(StandardLocation.CLASS_OUTPUT, List.of(classes.toFile()));
            javac.getTask(null, fm, diagnostics,
                    List.of("-proc:none", "-classpath", System.getProperty("java.class.path")),
                    null, fm.getJavaFileObjectsFromFiles(sources)).call();
        }
        String errors = diagnostics.getDiagnostics().stream()
                .filter(d -> d.getKind() == Diagnostic.Kind.ERROR).map(d -> "  " + d).collect(Collectors.joining("\n"));
        assertEquals(stableName + ", ejected alone, does not compile", "", errors);
        return classes;
    }

    private static final Pattern PACKAGED_CLASS = Pattern.compile("com/metaobjects/[A-Za-z0-9_/$]+");

    /**
     * Every packaged class a compiled class file names: the class names, descriptors and
     * signatures in its constant pool. A string the generator EMITS never qualifies: emitted
     * Java spells packages with dots, and a constant holding whitespace is not a name.
     */
    static Set<String> referencedClasses(byte[] classFile) throws IOException {
        Set<String> out = new TreeSet<>();
        DataInputStream in = new DataInputStream(new ByteArrayInputStream(classFile));
        in.skipBytes(8);   // magic, minor, major
        int count = in.readUnsignedShort();
        for (int i = 1; i < count; i++) {
            int tag = in.readUnsignedByte();
            switch (tag) {
                case 1: {
                    String text = in.readUTF();
                    if (text.indexOf('.') >= 0 || text.chars().anyMatch(Character::isWhitespace)) break;
                    Matcher m = PACKAGED_CLASS.matcher(text);
                    while (m.find()) out.add(m.group().replace('/', '.').replaceFirst("\\$.*", ""));
                    break;
                }
                case 3: case 4: case 9: case 10: case 11: case 12: case 17: case 18: in.skipBytes(4); break;
                case 5: case 6: in.skipBytes(8); i++; break;
                case 7: case 8: case 16: case 19: case 20: in.skipBytes(2); break;
                case 15: in.skipBytes(3); break;
                default: throw new IOException("unknown constant pool tag " + tag);
            }
        }
        return out;
    }

    private static Set<String> outsideEngineSurface(Path classes) throws IOException {
        Set<String> outside = new TreeSet<>();
        try (Stream<Path> s = Files.walk(classes)) {
            for (Path file : s.filter(p -> p.toString().endsWith(".class")).collect(Collectors.toList())) {
                for (String name : referencedClasses(Files.readAllBytes(file))) {
                    if (outsideEngineSurface(name)) outside.add(name);
                }
            }
        }
        return outside;
    }

    @Test
    public void depthAnOwnedCopyReferencesOnlyTheEngineSurface() throws Exception {
        Map<String, Set<String>> waiting = pending("depth");
        List<String> problems = new ArrayList<>();
        Set<String> names = new TreeSet<>();
        for (EjectSupport.Entry e : ejectable()) {
            names.add(e.stableName);
            Set<String> actual = outsideEngineSurface(compileAlone(e.stableName, ejectAlone(e.stableName)));
            Set<String> expected = waiting.getOrDefault(e.stableName, Set.of());
            if (actual.equals(expected)) continue;
            if (expected.isEmpty()) {
                problems.add(e.stableName + ": its owned copy calls emit code that stays in the package: " + actual
                        + ". Hand it over with the generator; a reference to the engine belongs in "
                        + "eject.engineSurface.java.engine.");
            } else if (actual.isEmpty()) {
                problems.add(e.stableName + ": its owned copy is whole now; remove its pending depth entry");
            } else {
                problems.add(e.stableName + ": pending depth entries list " + expected
                        + ", the owned copy references " + actual);
            }
        }
        for (String name : waiting.keySet()) {
            if (!names.contains(name)) problems.add(name + ": pending depth entry for a generator that is not ejectable");
        }
        assertTrue(String.join("\n", problems), problems.isEmpty());
    }

    @Test
    public void depthEveryEngineSurfaceEntryNamesARealClass() {
        List<String> stale = new ArrayList<>();
        for (String name : surface("engine")) {
            if (name.contains("*")) continue;
            try {
                Class.forName(name, false, getClass().getClassLoader());
            } catch (ClassNotFoundException | LinkageError e) {
                stale.add(name);
            }
        }
        assertEquals("eject.engineSurface.java.engine names classes that do not exist", List.of(), stale);
    }

    /** A shared model, and the directory its template refs resolve under. */
    private static final class Corpus {
        final String label;
        final Path model;
        final Path templates;

        Corpus(String label, String model, String templates) {
            this.label = label;
            this.model = repoRoot().resolve("fixtures").resolve(model);
            this.templates = templates == null ? null : repoRoot().resolve("fixtures").resolve(templates);
        }

        private MetaDataLoader loader;

        /** Loaded once and shared by both sides: generated headers name the loader. */
        MetaDataLoader loader() throws IOException {
            if (loader != null) return loader;
            // A loader's name is an identifier.
            MetaDataLoader loading = new MetaDataLoader(LoaderOptions.create(false, false, true),
                    MetaDataLoader.SUBTYPE_MANUAL, "ejectContract_" + label.replace('-', '_'));
            if (Files.isDirectory(model)) {
                loading.init();
                loading.load(new DirectorySource(model, new DirectorySource.Options()).expandToList());
            } else {
                loading.setSourceURIs(List.of(URIHelper.toURI(
                        "model:file:" + model.toAbsolutePath().toString().replace('\\', '/'))));
                loading.init();
            }
            assertTrue(label + ": " + loading.getErrors(), loading.getErrors().isEmpty());
            loader = loading;
            return loader;
        }
    }

    /** Shared models that between them make every ejectable generator emit. */
    private static final List<Corpus> CORPORA = List.of(
            new Corpus("fitness", "persistence-conformance/canonical/meta.fitness.json",
                    "persistence-conformance/canonical/prompts"),
            new Corpus("requirements", "requirement-test-identity-conformance/worked-example/input", null),
            new Corpus("llm-call", "conformance/ai-trace-prompt-nested/input", null));

    private Map<String, String> run(Generator generator, Corpus corpus, MetaDataLoader loader, boolean packaged)
            throws IOException {
        Path out = tempFolder.newFolder().toPath();
        Map<String, String> args = new LinkedHashMap<>();
        args.put("outputDir", out.toString());
        args.put("packageName", "acme");
        args.put("type", "interface");   // the one argument "entity" requires
        // Required by the generators that read template text, whatever the model holds.
        args.put("templateRoot", (corpus.templates != null ? corpus.templates : CORPORA.get(0).templates).toString());
        args.put("testPackage", "com.example.requirements");
        args.put("witnessClass", "com.example.Witnesses");
        args.put("warnUncovered", "false");
        // The one difference an owned copy's output is allowed: it imports the helper runtime
        // the adopter owns. The packaged generator is pointed at the same package to compare.
        if (packaged) args.put("runtimePackage", OWNED_RUNTIME_PACKAGE);
        if (generator instanceof ProjectClassLoaderAware) {
            ((ProjectClassLoaderAware) generator).setProjectClassLoader(getClass().getClassLoader());
        }
        generator.setArgs(args).execute(loader);
        Map<String, String> tree = new TreeMap<>();
        try (Stream<Path> s = Files.walk(out)) {
            for (Path p : s.filter(Files::isRegularFile).collect(Collectors.toList())) {
                tree.put(out.relativize(p).toString(), Files.readString(p, StandardCharsets.UTF_8));
            }
        }
        return tree;
    }

    @Test
    public void depthAnUnchangedOwnedCopyEmitsWhatThePackagedGeneratorEmits() throws Exception {
        List<String> silent = new ArrayList<>();
        for (EjectSupport.Entry e : ejectable()) {
            Path classes = compileAlone(e.stableName, ejectAlone(e.stableName));
            int emitted = 0;
            try (URLClassLoader cl = new URLClassLoader(new URL[]{classes.toUri().toURL()}, getClass().getClassLoader())) {
                for (Corpus corpus : CORPORA) {
                    String where = e.stableName + " over " + corpus.label;
                    Generator packaged = (Generator) Class.forName(e.classname).getDeclaredConstructor().newInstance();
                    Generator owned = (Generator) Class.forName(OWNED_PACKAGE + "." + e.simpleName(), true, cl)
                            .getDeclaredConstructor().newInstance();
                    Map<String, String> a = run(packaged, corpus, corpus.loader(), true);
                    Map<String, String> b = run(owned, corpus, corpus.loader(), false);
                    emitted += a.size();
                    assertEquals(where, a.keySet(), b.keySet());
                    for (Map.Entry<String, String> file : a.entrySet()) {
                        assertEquals(where + ": " + file.getKey(), file.getValue(), b.get(file.getKey()));
                    }
                }
            }
            // An empty emit on both sides compares equal and proves nothing.
            if (emitted == 0) silent.add(e.stableName);
        }
        assertEquals("emitted nothing over the corpora, so nothing was compared", List.of(), silent);
    }
}

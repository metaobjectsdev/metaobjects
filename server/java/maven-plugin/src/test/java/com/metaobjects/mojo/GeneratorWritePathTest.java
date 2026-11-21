package com.metaobjects.mojo;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import com.metaobjects.generator.Generator;
import com.metaobjects.generator.GeneratorRegistry;
import com.metaobjects.generator.kotlin.GeneratorRegistryKt;
import com.metaobjects.generator.util.GeneratedFileWriter;
import com.metaobjects.loader.LoaderOptions;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.loader.uri.URIHelper;
import java.io.IOException;
import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.FileTime;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.function.Supplier;
import java.util.stream.Stream;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

/**
 * Every registered Java and Kotlin generator writes through {@link GeneratedFileWriter}.
 *
 * <p>The JVM ports have no shared runner loop: each generator writes its own files, and the hash
 * manifest, the hand-edit refusal, the output-path collision check, the in-memory capture
 * {@code verify} renders through and the unchanged-bytes check all live in that one class. A
 * generator that opens a file any other way silently loses all five.
 *
 * <p>The oracle is the disk. Each generator in both registries runs, as the Maven goal runs it,
 * over the shared fitness corpus inside one {@link GeneratedFileWriter.Run} with a manifest; every
 * file then left under the output directory must be among the run's emitted paths, because a
 * file only the writer saw is a file the writer owns. A second run over the same tree must then
 * leave every file's bytes and modification time alone. A generator that writes a file by another
 * API fails the first check whatever API it used; one that rewrites unchanged bytes fails the
 * second.
 */
public class GeneratorWritePathTest {

    private Path root;
    private Path repo;
    private Path canonical;
    private MetaDataLoader loader;

    @Before
    public void setUp() throws IOException {
        repo = findRepo();
        canonical = repo.resolve("fixtures/persistence-conformance/canonical");
        String scratch = System.getenv("DEV_SCRATCH");
        Path base = scratch == null || scratch.isBlank() ? Path.of(System.getProperty("java.io.tmpdir")) : Path.of(scratch);
        Files.createDirectories(base);
        root = Files.createTempDirectory(base, "generator-write-path-");
        URI uri = URIHelper.toURI("model:file:"
                + canonical.resolve("meta.fitness.json").toAbsolutePath().toString().replace('\\', '/'));
        loader = new MetaDataLoader(LoaderOptions.create(false, false, true),
                MetaDataLoader.SUBTYPE_MANUAL, "generator-write-path-test");
        loader.setSourceURIs(List.of(uri));
        loader.init();
    }

    @After
    public void tearDown() throws IOException {
        if (root == null) return;
        try (Stream<Path> s = Files.walk(root)) {
            for (Path p : s.sorted(Comparator.reverseOrder()).toList()) Files.deleteIfExists(p);
        }
    }

    private static Path findRepo() {
        for (Path p = Path.of(System.getProperty("user.dir")).toAbsolutePath().normalize(); p != null; p = p.getParent()) {
            if (Files.isDirectory(p.resolve("fixtures/persistence-conformance/canonical"))) return p;
        }
        throw new IllegalStateException("could not locate the repository root");
    }

    /** One generator to run: a stable name beside the language port, and a fresh instance per run. */
    private record Entry(String name, Supplier<Generator> factory) {}

    private static Generator construct(String classname) {
        try {
            return (Generator) Class.forName(classname).getDeclaredConstructor().newInstance();
        } catch (ReflectiveOperationException e) {
            throw new IllegalStateException(classname, e);
        }
    }

    private static List<Entry> registered() {
        List<Entry> all = new ArrayList<>();
        GeneratorRegistry.list().forEach((name, info) ->
                all.add(new Entry("java-" + name, () -> construct(info.classname()))));
        GeneratorRegistryKt.getGENERATOR_REGISTRY().forEach((name, info) ->
                all.add(new Entry("kotlin-" + name, () -> info.getFactory().invoke())));
        return all;
    }

    private Map<String, String> args(Entry e, Path outDir) {
        Map<String, String> a = new LinkedHashMap<>();
        a.put("outputDir", outDir.toString());
        a.put("packageName", "fitness");
        a.put("templateRoot", canonical.resolve("prompts").toString());
        a.put("type", "class");
        a.put("flavor", "pojoAware");
        switch (e.name()) {
            case "java-template" -> {
                a.put("template", "entity");
                a.put("scope", "perEntity");
                a.put("outputPattern", "{name}.txt");
                a.put("templatesDir", repo.resolve("fixtures/template-codegen-conformance/templates").toString());
            }
            case "java-ai-docs", "java-html-docs", "java-json-schema", "java-plantuml" ->
                a.put("outputFilename", "document.out");
            case "java-shared-model", "kotlin-shared-model" -> {
                a.put("name", "fitness");
                a.put("include", "fitness::**");
                a.put("files", canonical.resolve("meta.fitness.json").toString());
                a.put("version", "1.0.0");
            }
            case "java-mustache" -> {
                a.put("templatePath", repo.resolve("server/java/codegen-mustache/src/test/resources/templates").toString());
                a.put("targetLanguage", "java");
                a.put("templateName", "basic-entity");
            }
            default -> { }
        }
        return a;
    }

    /** What each run wrote: the files left on disk, and the paths the writer was asked for. */
    private record Result(Map<Path, byte[]> disk, Set<Path> emitted) {}

    private Result run(List<Entry> entries, Path outRoot, Path genState) throws Exception {
        Set<Path> emitted = new TreeSet<>();
        try (GeneratedFileWriter.Run run = GeneratedFileWriter.beginRun()) {
            run.configureManifest(genState, root);
            for (Entry e : entries) {
                run.attributeTo(e.name());
                // A directory each: the entity and value-object tiers both write a type per value
                // object, and this test measures the write path, not a coherent project.
                Generator g = e.factory().get();
                g.setArgs(args(e, outRoot.resolve(e.name())));
                g.execute(loader);
            }
            emitted.addAll(run.emittedPaths());
        }
        Map<Path, byte[]> disk = new TreeMap<>();
        try (Stream<Path> s = Files.walk(outRoot)) {
            for (Path p : s.filter(Files::isRegularFile).toList()) disk.put(p.toAbsolutePath().normalize(), Files.readAllBytes(p));
        }
        return new Result(disk, emitted);
    }

    @Test
    public void everyFileOnDiskWasWrittenThroughTheWriterAndASecondRunWritesNothing() throws Exception {
        List<Entry> entries = registered();
        assertTrue("both registries should contribute", entries.stream().anyMatch(e -> e.name().startsWith("java-"))
                && entries.stream().anyMatch(e -> e.name().startsWith("kotlin-")));
        Path out = root.resolve("out");
        Path genState = root.resolve(".metaobjects/.gen-state");

        Result first = run(entries, out, genState);
        assertFalse("the corpus generated nothing at all", first.disk().isEmpty());
        List<Path> bypassed = new ArrayList<>();
        for (Path p : first.disk().keySet()) if (!first.emitted().contains(p)) bypassed.add(out.relativize(p));
        assertEquals("These files are on disk but no GeneratedFileWriter call produced them: write generated files with "
                + "GeneratedFileWriter.write (or writeUnmarked for output that cannot carry the GENERATED marker), so "
                + "the file is recorded in the hash manifest and unchanged bytes are never rewritten.",
                List.of(), bypassed);

        FileTime old = FileTime.fromMillis(1_000_000_000_000L);
        for (Path p : first.disk().keySet()) Files.setLastModifiedTime(p, old);

        Result second = run(entries, out, genState);
        assertEquals("a second run changed the set of files", first.disk().keySet(), second.disk().keySet());
        List<Path> rewritten = new ArrayList<>();
        for (Map.Entry<Path, byte[]> e : second.disk().entrySet()) {
            boolean sameBytes = Arrays.equals(first.disk().get(e.getKey()), e.getValue());
            boolean sameTime = Files.getLastModifiedTime(e.getKey()).equals(old);
            if (!sameBytes || !sameTime) rewritten.add(out.relativize(e.getKey()));
        }
        assertEquals("a second run over an unchanged tree must not write any file", List.of(), rewritten);
    }
}

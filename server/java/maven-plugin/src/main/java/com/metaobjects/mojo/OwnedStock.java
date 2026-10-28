package com.metaobjects.mojo;

import com.metaobjects.generator.GeneratorRegistry;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * The owned generator copies under {@code codegen/} that are identical to the stock generator
 * this plugin ships: what {@code mvn metaobjects:eject -Dundo=true} removes, and what
 * {@code metaobjects:generate} mentions in one advisory line.
 *
 * <p>Maven-free, like {@link EjectSupport}: it takes directories and a resource reader. "Identical"
 * is {@link EjectSupport#compare} over every file the eject wrote for the generator: the generator,
 * the classes copied with it and the page templates it reads (a file gone missing counts as
 * differing), and the shared support and helper runtime copies it reaches. Undo never deletes the
 * shared copies (other owned generators import them) and names them instead; but a change to one
 * keeps the generator out of "identical", because the shipped generator imports the shipped
 * support and runtime, so the change would stop reaching the generated code.
 */
final class OwnedStock {

    private OwnedStock() {}

    /** Reads a reference resource off the classpath. */
    interface Reader {
        String read(String resourcePath) throws IOException;
    }

    static Reader classpath(ClassLoader loader) {
        return resource -> {
            try (InputStream in = loader.getResourceAsStream(resource)) {
                if (in == null) throw new IOException("classpath resource not found: " + resource);
                return new String(in.readAllBytes(), StandardCharsets.UTF_8);
            }
        };
    }

    /** One owned copy found under {@code codegen/}. */
    static final class Copy {
        final EjectSupport.Entry entry;
        /** The package the copy lives in, read from where the adopter put it. */
        final String ownedPackage;
        /** Every file of the copy that exists: the generator, its companions, its templates. */
        final List<Path> files;
        /** Names of the files that differ from, or are missing against, the shipped ones. */
        final List<String> differing;
        final int behind;
        final int ownedOnly;
        /** Shared copies left in place by an undo: support classes and helper runtime. */
        final List<String> shared;

        Copy(EjectSupport.Entry entry, String ownedPackage, List<Path> files, List<String> differing,
             int behind, int ownedOnly, List<String> shared) {
            this.entry = entry;
            this.ownedPackage = ownedPackage;
            this.files = files;
            this.differing = differing;
            this.behind = behind;
            this.ownedOnly = ownedOnly;
            this.shared = shared;
        }

        boolean identical() { return differing.isEmpty(); }

        /** The {@code <classname>} the pom names today. */
        String ownedClassname() { return ownedPackage + "." + entry.simpleName(); }

        /** The {@code <classname>} that points back at the shipped generator. */
        String stockClassname() { return entry.classname; }
    }

    /** The source roots an owned helper runtime may sit under: {@code base}'s and each module's
     *  {@code src/main/java}. */
    static List<Path> runtimeRoots(Path base, List<String> modules) {
        List<Path> roots = new ArrayList<>();
        roots.add(base.resolve("src/main/java"));
        if (modules != null) {
            for (String module : modules) roots.add(base.resolve(module).resolve("src/main/java"));
        }
        return roots;
    }

    /** The owned runtime copy of {@code simple} under {@code roots}, recognised by its ownership
     *  marker, or {@code null}. */
    static Path findOwnedRuntime(List<Path> roots, String simple) throws IOException {
        for (Path root : roots) {
            if (!Files.isDirectory(root)) continue;
            try (var walk = Files.walk(root)) {
                for (Path p : (Iterable<Path>) walk.filter(f -> f.getFileName().toString().equals(simple + ".java"))::iterator) {
                    if (EjectSupport.isOwnedRuntime(Files.readString(p, StandardCharsets.UTF_8))) return p;
                }
            }
        }
        return null;
    }

    /** Every owned copy under {@code codegenRoot}, in catalog order; empty when there is none. The
     *  helper runtime its output imports is looked for under {@code runtimeRoots}. */
    static List<Copy> find(Path codegenRoot, List<Path> runtimeRoots, Reader reader) throws IOException {
        List<Copy> out = new ArrayList<>();
        if (codegenRoot == null || !Files.isDirectory(codegenRoot)) return out;
        for (EjectSupport.Entry e : EjectSupport.allEntries()) {
            if (e.resourcePath == null) continue;
            String langDir = e.port == EjectSupport.Port.KOTLIN ? "kotlin" : "java";
            Path found = MetaDataEjectMojo.findOwned(codegenRoot, langDir, e.simpleName() + "." + e.port.extension);
            if (found == null) continue;
            Path srcRoot = codegenRoot.resolve("src/main/" + langDir);
            String ownedPackage = srcRoot.relativize(found.getParent()).toString()
                    .replace(found.getFileSystem().getSeparator(), ".");
            List<Path> files = new ArrayList<>();
            List<String> differing = new ArrayList<>();
            int[] totals = new int[2];
            for (String source : e.sources()) {
                String name = EjectSupport.simpleNameOf(source) + "." + e.port.extension;
                Path file = found.resolveSibling(name);
                String owned = "";
                if (Files.exists(file)) {
                    files.add(file);
                    owned = Files.readString(file, StandardCharsets.UTF_8);
                }
                String reference = EjectSupport.rewriteCopiedImports(
                        reader.read(e.resourceOf(source)), e.sources(), ownedPackage);
                fold(totals, differing, name, EjectSupport.compare(owned, reference));
            }
            if (e.port == EjectSupport.Port.JAVA) {
                Path resourceRoot = codegenRoot.resolve("src/main/resources")
                        .resolve(EjectSupport.ownedTemplatePrefix(ownedPackage));
                for (String ref : e.resources) {
                    Path file = resourceRoot.resolve(ref + EjectSupport.TEMPLATE_EXTENSION);
                    String owned = "";
                    if (Files.exists(file)) {
                        files.add(file);
                        owned = Files.readString(file, StandardCharsets.UTF_8);
                    }
                    fold(totals, differing, ref + EjectSupport.TEMPLATE_EXTENSION, EjectSupport.compare(
                            owned, reader.read(GeneratorRegistry.EJECT_TEMPLATE_RESOURCE_ROOT
                                    + ref + EjectSupport.TEMPLATE_EXTENSION)));
                }
                Set<String> support = new LinkedHashSet<>();
                for (String source : e.sources()) support.addAll(EjectSupport.supportFor(reader.read(e.resourceOf(source))));
                for (String simple : support) {
                    Path owned = MetaDataEjectMojo.findOwned(codegenRoot, "java", simple + ".java");
                    if (owned == null) continue;
                    fold(totals, differing, simple + ".java", EjectSupport.compare(
                            Files.readString(owned, StandardCharsets.UTF_8),
                            reader.read(GeneratorRegistry.EJECT_SUPPORT_RESOURCE_ROOT + simple + ".java")));
                }
                for (String simple : e.runtime) {
                    Path owned = findOwnedRuntime(runtimeRoots, simple);
                    if (owned == null) continue;
                    fold(totals, differing, simple + ".java", EjectSupport.compare(
                            Files.readString(owned, StandardCharsets.UTF_8),
                            reader.read(GeneratorRegistry.EJECT_RUNTIME_RESOURCE_ROOT + simple + ".java")));
                }
            }
            out.add(new Copy(e, ownedPackage, files, differing, totals[0], totals[1],
                    shared(codegenRoot, e, reader)));
        }
        return out;
    }

    /** The shared copies an undo leaves: owned support classes the generator imports, and the
     *  helper runtime its output imports (named whether or not a copy exists). */
    private static List<String> shared(Path codegenRoot, EjectSupport.Entry e, Reader reader) throws IOException {
        Set<String> out = new LinkedHashSet<>();
        if (e.port == EjectSupport.Port.JAVA) {
            for (String source : e.sources()) {
                for (String simple : EjectSupport.supportFor(reader.read(e.resourceOf(source)))) {
                    if (MetaDataEjectMojo.findOwned(codegenRoot, "java", simple + ".java") != null) out.add(simple);
                }
            }
            out.addAll(e.runtime);
        }
        return new ArrayList<>(out);
    }

    /** The copies of {@code copies} whose files are all identical to the shipped ones. */
    static List<Copy> identical(List<Copy> copies) {
        return copies.stream().filter(Copy::identical).collect(Collectors.toList());
    }

    /**
     * The advisory line {@code metaobjects:generate} logs, or {@code null} when no owned copy is
     * identical to the shipped generator.
     */
    static String notice(List<Copy> copies) {
        List<Copy> same = identical(copies);
        if (same.isEmpty()) return null;
        String names = same.stream().map(c -> c.entry.stableName).distinct().collect(Collectors.joining(", "));
        return "Owned generator copies under codegen/ identical to the shipped ones: " + names
                + ". They add nothing to what the plugin runs; drop them with "
                + "`mvn metaobjects:eject -Dundo=true`.";
    }

    private static void fold(int[] totals, List<String> differing, String name, EjectSupport.Comparison cmp) {
        totals[0] += cmp.behind;
        totals[1] += cmp.ownedOnly;
        if (cmp.verdict != EjectSupport.Verdict.IDENTICAL) differing.add(name);
    }
}

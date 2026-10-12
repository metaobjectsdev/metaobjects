package com.metaobjects.mojo;

import com.metaobjects.generator.DocsGenerator;
import com.metaobjects.generator.GeneratorRegistry;
import com.metaobjects.generator.kotlin.GeneratorInfo;
import com.metaobjects.generator.kotlin.GeneratorRegistryKt;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

/**
 * Shared engine behind {@code mvn metaobjects:eject} / {@code mvn metaobjects:eject -Dlist}
 * (FR — eject in every port, JVM section; ADR-0034 Amendment 3).
 *
 * <p>Deliberately Maven-free: every method here takes plain values (a catalog, a source
 * string, a declared-dependency set) rather than a {@link org.apache.maven.project.MavenProject}
 * or a {@code Log}, so the eject/list LOGIC is unit-testable without a Maven test harness.
 * {@link MetaDataEjectMojo} is the thin Maven-facing wrapper around this.
 */
public final class EjectSupport {

    private EjectSupport() {}

    /** Which JVM port a generator belongs to. */
    public enum Port {
        JAVA("java", "java"),
        KOTLIN("kotlin", "kt");

        public final String id;
        public final String extension;

        Port(String id, String extension) {
            this.id = id;
            this.extension = extension;
        }

        public static Port parse(String s) {
            if (s == null) return null;
            for (Port p : values()) {
                if (p.id.equalsIgnoreCase(s.trim())) return p;
            }
            throw new IllegalArgumentException(
                    "unknown -Dport '" + s + "'; expected 'java' or 'kotlin'");
        }
    }

    /** One ejectable generator, resolved from either port's registry. */
    public static final class Entry {
        public final Port port;
        public final String stableName;
        /** FQN as registered — the {@code <generator><classname>} value being replaced. */
        public final String classname;
        public final String description;
        public final String resourcePath;
        /** Simple names of the helper-runtime classes this generator's OUTPUT imports, which
         *  eject copies alongside it (empty for every Kotlin generator — see
         *  {@link #allEntries()}). */
        public final List<String> runtime;
        /** Wiring the generic eject report cannot know, with {@code {owned}} standing for the
         *  owned copy's class name, or {@code null} (see {@link #wiringNote}). */
        public final String note;
        /** Whether this generator is a {@link DocsGenerator}: {@code metaobjects:docs} runs it
         *  and {@code metaobjects:generate} skips it. */
        public final boolean docs;
        /** Fully-qualified names of the classes eject copies WITH this generator into the
         *  same owned package: the rest of its emit (empty for most generators). */
        public final List<String> with;
        /** Template references the generator reads from the classpath, which eject copies into
         *  the adopter's resources (empty for every generator but {@code api-docs}). */
        public final List<String> resources;

        public Entry(Port port, String stableName, String classname, String description, String resourcePath) {
            this(port, stableName, classname, description, resourcePath, List.of());
        }

        public Entry(Port port, String stableName, String classname, String description,
                     String resourcePath, List<String> runtime) {
            this(port, stableName, classname, description, resourcePath, runtime, null, List.of());
        }

        public Entry(Port port, String stableName, String classname, String description,
                     String resourcePath, List<String> runtime, String note, List<String> with) {
            this(port, stableName, classname, description, resourcePath, runtime, note, with, List.of());
        }

        public Entry(Port port, String stableName, String classname, String description,
                     String resourcePath, List<String> runtime, String note, List<String> with,
                     List<String> resources) {
            this.resources = List.copyOf(resources);
            this.port = port;
            this.stableName = stableName;
            this.classname = classname;
            this.description = description;
            this.resourcePath = resourcePath;
            this.runtime = List.copyOf(runtime);
            this.docs = isDocsGenerator(classname);
            this.note = docs ? stableName + DOCS_NOTE.replace("{surface}", port.id) : note;
            this.with = List.copyOf(with);
        }

        /** Every class eject copies for this generator, by fully-qualified name: the
         *  generator first, then {@link #with}. */
        public List<String> sources() {
            List<String> out = new ArrayList<>();
            out.add(classname);
            out.addAll(with);
            return out;
        }

        /** Classpath resource holding the reference source of {@code source}, one of
         *  {@link #sources()}. */
        public String resourceOf(String source) {
            if (source.equals(classname)) return resourcePath;
            String root = port == Port.KOTLIN
                    ? com.metaobjects.generator.kotlin.GeneratorRegistryKt.EJECT_RESOURCE_ROOT
                    : GeneratorRegistry.EJECT_RESOURCE_ROOT;
            return root + simpleNameOf(source) + "." + port.extension;
        }

        /** {@link #note} with the owned copy's class name filled in, or {@code null} when
         *  this generator's only wiring is the {@code <classname>} change. */
        public String wiringNote(String basePackage) {
            return note == null ? null : note.replace("{owned}", ownedClassname(basePackage));
        }

        /**
         * The package this generator's copies are written in, given the package eject was asked
         * for. A {@link DocsGenerator}'s copies take a subpackage of their port: the Java and the
         * Kotlin api reference name their page model and path classes alike ({@code ApiUnit},
         * {@code DocsPaths}, …), and one owned module may hold both. Every other generator's
         * copies go in {@code basePackage} itself.
         */
        public String ownedPackage(String basePackage) {
            return docs ? basePackage + "." + DOCS_SUBPACKAGE + "." + port.id : basePackage;
        }

        /** The owned copy's class name: the {@code <generator><classname>} value to wire. */
        public String ownedClassname(String basePackage) {
            return ownedPackage(basePackage) + "." + simpleName();
        }

        /** The simple class name — also the filename stem the ejected copy is written as. */
        public String simpleName() {
            return simpleNameOf(classname);
        }
    }

    /** The subpackage of the owned package a {@link DocsGenerator}'s copies are written under,
     *  above the one named for its port (see {@link Entry#ownedPackage}). */
    public static final String DOCS_SUBPACKAGE = "apidocs";

    /** What eject prints for a {@link DocsGenerator}, on either port, after its stable name: no pom
     *  lists one until its owner adds it. {@code {surface}} is the port it documents. */
    private static final String DOCS_NOTE =
            ": `mvn metaobjects:docs` runs this generator, not `metaobjects:generate`, which "
                + "skips it. List it in <generators> with <classname>{owned}</classname> and the "
                + "docs goal runs your copy for the {surface} surface in place of the packaged one.";

    /** Whether the registered generator class {@code classname} is a {@link DocsGenerator}.
     *  Every registered class is on this plugin's classpath. */
    private static boolean isDocsGenerator(String classname) {
        if (classname == null) return false;
        try {
            return DocsGenerator.class.isAssignableFrom(
                    Class.forName(classname, false, EjectSupport.class.getClassLoader()));
        } catch (ClassNotFoundException e) {
            throw new IllegalStateException("registered generator class is not on the classpath: " + classname, e);
        }
    }

    /** The simple name of a fully-qualified class name. */
    public static String simpleNameOf(String classname) {
        int dot = classname.lastIndexOf('.');
        return dot < 0 ? classname : classname.substring(dot + 1);
    }

    /**
     * Every generator BOTH registries declare, ejectable or not (an entry with a {@code
     * null} {@link Entry#resourcePath} is registered but not ejectable — see {@code
     * GeneratorRegistry}'s "template" entry). Insertion order: Java first,
     * then Kotlin, each in its own registry's declared order.
     *
     * <p>Only Java entries carry helper runtime. The Kotlin generators emit their filter
     * parsing, constraint mapping and patch handling INLINE in each generated file, and
     * import nothing but core ({@code com.metaobjects.render.*}, the loader,
     * {@code metadata-ktx}) — so there is nothing for a Kotlin eject to hand over.
     * {@code EjectRuntimeRoundTripTest} asserts that against real Kotlin output.
     */
    public static List<Entry> allEntries() {
        List<Entry> out = new ArrayList<>();
        for (GeneratorRegistry.GeneratorInfo info : GeneratorRegistry.list().values()) {
            out.add(new Entry(Port.JAVA, info.stableName(), info.classname(), info.description(),
                    info.ejectResourcePath(), info.ejectRuntime(), info.ejectNote(),
                    info.ejectWith(), info.ejectResources()));
        }
        for (Map.Entry<String, GeneratorInfo> e : GeneratorRegistryKt.getGENERATOR_REGISTRY().entrySet()) {
            GeneratorInfo info = e.getValue();
            // Kotlin generator classes have no separate public "classname" string field: the
            // registry's factory closure constructs them, so the FQN is the class it builds
            // (calling it must not throw — the registry's own contract). The ejectable resource
            // is named after the class's simple name, e.g. "KotlinNamesGenerator.kt".
            String classname = info.getEjectResourcePath() == null ? null
                    : info.getFactory().invoke().getClass().getName();
            out.add(new Entry(Port.KOTLIN, info.getName(), classname, info.getDescription(),
                    info.getEjectResourcePath(), List.of(), null, info.getEjectWith()));
        }
        return out;
    }

    /** Only the ejectable entries (non-null {@link Entry#resourcePath}), grouped by stable name. */
    public static Map<String, List<Entry>> ejectableByStableName() {
        Map<String, List<Entry>> byName = new LinkedHashMap<>();
        for (Entry e : allEntries()) {
            if (e.resourcePath == null) continue;
            byName.computeIfAbsent(e.stableName, k -> new ArrayList<>()).add(e);
        }
        return byName;
    }

    /** How one requested name resolved — exactly one entry, or a reason it could not. */
    public static final class Resolution {
        public final String name;
        public final Entry entry;   // non-null on success
        public final String error;  // non-null on failure

        private Resolution(String name, Entry entry, String error) {
            this.name = name;
            this.entry = entry;
            this.error = error;
        }

        public boolean ok() { return entry != null; }
    }

    /**
     * Resolve one requested stable name against the ejectable catalog.
     *
     * @param explicitPort {@code -Dport}, or {@code null}
     * @param inferredPort the port inferred from the calling project's declared
     *      dependencies (see {@link #inferPort}), or {@code null}
     */
    public static Resolution resolve(String name, Map<String, List<Entry>> byName,
                                     Port explicitPort, Port inferredPort) {
        List<Entry> candidates = byName.get(name);
        if (candidates == null || candidates.isEmpty()) {
            return new Resolution(name, null, "unknown generator \"" + name + "\"");
        }
        if (candidates.size() == 1) {
            return new Resolution(name, candidates.get(0), null);
        }
        // Ambiguous: the same stable name is ejectable on more than one port.
        Port winner = explicitPort != null ? explicitPort : inferredPort;
        if (winner == null) {
            String ports = candidates.stream().map(c -> c.port.id).collect(Collectors.joining(", "));
            return new Resolution(name, null,
                    "\"" + name + "\" is ejectable on more than one port (" + ports + "). "
                        + "Pass -Dport=java|kotlin, or eject after your project declares a "
                        + "dependency on metaobjects-codegen-spring or metaobjects-codegen-kotlin "
                        + "so it can be inferred.");
        }
        for (Entry c : candidates) {
            if (c.port == winner) return new Resolution(name, c, null);
        }
        return new Resolution(name, null,
                "\"" + name + "\" is not ejectable on port '" + winner.id + "' (only on: "
                    + candidates.stream().map(c -> c.port.id).collect(Collectors.joining(", ")) + ")");
    }

    /**
     * Infer the port from a project's declared dependency artifactIds: exactly one of
     * {@code metaobjects-codegen-spring} / {@code metaobjects-codegen-kotlin} present, in
     * either order. Returns {@code null} (no inference) when neither or both are declared.
     */
    public static Port inferPort(List<String> declaredArtifactIds) {
        boolean java = declaredArtifactIds.contains("metaobjects-codegen-spring");
        boolean kotlin = declaredArtifactIds.contains("metaobjects-codegen-kotlin");
        if (java && !kotlin) return Port.JAVA;
        if (kotlin && !java) return Port.KOTLIN;
        return null;
    }

    // ------------------------------------------------------------------------------------
    // package rewrite — the edit every copy gets (ADR-0034, the JVM eject design). A generator
    // copied WITH other classes gets one more, which is the same rename seen from the importing
    // side: see rewriteCopiedImports. A Java generator may get two further edits, both further
    // down: its RUNTIME_PACKAGE declaration and its support imports.
    // ------------------------------------------------------------------------------------

    private static final Pattern PACKAGE_LINE = Pattern.compile("(?m)^package\\s+[\\w.]+\\s*;?\\s*$");

    /**
     * Rewrite the FIRST {@code package ...} line of {@code source} to {@code newPackage},
     * preserving the source's own punctuation (Java's trailing {@code ;}, Kotlin's lack of
     * one). Every ejectable reference file declares its package as literally its first
     * non-comment/non-blank statement, so replacing the first match is unambiguous.
     */
    public static String rewritePackage(String source, String newPackage) {
        Matcher m = PACKAGE_LINE.matcher(source);
        if (!m.find()) {
            throw new IllegalStateException("reference source has no 'package ...' line to rewrite");
        }
        boolean semicolon = m.group().stripTrailing().endsWith(";");
        String replacement = "package " + newPackage + (semicolon ? ";" : "");
        return new StringBuilder(source).replace(m.start(), m.end(), replacement).toString();
    }

    /**
     * Point every import of a class in {@code copied} (fully-qualified names) at its copy in
     * {@code ownedPackage}. The classes eject copies for one generator land in one package,
     * so a bare same-package reference between them already means the copy; an
     * {@code import} of one would still name the packaged class, and the owned generator
     * would go on extending and calling code its owner cannot edit. An import of anything
     * else is left alone. Java closes an import with {@code ;} and Kotlin does not; each
     * keeps its own punctuation.
     */
    public static String rewriteCopiedImports(String source, List<String> copied, String ownedPackage) {
        String out = source;
        for (String classname : copied) {
            out = out.replaceAll("(?m)^import\\s+" + Pattern.quote(classname) + "(?=\\s*;|[ \\t]*$)",
                    Matcher.quoteReplacement("import " + ownedPackage + "." + simpleNameOf(classname)));
        }
        return out;
    }

    /**
     * The owned copy of {@code reference}, the source of one of {@code entry}'s
     * {@link Entry#sources()}: its package renamed to {@code ownedPackage}, and its imports
     * of the classes copied with it pointed at those copies.
     */
    public static String ownedSource(Entry entry, String reference, String ownedPackage) {
        return rewriteCopiedImports(rewritePackage(reference, ownedPackage), entry.sources(), ownedPackage);
    }

    // ------------------------------------------------------------------------------------
    // templates — the page text a generator reads from the classpath, handed over with it
    // ------------------------------------------------------------------------------------

    /** The declaration a copied template provider names its classpath prefix in. */
    private static final Pattern TEMPLATE_PREFIX_DECL = Pattern.compile(
            "(?m)^(\\s*private static final String BASE_PREFIX = )\"[\\w/]+\";\\s*$");

    /** The classpath directory the owned templates of the generators in {@code ownedPackage} are
     *  written under: the package's own path, so no other module's templates can shadow them. */
    public static String ownedTemplatePrefix(String ownedPackage) {
        return ownedPackage.replace('.', '/') + "/" + GeneratorRegistry.TEMPLATE_RESOURCE_PREFIX;
    }

    /** Point a copied template provider's {@code BASE_PREFIX} at {@link #ownedTemplatePrefix}. A
     *  source with no such declaration is returned unchanged. */
    public static String rewriteTemplatePrefix(String source, String ownedPackage) {
        Matcher m = TEMPLATE_PREFIX_DECL.matcher(source);
        if (!m.find()) return source;
        String replacement = m.group(1) + "\"" + ownedTemplatePrefix(ownedPackage) + "\";";
        return new StringBuilder(source).replace(m.start(), m.end(), replacement).toString();
    }

    /** The extension a template reference resolves with. */
    public static final String TEMPLATE_EXTENSION = ".md.mustache";

    // ------------------------------------------------------------------------------------
    // helper runtime — the source a generator's OUTPUT imports, handed over with it
    // ------------------------------------------------------------------------------------

    /** The declaration an ejectable Java generator names its runtime package in. Eject
     *  rewrites this one line so the owned generator's output imports the owned runtime. */
    private static final Pattern RUNTIME_PACKAGE_DECL = Pattern.compile(
            "(?m)^(\\s*public static final String RUNTIME_PACKAGE = )\"[\\w.]+\";\\s*$");

    /**
     * The first line of every runtime file eject writes. It is how {@code metaobjects:verify}
     * tells an owned runtime file from a stale generated one when the two share an output
     * directory, and how {@code -Dlist} finds the copies. Keep it if you move the file.
     */
    public static final String OWNED_RUNTIME_MARKER = "// metaobjects:owned-runtime";

    /** Point an ejected generator's {@code RUNTIME_PACKAGE} at {@code runtimePackage}. A
     *  source with no such declaration (a generator whose output imports no runtime) is
     *  returned unchanged. */
    public static String rewriteRuntimePackage(String source, String runtimePackage) {
        Matcher m = RUNTIME_PACKAGE_DECL.matcher(source);
        if (!m.find()) return source;
        String replacement = m.group(1) + "\"" + runtimePackage + "\";";
        return new StringBuilder(source).replace(m.start(), m.end(), replacement).toString();
    }

    /**
     * The owned copy of one runtime class: its package renamed to {@code runtimePackage}, and
     * the {@link #OWNED_RUNTIME_MARKER} line (naming the reference it came from) on top.
     * Nothing else changes.
     */
    public static String ownedRuntimeSource(String reference, String simpleName, String runtimePackage) {
        return OWNED_RUNTIME_MARKER + " — copied by `mvn metaobjects:eject` from "
                + GeneratorRegistry.RUNTIME_PACKAGE + "." + simpleName
                + ". You own this file.\n"
                + rewritePackage(reference, runtimePackage);
    }

    /** Whether {@code content} is a runtime file eject wrote (its marker is on the first
     *  non-blank line). */
    public static boolean isOwnedRuntime(String content) {
        return firstLineStartsWith(content, OWNED_RUNTIME_MARKER);
    }

    private static boolean firstLineStartsWith(String content, String marker) {
        for (String line : content.split("\n", -1)) {
            String t = line.strip();
            if (t.isEmpty()) continue;
            return t.startsWith(marker);
        }
        return false;
    }

    /** Every runtime class the given entries' output imports, in first-seen order. */
    public static List<String> runtimeFor(List<Entry> entries) {
        Set<String> out = new LinkedHashSet<>();
        for (Entry e : entries) out.addAll(e.runtime);
        return new ArrayList<>(out);
    }

    // ------------------------------------------------------------------------------------
    // support source — the emit rules the Java generators share, handed over with them
    // ------------------------------------------------------------------------------------

    /** An {@code import} of one of {@link GeneratorRegistry#EJECT_SUPPORT}, from any package:
     *  group 1 is the package, group 2 the simple name. */
    private static final Pattern SUPPORT_IMPORT = Pattern.compile(
            "(?m)^import\\s+([\\w.]+)\\.(" + String.join("|", GeneratorRegistry.EJECT_SUPPORT) + ")\\s*;[ \\t]*$");

    /**
     * The first line of every support file eject writes: the same job
     * {@link #OWNED_RUNTIME_MARKER} does for a runtime file. Keep it if you move the file.
     */
    public static final String OWNED_SUPPORT_MARKER = "// metaobjects:owned-support";

    /** Simple names of the packaged support classes {@code source} imports, in source order.
     *  Eject copies exactly these beside the generator. */
    public static List<String> supportFor(String source) {
        List<String> out = new ArrayList<>();
        Matcher m = SUPPORT_IMPORT.matcher(source);
        while (m.find()) {
            if (m.group(1).equals(GeneratorRegistry.SUPPORT_PACKAGE) && !out.contains(m.group(2))) {
                out.add(m.group(2));
            }
        }
        return out;
    }

    /** Point an ejected generator's imports of the packaged support classes at the copies in
     *  {@code ownedPackage}. A source that imports none is returned unchanged. */
    public static String rewriteSupportImports(String source, String ownedPackage) {
        Matcher m = SUPPORT_IMPORT.matcher(source);
        StringBuilder out = new StringBuilder();
        while (m.find()) {
            String replacement = m.group(1).equals(GeneratorRegistry.SUPPORT_PACKAGE)
                    ? "import " + ownedPackage + "." + m.group(2) + ";" : m.group();
            m.appendReplacement(out, Matcher.quoteReplacement(replacement));
        }
        return m.appendTail(out).toString();
    }

    /**
     * The owned copy of one support class: its package renamed to {@code ownedPackage}, and
     * the {@link #OWNED_SUPPORT_MARKER} line (naming the reference it came from) on top.
     * Nothing else changes.
     */
    public static String ownedSupportSource(String reference, String simpleName, String ownedPackage) {
        return OWNED_SUPPORT_MARKER + " — copied by `mvn metaobjects:eject` from "
                + GeneratorRegistry.SUPPORT_PACKAGE + "." + simpleName
                + ". You own this file.\n"
                + rewritePackage(reference, ownedPackage);
    }

    /** Whether {@code content} is a support file eject wrote. */
    public static boolean isOwnedSupport(String content) {
        return firstLineStartsWith(content, OWNED_SUPPORT_MARKER);
    }

    // ------------------------------------------------------------------------------------
    // owned-copy comparison — line-multiset, ignoring the package line (mirrors Python's
    // metaobjects.codegen.eject._normalised / owned_status).
    // ------------------------------------------------------------------------------------

    public enum Verdict { IDENTICAL, DIFFERS }

    public static final class Comparison {
        public final Verdict verdict;
        /** Lines the reference has that the owned copy does not — how far behind it is. */
        public final int behind;
        /** Lines the owned copy has that the reference does not — the adopter's own edits. */
        public final int ownedOnly;

        Comparison(Verdict verdict, int behind, int ownedOnly) {
            this.verdict = verdict;
            this.behind = behind;
            this.ownedOnly = ownedOnly;
        }
    }

    /** Every non-blank line, trimmed, with the lines eject itself writes dropped — the
     *  package line, a generator's {@code RUNTIME_PACKAGE} declaration and support imports,
     *  and a runtime or support file's ownership marker are the deliberate edits of eject,
     *  not drift. */
    private static List<String> normalizedLines(String source) {
        List<String> out = new ArrayList<>();
        for (String line : source.split("\n", -1)) {
            String t = line.strip();
            if (t.isEmpty()) continue;
            if (PACKAGE_LINE.matcher(t).matches()) continue;
            if (RUNTIME_PACKAGE_DECL.matcher(t).matches()) continue;
            if (TEMPLATE_PREFIX_DECL.matcher(t).matches()) continue;
            if (isImportOfCopiedClass(t)) continue;
            if (SUPPORT_IMPORT.matcher(t).matches()) continue;
            if (t.startsWith(OWNED_RUNTIME_MARKER) || t.startsWith(OWNED_SUPPORT_MARKER)) continue;
            out.add(t);
        }
        return out;
    }

    private static final Pattern IMPORT_LINE = Pattern.compile("^import\\s+[\\w.]+\\.(\\w+)\\s*;?$");

    /** The simple names of every class eject may copy WITH a generator, across all entries. */
    private static final class Copied {
        static final Set<String> SIMPLE_NAMES = allEntries().stream()
                .flatMap(e -> e.with.stream()).map(EjectSupport::simpleNameOf)
                .collect(Collectors.toSet());
    }

    /**
     * An import of a class eject copies with a generator. Eject points it at the copy when the
     * copy is written for a generator that copies the class, and a file that two generators copy
     * (the extractor, with {@code entity} and on its own) is written by whichever came first, so
     * its imports follow that one: the line is eject's own edit, not drift.
     */
    private static boolean isImportOfCopiedClass(String trimmedLine) {
        Matcher m = IMPORT_LINE.matcher(trimmedLine);
        return m.matches() && Copied.SIMPLE_NAMES.contains(m.group(1));
    }

    public static Comparison compare(String owned, String reference) {
        List<String> a = normalizedLines(owned);
        List<String> b = normalizedLines(reference);
        Map<String, Integer> refCounts = new LinkedHashMap<>();
        for (String l : b) refCounts.merge(l, 1, Integer::sum);
        int ownedOnly = 0;
        Map<String, Integer> remaining = new LinkedHashMap<>(refCounts);
        for (String l : a) {
            Integer n = remaining.get(l);
            if (n != null && n > 0) {
                remaining.put(l, n - 1);
            } else {
                ownedOnly++;
            }
        }
        int behind = remaining.values().stream().mapToInt(Integer::intValue).sum();
        return new Comparison(behind == 0 && ownedOnly == 0 ? Verdict.IDENTICAL : Verdict.DIFFERS,
                behind, ownedOnly);
    }
}

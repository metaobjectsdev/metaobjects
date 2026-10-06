package com.metaobjects.generator.spring;

import com.metaobjects.generator.FileEmittingGenerator;
import com.metaobjects.generator.GeneratorException;
import com.metaobjects.generator.ProjectClassLoaderAware;
import com.metaobjects.generator.requirement.RenderedTest;
import com.metaobjects.generator.requirement.RequirementTestArgs;
import com.metaobjects.generator.requirement.RequirementTestRenderer;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.requirement.MetaRequirement;
import com.metaobjects.requirement.RequirementTestFilter;
import com.metaobjects.requirement.RequirementTestIdentities;
import com.metaobjects.requirement.RequirementTestIdentities.Grain;
import com.metaobjects.requirement.RequirementTestIdentities.Identity;
import com.metaobjects.requirement.RequirementTestIdentities.Target;
import com.metaobjects.requirement.RequirementTestIdentities.Walked;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.regex.Pattern;

/**
 * One JUnit Jupiter test per declared requirement, calling a project-owned witness (ADR-0057).
 *
 * <p>For each metamodel package that holds a tested requirement this writes two files into
 * {@code testPackage}, rewritten whole on every run: {@code Requirements_<pkgKey>_Witnesses.java}
 * (an interface with one default member per NON-skipped test, which fails with
 * {@code unimplemented requirement: ...}) and {@code Requirements_<pkgKey>_Test.java} (one
 * {@code @Test} per requirement, calling the member on the project's {@code witnessClass}).
 * The project owns the witnesses: it writes a class implementing every generated witness
 * interface and overrides the members it has witnesses for. A requirement that becomes live
 * adds a failing member, a red test and no compile break; one that is retired or deleted
 * removes the member, so a stale override stops compiling.</p>
 *
 * <p>Which tests exist, what each is called, whether it is skipped and its digest come from
 * {@link RequirementTestIdentities}, which every language port shares and a conformance corpus
 * pins. This class decides only how they are WRITTEN. It is a reference helper
 * (ADR-0034 Amendment 3): {@code mvn metaobjects:eject} copies this one file into your project,
 * and the default rendering is in it, so an owned copy changes the output freely.</p>
 *
 * <p>Args: {@code outputDir} and {@code testPackage} and {@code witnessClass} (required once the
 * model holds a requirement), {@code grain} ({@code concern}, the default, or {@code member}),
 * {@code filter} (a {@link RequirementTestFilter} class name that REPLACES the default of
 * functional requirements at level 4 or above), {@code renderer} (a
 * {@link RequirementTestRenderer} class name), and {@code warnUncovered} ({@code true} by
 * default: name the requirements the filter excluded).</p>
 *
 * <p>The generated tests are JUnit Jupiter; the project's test classpath needs
 * {@code org.junit.jupiter:junit-jupiter-api}. They import nothing from MetaObjects.</p>
 */
public class JUnitRequirementTestsGenerator extends FileEmittingGenerator implements ProjectClassLoaderAware {

    private static final Logger LOG = LoggerFactory.getLogger(JUnitRequirementTestsGenerator.class);

    public static final String ARG_TEST_PACKAGE = "testPackage";
    public static final String ARG_WITNESS_CLASS = "witnessClass";
    public static final String ARG_GRAIN = "grain";
    public static final String ARG_FILTER = "filter";
    public static final String ARG_RENDERER = "renderer";
    public static final String ARG_WARN_UNCOVERED = "warnUncovered";

    /** The refusal code when two tests map to one witness key. */
    public static final String ERR_WITNESS_KEY_COLLISION = "ERR_REQUIREMENT_WITNESS_KEY_COLLISION";

    /** How many uncovered requirements to name before "and N more". */
    private static final int MAX_NAMED_UNCOVERED = 5;

    private static final String SKIP_PLANNED = "planned - not built yet";
    private static final String SKIP_RETIRED =
        "retired - the capability was deliberately removed; assert it stays removed";

    private static final Pattern JAVA_NAME = Pattern.compile("[A-Za-z_$][A-Za-z0-9_$]*(\\.[A-Za-z_$][A-Za-z0-9_$]*)*");

    private ClassLoader projectClassLoader;
    private final List<String> warnings = new ArrayList<>();

    @Override
    public void setProjectClassLoader(ClassLoader projectClassLoader) {
        this.projectClassLoader = projectClassLoader;
    }

    /** What the last run warned about (each message was also logged). */
    public List<String> warnings() {
        return List.copyOf(warnings);
    }

    /** One test to write: its identity and the data its rendering is built from. */
    private record Planned(Identity identity, RequirementTestArgs args) {}

    @Override
    protected List<EmittedFile> generate(MetaDataLoader loader) {
        warnings.clear();
        // The optional args are checked first, so a typo is refused whatever the model holds.
        Grain grain = grain();
        RequirementTestFilter filter = loadOptional(ARG_FILTER, RequirementTestFilter.class);
        RequirementTestRenderer renderer = loadOptional(ARG_RENDERER, RequirementTestRenderer.class);
        boolean warnUncovered = warnUncovered();

        List<Walked> walked = RequirementTestIdentities.walk(loader.getRoot());
        // No requirement, no change: nothing is written and nothing is said.
        if (walked.isEmpty()) return List.of();

        String testPackage = requiredName(ARG_TEST_PACKAGE);
        String witnessClass = requiredName(ARG_WITNESS_CLASS);

        List<Planned> planned = new ArrayList<>();
        List<String> uncovered = new ArrayList<>();
        for (Walked w : walked) {
            boolean keep = filter == null ? RequirementTestIdentities.defaultFilter(w.view()) : filter.include(w.view());
            if (!keep) {
                // The PATH, not the qualified address: diagnostics name paths, in every port.
                uncovered.add(w.view().path());
                continue;
            }
            for (Map.Entry<String, List<Target>> unit : RequirementTestIdentities.units(w, grain).entrySet()) {
                Identity identity = RequirementTestIdentities.identity(w, unit.getKey());
                planned.add(new Planned(identity, argsFor(w.node(), identity, unit.getValue())));
            }
        }
        planned.sort((a, b) -> a.identity().id().compareTo(b.identity().id()));
        refuseCollisions(planned);
        warnUncovered(uncovered, warnUncovered);

        // One pair of files per package key. Two packages that mangle alike share a pair: their
        // tests keep distinct keys, which the collision check above has just proven.
        Map<String, List<Planned>> byPackage = new TreeMap<>();
        for (Planned p : planned) byPackage.computeIfAbsent(packageKey(p.identity().pkg()), k -> new ArrayList<>()).add(p);

        String dir = testPackage.replace('.', '/') + "/";
        List<EmittedFile> files = new ArrayList<>();
        for (Map.Entry<String, List<Planned>> e : byPackage.entrySet()) {
            String witnesses = "Requirements_" + e.getKey() + "_Witnesses";
            String test = "Requirements_" + e.getKey() + "_Test";
            files.add(new EmittedFile(dir + witnesses + ".java", witnessInterface(testPackage, witnesses, witnessClass, e.getValue())));
            files.add(new EmittedFile(dir + test + ".java", testClass(testPackage, test, witnesses, witnessClass, e.getValue(), renderer)));
        }
        return files;
    }

    // ------------------------------------------------------------------
    // args
    // ------------------------------------------------------------------

    private Grain grain() {
        if (!hasArg(ARG_GRAIN)) return Grain.CONCERN;
        try {
            return Grain.parse(getArg(ARG_GRAIN));
        } catch (IllegalArgumentException e) {
            throw new GeneratorException("requirement-tests: arg '" + ARG_GRAIN + "': " + e.getMessage(), e);
        }
    }

    private boolean warnUncovered() {
        String raw = getArg(ARG_WARN_UNCOVERED, "true");
        if ("true".equalsIgnoreCase(raw)) return true;
        if ("false".equalsIgnoreCase(raw)) return false;
        throw new GeneratorException("requirement-tests: arg '" + ARG_WARN_UNCOVERED + "' must be true or false, not '" + raw + "'");
    }

    /** A required arg that is spliced into generated source, so it must be a Java name. */
    private String requiredName(String arg) {
        String value = getArg(arg);
        if (value == null || value.isBlank()) {
            throw new GeneratorException("requirement-tests: set '" + arg + "' with <args><" + arg + ">...</" + arg + "></args>"
                + (ARG_WITNESS_CLASS.equals(arg) ? " (the fully-qualified name of the project class that implements the generated witness interfaces)" : "")
                + (ARG_TEST_PACKAGE.equals(arg) ? " (the package the generated tests are written into)" : ""));
        }
        String name = value.trim();
        if (!JAVA_NAME.matcher(name).matches()) {
            throw new GeneratorException("requirement-tests: arg '" + arg + "' must be a dotted Java name, not '" + value + "'");
        }
        return name;
    }

    /**
     * Instantiate the class an optional arg names, or {@code null} when the arg is absent. The
     * project's class loader is tried first because a packaged generator's own loader cannot see
     * the project's classes, then the context loader, then this class's own.
     */
    private <T> T loadOptional(String arg, Class<T> type) {
        String className = getArg(arg);
        if (className == null || className.isBlank()) return null;
        className = className.trim();

        List<ClassLoader> loaders = new ArrayList<>();
        for (ClassLoader l : new ClassLoader[]{projectClassLoader, Thread.currentThread().getContextClassLoader(),
            getClass().getClassLoader()}) {
            if (l != null && !loaders.contains(l)) loaders.add(l);
        }
        Class<?> found = null;
        for (ClassLoader l : loaders) {
            try {
                found = Class.forName(className, true, l);
                break;
            } catch (ClassNotFoundException ignored) {
                // not in this loader: try the next
            } catch (LinkageError e) {
                // The class IS here and cannot be used (built for a newer JDK, a missing
                // dependency, a static initialiser that threw): saying it is missing would send
                // the reader looking for the wrong problem, and the next loader would hide it.
                throw new GeneratorException("requirement-tests: arg '" + arg + "' names '" + className
                    + "', which was found but could not be loaded: " + e, null, null, e, Map.of());
            }
        }
        if (found == null) {
            throw new GeneratorException("requirement-tests: arg '" + arg + "' names '" + className
                + "', which is not on the project's classpath. Name a public class implementing "
                + type.getSimpleName() + " from a module the build compiles before this goal runs.");
        }
        if (!type.isAssignableFrom(found)) {
            throw new GeneratorException("requirement-tests: arg '" + arg + "' names '" + className
                + "', which does not implement " + type.getName());
        }
        try {
            return type.cast(found.getDeclaredConstructor().newInstance());
        } catch (ReflectiveOperationException e) {
            throw new GeneratorException("requirement-tests: arg '" + arg + "' names '" + className
                + "', which needs a public no-argument constructor: " + e, e);
        }
    }

    // ------------------------------------------------------------------
    // planning
    // ------------------------------------------------------------------

    private static RequirementTestArgs argsFor(MetaRequirement node, Identity identity, List<Target> targets) {
        List<RequirementTestArgs.Claim> claims = new ArrayList<>();
        for (Target t : targets) claims.add(new RequirementTestArgs.Claim(t.ref(), t.concern()));
        return new RequirementTestArgs(identity, orEmpty(node.getStatement()), orEmpty(node.getCounterexample()),
            claims, node.getDisposition(), node.getTrackedBy());
    }

    private static String orEmpty(String s) {
        return s == null ? "" : s;
    }

    /** {@code root} for the empty package, otherwise the package with each run of non-ASCII-alphanumerics as one underscore. */
    private static String packageKey(String pkg) {
        return pkg.isEmpty() ? "root" : pkg.replaceAll("[^A-Za-z0-9]+", "_");
    }

    /** Two tests with one witness key cannot be told apart by a witness: refuse, naming both. */
    private static void refuseCollisions(List<Planned> planned) {
        Map<String, String> keyById = new LinkedHashMap<>();
        for (Planned p : planned) keyById.put(p.identity().id(), p.identity().witnessKey());
        List<String[]> pairs = RequirementTestIdentities.witnessKeyCollisions(
            planned.stream().map(Planned::identity).toList());
        if (pairs.isEmpty()) return;
        StringBuilder sb = new StringBuilder(ERR_WITNESS_KEY_COLLISION)
            .append(": two requirement tests map to one witness key, so one witness could not serve both. ")
            .append("Rename one so the names differ in more than punctuation:");
        for (String[] pair : pairs) {
            sb.append("\n  '").append(pair[0]).append("' and '").append(pair[1])
              .append("' (witness key ").append(keyById.get(pair[0])).append(')');
        }
        throw new GeneratorException(sb.toString());
    }

    private void warnUncovered(List<String> uncovered, boolean enabled) {
        if (!enabled || uncovered.isEmpty()) return;
        String shown = String.join(", ", uncovered.subList(0, Math.min(MAX_NAMED_UNCOVERED, uncovered.size())));
        String more = uncovered.size() > MAX_NAMED_UNCOVERED ? ", and " + (uncovered.size() - MAX_NAMED_UNCOVERED) + " more" : "";
        String message = uncovered.size() + " requirement(s) matched no filter and get no test. "
            + "If that is deliberate, set " + ARG_WARN_UNCOVERED + "=false to silence this. Uncovered: " + shown + more + ".";
        warnings.add(message);
        LOG.warn(message);
    }

    // ------------------------------------------------------------------
    // rendering: the default rendering lives here, in this one file, so an eject takes it too
    // ------------------------------------------------------------------

    private static final String GENERATED_HEADER =
        "// GENERATED by metaobjects (requirement-tests). DO NOT EDIT: this file is rewritten whole.\n";

    private static String witnessInterface(String testPackage, String name, String witnessClass, List<Planned> tests) {
        StringBuilder sb = new StringBuilder(GENERATED_HEADER)
            .append("// Witnesses are project-owned: implement this interface in ").append(commentText(witnessClass))
            .append(" and override the members it has witnesses for.\n")
            .append("package ").append(testPackage).append(";\n\n")
            .append("public interface ").append(name).append(" {\n");
        for (Planned p : tests) {
            Identity id = p.identity();
            if (id.skip() != null) continue; // a skipped test claims nothing works yet: no member
            sb.append('\n').append(indent(testComments(p.args()))).append('\n')
              .append("    default void ").append(id.witnessKey()).append("() {\n")
              .append("        throw new AssertionError(\"")
              .append(stringLiteral("unimplemented requirement: " + id.id() + " - write " + witnessClass + "."
                  + id.witnessKey() + "() so that it fails when: " + p.args().counterexample()))
              .append("\");\n    }\n");
        }
        return sb.append("}\n").toString();
    }

    private static String testClass(String testPackage, String name, String witnesses, String witnessClass,
                                    List<Planned> tests, RequirementTestRenderer renderer) {
        TreeSet<String> imports = new TreeSet<>();
        imports.add("org.junit.jupiter.api.Test");
        StringBuilder body = new StringBuilder();
        for (Planned p : tests) {
            RenderedTest rendered = renderer == null ? null : renderer.render(p.args());
            String source;
            if (rendered != null) {
                imports.addAll(rendered.imports());
                source = rendered.source();
            } else {
                source = defaultTest(p);
                if (p.identity().skip() != null) imports.add("org.junit.jupiter.api.Disabled");
            }
            body.append('\n').append(indent(source.stripTrailing())).append('\n');
        }
        StringBuilder sb = new StringBuilder(GENERATED_HEADER)
            .append("// The witnesses are project-owned, in ").append(commentText(witnessClass)).append(".\n")
            .append("package ").append(testPackage).append(";\n\n");
        for (String i : imports) sb.append("import ").append(i).append(";\n");
        return sb.append("\npublic class ").append(name).append(" {\n\n")
            .append("    private final ").append(witnesses).append(" witnesses = new ").append(witnessClass).append("();\n")
            .append(body).append("}\n").toString();
    }

    /** The default rendering of one test: its comments, then a {@code @Test} calling the witness. */
    private static String defaultTest(Planned p) {
        Identity id = p.identity();
        StringBuilder sb = new StringBuilder(testComments(p.args())).append("\n@Test\n");
        if (id.skip() == null) {
            sb.append("void ").append(id.witnessKey()).append("() {\n    witnesses.").append(id.witnessKey()).append("();\n}");
        } else {
            sb.append("@Disabled(\"").append(stringLiteral(skipReason(id.skip()))).append("\")\n")
              .append("void ").append(id.witnessKey()).append("() {\n}");
        }
        return sb.toString();
    }

    private static String skipReason(String skip) {
        if (MetaRequirement.STATUS_PLANNED.equals(skip)) return SKIP_PLANNED;
        if (MetaRequirement.STATUS_RETIRED.equals(skip)) return SKIP_RETIRED;
        return skip + " - skipped";
    }

    /** The comment block above a test: id, statement, counterexample, status, claims, digest. */
    private static String testComments(RequirementTestArgs a) {
        Identity id = a.identity();
        StringBuilder claims = new StringBuilder();
        for (RequirementTestArgs.Claim c : a.targets()) {
            if (claims.length() > 0) claims.append(", ");
            claims.append(c.ref()).append("  (").append(c.concern()).append(')');
        }
        return commentLines(id.id()) + "\n"
            + commentLines(a.statement()) + "\n"
            + commentLines("Counterexample: " + a.counterexample()) + "\n"
            + commentLines("Status: " + (id.status() == null ? "(none)" : id.status())) + "\n"
            + commentLines("Claims: " + (claims.length() == 0 ? "(none)" : claims.toString())) + "\n"
            + commentLines("Digest: " + id.digest());
    }

    // ------------------------------------------------------------------
    // escaping: author prose lands in string literals and comments, and must not break either
    // ------------------------------------------------------------------

    private static String indent(String block) {
        StringBuilder sb = new StringBuilder();
        for (String line : block.split("\n", -1)) {
            if (sb.length() > 0) sb.append('\n');
            if (!line.isEmpty()) sb.append("    ").append(line);
        }
        return sb.toString();
    }

    /**
     * One {@code //} marker per line. A carriage return ends a Java line as a line feed does, so
     * both split; {@code *}{@code /} is broken as {@code * /} by contract. {@code \}{@code u} would be read as a
     * Unicode escape even inside a comment, and {@code \}{@code u000a} would end it, so it is broken as
     * {@code \ u}.
     */
    private static String commentLines(String text) {
        StringBuilder sb = new StringBuilder();
        for (String line : text.split("\r\n|\r|\n", -1)) {
            if (sb.length() > 0) sb.append('\n');
            sb.append("// ").append(commentText(line));
        }
        return sb.toString();
    }

    private static String commentText(String line) {
        return line.replace("*/", "* /").replace("\\u", "\\ u");
    }

    /** The text of a double-quoted string literal. Every control character is escaped, so no value can end the literal. */
    private static String stringLiteral(String s) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '\\' -> sb.append("\\\\");
                case '"' -> sb.append("\\\"");
                case '\n' -> sb.append("\\n");
                case '\r' -> sb.append("\\r");
                case '\t' -> sb.append("\\t");
                default -> {
                    if (c < 0x20 || c == 0x7f) sb.append(String.format("\\u%04x", (int) c));
                    else sb.append(c);
                }
            }
        }
        return sb.toString();
    }
}

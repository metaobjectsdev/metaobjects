package com.metaobjects.generator.direct.object.javacode;

// Eject note (ADR-0034 Amendment 6): `mvn metaobjects:eject -Dnames=extractor` copies this
// file together with JavaCodeWriter and BaseObjectCodeWriter, into one package. JavaCodeWriter,
// named bare below, is that copy: the names an owned extractor writes come from owned code.
import com.metaobjects.generator.writer.JavaWriter;
import com.metaobjects.generator.GeneratorBase;
import com.metaobjects.generator.GeneratorException;
import com.metaobjects.generator.direct.object.BaseObjectCodeGenerator;
import com.metaobjects.generator.util.GeneratedFileWriter;
import com.metaobjects.generator.util.GeneratorUtil;
import com.metaobjects.io.util.IOUtil;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.object.MetaObject;

import java.io.File;
import java.io.IOException;
import java.io.PrintWriter;
import java.io.StringWriter;

/**
 * Emits a generated {@code <Name>Extractor} — the Task-6 payoff that wraps the Phase-B
 * runtime extract so a consumer turns dirty LLM text into a fully-typed flavored object
 * graph (nested objects + arrays-of-objects populated) in one call.
 *
 * <p>The emitted class references {@code com.metaobjects.object.extract.MetaObjectExtractor}
 * (in module {@code metaobjects-om}) <b>by fully-qualified-name string only</b>. That keeps
 * {@code codegen-base} main free of any {@code om} compile dependency: the reference is a
 * source-level FQN that resolves on the <i>consumer's</i> classpath (where {@code om} is
 * present), never against {@code codegen-base} at build time.</p>
 *
 * <p>Two static entry points are emitted:</p>
 * <ul>
 *   <li>{@code extract(loader, text)} → the typed flavored object via
 *       {@code MetaObjectExtractor.extract(mo, text).orThrow()} (throws iff a required field
 *       was lost — the strict opt-in gate);</li>
 *   <li>{@code extractLenient(loader, text)} → the full
 *       {@code ExtractionResult<<Type>>} (never-throws; carries the per-field report).</li>
 * </ul>
 *
 * <p>The {@code MetaObjectExtractor.extract(...)} signature emitted against is
 * {@code ExtractionResult<Object> extractLenient(MetaObject, String)} (the JSON-default overload).
 * {@link com.metaobjects.render.extract.ExtractionResult#orThrow()} returns {@code Object};
 * the {@code (<Type>)} cast succeeds because the generated binding provider makes
 * {@code MetaObject.newInstance()} (and therefore the assembled graph root) the generated
 * flavored type. The {@code extractLenient(...)} overload widens through {@code ExtractionResult<?>}
 * to expose the typed {@code ExtractionResult<<Type>>}.</p>
 *
 * <p><b>One way to run it.</b> Wired as a {@code <generator>}, {@link #execute} writes one
 * Extractor per concrete object, named by the same {@code pkgPrefix} / {@code pkgSuffix} /
 * {@code namePrefix} / {@code nameSuffix} args the {@code entity} generator takes, so give
 * both the same values. Nothing else writes them: through 8.0 the {@code entity} generator
 * ({@link JavaObjectCodeGenerator}) wrote one beside each concrete class for a pom that did
 * not list this generator, and ADR-0034 Amendment 9 removed that.</p>
 *
 * <p>An Extractor casts to the generated flavored class, so it needs the {@code entity}
 * generator with a concrete {@code flavor} in the same run, selecting the same objects: give
 * both generators the same {@code <filters>}. An Extractor for an object {@code entity} wrote
 * no class for does not compile.</p>
 *
 * <p>Emission is a direct {@code StringBuilder} emit (no templates). Its steps are
 * {@code protected} so a subclass can override one (e.g. {@link #writeExtractMethod})
 * without reimplementing the whole class.</p>
 */
public class ExtractorCodeGenerator extends GeneratorBase {

    /** Fully-qualified name of the runtime extract entry point (emitted as a source FQN string). */
    public static final String META_OBJECT_EXTRACT_FQN =
            "com.metaobjects.object.extract.MetaObjectExtractor";

    /** Fully-qualified name of the typed extract result (emitted as a source FQN string). */
    public static final String EXTRACTION_RESULT_FQN =
            "com.metaobjects.render.extract.ExtractionResult";

    /** Fully-qualified name of the loader the generated {@code extract}/{@code extract} accept. */
    public static final String LOADER_FQN = "com.metaobjects.loader.MetaDataLoader";

    /** Suffix appended to the flavored class's simple name to form the Extractor class name. */
    public static final String EXTRACTOR_SUFFIX = "Extractor";

    /**
     * Write one {@code <Name>Extractor} per concrete object the filters select. Abstract
     * objects get none: {@code MetaObject.newInstance()} cannot build one, so an extractor
     * for it could never return a typed graph.
     */
    @Override
    public void execute(MetaDataLoader loader) {
        if (!hasArg(ARG_OUTPUTDIR)) {
            throw new GeneratorException(
                    "You must set a valid output directory with arg '" + ARG_OUTPUTDIR + "'");
        }
        File outputDir = getOutputDir();
        JavaCodeWriter namer = createNamer(loader);
        try {
            for (MetaObject mo : GeneratorUtil.getFilteredMetaData(
                    loader, MetaObject.class, getMetaDataFilters())) {
                if (IOUtil.isAbstract(mo) || !inEntitySelection(mo)) {
                    continue;
                }
                emit(outputDir, namer.getLanguagePackage(mo), namer.getClassName(mo), mo.getName());
            }
        } catch (IOException e) {
            throw new GeneratorException("Unable to emit generated Extractor: " + e, e);
        }
    }

    /**
     * The writer whose naming hooks say which package and class each Extractor sits beside.
     * It names; it never writes. It has to be the writer your {@code entity} generator names
     * its classes through, so both agree: ejected into one package, the two share one copy.
     */
    protected JavaCodeWriter createNamer(MetaDataLoader loader) {
        JavaCodeWriter namer = new JavaCodeWriter(loader, new PrintWriter(new StringWriter()));
        namer.withPkgPrefix(getArg(BaseObjectCodeGenerator.ARG_PKGPREFIX, ""))
             .withPkgSuffix(getArg(BaseObjectCodeGenerator.ARG_PKGSUFFIX, ""))
             .withNamePrefix(getArg(BaseObjectCodeGenerator.ARG_NAMEPREFIX, ""))
             .withNameSuffix(getArg(BaseObjectCodeGenerator.ARG_NAMESUFFIX, ""));
        return namer;
    }

    /**
     * Emit {@code <className>Extractor.java} into {@code outputDir} under the package directory
     * derived from {@code javaPackage}.
     *
     * @param outputDir       the codegen output root
     * @param javaPackage     the generated flavored class's Java package (may be blank → default package)
     * @param className       the generated flavored class's simple Java class name (the {@code <Type>})
     * @param resolutionKey   the package-folded metadata resolution key ({@code "pkg::Name"}) the
     *                        generated {@code extract}/{@code extract} pass to
     *                        {@code MetaDataLoader.getMetaObjectByName(...)}
     */
    public void emit(File outputDir, String javaPackage, String className, String resolutionKey)
            throws IOException {
        File pkgDir = isBlank(javaPackage)
                ? outputDir
                : new File(outputDir, javaPackage.replace('.', File.separatorChar));
        if (!pkgDir.exists()) pkgDir.mkdirs();

        String extractorName = className + EXTRACTOR_SUFFIX;
        File src = new File(pkgDir, extractorName + ".java");

        JavaWriter w = new JavaWriter();
        writeHeader(w, javaPackage, className);
        try (var cls = w.block("public final class " + extractorName + " {")) {
            w.line("private " + extractorName + "() { /* no instances */ }");
            w.blank();
            writeLookupHelper(w, resolutionKey);
            w.blank();
            writeExtractMethod(w, className);
            w.blank();
            writeExtractLenientMethod(w, className);
        }

        // Guarded like every other generator on this port: writeHeader emits the GENERATED
        // marker, so our own output is still overwritten freely while a hand-written extractor
        // at this path is refused.
        GeneratedFileWriter.write(src.toPath(), w.toString(), resolutionKey);
    }

    /** Write the package declaration and the class JavaDoc. */
    protected void writeHeader(JavaWriter w, String javaPackage, String className) {
        if (!isBlank(javaPackage)) w.packageName(javaPackage);
        w.line("/**");
        w.line(" * GENERATED — extractor for {@code " + className + "}.");
        w.line(" *");
        w.line(" * <p>Turns dirty LLM text into a fully-typed {@code " + className + "} graph (nested");
        w.line(" * objects + arrays-of-objects populated) in one call, by delegating to the Phase-B");
        w.line(" * runtime extract ({@code " + META_OBJECT_EXTRACT_FQN + "}).</p>");
        w.line(" */");
    }

    /** Write the private {@code lookup(loader)} helper resolving the payload MetaObject by FQN. */
    protected void writeLookupHelper(JavaWriter w, String resolutionKey) {
        try (var m = w.block("private static com.metaobjects.object.MetaObject lookup(" + LOADER_FQN + " loader) {")) {
            w.line("return loader.getMetaObjectByName(\"" + escape(resolutionKey) + "\");");
        }
    }

    /**
     * Write {@code extract(loader, text)} → typed object via the strict {@code orThrow()} gate.
     * Override to change the strictness gate or the default format.
     */
    protected void writeExtractMethod(JavaWriter w, String className) {
        w.line("/**");
        w.line(" * Extract a fully-typed {@code " + className + "} from dirty {@code text}.");
        w.line(" *");
        w.line(" * @throws com.metaobjects.render.extract.ExtractException iff a required field was lost or malformed");
        w.line(" */");
        try (var m = w.block("public static " + className + " extract(" + LOADER_FQN + " loader, String text) {")) {
            w.line("return (" + className + ") " + META_OBJECT_EXTRACT_FQN + ".extract(lookup(loader), text).orThrow();");
        }
    }

    /**
     * Write {@code extractLenient(loader, text)} → the never-throws {@code ExtractionResult<<Type>>}
     * (typed data + per-field report). Override to change the default format.
     */
    protected void writeExtractLenientMethod(JavaWriter w, String className) {
        String result = EXTRACTION_RESULT_FQN + "<" + className + ">";
        w.line("/**");
        w.line(" * Extract a {@code " + className + "} from dirty {@code text}, never throwing.");
        w.line(" *");
        w.line(" * @return the typed result; inspect {@code report()} for lost/malformed/defaulted fields");
        w.line(" */");
        w.line("@SuppressWarnings(\"unchecked\")");
        try (var m = w.block("public static " + result + " extractLenient(" + LOADER_FQN + " loader, String text) {")) {
            w.line("return (" + result + ") (" + EXTRACTION_RESULT_FQN + "<?>) "
                + META_OBJECT_EXTRACT_FQN + ".extract(lookup(loader), text);");
        }
    }

    private static boolean isBlank(String s) {
        return s == null || s.trim().isEmpty();
    }

    private static String escape(String s) {
        return com.metaobjects.generator.util.JavaIdentifiers.escapeStringLiteral(s);
    }
}

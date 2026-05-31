package com.metaobjects.generator.direct.object.javacode;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

/**
 * Emits a generated {@code <Name>Extractor} — the Task-6 payoff that wraps the Phase-B
 * runtime recover so a consumer turns dirty LLM text into a fully-typed flavored object
 * graph (nested objects + arrays-of-objects populated) in one call.
 *
 * <p>The emitted class references {@code com.metaobjects.object.recover.MetaObjectRecover}
 * (in module {@code metaobjects-om}) <b>by fully-qualified-name string only</b>. That keeps
 * {@code codegen-base} main free of any {@code om} compile dependency: the reference is a
 * source-level FQN that resolves on the <i>consumer's</i> classpath (where {@code om} is
 * present), never against {@code codegen-base} at build time.</p>
 *
 * <p>Two static entry points are emitted:</p>
 * <ul>
 *   <li>{@code extract(loader, text)} → the typed flavored object via
 *       {@code MetaObjectRecover.recover(mo, text).orThrow()} (throws iff a required field
 *       was lost — the strict opt-in gate);</li>
 *   <li>{@code recover(loader, text)} → the full
 *       {@code RecoveryResult<<Type>>} (never-throws; carries the per-field report).</li>
 * </ul>
 *
 * <p>The {@code MetaObjectRecover.recover(...)} signature emitted against is
 * {@code RecoveryResult<Object> recover(MetaObject, String)} (the JSON-default overload).
 * {@link com.metaobjects.render.recover.RecoveryResult#orThrow()} returns {@code Object};
 * the {@code (<Type>)} cast succeeds because the generated binding provider makes
 * {@code MetaObject.newInstance()} (and therefore the assembled graph root) the generated
 * flavored type. The {@code recover(...)} overload widens through {@code RecoveryResult<?>}
 * to expose the typed {@code RecoveryResult<<Type>>}.</p>
 *
 * <p>This is a plain emission helper (direct {@code StringBuilder} emit; no templates) driven
 * by {@link JavaObjectCodeGenerator#execute}. Its emission steps are {@code protected} so a
 * downstream generator can override one step (e.g. {@link #writeExtractMethod}) without
 * reimplementing the whole class.</p>
 */
public class ExtractorCodeGenerator {

    /** Fully-qualified name of the runtime recover entry point (emitted as a source FQN string). */
    public static final String META_OBJECT_RECOVER_FQN =
            "com.metaobjects.object.recover.MetaObjectRecover";

    /** Fully-qualified name of the typed recover result (emitted as a source FQN string). */
    public static final String RECOVERY_RESULT_FQN =
            "com.metaobjects.render.recover.RecoveryResult";

    /** Fully-qualified name of the loader the generated {@code extract}/{@code recover} accept. */
    public static final String LOADER_FQN = "com.metaobjects.loader.MetaDataLoader";

    /** Suffix appended to the flavored class's simple name to form the Extractor class name. */
    public static final String EXTRACTOR_SUFFIX = "Extractor";

    /**
     * Emit {@code <className>Extractor.java} into {@code outputDir} under the package directory
     * derived from {@code javaPackage}.
     *
     * @param outputDir       the codegen output root
     * @param javaPackage     the generated flavored class's Java package (may be blank → default package)
     * @param className       the generated flavored class's simple Java class name (the {@code <Type>})
     * @param resolutionKey   the package-folded metadata resolution key ({@code "pkg::Name"}) the
     *                        generated {@code extract}/{@code recover} pass to
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

        StringBuilder sb = new StringBuilder();
        writeHeader(sb, javaPackage, className, extractorName);
        writeLookupHelper(sb, resolutionKey);
        writeExtractMethod(sb, className);
        writeRecoverMethod(sb, className);
        writeFooter(sb);

        Files.write(src.toPath(), sb.toString().getBytes(StandardCharsets.UTF_8));
    }

    /** Emit the package declaration, JavaDoc, and the {@code final class} header + private ctor. */
    protected void writeHeader(StringBuilder sb, String javaPackage, String className, String extractorName) {
        if (!isBlank(javaPackage)) {
            sb.append("package ").append(javaPackage).append(";\n\n");
        }
        sb.append("/**\n");
        sb.append(" * GENERATED — extractor for {@code ").append(className).append("}.\n");
        sb.append(" *\n");
        sb.append(" * <p>Turns dirty LLM text into a fully-typed {@code ").append(className)
          .append("} graph (nested\n");
        sb.append(" * objects + arrays-of-objects populated) in one call, by delegating to the Phase-B\n");
        sb.append(" * runtime recover ({@code ").append(META_OBJECT_RECOVER_FQN).append("}).</p>\n");
        sb.append(" */\n");
        sb.append("public final class ").append(extractorName).append(" {\n\n");
        sb.append("    private ").append(extractorName).append("() { /* no instances */ }\n\n");
    }

    /** Emit the private {@code lookup(loader)} helper resolving the payload MetaObject by FQN. */
    protected void writeLookupHelper(StringBuilder sb, String resolutionKey) {
        sb.append("    private static com.metaobjects.object.MetaObject lookup(")
          .append(LOADER_FQN).append(" loader) {\n");
        sb.append("        return loader.getMetaObjectByName(\"").append(escape(resolutionKey)).append("\");\n");
        sb.append("    }\n\n");
    }

    /**
     * Emit {@code extract(loader, text)} → typed object via the strict {@code orThrow()} gate.
     * Override to change the strictness gate or the default format.
     */
    protected void writeExtractMethod(StringBuilder sb, String className) {
        sb.append("    /**\n");
        sb.append("     * Extract a fully-typed {@code ").append(className)
          .append("} from dirty {@code text}.\n");
        sb.append("     *\n");
        sb.append("     * @throws com.metaobjects.render.recover.RecoverException iff a required field was lost\n");
        sb.append("     */\n");
        sb.append("    public static ").append(className).append(" extract(")
          .append(LOADER_FQN).append(" loader, String text) {\n");
        sb.append("        return (").append(className).append(") ")
          .append(META_OBJECT_RECOVER_FQN).append(".recover(lookup(loader), text).orThrow();\n");
        sb.append("    }\n\n");
    }

    /**
     * Emit {@code recover(loader, text)} → the never-throws {@code RecoveryResult<<Type>>}
     * (typed data + per-field report). Override to change the default format.
     */
    protected void writeRecoverMethod(StringBuilder sb, String className) {
        sb.append("    /**\n");
        sb.append("     * Recover a {@code ").append(className)
          .append("} from dirty {@code text}, never throwing.\n");
        sb.append("     *\n");
        sb.append("     * @return the typed result; inspect {@code report()} for lost/defaulted fields\n");
        sb.append("     */\n");
        sb.append("    @SuppressWarnings(\"unchecked\")\n");
        sb.append("    public static ").append(RECOVERY_RESULT_FQN).append("<").append(className)
          .append("> recover(").append(LOADER_FQN).append(" loader, String text) {\n");
        sb.append("        return (").append(RECOVERY_RESULT_FQN).append("<").append(className).append(">) (")
          .append(RECOVERY_RESULT_FQN).append("<?>) ")
          .append(META_OBJECT_RECOVER_FQN).append(".recover(lookup(loader), text);\n");
        sb.append("    }\n");
    }

    /** Emit the closing brace. */
    protected void writeFooter(StringBuilder sb) {
        sb.append("}\n");
    }

    private static boolean isBlank(String s) {
        return s == null || s.trim().isEmpty();
    }

    private static String escape(String s) {
        return s.replace("\\", "\\\\").replace("\"", "\\\"");
    }
}

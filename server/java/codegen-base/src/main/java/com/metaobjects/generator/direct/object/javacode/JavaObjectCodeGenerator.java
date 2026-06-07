package com.metaobjects.generator.direct.object.javacode;

import com.metaobjects.generator.GeneratorException;
import com.metaobjects.generator.GeneratorIOException;
import com.metaobjects.generator.GeneratorIOWriter;
import com.metaobjects.generator.direct.GenerationContext;
import com.metaobjects.generator.direct.object.BaseObjectCodeWriter;
import com.metaobjects.generator.util.GeneratorUtil;
import com.metaobjects.io.util.IOUtil;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.object.MetaObject;
import com.metaobjects.registry.ObjectClassBindingProvider;

import java.io.File;
import java.io.IOException;
import java.io.PrintWriter;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Flavor-selecting Java object code generator.
 *
 * <p>Extends the legacy reference {@link JavaCodeGenerator} and adds a {@code flavor}
 * argument. When {@code flavor=pojoAware}, {@link #createWriter} returns a
 * {@link PojoAwareCodeWriter} (a concrete class {@code extends PojoObject}); when
 * {@code flavor=valueObject}, it returns a {@link ValueObjectCodeWriter} (a concrete
 * class {@code extends ValueObject} with cached per-field value-holder accessors);
 * otherwise it falls through to the legacy interface-emitting {@link JavaCodeWriter}.</p>
 *
 * <p>All other behavior — supported types, file extension, naming, the multi-file
 * emission loop (which already iterates EVERY {@code MetaObject} in the loader, so the
 * nested sub-objects referenced via {@code @objectRef} are emitted as their own files) —
 * is inherited unchanged from the legacy framework.</p>
 */
public class JavaObjectCodeGenerator extends JavaCodeGenerator {

    /** Generator argument selecting the code flavor (e.g. {@code pojoAware}). */
    public static final String ARG_FLAVOR = "flavor";

    /** Concrete-class flavor: emit {@code class <Name> extends PojoObject}. */
    public static final String FLAVOR_POJO_AWARE = "pojoAware";

    /**
     * Concrete-class flavor: emit {@code class <Name> extends ValueObject} with
     * cached per-field value-holder accessors (perf-tuned, map-backed/extensible).
     */
    public static final String FLAVOR_VALUE_OBJECT = "valueObject";

    /** Read the {@code flavor} argument (empty = legacy interface flavor). */
    public String getFlavor() {
        return getArg(ARG_FLAVOR, "");
    }

    /**
     * The per-object inclusion predicate for the instantiable MODEL artifact: whether
     * this generator emits an instance class (and a binding/extractor) for {@code mo}.
     *
     * <p>Abstract objects cannot be instantiated via {@code newInstance()}, so the
     * generator skips them (honors the abstract-codegen invariant: no instance
     * artifacts for abstracts). This is the single source of truth for that skip
     * decision — both the emission loop here and any api-docs builder that documents
     * the MODEL symbol gate on it, so documented == generated (drift-proof).</p>
     */
    public static boolean appliesTo(MetaObject mo) {
        return !IOUtil.isAbstract(mo);
    }

    /**
     * Per-object class-file emission, gated by {@link #appliesTo(MetaObject)}.
     *
     * <p>The multi-file framework iterates EVERY filtered {@link MetaObject} and creates
     * a placeholder file before calling this. For an abstract object we emit nothing and
     * remove that placeholder, so an abstract object yields no model class file at all
     * (honors the abstract-codegen invariant: no instance artifacts for abstracts — the
     * same rule the binding/extractor loop and {@code appliesTo} enforce, now applied to
     * the model class too so documented == generated).</p>
     */
    @Override
    protected void writeSingleFile(MetaObject mo, GeneratorIOWriter<?> writer)
            throws GeneratorIOException {
        if (!appliesTo(mo)) {
            // Drop the empty placeholder the framework created for this abstract object.
            File placeholder = new File(
                    new File(getOutputDir(), getSingleOutputFilePath(mo)),
                    getSingleOutputFilename(mo));
            //noinspection ResultOfMethodCallIgnored
            placeholder.delete();
            return;
        }
        super.writeSingleFile(mo, writer);
    }

    /** Whether this run emits CONCRETE classes (and therefore a binding provider). */
    private boolean isConcreteFlavor() {
        return FLAVOR_POJO_AWARE.equals(getFlavor()) || FLAVOR_VALUE_OBJECT.equals(getFlavor());
    }

    // FQN ("pkg::Name") of the generated provider class self-registered via ServiceLoader.
    static final String PROVIDER_PACKAGE = "com.metaobjects.generated";
    static final String PROVIDER_SIMPLE_NAME = "GeneratedObjectClassBindingProvider";
    static final String PROVIDER_FQN = PROVIDER_PACKAGE + "." + PROVIDER_SIMPLE_NAME;

    /**
     * Runs the standard multi-file emission, then — for a concrete flavor — emits ONE
     * self-registering {@link ObjectClassBindingProvider} covering every generated object
     * (keyed on the package-folded metadata resolution key {@code pkg::Name}, which is what
     * {@link MetaObject#newInstance()} looks up), plus its {@code META-INF/services}
     * registration so the provider is discoverable via {@code ServiceLoader}.
     */
    @Override
    public void execute(MetaDataLoader loader) {
        super.execute(loader);

        if (!isConcreteFlavor()) {
            return; // legacy interface flavor emits no instantiable class → no binding
        }

        // Map each generated object's resolution key (mo.getName(), the "pkg::Name" FQN)
        // to its generated fully-qualified Java class name, reusing the SAME naming hooks
        // the writer used so the binding targets the class that was actually emitted.
        JavaCodeWriter namer = (JavaCodeWriter)
                createWriter(loader, null, new PrintWriter(new java.io.StringWriter()), globalContext);
        Map<String, String> fqnToClass = new LinkedHashMap<>();
        ExtractorCodeGenerator extractorGen = new ExtractorCodeGenerator();
        Collection<MetaObject> metadata =
                GeneratorUtil.getFilteredMetaData(loader, getFilterClass(), getMetaDataFilters());
        try {
            for (MetaObject mo : metadata) {
                // Abstract objects cannot be instantiated via newInstance(), so binding their
                // resolution key to a generated class would make newInstance() try to construct
                // a non-instantiable type — and an extractor for one could never produce a typed
                // graph. Skip BOTH the binding entry and the extractor for abstract metadata
                // (honors the abstract-codegen invariant: no instance artifacts for abstracts).
                if (!appliesTo(mo)) {
                    continue;
                }
                String javaPkg = namer.getLanguagePackage(mo);
                String javaClass = namer.getClassName(mo);
                String generatedFqn = isNotBlank(javaPkg) ? javaPkg + "." + javaClass : javaClass;
                // Key on the package-folded resolution key — NOT the dotted Java FQN.
                fqnToClass.put(mo.getName(), generatedFqn);
                // Emit a <Name>Extractor alongside each CONCRETE flavored class.
                extractorGen.emit(getOutputDir(), javaPkg, javaClass, mo.getName());
            }
        } catch (IOException e) {
            throw new GeneratorException("Unable to emit generated Extractor: " + e, e);
        }

        if (fqnToClass.isEmpty()) return;

        try {
            emitProviderSource(fqnToClass);
            emitServicesRegistration();
        } catch (IOException e) {
            throw new GeneratorException("Unable to emit ObjectClassBindingProvider: " + e, e);
        }
    }

    /** Emit the generated {@code ObjectClassBindingProvider} {@code .java} source. */
    private void emitProviderSource(Map<String, String> fqnToClass) throws IOException {
        File pkgDir = new File(getOutputDir(), PROVIDER_PACKAGE.replace('.', File.separatorChar));
        if (!pkgDir.exists()) pkgDir.mkdirs();
        File src = new File(pkgDir, PROVIDER_SIMPLE_NAME + ".java");

        StringBuilder sb = new StringBuilder();
        sb.append("package ").append(PROVIDER_PACKAGE).append(";\n\n");
        sb.append("import java.util.Map;\n");
        sb.append("import java.util.HashMap;\n\n");
        sb.append("/**\n");
        sb.append(" * GENERATED — self-registering ").append(ObjectClassBindingProvider.class.getSimpleName())
          .append(" (ADR-0001).\n");
        sb.append(" * Maps each generated object's metadata resolution key (\"pkg::Name\") to its\n");
        sb.append(" * generated Java class, so MetaObject.newInstance() yields the generated type.\n");
        sb.append(" */\n");
        sb.append("public final class ").append(PROVIDER_SIMPLE_NAME)
          .append(" implements ").append(ObjectClassBindingProvider.class.getName()).append(" {\n\n");
        sb.append("    @Override\n");
        sb.append("    public Map<String, Class<?>> bindings() {\n");
        sb.append("        Map<String, Class<?>> m = new HashMap<>();\n");
        for (Map.Entry<String, String> e : fqnToClass.entrySet()) {
            sb.append("        m.put(\"").append(escape(e.getKey())).append("\", ")
              .append(e.getValue()).append(".class);\n");
        }
        sb.append("        return m;\n");
        sb.append("    }\n");
        sb.append("}\n");

        Files.write(src.toPath(), sb.toString().getBytes(StandardCharsets.UTF_8));
    }

    /** Emit the {@code META-INF/services} registration naming the generated provider. */
    private void emitServicesRegistration() throws IOException {
        File servicesDir = new File(getOutputDir(),
                "META-INF" + File.separatorChar + "services");
        if (!servicesDir.exists()) servicesDir.mkdirs();
        File services = new File(servicesDir, ObjectClassBindingProvider.class.getName());
        Files.write(services.toPath(), (PROVIDER_FQN + "\n").getBytes(StandardCharsets.UTF_8));
    }

    private static String escape(String s) {
        return s.replace("\\", "\\\\").replace("\"", "\\\"");
    }

    @Override
    protected BaseObjectCodeWriter createWriter(MetaDataLoader loader, MetaObject md,
                                                PrintWriter pw, GenerationContext context) {
        if (FLAVOR_POJO_AWARE.equals(getFlavor())) {
            return new PojoAwareCodeWriter(loader, pw, context)
                    .forType(TYPE_CLASS)
                    .withPkgPrefix(getPkgPrefix())
                    .withPkgSuffix(getPkgSuffix())
                    .withNamePrefix(getNamePrefix())
                    .withNameSuffix(getNameSuffix())
                    .addArrayMethods(addArrayMethods())
                    .addKeyMethods(addKeyMethods())
                    .withIndentor("    ");
        }
        if (FLAVOR_VALUE_OBJECT.equals(getFlavor())) {
            return new ValueObjectCodeWriter(loader, pw, context)
                    .forType(TYPE_CLASS)
                    .withPkgPrefix(getPkgPrefix())
                    .withPkgSuffix(getPkgSuffix())
                    .withNamePrefix(getNamePrefix())
                    .withNameSuffix(getNameSuffix())
                    .addArrayMethods(addArrayMethods())
                    .addKeyMethods(addKeyMethods())
                    .withIndentor("    ");
        }
        return super.createWriter(loader, md, pw, context);
    }
}

package com.metaobjects.generator.direct.object.javacode;

import com.metaobjects.generator.direct.GenerationContext;
import com.metaobjects.generator.direct.object.BaseObjectCodeWriter;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.object.MetaObject;

import java.io.PrintWriter;

/**
 * Flavor-selecting Java object code generator.
 *
 * <p>Extends the legacy reference {@link JavaCodeGenerator} and adds a {@code flavor}
 * argument. When {@code flavor=pojoAware}, {@link #createWriter} returns a
 * {@link PojoAwareCodeWriter} (a concrete class {@code extends PojoObject}); otherwise
 * it falls through to the legacy interface-emitting {@link JavaCodeWriter}.</p>
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

    /** Read the {@code flavor} argument (empty = legacy interface flavor). */
    public String getFlavor() {
        return getArg(ARG_FLAVOR, "");
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
        return super.createWriter(loader, md, pw, context);
    }
}

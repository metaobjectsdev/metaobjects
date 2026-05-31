package com.metaobjects.generator.direct.object.javacode;

import com.metaobjects.field.MetaField;
import com.metaobjects.generator.direct.GenerationContext;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.object.MetaObject;

import java.io.PrintWriter;
import java.util.List;

/**
 * {@code pojoAware} flavor writer: emits a CONCRETE Java class that
 * {@code extends com.metaobjects.object.pojo.PojoObject} instead of the legacy
 * interface produced by {@link JavaCodeWriter}.
 *
 * <p>This subclass reuses every naming/type hook of the legacy reference writer
 * ({@code getLanguageType}, {@code getGetterMethodName}, {@code getSetterMethodName},
 * {@code getParameterName}, {@code getClassName}, {@code getLanguagePackage}, the
 * nested-ref resolution via {@code objectReferenceMap}) and overrides ONLY what is
 * needed to emit a concrete class: the {@code class} type, the class header's
 * {@code extends PojoObject} clause, typed private fields, a {@code (MetaObject)}
 * constructor that forwards to {@code super(mo)}, and getter/setter BODIES.</p>
 *
 * <p>Every emission step is {@code protected} (no {@code private}/{@code final} on
 * seams) so a downstream customizer can override field/constructor/accessor emission.</p>
 */
public class PojoAwareCodeWriter extends JavaCodeWriter {

    /** FQN of the concrete base class generated POJOs extend. */
    public static final String POJO_OBJECT_FQN = "com.metaobjects.object.pojo.PojoObject";

    public PojoAwareCodeWriter(MetaDataLoader loader, PrintWriter pw) {
        super(loader, pw);
        forType(JavaCodeGenerator.TYPE_CLASS);
    }

    public PojoAwareCodeWriter(MetaDataLoader loader, PrintWriter pw, GenerationContext context) {
        super(loader, pw, context);
        forType(JavaCodeGenerator.TYPE_CLASS);
    }

    /**
     * Emit {@code public class <Name> extends com.metaobjects.object.pojo.PojoObject {}.
     * Reuses the legacy header emission (package + imports + JavaDoc) but forces the
     * superclass to {@code PojoObject} when the metadata declares no super object.
     */
    @Override
    protected void writeObjectHeader(List<String> docs, String pkg, String name,
                                     List<String> importList, String fullSuperName) {
        String superName = (fullSuperName != null && !fullSuperName.isEmpty())
                ? fullSuperName
                : POJO_OBJECT_FQN;
        super.writeObjectHeader(docs, pkg, name, importList, superName);
    }

    /**
     * Emit fields + constructor BEFORE the accessor methods, then delegate to the
     * legacy body emission (comment + getter + setter per field).
     */
    @Override
    protected void writeObjectMethods(MetaObject mo) {
        inc();
        writeFields(mo);
        writeConstructor(mo);
        dec();

        super.writeObjectMethods(mo);
    }

    /**
     * Emit one private typed field per MetaField.
     */
    protected void writeFields(MetaObject mo) {
        writeNewLine();
        for (MetaField mf : mo.getMetaFields(false)) {
            String typeName = getLanguageType(mf);
            String fieldName = getParameterName(mf);
            println(true, "private " + typeName + " " + fieldName + ";");
        }
    }

    /**
     * Emit the {@code (MetaObject)} constructor forwarding to {@code super(mo)}.
     * PojoObject has no no-arg constructor, so only this form is emitted.
     */
    protected void writeConstructor(MetaObject mo) {
        writeNewLine();
        println(true, "public " + name + "(" + MetaObject.class.getName() + " mo) {");
        inc();
        println(true, "super(mo);");
        dec();
        println(true, "}");
    }

    /**
     * Emit a getter BODY: {@code return this.<field>;}.
     */
    @Override
    protected void writeGetter(String getterName, String typeName, MetaField field) {
        String fieldName = getParameterName(field);

        println(true, "/**");
        println(true, " * " + getterName + " is a code generated Getter method");
        println(true, " * @return " + typeName + " value");
        println(true, " */");
        println(true, "public " + typeName + " " + getterName + "() {");
        inc();
        println(true, "return this." + fieldName + ";");
        dec();
        println(true, "}");
    }

    /**
     * Emit a setter BODY: {@code this.<field> = <param>;}.
     */
    @Override
    protected void writeSetter(String setterName, String paramName, String typeName, MetaField field) {
        String fieldName = getParameterName(field);

        println(true, "/**");
        println(true, " * " + setterName + " is a code generated Setter method");
        println(true, " * @param " + paramName + " value to set");
        println(true, " */");
        println(true, "public void " + setterName + "(" + typeName + " " + paramName + ") {");
        inc();
        println(true, "this." + fieldName + " = " + paramName + ";");
        dec();
        println(true, "}");
    }
}

package com.metaobjects.generator.direct.object.javacode;

import com.metaobjects.field.MetaField;
import com.metaobjects.generator.direct.GenerationContext;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.object.MetaObject;

import java.io.PrintWriter;
import java.util.List;

/**
 * {@code valueObject} flavor writer: emits a CONCRETE Java class that
 * {@code extends com.metaobjects.object.value.ValueObject} (the map-backed,
 * extensible base) whose typed accessors use a per-field CACHED value holder
 * bound ONCE — the perf pattern.
 *
 * <p>Structurally parallels {@link PojoAwareCodeWriter} (extends {@link JavaCodeWriter},
 * targets {@code class}, overrides the same header/methods/getter/setter seams plus the
 * {@code protected} {@code writeFields}/{@code writeConstructor} hooks), but is perf-tuned
 * and map-backed rather than plain-field:</p>
 *
 * <ul>
 *   <li>For each {@link MetaField} it emits ONE {@code private final
 *       com.metaobjects.object.data.DataObjectBase.Value _&lt;field&gt; =
 *       valueHolder("&lt;field&gt;");} field. Instance-field initializers run AFTER the
 *       {@code super(mo)} call, so the holder is bound exactly once at construction —
 *       no {@code get(name)}/{@code set(name,v)} hash lookup on every accessor call.</li>
 *   <li>Getter body: {@code return (&lt;Type&gt;) _&lt;field&gt;.getValue();}</li>
 *   <li>Setter body: {@code _&lt;field&gt;.setValue(&lt;param&gt;);}</li>
 * </ul>
 *
 * <p>Because the cached holder IS the live cell in the {@link com.metaobjects.object.value.ValueObject}
 * backing map, typed accessors and the inherited {@code Map} surface are mutually visible,
 * and undeclared keys still round-trip through the map base.</p>
 *
 * <p>Every emission step is {@code protected} (no {@code private}/{@code final} on a writer
 * seam) so a downstream customizer can override field/constructor/accessor emission. The
 * holder FIELDS are {@code private final} — that is the generated OUTPUT shape, not a seam.</p>
 */
public class ValueObjectCodeWriter extends JavaCodeWriter {

    /** FQN of the concrete base class generated value objects extend. */
    public static final String VALUE_OBJECT_FQN = "com.metaobjects.object.value.ValueObject";

    /** FQN of the per-field cached value-holder type. */
    public static final String VALUE_HOLDER_FQN = "com.metaobjects.object.data.DataObjectBase.Value";

    public ValueObjectCodeWriter(MetaDataLoader loader, PrintWriter pw) {
        super(loader, pw);
        forType(JavaCodeGenerator.TYPE_CLASS);
    }

    public ValueObjectCodeWriter(MetaDataLoader loader, PrintWriter pw, GenerationContext context) {
        super(loader, pw, context);
        forType(JavaCodeGenerator.TYPE_CLASS);
    }

    /**
     * Emit {@code public class <Name> extends com.metaobjects.object.value.ValueObject {}.
     * Reuses the legacy header emission (package + imports + JavaDoc) but forces the
     * superclass to {@code ValueObject} when the metadata declares no super object.
     */
    @Override
    protected void writeObjectHeader(List<String> docs, String pkg, String name,
                                     List<String> importList, String fullSuperName) {
        String superName = (fullSuperName != null && !fullSuperName.isEmpty())
                ? fullSuperName
                : VALUE_OBJECT_FQN;
        super.writeObjectHeader(docs, pkg, name, importList, superName);
    }

    /**
     * Emit the cached holder fields + constructor BEFORE the accessor methods, then
     * delegate to the legacy body emission (comment + getter + setter per field).
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
     * Emit one cached value-holder field per MetaField, bound ONCE via
     * {@code valueHolder("<field>")}. The inline-final initializer runs after
     * {@code super(mo)} (Java field-init ordering), so the holder is valid and
     * bound exactly once at construction.
     */
    protected void writeFields(MetaObject mo) {
        writeNewLine();
        for (MetaField mf : mo.getMetaFields(false)) {
            String holderName = getHolderFieldName(mf);
            println(true, "private final " + VALUE_HOLDER_FQN + " " + holderName
                    + " = valueHolder(\"" + mf.getName() + "\");");
        }
    }

    /**
     * Emit the {@code (MetaObject)} constructor forwarding to {@code super(mo)}.
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
     * Emit a getter BODY that reads the cached holder:
     * {@code return (<Type>) _<field>.getValue();}.
     */
    @Override
    protected void writeGetter(String getterName, String typeName, MetaField field) {
        String holderName = getHolderFieldName(field);

        println(true, "/**");
        println(true, " * " + getterName + " is a code generated Getter method");
        println(true, " * @return " + typeName + " value");
        println(true, " */");
        println(true, "public " + typeName + " " + getterName + "() {");
        inc();
        println(true, "return (" + typeName + ") " + holderName + ".getValue();");
        dec();
        println(true, "}");
    }

    /**
     * Emit a setter BODY that writes the cached holder:
     * {@code _<field>.setValue(<param>);}.
     */
    @Override
    protected void writeSetter(String setterName, String paramName, String typeName, MetaField field) {
        String holderName = getHolderFieldName(field);

        println(true, "/**");
        println(true, " * " + setterName + " is a code generated Setter method");
        println(true, " * @param " + paramName + " value to set");
        println(true, " */");
        println(true, "public void " + setterName + "(" + typeName + " " + paramName + ") {");
        inc();
        println(true, holderName + ".setValue(" + paramName + ");");
        dec();
        println(true, "}");
    }

    /**
     * Name of the cached holder field backing a given MetaField's accessors.
     * Prefixed with {@code _} to avoid colliding with the camelCase parameter name.
     */
    protected String getHolderFieldName(MetaField field) {
        return "_" + getParameterName(field);
    }
}

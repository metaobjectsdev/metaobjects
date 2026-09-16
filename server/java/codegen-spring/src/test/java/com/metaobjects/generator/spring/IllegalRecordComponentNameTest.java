package com.metaobjects.generator.spring;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

/**
 * A field name that is legal metadata but cannot BE a Java record component.
 *
 * <p>Found by {@link CodegenCompileConformanceTest} on its first run. The shared fitness
 * corpus declares {@code object.value Settings} with a {@code field.boolean notify} — and
 * {@code SpringValueObjectGenerator} emitted {@code public record Settings(…, Boolean
 * notify, …)}, which javac refuses outright: <i>illegal record component name notify</i>.
 * A record component generates an accessor of the same name, and {@code Object.notify()}
 * is {@code final}, so the component can never be declared (JLS 8.10.3).
 *
 * <p>Nothing caught it because {@code mvn metaobjects:generate} exits 0 and no test had
 * ever COMPILED this generator's output over a corpus containing such a name. The POJO
 * arm was unaffected — a plain class may have a field called {@code notify}, because its
 * accessor is {@code getNotify()} — which is why only the record emitters escape.
 *
 * <p>The escape is a Java concern and stops at Java: {@code notify} stays a legal field
 * name in all five ports, and the wire keeps the declared name via {@code @JsonProperty},
 * so no other port and no payload changes.
 */
public class IllegalRecordComponentNameTest {

    @Test
    public void theEightNamesTheJlsForbidsAreEscaped() {
        // JLS 8.10.3 — the no-argument methods of Object. `equals` is NOT among them: it
        // takes a parameter, so `equals()` does not override it and the name stays legal.
        for (String name : new String[] {
                "clone", "finalize", "getClass", "hashCode", "notify", "notifyAll", "toString", "wait" }) {
            assertTrue(name + " must be recognised as an illegal record component",
                SpringNaming.isIllegalRecordComponent(name));
            assertEquals(name + "_", SpringNaming.recordComponentName(name));
            assertEquals("@com.fasterxml.jackson.annotation.JsonProperty(\"" + name + "\")",
                SpringNaming.jsonPropertyAnnotation(name));
        }
    }

    @Test
    public void everyOtherNameIsLeftExactlyAlone() {
        // The escape must be inert for the ~100% of fields that do not need it — an
        // unconditional rename would churn every generated record in every adopter repo.
        for (String name : new String[] { "equals", "notified", "theme", "retries", "name", "id", "waiting" }) {
            assertTrue(name + " must not be escaped", !SpringNaming.isIllegalRecordComponent(name));
            assertEquals(name, SpringNaming.recordComponentName(name));
            assertEquals("", SpringNaming.jsonPropertyAnnotation(name));
        }
    }

    @Test
    public void theWireNameSurvivesTheEscape() {
        // The whole point: the Java identifier changes, the JSON property does not. Without
        // the annotation Jackson would name the property after the component and this port
        // would disagree with the other four about the payload.
        assertTrue(SpringNaming.jsonPropertyAnnotation("notify").contains("\"notify\""));
        assertTrue(!SpringNaming.jsonPropertyAnnotation("notify").contains("notify_"));
    }
}

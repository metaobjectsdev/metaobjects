package com.metaobjects.generator.spring;

import com.metaobjects.object.MetaObject;
import com.metaobjects.registry.SharedRegistryTestBase;
import org.junit.Test;

import static org.junit.Assert.assertTrue;

/**
 * Unit tests for {@link RecoverSchemaEmitter}.
 *
 * <p>Pins the two output contracts:
 * <ul>
 *   <li>{@link RecoverSchemaEmitter#schemaLiteral} — emits a
 *       {@code new RecoverSchema(...)} literal with correct {@code FieldSpec} calls
 *       for scalar, enum (with alias), and optional fields.</li>
 *   <li>{@link RecoverSchemaEmitter#constructorArgs} — emits the comma-separated
 *       {@code RecoverMap.*} argument list for each field.</li>
 * </ul>
 *
 * <p>The VO fixture (declared in {@link SpringTestFixtures#RECOVER_VO_FIXTURE})
 * has three fields: {@code text} (string, required), {@code confidence} (enum,
 * required, values HIGH/OK/LOW, alias medium→OK), {@code note} (string, optional).
 */
public class RecoverSchemaEmitterTest extends SharedRegistryTestBase {

    private MetaObject vo() throws Exception {
        return SpringTestFixtures.loadVo(SpringTestFixtures.RECOVER_VO_FIXTURE, "AnswerOutputPayload");
    }

    // -------------------------------------------------------------------------
    // schemaLiteral tests
    // -------------------------------------------------------------------------

    @Test
    public void emitsSchemaLiteralWithEnumAndAlias() throws Exception {
        String s = RecoverSchemaEmitter.schemaLiteral(vo(), "json", "AnswerOutputPayload");

        assertTrue("expected RecoverSchema(Format.JSON, \"AnswerOutputPayload\"; saw:\n" + s,
            s.contains("new RecoverSchema(Format.JSON, \"AnswerOutputPayload\""));

        assertTrue("expected scalar for text; saw:\n" + s,
            s.contains("FieldSpec.scalar(\"text\", FieldKind.STRING, true)"));

        assertTrue("expected enumField for confidence; saw:\n" + s,
            s.contains("FieldSpec.enumField(\"confidence\", true,"));

        assertTrue("expected HIGH in enum values; saw:\n" + s,
            s.contains("\"HIGH\""));

        assertTrue("expected alias map literal with medium→OK; saw:\n" + s,
            s.contains("java.util.Map.of(\"medium\", \"OK\")"));

        assertTrue("expected scalar for note (optional); saw:\n" + s,
            s.contains("FieldSpec.scalar(\"note\", FieldKind.STRING, false)"));
    }

    @Test
    public void xmlSchemaUsesXmlFormat() throws Exception {
        String s = RecoverSchemaEmitter.schemaLiteral(vo(), "xml", "AnswerOutputPayload");
        assertTrue("expected Format.XML; saw:\n" + s,
            s.contains("new RecoverSchema(Format.XML, \"AnswerOutputPayload\""));
    }

    // -------------------------------------------------------------------------
    // constructorArgs tests
    // -------------------------------------------------------------------------

    @Test
    public void emitsConstructorArgsUsingRecoverMap() throws Exception {
        String a = RecoverSchemaEmitter.constructorArgs(vo());

        assertTrue("expected asString for text; saw:\n" + a,
            a.contains("RecoverMap.asString(d, \"text\")"));

        assertTrue("expected asString for confidence (enum); saw:\n" + a,
            a.contains("RecoverMap.asString(d, \"confidence\")"));

        assertTrue("expected asString for note; saw:\n" + a,
            a.contains("RecoverMap.asString(d, \"note\")"));
    }
}

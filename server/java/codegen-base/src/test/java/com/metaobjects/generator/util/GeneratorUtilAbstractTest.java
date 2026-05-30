package com.metaobjects.generator.util;

import com.metaobjects.generator.GeneratorTestBase;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.loader.uri.URIHelper;
import com.metaobjects.object.MetaObject;
import org.junit.Test;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Collections;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * Verifies {@link GeneratorUtil#isAbstract(com.metaobjects.MetaData)} reads the
 * canonical {@code isAbstract} MetaAttribute (the loader stores {@code abstract: true}
 * as a MetaAttribute named {@code isAbstract}), not the vestigial {@code _isAbstract}.
 */
public class GeneratorUtilAbstractTest extends GeneratorTestBase {

    // Field-bearing on purpose: loading field.long/field.string forces the
    // metadata provider-bootstrap path. This is also a regression guard for the
    // class-init cycle where MetaData's static{} block bootstrapped the registry
    // during its own <clinit>, leaving subclass loggers null and the field
    // subtypes unregistered (only field.base). See the removal of the redundant
    // self-registration static{} blocks in MetaData/MetaRoot.
    private static final String MODEL = "{\n" +
        "  \"metadata.root\": {\n" +
        "    \"package\": \"acme\",\n" +
        "    \"children\": [\n" +
        "      { \"object.entity\": { \"name\": \"Base\", \"abstract\": true, \"children\": [\n" +
        "        { \"field.long\": { \"name\": \"id\" } }\n" +
        "      ] } },\n" +
        "      { \"object.entity\": { \"name\": \"Concrete\", \"extends\": \"Base\", \"children\": [\n" +
        "        { \"field.string\": { \"name\": \"label\" } },\n" +
        "        { \"identity.primary\": { \"name\": \"pk\", \"@fields\": [\"id\"] } }\n" +
        "      ] } }\n" +
        "    ]\n" +
        "  }\n" +
        "}";

    @Test
    public void abstractAccessorReadsCanonicalIsAbstract() throws Exception {
        File tmp = File.createTempFile("gu-abstract", ".json");
        tmp.deleteOnExit();
        Files.write(tmp.toPath(), MODEL.getBytes(StandardCharsets.UTF_8));

        MetaDataLoader loader = initLoader(Collections.singletonList(
            URIHelper.toURI("model:file:" + tmp.getAbsolutePath())));

        MetaObject base = loader.getMetaObjectByName("acme::Base");
        MetaObject concrete = loader.getMetaObjectByName("acme::Concrete");

        assertTrue("abstract entity should be reported abstract",
            GeneratorUtil.isAbstract(base));
        assertFalse("concrete entity should NOT be reported abstract",
            GeneratorUtil.isAbstract(concrete));
    }
}

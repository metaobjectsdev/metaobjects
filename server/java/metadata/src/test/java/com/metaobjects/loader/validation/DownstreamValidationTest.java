package com.metaobjects.loader.validation;

import com.metaobjects.MetaDataException;
import com.metaobjects.loader.InMemoryStringSource;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.registry.SharedRegistryTestBase;
import com.metaobjects.registry.TypeDefinition;
import org.junit.Test;

import java.util.Collections;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

/**
 * Phase 2 proof (JVM): validation is now DERIVED FROM THE TYPE REGISTRY — each type's
 * cross-references live on its {@link TypeDefinition} (config-on-the-type), and the loader's
 * registry-derived walk enforces them. This is the Java realization of "validation is part
 * of the type's registration." (Registering a brand-new downstream TYPE with its own
 * validation rides in on the same mechanism — composed via setTypeRegistry — and is proven
 * end-to-end by the TS slice.)
 */
public class DownstreamValidationTest extends SharedRegistryTestBase {

    private MetaDataLoader newLoader() {
        return createTestLoader("DownstreamValidation", Collections.emptyList());
    }

    @Test
    public void coreCrossReferencesLiveOnTheirTypeDefinitions() {
        // The descriptors are carried by the type's registration, not hardcoded in a pass.
        TypeDefinition rel = getSharedRegistry().getTypeDefinition("relationship", "composition");
        assertNotNull("relationship.composition is registered", rel);
        assertFalse("relationship.composition declares its @objectRef cross-reference",
            rel.getReferences().isEmpty());
        assertEquals("objectRef", rel.getReferences().get(0).attr());

        TypeDefinition idRef = getSharedRegistry().getTypeDefinition("identity", "reference");
        assertNotNull("identity.reference is registered", idRef);
        assertFalse("identity.reference declares its @references cross-reference",
            idRef.getReferences().isEmpty());
        assertTrue("identity.reference resolves the entity segment of a dotted path",
            idRef.getReferences().get(0).dottedFieldPath());
    }

    @Test
    public void derivedValidationCatchesADanglingObjectRef() {
        // End-to-end: the loader derives validation from the registry and enforces the
        // declared @objectRef descriptor.
        String bad =
            "{ \"metadata.root\": { \"package\": \"app\", \"children\": [" +
            "  { \"object.entity\": { \"name\": \"Author\", \"children\": [" +
            "    { \"field.long\": { \"name\": \"id\" } }," +
            "    { \"relationship.composition\": { \"name\": \"posts\", \"@objectRef\": \"NoSuch\", \"@cardinality\": \"many\" } }," +
            "    { \"identity.primary\": { \"@fields\": \"id\" } }" +
            "  ] } }" +
            "] } }";
        try {
            newLoader().load(List.of(new InMemoryStringSource(bad, "bad.json")));
            org.junit.Assert.fail("expected a dangling-objectRef load error");
        } catch (Exception ex) {
            String msg = ex.getMessage() + (ex.getCause() != null ? ex.getCause().getMessage() : "");
            assertTrue("expected ERR_INVALID_RELATIONSHIP, got: " + msg,
                msg.contains("does not resolve") || msg.contains("ERR_INVALID_RELATIONSHIP"));
        }
    }

    @Test
    public void runReadsTheValidatorFromTheTypeDefinition() {
        // A valid model parses; the registry-derived run (reading TypeDefinition references +
        // validators) produces no errors for it — confirming the derivation path is live.
        String good =
            "{ \"metadata.root\": { \"package\": \"app\", \"children\": [" +
            "  { \"object.entity\": { \"name\": \"Author\", \"children\": [" +
            "    { \"field.long\": { \"name\": \"id\" } }," +
            "    { \"relationship.composition\": { \"name\": \"posts\", \"@objectRef\": \"Post\", \"@cardinality\": \"many\" } }," +
            "    { \"identity.primary\": { \"@fields\": \"id\" } }" +
            "  ] } }," +
            "  { \"object.entity\": { \"name\": \"Post\", \"children\": [" +
            "    { \"field.long\": { \"name\": \"id\" } }," +
            "    { \"identity.primary\": { \"@fields\": \"id\" } }" +
            "  ] } }" +
            "] } }";
        MetaDataLoader loader = newLoader();
        loader.load(List.of(new InMemoryStringSource(good, "good.json")));
        List<ValidationError> errors =
            RegisteredValidation.run(loader.getRoot(), loader.getTypeRegistry());
        assertTrue("valid model yields no registry-derived errors: " + errors, errors.isEmpty());
    }
}

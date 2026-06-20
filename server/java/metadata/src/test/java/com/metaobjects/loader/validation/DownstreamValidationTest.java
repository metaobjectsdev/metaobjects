package com.metaobjects.loader.validation;

import com.metaobjects.MetaData;
import com.metaobjects.MetaRoot;
import com.metaobjects.field.MetaField;
import com.metaobjects.loader.InMemoryStringSource;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.object.MetaObject;
import com.metaobjects.registry.SharedRegistryTestBase;
import org.junit.Test;

import java.util.Collections;
import java.util.List;

import static org.junit.Assert.assertTrue;

/**
 * Phase 2 prototype proof (JVM): a DOWNSTREAM party extends validation through the registry —
 * a method-reference node validator AND a reference descriptor with its OWN error code — and
 * the same recursive walk runs them, with NO core edits. This is the load-bearing R2 check
 * expressed on the JVM. (Registering a brand-new TYPE uses the existing provider machinery
 * and is proven by the TS slice; here we exercise the novel part — the validation registry.)
 */
public class DownstreamValidationTest extends SharedRegistryTestBase {

    // A built-in-VALID model: Author.posts -> Post (exists), Post.fkAuthor -> Author (exists).
    private static final String MODEL =
        "{ \"metadata.root\": { \"package\": \"app\", \"children\": [" +
        "  { \"object.entity\": { \"name\": \"Author\", \"children\": [" +
        "    { \"field.long\": { \"name\": \"id\" } }," +
        "    { \"relationship.composition\": { \"name\": \"posts\", \"@objectRef\": \"Post\", \"@cardinality\": \"many\" } }," +
        "    { \"identity.primary\": { \"@fields\": \"id\" } }" +
        "  ] } }," +
        "  { \"object.entity\": { \"name\": \"Post\", \"children\": [" +
        "    { \"field.long\": { \"name\": \"id\" } }," +
        "    { \"field.long\": { \"name\": \"authorId\" } }," +
        "    { \"identity.primary\": { \"@fields\": \"id\" } }," +
        "    { \"identity.reference\": { \"name\": \"fkAuthor\", \"@fields\": \"authorId\", \"@references\": \"Author\" } }" +
        "  ] } }" +
        "] } }";

    /** A downstream imperative rule — registered as a METHOD REFERENCE (the Java idiom). */
    static void entityMustHaveTitleField(MetaData node, ValidationContext ctx) {
        boolean hasTitle = node.getChildren(MetaData.class, false).stream()
            .anyMatch(c -> MetaField.TYPE_FIELD.equals(c.getType()) && "title".equals(c.getName()));
        if (!hasTitle) {
            ctx.error("ERR_DOWNSTREAM_NO_TITLE", node,
                "entity \"" + node.getShortName() + "\" must declare a 'title' field");
        }
    }

    @Test
    public void downstreamRegistryValidatesViaSameWalkWithNoCoreEdits() {
        MetaDataLoader loader = createTestLoader("DownstreamValidation", Collections.emptyList());
        loader.load(List.of(new InMemoryStringSource(MODEL, "test.json")));
        MetaRoot root = loader.getRoot();

        // A DOWNSTREAM party's validation registry: a method-ref validator + a reference
        // descriptor with a tighter target-kind, both using the party's OWN error codes.
        ValidationRegistry downstream = new ValidationRegistry()
            .registerValidator(MetaObject.TYPE_OBJECT, "entity",
                DownstreamValidationTest::entityMustHaveTitleField)
            .registerReference("relationship", ValidationRegistry.SUBTYPE_ANY,
                new ReferenceDescriptor("objectRef", MetaObject.TYPE_OBJECT, "value", false,
                    "ERR_DOWNSTREAM_REL_MUST_TARGET_VALUE"));

        List<ValidationError> errors = RegisteredValidation.run(root, downstream);
        List<String> codes = errors.stream().map(ValidationError::code).toList();

        // The method-ref validator fired (neither entity has a 'title' field)...
        assertTrue("expected downstream validator error, got: " + codes,
            codes.contains("ERR_DOWNSTREAM_NO_TITLE"));
        // ...and the custom reference descriptor fired with target-kind enforcement
        // (Author.posts -> Post is an entity, not a value) and a downstream code.
        assertTrue("expected downstream reference error, got: " + codes,
            codes.contains("ERR_DOWNSTREAM_REL_MUST_TARGET_VALUE"));
    }

    @Test
    public void coreRegistryStillRunsViaTheLoader() {
        // Sanity: the built-in @objectRef / @references resolution that now runs through the
        // registry inside the loader still loads a valid model without error.
        MetaDataLoader loader = createTestLoader("DownstreamValidationCore", Collections.emptyList());
        loader.load(List.of(new InMemoryStringSource(MODEL, "test.json")));
        assertTrue("valid model should load", loader.getRoot() != null);
    }
}

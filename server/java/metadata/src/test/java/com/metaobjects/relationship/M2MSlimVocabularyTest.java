package com.metaobjects.relationship;

import com.metaobjects.ErrorCode;
import com.metaobjects.MetaData;
import com.metaobjects.MetaDataException;
import com.metaobjects.MetaRoot;
import com.metaobjects.loader.InMemoryStringSource;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.object.MetaObject;
import com.metaobjects.registry.SharedRegistryTestBase;
import org.junit.Test;

import java.util.List;

import static org.junit.Assert.*;

/**
 * FR-017 — Java M:N slim vocabulary ({@code @through} / {@code @sourceRefField} /
 * {@code @symmetric}), junction-FK derivation ({@link M2MFields}), and loader validation.
 *
 * <p>Mirrors the TS reference ({@code relationship-constants.ts} + {@code derive-m2m-fields.ts}
 * + the {@code validateRelationships} pass). The shared cross-port conformance fixtures
 * ({@code relationship-m2m-*} / {@code error-relationship-*}) exercise the loader-pipeline
 * envelope contract; this test exercises the accessors + the standalone derivation helper +
 * the four validation rules directly.</p>
 */
public class M2MSlimVocabularyTest extends SharedRegistryTestBase {

    private MetaDataLoader newTestLoader() {
        return createTestLoader("M2MSlimVocabularyTest", java.util.Collections.emptyList());
    }

    private MetaDataLoader loadThrough(String canonical, String id) {
        MetaDataLoader loader = newTestLoader();
        loader.load(List.of(new InMemoryStringSource(canonical, id)));
        return loader;
    }

    // --- Fixtures (canonical JSON) -----------------------------------------

    /** Hetero M:N: Post --tags--> Tag through PostTag (postRef/tagRef). */
    private static final String HETERO =
        "{ \"metadata.root\": { \"package\": \"acme\", \"children\": ["
        + "  { \"object.entity\": { \"name\": \"Post\", \"children\": ["
        + "    { \"field.long\": { \"name\": \"id\" } },"
        + "    { \"relationship.association\": { \"name\": \"tags\", \"@cardinality\": \"many\","
        + "        \"@objectRef\": \"Tag\", \"@through\": \"PostTag\" } },"
        + "    { \"identity.primary\": { \"@fields\": \"id\" } } ] } },"
        + "  { \"object.entity\": { \"name\": \"Tag\", \"children\": ["
        + "    { \"field.long\": { \"name\": \"id\" } },"
        + "    { \"identity.primary\": { \"@fields\": \"id\" } } ] } },"
        + "  { \"object.entity\": { \"name\": \"PostTag\", \"children\": ["
        + "    { \"field.long\": { \"name\": \"id\" } },"
        + "    { \"field.long\": { \"name\": \"postId\" } },"
        + "    { \"field.long\": { \"name\": \"tagId\" } },"
        + "    { \"identity.primary\": { \"@fields\": \"id\" } },"
        + "    { \"identity.reference\": { \"name\": \"postRef\", \"@fields\": \"postId\", \"@references\": \"Post\" } },"
        + "    { \"identity.reference\": { \"name\": \"tagRef\", \"@fields\": \"tagId\", \"@references\": \"Tag\" } } ] } }"
        + "] } }";

    /** Directed self-join: User --follows--> User through Follow, @sourceRefField=followerId. */
    private static final String DIRECTED =
        "{ \"metadata.root\": { \"package\": \"acme\", \"children\": ["
        + "  { \"object.entity\": { \"name\": \"User\", \"children\": ["
        + "    { \"field.long\": { \"name\": \"id\" } },"
        + "    { \"relationship.association\": { \"name\": \"follows\", \"@cardinality\": \"many\","
        + "        \"@objectRef\": \"User\", \"@through\": \"Follow\", \"@sourceRefField\": \"followerId\" } },"
        + "    { \"identity.primary\": { \"@fields\": \"id\" } } ] } },"
        + "  { \"object.entity\": { \"name\": \"Follow\", \"children\": ["
        + "    { \"field.long\": { \"name\": \"id\" } },"
        + "    { \"field.long\": { \"name\": \"followerId\" } },"
        + "    { \"field.long\": { \"name\": \"followeeId\" } },"
        + "    { \"identity.primary\": { \"@fields\": \"id\" } },"
        + "    { \"identity.reference\": { \"name\": \"followerRef\", \"@fields\": \"followerId\", \"@references\": \"User\" } },"
        + "    { \"identity.reference\": { \"name\": \"followeeRef\", \"@fields\": \"followeeId\", \"@references\": \"User\" } } ] } }"
        + "] } }";

    /** Symmetric self-join: User --friends--> User through Friendship, @symmetric=true. */
    private static final String SYMMETRIC =
        "{ \"metadata.root\": { \"package\": \"acme\", \"children\": ["
        + "  { \"object.entity\": { \"name\": \"User\", \"children\": ["
        + "    { \"field.long\": { \"name\": \"id\" } },"
        + "    { \"relationship.association\": { \"name\": \"friends\", \"@cardinality\": \"many\","
        + "        \"@objectRef\": \"User\", \"@through\": \"Friendship\", \"@symmetric\": true } },"
        + "    { \"identity.primary\": { \"@fields\": \"id\" } } ] } },"
        + "  { \"object.entity\": { \"name\": \"Friendship\", \"children\": ["
        + "    { \"field.long\": { \"name\": \"id\" } },"
        + "    { \"field.long\": { \"name\": \"userAId\" } },"
        + "    { \"field.long\": { \"name\": \"userBId\" } },"
        + "    { \"identity.primary\": { \"@fields\": \"id\" } },"
        + "    { \"identity.reference\": { \"name\": \"userARef\", \"@fields\": \"userAId\", \"@references\": \"User\" } },"
        + "    { \"identity.reference\": { \"name\": \"userBRef\", \"@fields\": \"userBId\", \"@references\": \"User\" } } ] } }"
        + "] } }";

    private MetaRelationship rel(MetaDataLoader loader, String entityFqn, String relFqn) {
        MetaData obj = loader.getRoot().getChildOfType("object", entityFqn);
        MetaData r = obj.getChildOfType(MetaRelationship.TYPE_RELATIONSHIP, relFqn);
        return (MetaRelationship) r;
    }

    private MetaObject obj(MetaDataLoader loader, String entityFqn) {
        return (MetaObject) loader.getRoot().getChildOfType("object", entityFqn);
    }

    // --- 1. Accessors -------------------------------------------------------

    @Test
    public void accessorsReadSlimVocabulary() {
        MetaDataLoader loader = loadThrough(DIRECTED, "directed.json");
        MetaRelationship r = rel(loader, "acme::User", "follows");
        assertEquals("Follow", r.getThrough());
        assertEquals("followerId", r.getSourceRefField());
        assertFalse(r.isSymmetric());
        assertEquals("many", r.getCardinality());
        assertEquals("User", r.getObjectRef());
    }

    @Test
    public void symmetricAccessorReadsBoolean() {
        MetaDataLoader loader = loadThrough(SYMMETRIC, "symmetric.json");
        MetaRelationship r = rel(loader, "acme::User", "friends");
        assertTrue(r.isSymmetric());
        assertEquals("Friendship", r.getThrough());
        assertNull(r.getSourceRefField());
    }

    @Test
    public void accessorsNullWhenAbsent() {
        MetaRelationship r = new AssociationRelationship("plain");
        assertNull(r.getThrough());
        assertNull(r.getSourceRefField());
        assertFalse(r.isSymmetric());
    }

    // --- 2. Derivation: three modes ----------------------------------------

    @Test
    public void deriveHetero() {
        MetaDataLoader loader = loadThrough(HETERO, "hetero.json");
        MetaRoot root = loader.getRoot();
        M2MFields f = M2MFields.derive(rel(loader, "acme::Post", "tags"),
            obj(loader, "acme::Post"), root);
        assertEquals("postId", f.getSourceField());
        assertEquals("tagId", f.getTargetField());
    }

    @Test
    public void deriveDirectedSelfJoin() {
        MetaDataLoader loader = loadThrough(DIRECTED, "directed.json");
        M2MFields f = M2MFields.derive(rel(loader, "acme::User", "follows"),
            obj(loader, "acme::User"), loader.getRoot());
        assertEquals("followerId", f.getSourceField());
        assertEquals("followeeId", f.getTargetField());
    }

    @Test
    public void deriveSymmetricSelfJoin() {
        MetaDataLoader loader = loadThrough(SYMMETRIC, "symmetric.json");
        M2MFields f = M2MFields.derive(rel(loader, "acme::User", "friends"),
            obj(loader, "acme::User"), loader.getRoot());
        // Declaration order: userAId first, userBId second.
        assertEquals("userAId", f.getSourceField());
        assertEquals("userBId", f.getTargetField());
    }

    // --- 3. Validation rules -----------------------------------------------

    private void assertLoadFails(String json, String id, ErrorCode expected) {
        try {
            loadThrough(json, id);
            fail("Expected MetaDataException " + expected + " for " + id);
        } catch (MetaDataException e) {
            boolean byCode = e.getCode().map(c -> c == expected).orElse(false);
            boolean byMsg = e.getMessage() != null && e.getMessage().contains(expected.name());
            assertTrue("Exception must signal " + expected + " (code or message): "
                + e.getMessage(), byCode || byMsg);
        }
    }

    @Test
    public void symmetricOnHeteroIsBadAttrValue() {
        String json =
            "{ \"metadata.root\": { \"package\": \"acme\", \"children\": ["
            + "  { \"object.entity\": { \"name\": \"Post\", \"children\": ["
            + "    { \"field.long\": { \"name\": \"id\" } },"
            + "    { \"relationship.association\": { \"name\": \"tags\", \"@cardinality\": \"many\","
            + "        \"@objectRef\": \"Tag\", \"@through\": \"PostTag\", \"@symmetric\": true } },"
            + "    { \"identity.primary\": { \"@fields\": \"id\" } } ] } },"
            + "  { \"object.entity\": { \"name\": \"Tag\", \"children\": ["
            + "    { \"field.long\": { \"name\": \"id\" } },"
            + "    { \"identity.primary\": { \"@fields\": \"id\" } } ] } },"
            + "  { \"object.entity\": { \"name\": \"PostTag\", \"children\": ["
            + "    { \"field.long\": { \"name\": \"id\" } },"
            + "    { \"field.long\": { \"name\": \"postId\" } },"
            + "    { \"field.long\": { \"name\": \"tagId\" } },"
            + "    { \"identity.primary\": { \"@fields\": \"id\" } },"
            + "    { \"identity.reference\": { \"name\": \"postRef\", \"@fields\": \"postId\", \"@references\": \"Post\" } },"
            + "    { \"identity.reference\": { \"name\": \"tagRef\", \"@fields\": \"tagId\", \"@references\": \"Tag\" } } ] } }"
            + "] } }";
        assertLoadFails(json, "symmetric-on-hetero.json", ErrorCode.ERR_BAD_ATTR_VALUE);
    }

    @Test
    public void symmetricAndSourceRefAreMutuallyExclusive() {
        String json =
            "{ \"metadata.root\": { \"package\": \"acme\", \"children\": ["
            + "  { \"object.entity\": { \"name\": \"User\", \"children\": ["
            + "    { \"field.long\": { \"name\": \"id\" } },"
            + "    { \"relationship.association\": { \"name\": \"friends\", \"@cardinality\": \"many\","
            + "        \"@objectRef\": \"User\", \"@through\": \"Friendship\", \"@symmetric\": true,"
            + "        \"@sourceRefField\": \"userAId\" } },"
            + "    { \"identity.primary\": { \"@fields\": \"id\" } } ] } },"
            + "  { \"object.entity\": { \"name\": \"Friendship\", \"children\": ["
            + "    { \"field.long\": { \"name\": \"id\" } },"
            + "    { \"field.long\": { \"name\": \"userAId\" } },"
            + "    { \"field.long\": { \"name\": \"userBId\" } },"
            + "    { \"identity.primary\": { \"@fields\": \"id\" } },"
            + "    { \"identity.reference\": { \"name\": \"userARef\", \"@fields\": \"userAId\", \"@references\": \"User\" } },"
            + "    { \"identity.reference\": { \"name\": \"userBRef\", \"@fields\": \"userBId\", \"@references\": \"User\" } } ] } }"
            + "] } }";
        assertLoadFails(json, "symmetric-and-sourceref.json", ErrorCode.ERR_BAD_ATTR_VALUE);
    }

    @Test
    public void junctionMissingTwoReferencesIsInvalidRelationship() {
        // PostTag declares only one identity.reference.
        String json =
            "{ \"metadata.root\": { \"package\": \"acme\", \"children\": ["
            + "  { \"object.entity\": { \"name\": \"Post\", \"children\": ["
            + "    { \"field.long\": { \"name\": \"id\" } },"
            + "    { \"relationship.association\": { \"name\": \"tags\", \"@cardinality\": \"many\","
            + "        \"@objectRef\": \"Tag\", \"@through\": \"PostTag\" } },"
            + "    { \"identity.primary\": { \"@fields\": \"id\" } } ] } },"
            + "  { \"object.entity\": { \"name\": \"Tag\", \"children\": ["
            + "    { \"field.long\": { \"name\": \"id\" } },"
            + "    { \"identity.primary\": { \"@fields\": \"id\" } } ] } },"
            + "  { \"object.entity\": { \"name\": \"PostTag\", \"children\": ["
            + "    { \"field.long\": { \"name\": \"id\" } },"
            + "    { \"field.long\": { \"name\": \"postId\" } },"
            + "    { \"field.long\": { \"name\": \"tagId\" } },"
            + "    { \"identity.primary\": { \"@fields\": \"id\" } },"
            + "    { \"identity.reference\": { \"name\": \"postRef\", \"@fields\": \"postId\", \"@references\": \"Post\" } } ] } }"
            + "] } }";
        assertLoadFails(json, "missing-junction-refs.json", ErrorCode.ERR_INVALID_RELATIONSHIP);
    }

    @Test
    public void m2mAttrOnOneToManyIsInvalidRelationship() {
        String json =
            "{ \"metadata.root\": { \"package\": \"acme\", \"children\": ["
            + "  { \"object.entity\": { \"name\": \"Week\", \"children\": ["
            + "    { \"field.long\": { \"name\": \"id\" } },"
            + "    { \"relationship.composition\": { \"name\": \"program\", \"@objectRef\": \"Program\","
            + "        \"@cardinality\": \"one\", \"@through\": \"ProgramWeek\" } },"
            + "    { \"identity.primary\": { \"@fields\": \"id\" } } ] } },"
            + "  { \"object.entity\": { \"name\": \"Program\", \"children\": ["
            + "    { \"field.long\": { \"name\": \"id\" } },"
            + "    { \"identity.primary\": { \"@fields\": \"id\" } } ] } }"
            + "] } }";
        assertLoadFails(json, "m2m-attr-on-1n.json", ErrorCode.ERR_INVALID_RELATIONSHIP);
    }

    @Test
    public void sourceRefFieldNotMatchingIsInvalidRelationship() {
        // @sourceRefField names a field that is not one of the junction's reference FKs.
        String json =
            "{ \"metadata.root\": { \"package\": \"acme\", \"children\": ["
            + "  { \"object.entity\": { \"name\": \"User\", \"children\": ["
            + "    { \"field.long\": { \"name\": \"id\" } },"
            + "    { \"relationship.association\": { \"name\": \"follows\", \"@cardinality\": \"many\","
            + "        \"@objectRef\": \"User\", \"@through\": \"Follow\", \"@sourceRefField\": \"nope\" } },"
            + "    { \"identity.primary\": { \"@fields\": \"id\" } } ] } },"
            + "  { \"object.entity\": { \"name\": \"Follow\", \"children\": ["
            + "    { \"field.long\": { \"name\": \"id\" } },"
            + "    { \"field.long\": { \"name\": \"followerId\" } },"
            + "    { \"field.long\": { \"name\": \"followeeId\" } },"
            + "    { \"identity.primary\": { \"@fields\": \"id\" } },"
            + "    { \"identity.reference\": { \"name\": \"followerRef\", \"@fields\": \"followerId\", \"@references\": \"User\" } },"
            + "    { \"identity.reference\": { \"name\": \"followeeRef\", \"@fields\": \"followeeId\", \"@references\": \"User\" } } ] } }"
            + "] } }";
        assertLoadFails(json, "sourceref-mismatch.json", ErrorCode.ERR_INVALID_RELATIONSHIP);
    }

    @Test
    public void validM2MFixturesLoadCleanly() {
        // All three positive modes load without throwing.
        loadThrough(HETERO, "hetero-ok.json");
        loadThrough(DIRECTED, "directed-ok.json");
        loadThrough(SYMMETRIC, "symmetric-ok.json");
    }
}

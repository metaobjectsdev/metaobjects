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

    // --- 4. ADR-0039 — junction inherits its identity.reference children via extends -----

    /**
     * Hetero M:N whose junction ({@code PostTag}) declares NO own
     * {@code identity.reference} children — it inherits BOTH from an abstract base
     * ({@code JunctionBase}) via {@code extends}. Under the pre-ADR-0039 own-only
     * junction-reference iteration, the junction would show ZERO references and the
     * M:N would be wrongly rejected ({@code ERR_INVALID_RELATIONSHIP}) at load and
     * fail to derive its FK direction. The resolving fix (junction.getIdentities()
     * effective, mirroring TS referenceIdentities()) sees the two inherited
     * references, so the model loads cleanly AND derives the FK columns.
     */
    private static final String JUNCTION_REFS_INHERITED =
        "{ \"metadata.root\": { \"package\": \"acme\", \"children\": ["
        + "  { \"object.entity\": { \"name\": \"JunctionBase\", \"@isAbstract\": true, \"children\": ["
        + "    { \"identity.reference\": { \"name\": \"postRef\", \"@fields\": \"postId\", \"@references\": \"Post\" } },"
        + "    { \"identity.reference\": { \"name\": \"tagRef\", \"@fields\": \"tagId\", \"@references\": \"Tag\" } } ] } },"
        + "  { \"object.entity\": { \"name\": \"Post\", \"children\": ["
        + "    { \"field.long\": { \"name\": \"id\" } },"
        + "    { \"relationship.association\": { \"name\": \"tags\", \"@cardinality\": \"many\","
        + "        \"@objectRef\": \"Tag\", \"@through\": \"PostTag\" } },"
        + "    { \"identity.primary\": { \"@fields\": \"id\" } } ] } },"
        + "  { \"object.entity\": { \"name\": \"Tag\", \"children\": ["
        + "    { \"field.long\": { \"name\": \"id\" } },"
        + "    { \"identity.primary\": { \"@fields\": \"id\" } } ] } },"
        + "  { \"object.entity\": { \"name\": \"PostTag\", \"extends\": \"JunctionBase\", \"children\": ["
        + "    { \"field.long\": { \"name\": \"id\" } },"
        + "    { \"field.long\": { \"name\": \"postId\" } },"
        + "    { \"field.long\": { \"name\": \"tagId\" } },"
        + "    { \"identity.primary\": { \"@fields\": \"id\" } } ] } }"
        + "] } }";

    @Test
    public void junctionWithInheritedReferencesLoadsCleanly() {
        // ADR-0039: the M:N junction-reference view must RESOLVE — own-only would
        // count 0 references on PostTag and reject the M:N at load.
        loadThrough(JUNCTION_REFS_INHERITED, "junction-inherited-refs.json");
    }

    @Test
    public void junctionWithInheritedReferencesDerivesFkDirection() {
        // ADR-0039: M2MFields.derive + validation both read the junction's EFFECTIVE
        // identity.reference view, so the FK columns are derived from the inherited refs.
        MetaDataLoader loader = loadThrough(JUNCTION_REFS_INHERITED, "junction-inherited-refs.json");
        M2MFields f = M2MFields.derive(rel(loader, "acme::Post", "tags"),
            obj(loader, "acme::Post"), loader.getRoot());
        assertEquals("postId", f.getSourceField());
        assertEquals("tagId", f.getTargetField());
    }

    // --- 5. ADR-0041 — FQN references resolve EXACTLY, never a bare-tail fallback -------
    //
    // These gate the M:N derivation-path FQN-discard bug (the shared cross-port
    // xpkg-m2n-collision conformance fixture LOADS + round-trips the same model, but
    // the canonical serializer only preserves the declared @objectRef/@through strings —
    // it does NOT surface M2MFields.derive's result — so the collision cannot be
    // distinguished at the conformance layer; these unit tests ARE the derive gate).

    private MetaDataLoader loadTwo(String a, String aId, String b, String bId) {
        MetaDataLoader loader = newTestLoader();
        loader.load(List.of(new InMemoryStringSource(a, aId), new InMemoryStringSource(b, bId)));
        return loader;
    }

    /** Root object whose FULL package-qualified name matches (never a bare-tail match). */
    private static MetaObject objExact(MetaDataLoader loader, String fqn) {
        for (MetaObject mo : loader.getRoot().getChildren(MetaObject.class, false)) {
            if (fqn.equals(mo.getName())) return mo;
        }
        throw new IllegalStateException("no object " + fqn);
    }

    private static MetaRelationship relOf(MetaObject obj, String relName) {
        for (MetaRelationship r : obj.getRelationships()) {
            if (relName.equals(r.getShortName())) return r;
        }
        throw new IllegalStateException("no relationship " + relName + " on " + obj.getName());
    }

    /** Decoy package: an unrelated {@code Account} + {@code AccountLink} sharing the bare
     *  names used by the real M:N in {@link #STORE_PKG}. Loaded FIRST so a bare-tail match
     *  would bind THIS package. */
    private static final String PARTNER_PKG =
        "{ \"metadata.root\": { \"package\": \"xpkg::partner\", \"children\": ["
        + "  { \"object.entity\": { \"name\": \"Account\", \"children\": ["
        + "    { \"field.long\": { \"name\": \"id\" } },"
        + "    { \"identity.primary\": { \"@fields\": \"id\" } } ] } },"
        + "  { \"object.entity\": { \"name\": \"AccountLink\", \"children\": ["
        + "    { \"field.long\": { \"name\": \"id\" } },"
        + "    { \"field.long\": { \"name\": \"aId\" } },"
        + "    { \"field.long\": { \"name\": \"bId\" } },"
        + "    { \"identity.primary\": { \"@fields\": \"id\" } },"
        + "    { \"identity.reference\": { \"name\": \"aRef\", \"@fields\": \"aId\", \"@references\": \"xpkg::partner::Account\" } },"
        + "    { \"identity.reference\": { \"name\": \"bRef\", \"@fields\": \"bId\", \"@references\": \"xpkg::partner::Account\" } } ] } }"
        + "] } }";

    /** Real M:N: store::Account --partners--> partner::Account (a DIFFERENT entity that shares
     *  the bare name "Account") through store::AccountLink (whose bare name also collides). */
    private static final String STORE_PKG =
        "{ \"metadata.root\": { \"package\": \"xpkg::store\", \"children\": ["
        + "  { \"object.entity\": { \"name\": \"Account\", \"children\": ["
        + "    { \"field.long\": { \"name\": \"id\" } },"
        + "    { \"relationship.association\": { \"name\": \"partners\", \"@cardinality\": \"many\","
        + "        \"@objectRef\": \"xpkg::partner::Account\", \"@through\": \"xpkg::store::AccountLink\" } },"
        + "    { \"identity.primary\": { \"@fields\": \"id\" } } ] } },"
        + "  { \"object.entity\": { \"name\": \"AccountLink\", \"children\": ["
        + "    { \"field.long\": { \"name\": \"id\" } },"
        + "    { \"field.long\": { \"name\": \"ownerId\" } },"
        + "    { \"field.long\": { \"name\": \"partnerId\" } },"
        + "    { \"identity.primary\": { \"@fields\": \"id\" } },"
        + "    { \"identity.reference\": { \"name\": \"ownerRef\", \"@fields\": \"ownerId\", \"@references\": \"xpkg::store::Account\" } },"
        + "    { \"identity.reference\": { \"name\": \"partnerRef\", \"@fields\": \"partnerId\", \"@references\": \"xpkg::partner::Account\" } } ] } }"
        + "] } }";

    // CROSS-PORT NOTE: Java is the only port whose derive() resolves @objectRef and the
    // junction references to OBJECTS and compares FQN identity. TS, C# and Python compare
    // stripped short names, so the shape below — a cross-package hetero target whose bare
    // name collides with the subject's — misreads as an ambiguous self-join there. That
    // divergence is now PINNED on all three (relationship-m2m.test.ts,
    // M2MInheritedDeclaringEntityTests.cs, test_derive_m2m_declaring_entity.py, each
    // named "ADR-0041 GAP"), so adopting FQN-exactness elsewhere fails those tests loudly
    // instead of silently changing behaviour. This test is the correct-behaviour side.
    @Test
    public void deriveCrossPackageHeteroBindsCorrectPackage() {
        // ADR-0041: same-bare-name entities/junctions in different packages. Under the
        // pre-fix bare-tail resolution, findObject binds the WRONG junction
        // (partner::AccountLink, loaded first) AND stripPackage("...::Account")=="Account"
        // mis-reads the cross-package hetero M:N as a self-join → throws "ambiguous". The
        // FQN-exact fix binds store::AccountLink and derives ownerId/partnerId.
        MetaDataLoader loader = loadTwo(PARTNER_PKG, "partner.json", STORE_PKG, "store.json");
        MetaObject storeAccount = objExact(loader, "xpkg::store::Account");
        M2MFields f = M2MFields.derive(relOf(storeAccount, "partners"), storeAccount, loader.getRoot());
        assertEquals("ownerId", f.getSourceField());
        assertEquals("partnerId", f.getTargetField());
    }

    /** Decoy package whose junction bare name "PostTag" collides but carries DIFFERENT
     *  FK field names — so binding it (vs the real blog::PostTag) is observable. */
    private static final String ARCHIVE_PKG =
        "{ \"metadata.root\": { \"package\": \"xpkg::archive\", \"children\": ["
        + "  { \"object.entity\": { \"name\": \"Post\", \"children\": ["
        + "    { \"field.long\": { \"name\": \"id\" } }, { \"identity.primary\": { \"@fields\": \"id\" } } ] } },"
        + "  { \"object.entity\": { \"name\": \"Tag\", \"children\": ["
        + "    { \"field.long\": { \"name\": \"id\" } }, { \"identity.primary\": { \"@fields\": \"id\" } } ] } },"
        + "  { \"object.entity\": { \"name\": \"PostTag\", \"children\": ["
        + "    { \"field.long\": { \"name\": \"id\" } },"
        + "    { \"field.long\": { \"name\": \"archivedPostId\" } },"
        + "    { \"field.long\": { \"name\": \"archivedTagId\" } },"
        + "    { \"identity.primary\": { \"@fields\": \"id\" } },"
        + "    { \"identity.reference\": { \"name\": \"pRef\", \"@fields\": \"archivedPostId\", \"@references\": \"xpkg::archive::Post\" } },"
        + "    { \"identity.reference\": { \"name\": \"tRef\", \"@fields\": \"archivedTagId\", \"@references\": \"xpkg::archive::Tag\" } } ] } }"
        + "] } }";

    /** Real M:N: blog::Post --tags--> blog::Tag through blog::PostTag, FQN @through. */
    private static final String BLOG_PKG =
        "{ \"metadata.root\": { \"package\": \"xpkg::blog\", \"children\": ["
        + "  { \"object.entity\": { \"name\": \"Post\", \"children\": ["
        + "    { \"field.long\": { \"name\": \"id\" } },"
        + "    { \"relationship.association\": { \"name\": \"tags\", \"@cardinality\": \"many\","
        + "        \"@objectRef\": \"xpkg::blog::Tag\", \"@through\": \"xpkg::blog::PostTag\" } },"
        + "    { \"identity.primary\": { \"@fields\": \"id\" } } ] } },"
        + "  { \"object.entity\": { \"name\": \"Tag\", \"children\": ["
        + "    { \"field.long\": { \"name\": \"id\" } }, { \"identity.primary\": { \"@fields\": \"id\" } } ] } },"
        + "  { \"object.entity\": { \"name\": \"PostTag\", \"children\": ["
        + "    { \"field.long\": { \"name\": \"id\" } },"
        + "    { \"field.long\": { \"name\": \"postId\" } },"
        + "    { \"field.long\": { \"name\": \"tagId\" } },"
        + "    { \"identity.primary\": { \"@fields\": \"id\" } },"
        + "    { \"identity.reference\": { \"name\": \"postRef\", \"@fields\": \"postId\", \"@references\": \"xpkg::blog::Post\" } },"
        + "    { \"identity.reference\": { \"name\": \"tagRef\", \"@fields\": \"tagId\", \"@references\": \"xpkg::blog::Tag\" } } ] } }"
        + "] } }";

    @Test
    public void deriveCrossPackageJunctionCollisionBindsCorrectPackage() {
        // ADR-0041: the @through junction bare name "PostTag" collides with an unrelated
        // xpkg::archive::PostTag (loaded FIRST, DIFFERENT FK field names). A bare-tail match
        // binds the decoy and derives archivedPostId/archivedTagId; FQN-exact resolution
        // binds xpkg::blog::PostTag and derives postId/tagId.
        MetaDataLoader loader = loadTwo(ARCHIVE_PKG, "archive.json", BLOG_PKG, "blog.json");
        MetaObject blogPost = objExact(loader, "xpkg::blog::Post");
        M2MFields f = M2MFields.derive(relOf(blogPost, "tags"), blogPost, loader.getRoot());
        assertEquals("postId", f.getSourceField());
        assertEquals("tagId", f.getTargetField());
    }

    // --- 6. Declaring entity vs. visiting entity (the #368 follow-up) ------------------
    //
    // Same confusion as the #368 loader passes, one layer down: derive() classified the
    // self-join, and matched the hetero junction reference, against the `source` entity
    // its CALLER passed. Every caller walks the RESOLVING getRelationships()
    // (SpringM2mSupport, KotlinM2mSupport, omdb's M2MResolver) and passes the entity it
    // is iterating — so for a relationship inherited via `extends` that is the
    // INHERITING entity, not the one that declared it.
    //
    // Unlike the loader passes there is no once-per-node `checked` set here, so the
    // defect is NOT gated on visit order — it is wrong for every inheriting entity in
    // any order. The fixtures still declare the child BEFORE the base and pin the root
    // visit order, matching the #368 convention.

    /** Node extends NodeBase, which declares a @symmetric self-join onto ITSELF. Node
     *  is declared FIRST so the root's child order is child-before-base. */
    private static final String INHERITED_SELF_JOIN =
        "{ \"metadata.root\": { \"package\": \"acme\", \"children\": ["
        + "  { \"object.entity\": { \"name\": \"Node\", \"extends\": \"NodeBase\", \"children\": ["
        + "    { \"field.long\": { \"name\": \"id\" } },"
        + "    { \"identity.primary\": { \"@fields\": \"id\" } } ] } },"
        + "  { \"object.entity\": { \"name\": \"NodeBase\", \"@isAbstract\": true, \"children\": ["
        + "    { \"relationship.association\": { \"name\": \"peers\", \"@cardinality\": \"many\","
        + "        \"@objectRef\": \"NodeBase\", \"@through\": \"NodeLink\", \"@symmetric\": true } } ] } },"
        + "  { \"object.entity\": { \"name\": \"NodeLink\", \"children\": ["
        + "    { \"field.long\": { \"name\": \"id\" } },"
        + "    { \"field.long\": { \"name\": \"aId\" } },"
        + "    { \"field.long\": { \"name\": \"bId\" } },"
        + "    { \"identity.primary\": { \"@fields\": \"id\" } },"
        + "    { \"identity.reference\": { \"name\": \"aRef\", \"@fields\": \"aId\", \"@references\": \"NodeBase\" } },"
        + "    { \"identity.reference\": { \"name\": \"bRef\", \"@fields\": \"bId\", \"@references\": \"NodeBase\" } } ] } }"
        + "] } }";

    /** Article extends ArticleBase, which declares a HETERO M:N whose junction references
     *  the BASE — so a match against the visiting child finds nothing. */
    private static final String INHERITED_HETERO =
        "{ \"metadata.root\": { \"package\": \"acme\", \"children\": ["
        + "  { \"object.entity\": { \"name\": \"Article\", \"extends\": \"ArticleBase\", \"children\": ["
        + "    { \"field.long\": { \"name\": \"id\" } },"
        + "    { \"identity.primary\": { \"@fields\": \"id\" } } ] } },"
        + "  { \"object.entity\": { \"name\": \"ArticleBase\", \"@isAbstract\": true, \"children\": ["
        + "    { \"relationship.association\": { \"name\": \"tags\", \"@cardinality\": \"many\","
        + "        \"@objectRef\": \"Tag\", \"@through\": \"ArticleTag\" } } ] } },"
        + "  { \"object.entity\": { \"name\": \"Tag\", \"children\": ["
        + "    { \"field.long\": { \"name\": \"id\" } },"
        + "    { \"identity.primary\": { \"@fields\": \"id\" } } ] } },"
        + "  { \"object.entity\": { \"name\": \"ArticleTag\", \"children\": ["
        + "    { \"field.long\": { \"name\": \"id\" } },"
        + "    { \"field.long\": { \"name\": \"articleId\" } },"
        + "    { \"field.long\": { \"name\": \"tagId\" } },"
        + "    { \"identity.primary\": { \"@fields\": \"id\" } },"
        + "    { \"identity.reference\": { \"name\": \"aRef\", \"@fields\": \"articleId\", \"@references\": \"ArticleBase\" } },"
        + "    { \"identity.reference\": { \"name\": \"tRef\", \"@fields\": \"tagId\", \"@references\": \"Tag\" } } ] } }"
        + "] } }";

    /** Root-level object order, so a test's child-before-base premise fails loudly if
     *  the loader ever stops preserving declaration order. */
    private static List<String> objectOrder(MetaDataLoader loader) {
        List<String> out = new java.util.ArrayList<>();
        for (MetaObject mo : loader.getRoot().getChildren(MetaObject.class, false)) out.add(mo.getName());
        return out;
    }

    /** The OTHER legitimate shape, and the common one: the base is abstract (no table),
     *  so the junction FK references the CONCRETE child. Both names of the subject must
     *  be accepted, or fixing the base-referencing shape breaks this one. */
    private static final String INHERITED_HETERO_CONCRETE_REF =
        "{ \"metadata.root\": { \"package\": \"acme\", \"children\": ["
        + "  { \"object.entity\": { \"name\": \"Post\", \"extends\": \"PostBase\", \"children\": ["
        + "    { \"field.long\": { \"name\": \"id\" } },"
        + "    { \"identity.primary\": { \"@fields\": \"id\" } } ] } },"
        + "  { \"object.entity\": { \"name\": \"PostBase\", \"@isAbstract\": true, \"children\": ["
        + "    { \"relationship.association\": { \"name\": \"tags\", \"@cardinality\": \"many\","
        + "        \"@objectRef\": \"Tag\", \"@through\": \"PostTag\" } } ] } },"
        + "  { \"object.entity\": { \"name\": \"Tag\", \"children\": ["
        + "    { \"field.long\": { \"name\": \"id\" } },"
        + "    { \"identity.primary\": { \"@fields\": \"id\" } } ] } },"
        + "  { \"object.entity\": { \"name\": \"PostTag\", \"children\": ["
        + "    { \"field.long\": { \"name\": \"id\" } },"
        + "    { \"field.long\": { \"name\": \"postId\" } },"
        + "    { \"field.long\": { \"name\": \"tagId\" } },"
        + "    { \"identity.primary\": { \"@fields\": \"id\" } },"
        + "    { \"identity.reference\": { \"name\": \"pRef\", \"@fields\": \"postId\", \"@references\": \"Post\" } },"
        + "    { \"identity.reference\": { \"name\": \"tRef\", \"@fields\": \"tagId\", \"@references\": \"Tag\" } } ] } }"
        + "] } }";

    @Test
    public void deriveInheritedHeteroWithConcreteJunctionReference() {
        MetaDataLoader loader = loadThrough(INHERITED_HETERO_CONCRETE_REF, "inherited-hetero-concrete.json");
        MetaObject post = objExact(loader, "acme::Post");
        MetaRelationship rel = relOf(post, "tags");
        assertEquals("acme::PostBase", ((MetaObject) rel.getParent()).getName());
        M2MFields f = M2MFields.derive(rel, post, loader.getRoot());
        assertEquals("postId", f.getSourceField());
        assertEquals("tagId", f.getTargetField());
    }

    @Test
    public void deriveInheritedSelfJoinUsesDeclaringEntity() {
        MetaDataLoader loader = loadThrough(INHERITED_SELF_JOIN, "inherited-self-join.json");
        assertEquals(List.of("acme::Node", "acme::NodeBase", "acme::NodeLink"), objectOrder(loader));
        MetaObject node = objExact(loader, "acme::Node");
        MetaRelationship rel = relOf(node, "peers");
        // The relationship is INHERITED: it is not one of Node's own children.
        assertTrue(node.getRelationships(false).isEmpty());
        assertEquals("acme::NodeBase", ((MetaObject) rel.getParent()).getName());
        // Pre-fix: @objectRef "NodeBase" vs the visiting "acme::Node" => not a self-join
        // => hetero branch => no junction reference to Node => M2MDerivationException.
        M2MFields f = M2MFields.derive(rel, node, loader.getRoot());
        assertEquals("aId", f.getSourceField());
        assertEquals("bId", f.getTargetField());
        // The declaring entity itself must agree — same node, same answer.
        MetaObject base = objExact(loader, "acme::NodeBase");
        M2MFields viaBase = M2MFields.derive(rel, base, loader.getRoot());
        assertEquals(f.getSourceField(), viaBase.getSourceField());
        assertEquals(f.getTargetField(), viaBase.getTargetField());
    }

    @Test
    public void deriveInheritedHeteroMatchesDeclaringEntityReference() {
        MetaDataLoader loader = loadThrough(INHERITED_HETERO, "inherited-hetero.json");
        assertEquals(List.of("acme::Article", "acme::ArticleBase", "acme::Tag", "acme::ArticleTag"),
            objectOrder(loader));
        MetaObject article = objExact(loader, "acme::Article");
        M2MFields f = M2MFields.derive(relOf(article, "tags"), article, loader.getRoot());
        assertEquals("articleId", f.getSourceField());
        assertEquals("tagId", f.getTargetField());
    }
}

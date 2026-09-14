package com.metaobjects.relationship;

import com.metaobjects.MetaData;
import com.metaobjects.identity.ReferenceIdentity;
import com.metaobjects.loader.InMemoryStringSource;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.object.MetaObject;
import com.metaobjects.registry.SharedRegistryTestBase;
import org.junit.Test;

import java.util.List;

import static org.junit.Assert.*;

/**
 * Issue #368 — direct unit tests for the reference-resolution ladder
 * ({@link RelationshipReferences}).
 *
 * <p>Java port of the TS reference suite
 * ({@code server/typescript/packages/metadata/test/resolve-relationship-reference.test.ts})
 * and its Python/C# ports — exercises {@link RelationshipReferences#referenceCandidatesFor}
 * / {@link RelationshipReferences#resolveRelationshipReference} directly against a loaded
 * model, rather than only through the loader's error output (see
 * {@link Issue368RelationshipReferenceValidationTest} for the loader-integration tests
 * covering rule (d) / rule (e)).</p>
 */
public class Issue368RelationshipReferenceLadderTest extends SharedRegistryTestBase {

    private MetaDataLoader newTestLoader() {
        return createTestLoader("Issue368RelationshipReferenceLadderTest", java.util.Collections.emptyList());
    }

    private MetaDataLoader loadClean(String json, String id) {
        MetaDataLoader loader = newTestLoader();
        loader.load(List.of(new InMemoryStringSource(json, id)));
        return loader;
    }

    private static final String MATCH_MODEL =
        "{ \"metadata.root\": { \"package\": \"repro\", \"children\": ["
        + "  { \"object.entity\": { \"name\": \"Team\", \"children\": ["
        + "    { \"field.long\": { \"name\": \"id\" } },"
        + "    { \"identity.primary\": { \"name\": \"id\", \"@fields\": \"id\" } } ] } },"
        + "  { \"object.entity\": { \"name\": \"Match\", \"children\": ["
        + "    { \"field.long\": { \"name\": \"id\" } },"
        + "    { \"field.long\": { \"name\": \"homeTeamId\" } },"
        + "    { \"field.long\": { \"name\": \"awayTeamId\" } },"
        + "    { \"identity.primary\": { \"name\": \"id\", \"@fields\": \"id\" } },"
        + "    { \"identity.reference\": { \"name\": \"homeTeamRef\", \"@fields\": \"homeTeamId\", \"@references\": \"Team\" } },"
        + "    { \"relationship.association\": { \"name\": \"homeTeam\", \"@objectRef\": \"Team\", \"@cardinality\": \"one\" } },"
        + "    { \"identity.reference\": { \"name\": \"awayTeamRef\", \"@fields\": \"awayTeamId\", \"@references\": \"Team\" } },"
        + "    { \"relationship.association\": { \"name\": \"awayTeam\", \"@objectRef\": \"Team\", \"@cardinality\": \"one\" } } ] } }"
        + "] } }";

    private MetaObject loadMatch() {
        MetaDataLoader loader = loadClean(MATCH_MODEL, "match.json");
        assertTrue(loader.getErrors().isEmpty());
        return (MetaObject) loader.getRoot().getChildOfType("object", "repro::Match");
    }

    @Test
    public void enumeratesEveryCandidateReferenceForTheTarget() {
        List<ReferenceIdentity> candidates = RelationshipReferences.referenceCandidatesFor(loadMatch(), "Team");
        assertEquals(2, candidates.size());
        assertEquals("homeTeamRef", candidates.get(0).getShortName());
        assertEquals("awayTeamRef", candidates.get(1).getShortName());
    }

    @Test
    public void namePairingResolvesEachAssociationToItsOwnReference() {
        MetaObject match = loadMatch();
        assertEquals("homeTeamRef",
            RelationshipReferences.resolveRelationshipReference(match, "homeTeam", "Team").getShortName());
        assertEquals("awayTeamRef",
            RelationshipReferences.resolveRelationshipReference(match, "awayTeam", "Team").getShortName());
    }

    @Test
    public void sourceRefFieldWinsOverNamePairing() {
        MetaObject match = loadMatch();
        assertEquals("awayTeamRef",
            RelationshipReferences.resolveRelationshipReference(match, "homeTeam", "Team", "awayTeamId")
                .getShortName());
    }

    @Test
    public void sourceRefFieldMissShortCircuitsRatherThanFallingThroughToNamePairing() {
        // #368 ladder step 2: a declared @sourceRefField that matches NOTHING must
        // return null -- it must NOT fall through to step 3 (name-pairing), even
        // though "homeTeam" would otherwise pair cleanly with "homeTeamRef".
        MetaObject match = loadMatch();
        assertNull(RelationshipReferences.resolveRelationshipReference(match, "homeTeam", "Team", "doesNotExist"));
    }

    @Test
    public void aSingleCandidateResolvesRegardlessOfName() {
        String doc =
            "{ \"metadata.root\": { \"package\": \"repro\", \"children\": ["
            + "  { \"object.entity\": { \"name\": \"Team\", \"children\": ["
            + "    { \"field.long\": { \"name\": \"id\" } },"
            + "    { \"identity.primary\": { \"name\": \"id\", \"@fields\": \"id\" } } ] } },"
            + "  { \"object.entity\": { \"name\": \"Match\", \"children\": ["
            + "    { \"field.long\": { \"name\": \"id\" } },"
            + "    { \"field.long\": { \"name\": \"winnerFk\" } },"
            + "    { \"identity.primary\": { \"name\": \"id\", \"@fields\": \"id\" } },"
            + "    { \"identity.reference\": { \"name\": \"anythingAtAll\", \"@fields\": \"winnerFk\", \"@references\": \"Team\" } },"
            + "    { \"relationship.association\": { \"name\": \"champion\", \"@objectRef\": \"Team\", \"@cardinality\": \"one\" } } ] } }"
            + "] } }";
        MetaDataLoader loader = loadClean(doc, "single-candidate.json");
        assertTrue(loader.getErrors().isEmpty());
        MetaObject match = (MetaObject) loader.getRoot().getChildOfType("object", "repro::Match");
        assertEquals("anythingAtAll",
            RelationshipReferences.resolveRelationshipReference(match, "champion", "Team").getShortName());
    }

    @Test
    public void unpairableNamesReturnNullRatherThanGuessing() {
        // #368 rule (e) flags this fixture as a load error -- it's the exact
        // ambiguity the ladder returning null exists to surface. The loader throws;
        // catch it and assert the ladder's return value directly against the
        // already-loaded (partially-validated) root.
        String doc =
            "{ \"metadata.root\": { \"package\": \"repro\", \"children\": ["
            + "  { \"object.entity\": { \"name\": \"Team\", \"children\": ["
            + "    { \"field.long\": { \"name\": \"id\" } },"
            + "    { \"identity.primary\": { \"name\": \"id\", \"@fields\": \"id\" } } ] } },"
            + "  { \"object.entity\": { \"name\": \"Match\", \"children\": ["
            + "    { \"field.long\": { \"name\": \"id\" } },"
            + "    { \"field.long\": { \"name\": \"alphaFk\" } },"
            + "    { \"field.long\": { \"name\": \"betaFk\" } },"
            + "    { \"identity.primary\": { \"name\": \"id\", \"@fields\": \"id\" } },"
            + "    { \"identity.reference\": { \"name\": \"alphaRef\", \"@fields\": \"alphaFk\", \"@references\": \"Team\" } },"
            + "    { \"identity.reference\": { \"name\": \"betaRef\", \"@fields\": \"betaFk\", \"@references\": \"Team\" } },"
            + "    { \"relationship.association\": { \"name\": \"winner\", \"@objectRef\": \"Team\", \"@cardinality\": \"one\" } } ] } }"
            + "] } }";
        MetaDataLoader loader = newTestLoader();
        try {
            loader.load(List.of(new InMemoryStringSource(doc, "unpairable.json")));
            fail("Expected the load to fail with an ambiguity error");
        } catch (com.metaobjects.MetaDataException expected) {
            // expected -- rule (e) rejects this model
        }
        MetaObject match = (MetaObject) loader.getRoot().getChildOfType("object", "repro::Match");
        assertNull(RelationshipReferences.resolveRelationshipReference(match, "winner", "Team"));
    }

    @Test
    public void suffixStrippingNeverAppliesToTheRelationshipName() {
        // "valid" must NOT be stripped to "val" and pair with valRef.
        String doc =
            "{ \"metadata.root\": { \"package\": \"repro\", \"children\": ["
            + "  { \"object.entity\": { \"name\": \"Team\", \"children\": ["
            + "    { \"field.long\": { \"name\": \"id\" } },"
            + "    { \"identity.primary\": { \"name\": \"id\", \"@fields\": \"id\" } } ] } },"
            + "  { \"object.entity\": { \"name\": \"Match\", \"children\": ["
            + "    { \"field.long\": { \"name\": \"id\" } },"
            + "    { \"field.long\": { \"name\": \"valFk\" } },"
            + "    { \"field.long\": { \"name\": \"otherFk\" } },"
            + "    { \"identity.primary\": { \"name\": \"id\", \"@fields\": \"id\" } },"
            + "    { \"identity.reference\": { \"name\": \"valRef\", \"@fields\": \"valFk\", \"@references\": \"Team\" } },"
            + "    { \"identity.reference\": { \"name\": \"otherRef\", \"@fields\": \"otherFk\", \"@references\": \"Team\" } },"
            + "    { \"relationship.association\": { \"name\": \"valid\", \"@objectRef\": \"Team\", \"@cardinality\": \"one\" } } ] } }"
            + "] } }";
        MetaDataLoader loader = newTestLoader();
        try {
            loader.load(List.of(new InMemoryStringSource(doc, "valid-valref.json")));
            fail("Expected the load to fail with an ambiguity error");
        } catch (com.metaobjects.MetaDataException expected) {
            // expected -- "valid" must not pair with "valRef"
        }
        MetaObject match = (MetaObject) loader.getRoot().getChildOfType("object", "repro::Match");
        assertNull(RelationshipReferences.resolveRelationshipReference(match, "valid", "Team"));
    }
}

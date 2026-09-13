package com.metaobjects.relationship;

import com.metaobjects.ErrorCode;
import com.metaobjects.MetaDataException;
import com.metaobjects.loader.InMemoryStringSource;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.loader.MetaDataSource;
import com.metaobjects.registry.SharedRegistryTestBase;
import org.junit.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.Assert.*;

/**
 * Issue #368 — loader validation for relationship.* M:N slim vocabulary + the
 * 1:N reference-disambiguation rules (the resolution ladder in
 * {@link RelationshipReferences}).
 *
 * <p>Java port of the TS reference suite ({@code relationship-m2m.test.ts}) and its
 * Python/C# ports, covering the #368 additions:</p>
 * <ul>
 *   <li>(B) {@code @sourceRefField} becomes legal on {@code @cardinality: "one"}
 *       (previously rejected on any non-M:N relationship).</li>
 *   <li>(C) Rule (e) — a {@code @cardinality: one} relationship must resolve to
 *       exactly one identity.reference candidate; ambiguity is a load error.</li>
 *   <li>(D) Both rule (d) (the M:N slim-vocabulary pass) and rule (e) iterate the
 *       EFFECTIVE relationship set (own + inherited via extends), not just
 *       own-declared relationships — with rule (d) deduping on the relationship
 *       node's identity (an inherited, unmodified relationship must not be
 *       reported once per inheriting entity).</li>
 * </ul>
 *
 * <p>Also regression-covers two latent "obj vs. declaring entity" bugs (present in
 * TS, Python and C# before their own #368 fixes): ADR-0042 package resolution for a
 * bare {@code @through} must use the DECLARING entity's package, and rule (a)'s
 * self-join comparison must use the DECLARING entity, not whichever entity's
 * effective view reached the inherited relationship first.</p>
 *
 * <p>See {@code server/typescript/packages/metadata/src/core/relationship/
 * resolve-relationship-reference.ts} and {@code .../src/loader/validation-passes.ts}
 * ({@code validateRelationships} / {@code validateOneSideReferenceResolution}) for
 * the authoritative spec these tests mirror.</p>
 */
public class Issue368RelationshipReferenceValidationTest extends SharedRegistryTestBase {

    private MetaDataLoader newTestLoader() {
        return createTestLoader("Issue368RelationshipReferenceValidationTest", java.util.Collections.emptyList());
    }

    /** Outcome of a load attempt: every error the loader saw, whether recorded via
     *  {@code getErrors()} (all-but-last) or thrown (the last one) — mirrors the C#
     *  {@code LoadResult.Errors} single collection so assertions read the same way. */
    private static final class Outcome {
        final MetaDataLoader loader;
        final MetaDataException thrown;

        Outcome(MetaDataLoader loader, MetaDataException thrown) {
            this.loader = loader;
            this.thrown = thrown;
        }

        List<MetaDataException> allErrors() {
            List<MetaDataException> all = new ArrayList<>(loader.getErrors());
            if (thrown != null) all.add(thrown);
            return all;
        }

        String joinedMessages() {
            StringBuilder sb = new StringBuilder();
            for (MetaDataException e : allErrors()) {
                if (sb.length() > 0) sb.append('\n');
                sb.append(e.getMessage());
            }
            return sb.toString();
        }
    }

    private Outcome attemptLoad(String... jsons) {
        MetaDataLoader loader = newTestLoader();
        List<MetaDataSource> sources = new ArrayList<>();
        for (int i = 0; i < jsons.length; i++) {
            sources.add(new InMemoryStringSource(jsons[i], "inline-" + i + ".json"));
        }
        try {
            loader.load(sources);
            return new Outcome(loader, null);
        } catch (MetaDataException e) {
            return new Outcome(loader, e);
        }
    }

    private void assertLoadsClean(String... jsons) {
        Outcome outcome = attemptLoad(jsons);
        if (outcome.thrown != null || !outcome.loader.getErrors().isEmpty()) {
            fail("Expected a clean load; got: " + outcome.joinedMessages());
        }
    }

    private void assertHasError(Outcome outcome, ErrorCode expected) {
        boolean found = outcome.allErrors().stream()
            .anyMatch(e -> e.getCode().map(c -> c == expected).orElse(false));
        assertTrue("Expected an error with code " + expected + "; got: " + outcome.joinedMessages(), found);
    }

    private void assertNoErrorOfCode(Outcome outcome, ErrorCode code) {
        boolean found = outcome.allErrors().stream()
            .anyMatch(e -> e.getCode().map(c -> c == code).orElse(false));
        assertFalse("Did not expect any " + code + "; got: " + outcome.joinedMessages(), found);
    }

    // -------------------------------------------------------------------------
    // (B) @sourceRefField becomes legal on @cardinality: "one"
    // -------------------------------------------------------------------------

    @Test
    public void sourceRefFieldOnCardinalityOneLoadsClean() {
        // The issue #368 repro: two 1:N relationships, each disambiguated by
        // @sourceRefField, load with no errors.
        String doc =
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
            + "    { \"identity.reference\": { \"name\": \"awayTeamRef\", \"@fields\": \"awayTeamId\", \"@references\": \"Team\" } },"
            + "    { \"relationship.association\": { \"name\": \"homeTeam\", \"@objectRef\": \"Team\", \"@cardinality\": \"one\", \"@sourceRefField\": \"homeTeamId\" } },"
            + "    { \"relationship.association\": { \"name\": \"awayTeam\", \"@objectRef\": \"Team\", \"@cardinality\": \"one\", \"@sourceRefField\": \"awayTeamId\" } } ] } }"
            + "] } }";
        assertLoadsClean(doc);
    }

    @Test
    public void sourceRefFieldOnManyWithoutThroughStillErrors() {
        // @sourceRefField on @cardinality: many with no @through is still not
        // M:N -- the widening only spares @cardinality: one.
        String doc =
            "{ \"metadata.root\": { \"package\": \"repro\", \"children\": ["
            + "  { \"object.entity\": { \"name\": \"Team\", \"children\": ["
            + "    { \"field.long\": { \"name\": \"id\" } },"
            + "    { \"identity.primary\": { \"name\": \"id\", \"@fields\": \"id\" } } ] } },"
            + "  { \"object.entity\": { \"name\": \"Match\", \"children\": ["
            + "    { \"field.long\": { \"name\": \"id\" } },"
            + "    { \"identity.primary\": { \"name\": \"id\", \"@fields\": \"id\" } },"
            + "    { \"relationship.association\": { \"name\": \"teams\", \"@objectRef\": \"Team\", \"@cardinality\": \"many\", \"@sourceRefField\": \"whatever\" } } ] } }"
            + "] } }";
        assertHasError(attemptLoad(doc), ErrorCode.ERR_INVALID_RELATIONSHIP);
    }

    @Test
    public void throughOnCardinalityOneStillErrors() {
        // @through still requires @cardinality: many -- only @sourceRefField was widened.
        String doc =
            "{ \"metadata.root\": { \"package\": \"acme\", \"children\": ["
            + "  { \"object.entity\": { \"name\": \"Week\", \"children\": ["
            + "    { \"field.long\": { \"name\": \"id\" } },"
            + "    { \"identity.primary\": { \"name\": \"id\", \"@fields\": \"id\" } },"
            + "    { \"relationship.composition\": { \"name\": \"program\", \"@objectRef\": \"Program\", \"@cardinality\": \"one\", \"@through\": \"X\" } } ] } },"
            + "  { \"object.entity\": { \"name\": \"Program\", \"children\": ["
            + "    { \"field.long\": { \"name\": \"id\" } },"
            + "    { \"identity.primary\": { \"name\": \"id\", \"@fields\": \"id\" } } ] } }"
            + "] } }";
        assertHasError(attemptLoad(doc), ErrorCode.ERR_INVALID_RELATIONSHIP);
    }

    @Test
    public void symmetricOnCardinalityOneStillErrors() {
        // @symmetric still requires M:N -- only @sourceRefField was widened.
        String doc =
            "{ \"metadata.root\": { \"package\": \"acme\", \"children\": ["
            + "  { \"object.entity\": { \"name\": \"Week\", \"children\": ["
            + "    { \"field.long\": { \"name\": \"id\" } },"
            + "    { \"identity.primary\": { \"name\": \"id\", \"@fields\": \"id\" } },"
            + "    { \"relationship.association\": { \"name\": \"program\", \"@objectRef\": \"Program\", \"@symmetric\": true } } ] } },"
            + "  { \"object.entity\": { \"name\": \"Program\", \"children\": ["
            + "    { \"field.long\": { \"name\": \"id\" } },"
            + "    { \"identity.primary\": { \"name\": \"id\", \"@fields\": \"id\" } } ] } }"
            + "] } }";
        assertHasError(attemptLoad(doc), ErrorCode.ERR_INVALID_RELATIONSHIP);
    }

    // -------------------------------------------------------------------------
    // (A) The resolution ladder, exercised end-to-end through the loader.
    // -------------------------------------------------------------------------

    @Test
    public void issueReproLoadsCleanViaNamePairing() {
        // Two references onto the same target, no @sourceRefField -- resolved by
        // name-pairing (homeTeamRef <-> homeTeam, awayTeamRef <-> awayTeam).
        String doc =
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
        assertLoadsClean(doc);
    }

    @Test
    public void unpairableNamesErrorNamingBothCandidates() {
        // Two references whose names don't pair with the relationship name --
        // ambiguous, and the error names both candidates as name(fkField).
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
        Outcome outcome = attemptLoad(doc);
        assertHasError(outcome, ErrorCode.ERR_INVALID_RELATIONSHIP);
        String joined = outcome.joinedMessages();
        assertTrue(joined, joined.contains("Match.winner"));
        assertTrue(joined, joined.contains("alphaRef(alphaFk)"));
        assertTrue(joined, joined.contains("betaRef(betaFk)"));
    }

    @Test
    public void declaredButUnmatchedErrorsAtSingleCandidateCount() {
        // A declared @sourceRefField naming nothing must error even with exactly
        // one candidate -- the ladder's step 1 ("exactly one candidate -> that
        // one") must not silently short-circuit past a bad declared value.
        String doc =
            "{ \"metadata.root\": { \"package\": \"repro\", \"children\": ["
            + "  { \"object.entity\": { \"name\": \"Team\", \"children\": ["
            + "    { \"field.long\": { \"name\": \"id\" } },"
            + "    { \"identity.primary\": { \"name\": \"id\", \"@fields\": \"id\" } } ] } },"
            + "  { \"object.entity\": { \"name\": \"Match\", \"children\": ["
            + "    { \"field.long\": { \"name\": \"id\" } },"
            + "    { \"field.long\": { \"name\": \"homeTeamId\" } },"
            + "    { \"identity.primary\": { \"name\": \"id\", \"@fields\": \"id\" } },"
            + "    { \"identity.reference\": { \"name\": \"homeTeamRef\", \"@fields\": \"homeTeamId\", \"@references\": \"Team\" } },"
            + "    { \"relationship.association\": { \"name\": \"awayTeam\", \"@objectRef\": \"Team\", \"@cardinality\": \"one\", \"@sourceRefField\": \"awayTeamId\" } } ] } }"
            + "] } }";
        Outcome outcome = attemptLoad(doc);
        List<MetaDataException> all = outcome.allErrors();
        assertEquals(outcome.joinedMessages(), 1, all.size());
        assertHasError(outcome, ErrorCode.ERR_INVALID_RELATIONSHIP);
        String joined = outcome.joinedMessages();
        assertTrue(joined, joined.contains("Match.awayTeam"));
        assertTrue(joined, joined.contains("\"awayTeamId\""));
    }

    @Test
    public void declaredButUnmatchedErrorsAtZeroCandidateCount() {
        // A declared @sourceRefField naming nothing must also error with ZERO
        // candidates (no identity.reference targets the objectRef at all) -- the
        // declared value is read BEFORE any candidate-count guard.
        String doc =
            "{ \"metadata.root\": { \"package\": \"repro\", \"children\": ["
            + "  { \"object.entity\": { \"name\": \"Team\", \"children\": ["
            + "    { \"field.long\": { \"name\": \"id\" } },"
            + "    { \"identity.primary\": { \"name\": \"id\", \"@fields\": \"id\" } } ] } },"
            + "  { \"object.entity\": { \"name\": \"Match\", \"children\": ["
            + "    { \"field.long\": { \"name\": \"id\" } },"
            + "    { \"identity.primary\": { \"name\": \"id\", \"@fields\": \"id\" } },"
            + "    { \"relationship.association\": { \"name\": \"homeTeam\", \"@objectRef\": \"Team\", \"@cardinality\": \"one\", \"@sourceRefField\": \"homeTeamId\" } } ] } }"
            + "] } }";
        Outcome outcome = attemptLoad(doc);
        List<MetaDataException> all = outcome.allErrors();
        assertEquals(outcome.joinedMessages(), 1, all.size());
        assertHasError(outcome, ErrorCode.ERR_INVALID_RELATIONSHIP);
        String joined = outcome.joinedMessages();
        assertTrue(joined, joined.contains("Match.homeTeam"));
        assertTrue(joined, joined.contains("\"homeTeamId\""));
    }

    @Test
    public void sourceRefFieldCorrectlyNamingSingleCandidateLoadsClean() {
        // Regression: a correctly-declared @sourceRefField over a single
        // candidate stays clean.
        String doc =
            "{ \"metadata.root\": { \"package\": \"repro\", \"children\": ["
            + "  { \"object.entity\": { \"name\": \"Team\", \"children\": ["
            + "    { \"field.long\": { \"name\": \"id\" } },"
            + "    { \"identity.primary\": { \"name\": \"id\", \"@fields\": \"id\" } } ] } },"
            + "  { \"object.entity\": { \"name\": \"Match\", \"children\": ["
            + "    { \"field.long\": { \"name\": \"id\" } },"
            + "    { \"field.long\": { \"name\": \"homeTeamId\" } },"
            + "    { \"identity.primary\": { \"name\": \"id\", \"@fields\": \"id\" } },"
            + "    { \"identity.reference\": { \"name\": \"homeTeamRef\", \"@fields\": \"homeTeamId\", \"@references\": \"Team\" } },"
            + "    { \"relationship.association\": { \"name\": \"homeTeam\", \"@objectRef\": \"Team\", \"@cardinality\": \"one\", \"@sourceRefField\": \"homeTeamId\" } } ] } }"
            + "] } }";
        assertLoadsClean(doc);
    }

    @Test
    public void compositeReferenceCandidatesRenderFullFieldTuple() {
        // Two composite references sharing a first column must still print
        // distinguishably in the candidate list (fields[0] alone would collide).
        String doc =
            "{ \"metadata.root\": { \"package\": \"repro\", \"children\": ["
            + "  { \"object.entity\": { \"name\": \"Team\", \"children\": ["
            + "    { \"field.long\": { \"name\": \"id\" } },"
            + "    { \"identity.primary\": { \"name\": \"id\", \"@fields\": \"id\" } } ] } },"
            + "  { \"object.entity\": { \"name\": \"Match\", \"children\": ["
            + "    { \"field.long\": { \"name\": \"id\" } },"
            + "    { \"field.long\": { \"name\": \"tenantId\" } },"
            + "    { \"field.long\": { \"name\": \"homeTeamId\" } },"
            + "    { \"field.long\": { \"name\": \"awayTeamId\" } },"
            + "    { \"identity.primary\": { \"name\": \"id\", \"@fields\": \"id\" } },"
            + "    { \"identity.reference\": { \"name\": \"aRef\", \"@fields\": [\"tenantId\", \"homeTeamId\"], \"@references\": \"Team\" } },"
            + "    { \"identity.reference\": { \"name\": \"bRef\", \"@fields\": [\"tenantId\", \"awayTeamId\"], \"@references\": \"Team\" } },"
            + "    { \"relationship.association\": { \"name\": \"winner\", \"@objectRef\": \"Team\", \"@cardinality\": \"one\" } } ] } }"
            + "] } }";
        Outcome outcome = attemptLoad(doc);
        assertHasError(outcome, ErrorCode.ERR_INVALID_RELATIONSHIP);
        String joined = outcome.joinedMessages();
        assertTrue(joined, joined.contains("aRef(tenantId, homeTeamId)"));
        assertTrue(joined, joined.contains("bRef(tenantId, awayTeamId)"));
    }

    // -------------------------------------------------------------------------
    // (D) Rule (e) must iterate the EFFECTIVE relationship set.
    // -------------------------------------------------------------------------

    @Test
    public void inheritedRelationshipAmbiguityErrors() {
        // A extends cleanly; B extends A and adds a second reference onto the
        // same target -- the inherited relationship becomes ambiguous on B even
        // though A (and the relationship's own declaration) are untouched.
        String doc =
            "{ \"metadata.root\": { \"package\": \"repro\", \"children\": ["
            + "  { \"object.entity\": { \"name\": \"Team\", \"children\": ["
            + "    { \"field.long\": { \"name\": \"id\" } },"
            + "    { \"identity.primary\": { \"name\": \"id\", \"@fields\": \"id\" } } ] } },"
            + "  { \"object.entity\": { \"name\": \"A\", \"children\": ["
            + "    { \"field.long\": { \"name\": \"id\" } },"
            + "    { \"field.long\": { \"name\": \"homeTeamId\" } },"
            + "    { \"identity.primary\": { \"name\": \"id\", \"@fields\": \"id\" } },"
            + "    { \"identity.reference\": { \"name\": \"homeTeamRef\", \"@fields\": \"homeTeamId\", \"@references\": \"Team\" } },"
            + "    { \"relationship.association\": { \"name\": \"winner\", \"@objectRef\": \"Team\", \"@cardinality\": \"one\" } } ] } },"
            + "  { \"object.entity\": { \"name\": \"B\", \"extends\": \"A\", \"children\": ["
            + "    { \"field.long\": { \"name\": \"awayTeamId\" } },"
            + "    { \"identity.reference\": { \"name\": \"awayTeamRef\", \"@fields\": \"awayTeamId\", \"@references\": \"Team\" } } ] } }"
            + "] } }";
        Outcome outcome = attemptLoad(doc);
        List<MetaDataException> all = outcome.allErrors();
        assertEquals(outcome.joinedMessages(), 1, all.size());
        assertHasError(outcome, ErrorCode.ERR_INVALID_RELATIONSHIP);
        String joined = outcome.joinedMessages();
        assertTrue(joined, joined.contains("B.winner"));
        assertTrue(joined, joined.contains("homeTeamRef(homeTeamId)"));
        assertTrue(joined, joined.contains("awayTeamRef(awayTeamId)"));
    }

    @Test
    public void inheritedRelationshipResolvedByChildAddedReferenceLoadsClean() {
        // A child entity's added reference that name-pairs with the inherited
        // relationship resolves cleanly.
        String doc =
            "{ \"metadata.root\": { \"package\": \"repro\", \"children\": ["
            + "  { \"object.entity\": { \"name\": \"Team\", \"children\": ["
            + "    { \"field.long\": { \"name\": \"id\" } },"
            + "    { \"identity.primary\": { \"name\": \"id\", \"@fields\": \"id\" } } ] } },"
            + "  { \"object.entity\": { \"name\": \"A\", \"children\": ["
            + "    { \"field.long\": { \"name\": \"id\" } },"
            + "    { \"field.long\": { \"name\": \"homeTeamId\" } },"
            + "    { \"identity.primary\": { \"name\": \"id\", \"@fields\": \"id\" } },"
            + "    { \"identity.reference\": { \"name\": \"homeTeamRef\", \"@fields\": \"homeTeamId\", \"@references\": \"Team\" } },"
            + "    { \"relationship.association\": { \"name\": \"awayTeam\", \"@objectRef\": \"Team\", \"@cardinality\": \"one\" } } ] } },"
            + "  { \"object.entity\": { \"name\": \"B\", \"extends\": \"A\", \"children\": ["
            + "    { \"field.long\": { \"name\": \"awayTeamId\" } },"
            + "    { \"identity.reference\": { \"name\": \"awayTeamRef\", \"@fields\": \"awayTeamId\", \"@references\": \"Team\" } } ] } }"
            + "] } }";
        assertLoadsClean(doc);
    }

    // -------------------------------------------------------------------------
    // (D) Rule (d) dedupe -- own attrs never change per inheriting entity, so an
    // inherited unmodified relationship must be reported exactly once.
    // -------------------------------------------------------------------------

    @Test
    public void ruleDDedupeSingleErrorForOneInheritingChild() {
        String doc =
            "{ \"metadata.root\": { \"package\": \"repro\", \"children\": ["
            + "  { \"object.entity\": { \"name\": \"Program\", \"children\": ["
            + "    { \"field.long\": { \"name\": \"id\" } },"
            + "    { \"identity.primary\": { \"name\": \"id\", \"@fields\": \"id\" } } ] } },"
            + "  { \"object.entity\": { \"name\": \"A\", \"children\": ["
            + "    { \"field.long\": { \"name\": \"id\" } },"
            + "    { \"relationship.composition\": { \"name\": \"program\", \"@objectRef\": \"Program\", \"@cardinality\": \"one\", \"@through\": \"X\" } },"
            + "    { \"identity.primary\": { \"name\": \"id\", \"@fields\": \"id\" } } ] } },"
            + "  { \"object.entity\": { \"name\": \"B\", \"extends\": \"A\" } }"
            + "] } }";
        Outcome outcome = attemptLoad(doc);
        List<MetaDataException> all = outcome.allErrors();
        assertEquals(outcome.joinedMessages(), 1, all.size());
        assertEquals(ErrorCode.ERR_INVALID_RELATIONSHIP, all.get(0).getCode().orElse(null));
    }

    @Test
    public void ruleDDedupeSingleErrorAcrossSeveralInheritingChildren() {
        String doc =
            "{ \"metadata.root\": { \"package\": \"repro\", \"children\": ["
            + "  { \"object.entity\": { \"name\": \"Program\", \"children\": ["
            + "    { \"field.long\": { \"name\": \"id\" } },"
            + "    { \"identity.primary\": { \"name\": \"id\", \"@fields\": \"id\" } } ] } },"
            + "  { \"object.entity\": { \"name\": \"A\", \"children\": ["
            + "    { \"field.long\": { \"name\": \"id\" } },"
            + "    { \"relationship.composition\": { \"name\": \"program\", \"@objectRef\": \"Program\", \"@cardinality\": \"one\", \"@through\": \"X\" } },"
            + "    { \"identity.primary\": { \"name\": \"id\", \"@fields\": \"id\" } } ] } },"
            + "  { \"object.entity\": { \"name\": \"B\", \"extends\": \"A\" } },"
            + "  { \"object.entity\": { \"name\": \"C\", \"extends\": \"A\" } },"
            + "  { \"object.entity\": { \"name\": \"D\", \"extends\": \"A\" } }"
            + "] } }";
        Outcome outcome = attemptLoad(doc);
        List<MetaDataException> all = outcome.allErrors();
        assertEquals(outcome.joinedMessages(), 1, all.size());
        assertEquals(ErrorCode.ERR_INVALID_RELATIONSHIP, all.get(0).getCode().orElse(null));
    }

    // -------------------------------------------------------------------------
    // Cross-relationship state-leakage regression: a declared-but-unmatched
    // @sourceRefField at 2+ candidates on one relationship must not affect a
    // SIBLING relationship on the same entity whose declared field DOES match.
    // (Not present in the Python port; it is the case most likely to catch
    // per-relationship state accidentally shared across a loop iteration.)
    // -------------------------------------------------------------------------

    @Test
    public void siblingRelationshipWithMatchingSourceRefFieldProducesNoErrorWhileTheBadOneDoes() {
        String doc =
            "{ \"metadata.root\": { \"package\": \"repro\", \"children\": ["
            + "  { \"object.entity\": { \"name\": \"Team\", \"children\": ["
            + "    { \"field.long\": { \"name\": \"id\" } },"
            + "    { \"identity.primary\": { \"name\": \"id\", \"@fields\": \"id\" } } ] } },"
            + "  { \"object.entity\": { \"name\": \"Venue\", \"children\": ["
            + "    { \"field.long\": { \"name\": \"id\" } },"
            + "    { \"identity.primary\": { \"name\": \"id\", \"@fields\": \"id\" } } ] } },"
            + "  { \"object.entity\": { \"name\": \"Match\", \"children\": ["
            + "    { \"field.long\": { \"name\": \"id\" } },"
            + "    { \"field.long\": { \"name\": \"venueId\" } },"
            + "    { \"field.long\": { \"name\": \"alphaFk\" } },"
            + "    { \"field.long\": { \"name\": \"betaFk\" } },"
            + "    { \"identity.primary\": { \"name\": \"id\", \"@fields\": \"id\" } },"
            // The GOOD sibling: a single, correctly-matched candidate onto Venue.
            + "    { \"identity.reference\": { \"name\": \"venueRef\", \"@fields\": \"venueId\", \"@references\": \"Venue\" } },"
            + "    { \"relationship.association\": { \"name\": \"venue\", \"@objectRef\": \"Venue\", \"@cardinality\": \"one\", \"@sourceRefField\": \"venueId\" } },"
            // The BAD one: 2+ candidates onto Team, declared @sourceRefField matches neither.
            + "    { \"identity.reference\": { \"name\": \"alphaRef\", \"@fields\": \"alphaFk\", \"@references\": \"Team\" } },"
            + "    { \"identity.reference\": { \"name\": \"betaRef\", \"@fields\": \"betaFk\", \"@references\": \"Team\" } },"
            + "    { \"relationship.association\": { \"name\": \"winner\", \"@objectRef\": \"Team\", \"@cardinality\": \"one\", \"@sourceRefField\": \"doesNotExist\" } } ] } }"
            + "] } }";
        Outcome outcome = attemptLoad(doc);
        List<MetaDataException> all = outcome.allErrors();
        assertEquals("Expected exactly one error (the bad 'winner' relationship only): "
            + outcome.joinedMessages(), 1, all.size());
        String joined = outcome.joinedMessages();
        assertTrue(joined, joined.contains("Match.winner"));
        assertTrue(joined, joined.contains("\"doesNotExist\""));
        // The good sibling must never be named in any error -- no state leaked
        // from evaluating "winner" into (or out of) evaluating "venue".
        assertFalse(joined, joined.contains("Match.venue\""));
    }

    // -------------------------------------------------------------------------
    // Two latent "obj vs. declaring entity" bugs -- present in TS, Python and C#
    // before their own #368 fixes. Regression-covered here for Java.
    // -------------------------------------------------------------------------

    @Test
    public void inheritedSelfJoinRelationshipIsNotMisflaggedAsNonSelfJoin() {
        // Node extends NodeBase, which declares a @symmetric self-join
        // relationship onto NodeBase itself (@objectRef: "NodeBase"). Node is
        // declared BEFORE NodeBase (extends is resolved order-independently by
        // a deferred pass, so this is legal) so that the outer validation loop
        // visits `obj = Node` FIRST -- if rule (a)'s self-join comparison used
        // the visiting `obj` instead of the relationship's DECLARING entity
        // (NodeBase, via rel.getParent()), it would wrongly conclude @objectRef
        // "NodeBase" is not the (visiting) declaring entity "Node" and misfire
        // ERR_BAD_ATTR_VALUE.
        String doc =
            "{ \"metadata.root\": { \"package\": \"acme\", \"children\": ["
            + "  { \"object.entity\": { \"name\": \"Node\", \"extends\": \"NodeBase\", \"children\": ["
            + "    { \"field.long\": { \"name\": \"id\" } },"
            + "    { \"identity.primary\": { \"name\": \"id\", \"@fields\": \"id\" } } ] } },"
            + "  { \"object.entity\": { \"name\": \"NodeBase\", \"@isAbstract\": true, \"children\": ["
            + "    { \"relationship.association\": { \"name\": \"peers\", \"@cardinality\": \"many\", \"@objectRef\": \"NodeBase\","
            + "        \"@through\": \"NodeLink\", \"@symmetric\": true } } ] } },"
            + "  { \"object.entity\": { \"name\": \"NodeLink\", \"children\": ["
            + "    { \"field.long\": { \"name\": \"id\" } },"
            + "    { \"field.long\": { \"name\": \"aId\" } },"
            + "    { \"field.long\": { \"name\": \"bId\" } },"
            + "    { \"identity.primary\": { \"name\": \"id\", \"@fields\": \"id\" } },"
            + "    { \"identity.reference\": { \"name\": \"a\", \"@fields\": \"aId\", \"@references\": \"NodeBase\" } },"
            + "    { \"identity.reference\": { \"name\": \"b\", \"@fields\": \"bId\", \"@references\": \"NodeBase\" } } ] } }"
            + "] } }";
        Outcome outcome = attemptLoad(doc);
        assertNoErrorOfCode(outcome, ErrorCode.ERR_BAD_ATTR_VALUE);
        assertNoErrorOfCode(outcome, ErrorCode.ERR_INVALID_RELATIONSHIP);
    }

    @Test
    public void inheritedBareThroughResolvesInTheDeclaringEntityPackageNotTheVisitingOne() {
        // WeekBase (package "base") declares a M:N relationship with a BARE
        // @through "Tag" -- ADR-0042 says a bare ref resolves in the DECLARING
        // entity's package ("base::Tag"), never the package of whichever entity
        // inherits and visits it. Week extends WeekBase from a DIFFERENT package
        // ("acme") that also happens to declare its own unrelated "Tag" entity.
        // The acme source is loaded FIRST so the outer validation loop visits
        // `obj = Week` before `obj = WeekBase` -- if @through resolution used the
        // visiting entity's package it would wrongly bind to "acme::Tag" (which
        // has zero identity.reference children) instead of "base::Tag" (which
        // correctly has two).
        String acmeDoc =
            "{ \"metadata.root\": { \"package\": \"acme\", \"children\": ["
            + "  { \"object.entity\": { \"name\": \"Week\", \"extends\": \"base::WeekBase\", \"children\": ["
            + "    { \"field.long\": { \"name\": \"id\" } },"
            + "    { \"identity.primary\": { \"name\": \"id\", \"@fields\": \"id\" } } ] } },"
            + "  { \"object.entity\": { \"name\": \"Tag\", \"children\": ["
            + "    { \"field.long\": { \"name\": \"id\" } },"
            + "    { \"identity.primary\": { \"name\": \"id\", \"@fields\": \"id\" } } ] } }"
            + "] } }";
        String baseDoc =
            "{ \"metadata.root\": { \"package\": \"base\", \"children\": ["
            + "  { \"object.entity\": { \"name\": \"WeekBase\", \"@isAbstract\": true, \"children\": ["
            + "    { \"relationship.association\": { \"name\": \"tags\", \"@cardinality\": \"many\", \"@objectRef\": \"Tag\", \"@through\": \"Tag\" } } ] } },"
            + "  { \"object.entity\": { \"name\": \"Tag\", \"children\": ["
            + "    { \"field.long\": { \"name\": \"id\" } },"
            + "    { \"field.long\": { \"name\": \"weekId\" } },"
            + "    { \"field.long\": { \"name\": \"labelId\" } },"
            + "    { \"identity.primary\": { \"name\": \"id\", \"@fields\": \"id\" } },"
            + "    { \"identity.reference\": { \"name\": \"w\", \"@fields\": \"weekId\", \"@references\": \"base::WeekBase\" } },"
            + "    { \"identity.reference\": { \"name\": \"l\", \"@fields\": \"labelId\", \"@references\": \"base::Tag\" } } ] } }"
            + "] } }";
        Outcome outcome = attemptLoad(acmeDoc, baseDoc);
        assertNoErrorOfCode(outcome, ErrorCode.ERR_INVALID_RELATIONSHIP);
    }

    // -------------------------------------------------------------------------
    // Regression: valid M:N still loads clean.
    // -------------------------------------------------------------------------

    @Test
    public void validHeteroM2mProducesNoRelationshipErrors() {
        String doc =
            "{ \"metadata.root\": { \"package\": \"acme\", \"children\": ["
            + "  { \"object.entity\": { \"name\": \"Post\", \"children\": ["
            + "    { \"field.long\": { \"name\": \"id\" } },"
            + "    { \"relationship.association\": { \"name\": \"tags\", \"@cardinality\": \"many\", \"@objectRef\": \"Tag\", \"@through\": \"PostTag\" } },"
            + "    { \"identity.primary\": { \"name\": \"id\", \"@fields\": \"id\" } } ] } },"
            + "  { \"object.entity\": { \"name\": \"Tag\", \"children\": ["
            + "    { \"field.long\": { \"name\": \"id\" } },"
            + "    { \"identity.primary\": { \"name\": \"id\", \"@fields\": \"id\" } } ] } },"
            + "  { \"object.entity\": { \"name\": \"PostTag\", \"children\": ["
            + "    { \"field.long\": { \"name\": \"id\" } },"
            + "    { \"field.long\": { \"name\": \"postId\" } },"
            + "    { \"field.long\": { \"name\": \"tagId\" } },"
            + "    { \"identity.primary\": { \"name\": \"id\", \"@fields\": \"id\" } },"
            + "    { \"identity.reference\": { \"name\": \"p\", \"@fields\": \"postId\", \"@references\": \"Post\" } },"
            + "    { \"identity.reference\": { \"name\": \"t\", \"@fields\": \"tagId\", \"@references\": \"Tag\" } } ] } }"
            + "] } }";
        Outcome outcome = attemptLoad(doc);
        assertNoErrorOfCode(outcome, ErrorCode.ERR_INVALID_RELATIONSHIP);
        assertNoErrorOfCode(outcome, ErrorCode.ERR_BAD_ATTR_VALUE);
    }
}

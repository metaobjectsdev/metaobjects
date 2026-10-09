package com.metaobjects.generator.requirement;

import com.metaobjects.requirement.RequirementTestIdentities;

import java.util.List;

/**
 * Everything a {@link RequirementTestRenderer} is given about one test: its identity (the same
 * record in every language port), and the prose and claims the default rendering is built from.
 * The library supplies DATA; a renderer supplies SYNTAX.
 *
 * @param identity       the test's identity: package, path, unit, id, witness key, status,
 *                       skip reason (or {@code null}) and digest
 * @param statement      what the capability is, or the empty string
 * @param counterexample what breaking it looks like, or the empty string
 * @param targets        the claims this test covers, as authored plus the concern each resolved to
 * @param disposition    what was decided about outstanding work, or {@code null} (undecided)
 * @param trackedBy      issue references for outstanding work; empty when none
 */
public record RequirementTestArgs(RequirementTestIdentities.Identity identity, String statement,
                                  String counterexample, List<Claim> targets, String disposition,
                                  List<String> trackedBy) {

    /** One resolved {@code implementedBy} reference. */
    public record Claim(String ref, String concern) {}

    public RequirementTestArgs {
        targets = List.copyOf(targets);
        trackedBy = List.copyOf(trackedBy);
    }
}

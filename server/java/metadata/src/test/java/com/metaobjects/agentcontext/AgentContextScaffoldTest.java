package com.metaobjects.agentcontext;

import org.junit.Test;

import java.util.List;
import java.util.Map;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

/**
 * Unit coverage for the pure scaffold planner — mirrors the behavior the Python
 * {@code plan_scaffold} / TS {@code planScaffold} references encode: absent → write,
 * unmodified-since-manifest → refresh, hand-edited → conflict ({@code .new}),
 * dropped-from-stack → removed (reported, never deleted).
 */
public class AgentContextScaffoldTest {

    private static final Stack STACK = Stack.of(List.of("java"), List.of("react"));

    private static List<AssembledFile> assembled() {
        return List.of(
                new AssembledFile(".metaobjects/AGENTS.md", "alpha"),
                new AssembledFile(".claude/skills/x/SKILL.md", "beta"));
    }

    @Test
    public void absentFilesAreWrittenFresh() {
        AgentContextScaffold.ScaffoldDecision d =
                AgentContextScaffold.plan(STACK, assembled(), null, rel -> null, "9.9.9");
        assertEquals(2, d.writes().size());
        assertTrue(d.conflicts().isEmpty());
        assertTrue(d.removed().isEmpty());
        assertEquals(
                AgentContextScaffold.hashContents("alpha"),
                d.manifest().files().get(".metaobjects/AGENTS.md"));
    }

    @Test
    public void manifestRecordsGeneratedBy() {
        AgentContextScaffold.ScaffoldDecision d =
                AgentContextScaffold.plan(STACK, assembled(), null, rel -> null, "9.9.9");
        assertEquals("9.9.9", d.manifest().generatedBy());
    }

    @Test
    public void unmodifiedSinceManifestIsRefreshed() {
        AgentContextScaffold.Manifest prior = new AgentContextScaffold.Manifest(
                1, "1.0.0", List.of("java"), List.of("react"),
                Map.of(".metaobjects/AGENTS.md", AgentContextScaffold.hashContents("alpha")));
        // On disk still holds the prior-recorded contents → safe to overwrite.
        AgentContextScaffold.ScaffoldDecision d = AgentContextScaffold.plan(
                STACK, assembled(), prior,
                rel -> rel.equals(".metaobjects/AGENTS.md") ? "alpha" : null, "9.9.9");
        assertEquals(2, d.writes().size());
        assertTrue(d.conflicts().isEmpty());
    }

    @Test
    public void handEditedFileBecomesConflict() {
        AgentContextScaffold.Manifest prior = new AgentContextScaffold.Manifest(
                1, "1.0.0", List.of("java"), List.of("react"),
                Map.of(".metaobjects/AGENTS.md", AgentContextScaffold.hashContents("alpha")));
        // On disk differs from the recorded hash → preserve it, emit a .new.
        AgentContextScaffold.ScaffoldDecision d = AgentContextScaffold.plan(
                STACK, assembled(), prior,
                rel -> rel.equals(".metaobjects/AGENTS.md") ? "USER EDIT" : null, "9.9.9");
        assertEquals(1, d.writes().size());
        assertEquals(1, d.conflicts().size());
        assertEquals(".metaobjects/AGENTS.md.new", d.conflicts().get(0).newPath());
    }

    @Test
    public void priorPathNoLongerAssembledIsReportedRemoved() {
        AgentContextScaffold.Manifest prior = new AgentContextScaffold.Manifest(
                1, "1.0.0", List.of("java"), List.of("react"),
                Map.of(".claude/skills/gone/SKILL.md", "deadbeef"));
        AgentContextScaffold.ScaffoldDecision d =
                AgentContextScaffold.plan(STACK, assembled(), prior, rel -> null, "9.9.9");
        assertEquals(List.of(".claude/skills/gone/SKILL.md"), d.removed());
    }
}

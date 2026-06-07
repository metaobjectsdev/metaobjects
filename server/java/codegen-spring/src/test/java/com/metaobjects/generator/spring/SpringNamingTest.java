package com.metaobjects.generator.spring;

import org.junit.Test;

import static org.junit.Assert.assertEquals;

/**
 * Locks the generated-name seam: each {@link SpringNaming} method must return
 * EXACTLY the string the corresponding generator concatenates inline today
 * (verbatim, behavior-preserving). Generators are routed through these methods
 * in a follow-up task; this test guards the literals so that refactor is
 * provably no-op.
 */
public class SpringNamingTest {

    @Test
    public void generatedNames() {
        // capitalize == the generators' private capitalizeFirst logic.
        assertEquals("Author", SpringNaming.capitalize("author"));
        assertEquals("Author", SpringNaming.capitalize("Author"));

        // Entity-derived names (verbatim shortName + suffix).
        assertEquals("AuthorDto", SpringNaming.dtoName("Author"));
        assertEquals("AuthorRepository", SpringNaming.repositoryName("Author"));
        assertEquals("AuthorController", SpringNaming.controllerName("Author"));
        assertEquals("AuthorFilterAllowlist", SpringNaming.filterAllowlistName("Author"));
        assertEquals("AuthorExtractor", SpringNaming.extractorName("Author"));

        // Controller route base: "/api/" + pluralLowercase(shortName).
        assertEquals("/api/authors", SpringNaming.controllerPath("Author"));

        // Prompts package rule.
        assertEquals("prompts", SpringNaming.promptsPackage(""));
        assertEquals("acme.blog.prompts", SpringNaming.promptsPackage("acme.blog"));

        // Template-helper names — capitalize(templateShort) + suffix.
        assertEquals("SummaryRenderHelper", SpringNaming.renderHelperName("summary"));
        assertEquals("SummaryPayload", SpringNaming.payloadName("summary"));
        // Verified suffix is "Prompt" (SpringOutputPromptGenerator), not "OutputPrompt".
        assertEquals("SummaryPrompt", SpringNaming.promptName("summary"));
        // Verified suffix is "Parser" (SpringOutputParserGenerator), not "OutputParser".
        assertEquals("SummaryParser", SpringNaming.parserName("summary"));

        // Trace-helper name — shortName + "TraceHelper" (not "LlmTraceHelper").
        assertEquals("AuthorTraceHelper", SpringNaming.traceHelperName("Author"));
    }
}

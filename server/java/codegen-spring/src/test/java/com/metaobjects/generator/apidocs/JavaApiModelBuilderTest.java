package com.metaobjects.generator.apidocs;

import com.metaobjects.generator.spring.SpringTestFixtures;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.registry.SharedRegistryTestBase;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.nio.file.Path;
import java.util.EnumSet;
import java.util.Set;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

/**
 * Tests {@link JavaApiModelBuilder} — that it enumerates the generated Java SDK
 * surface (one {@link ApiSymbol} per category) by reusing the drift-proof
 * {@code SpringNaming} / {@code SpringM2mSupport} name seams and each generator's
 * {@code appliesTo(...)} inclusion predicate. The model is built from a loaded
 * {@link MetaDataLoader}, never re-concatenating a name or re-implementing a guard.
 */
public class JavaApiModelBuilderTest extends SharedRegistryTestBase {

    @Rule
    public TemporaryFolder tempFolder = new TemporaryFolder();

    /**
     * One table entity {@code Author} with a M:N to {@code Tag} (through {@code AuthorTag}),
     * a value object {@code Address} (MODEL only), and a json {@code template.output}
     * {@code SummaryOutput} whose {@code @payloadRef} resolves to an {@code object.value}.
     */
    private static final String FIXTURE = """
        {
          "metadata.root": { "package": "acme::blog", "children": [
            { "object.entity": { "name": "Author", "children": [
                { "field.long":   { "name": "id" } },
                { "field.string": { "name": "name", "@required": true } },
                { "source.rdb":   { "@table": "authors" } },
                { "relationship.association": { "name": "tags", "@cardinality": "many",
                    "@objectRef": "Tag", "@through": "AuthorTag" } },
                { "identity.primary": { "name": "pk", "@fields": ["id"], "@generation": "increment" } }
            ] } },
            { "object.entity": { "name": "Tag", "children": [
                { "field.long":   { "name": "id" } },
                { "field.string": { "name": "label" } },
                { "source.rdb":   { "@table": "tags" } },
                { "identity.primary": { "name": "pk", "@fields": ["id"], "@generation": "increment" } }
            ] } },
            { "object.entity": { "name": "AuthorTag", "children": [
                { "field.long": { "name": "authorId" } },
                { "field.long": { "name": "tagId" } },
                { "source.rdb": { "@table": "author_tags" } },
                { "identity.primary":   { "@fields": ["authorId", "tagId"] } },
                { "identity.reference": { "name": "fkAuthor", "@fields": "authorId", "@references": "Author" } },
                { "identity.reference": { "name": "fkTag",    "@fields": "tagId",    "@references": "Tag" } }
            ] } },
            { "object.value": { "name": "Address", "children": [
                { "field.string": { "name": "city" } },
                { "field.string": { "name": "zip" } }
            ] } },
            { "object.value": { "name": "SummaryPayloadVo", "children": [
                { "field.string": { "name": "summary", "@required": true } }
            ] } },
            { "template.output": {
                "name": "SummaryOutput",
                "@payloadRef": "SummaryPayloadVo",
                "@textRef": "blog/summary",
                "@format": "json"
            } }
          ] }
        }
        """;

    @Test
    public void enumeratesTheJavaSdkSurface() throws Exception {
        Path workspace = tempFolder.newFolder("apidocs-fx").toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(workspace, "apidocs", FIXTURE);

        JavaApiModel m = new JavaApiModelBuilder().build(loader, "acme-blog");

        ApiUnit author = unit(m, "Author");
        assertTrue("MODEL Author", has(author, ApiSymbolKind.MODEL, "Author"));
        assertTrue("DTO AuthorDto", has(author, ApiSymbolKind.DTO, "AuthorDto"));
        assertTrue("DATA_ACCESS AuthorRepository", has(author, ApiSymbolKind.DATA_ACCESS, "AuthorRepository"));
        assertTrue("REST GET list", hasName(author, ApiSymbolKind.REST, "GET /api/authors"));
        assertTrue("REST POST", hasName(author, ApiSymbolKind.REST, "POST /api/authors"));
        assertTrue("REST GET by id", hasName(author, ApiSymbolKind.REST, "GET /api/authors/{id}"));
        assertTrue("REST PATCH", hasName(author, ApiSymbolKind.REST, "PATCH /api/authors/{id}"));
        assertTrue("REST DELETE", hasName(author, ApiSymbolKind.REST, "DELETE /api/authors/{id}"));
        assertTrue("REST M:N traversal", hasName(author, ApiSymbolKind.REST, "GET /api/authors/{id}/tags"));
        assertTrue("FILTER AuthorFilterAllowlist", has(author, ApiSymbolKind.FILTER, "AuthorFilterAllowlist"));

        // The repository symbol's signature lists the M:N finder derived via the seam.
        ApiSymbol repo = symbol(author, ApiSymbolKind.DATA_ACCESS, "AuthorRepository");
        assertTrue("repo signature lists findTags; saw:\n" + repo.signature(),
            repo.signature().contains("findTags"));

        // DTO symbol carries the field shapes; a VALIDATION symbol exists on the
        // same DTO record with the same field set.
        ApiSymbol dto = symbol(author, ApiSymbolKind.DTO, "AuthorDto");
        assertTrue("DTO fields non-empty", !dto.fields().isEmpty());
        assertTrue("VALIDATION AuthorDto", has(author, ApiSymbolKind.VALIDATION, "AuthorDto"));
        ApiSymbol validation = symbol(author, ApiSymbolKind.VALIDATION, "AuthorDto");
        assertEquals("VALIDATION carries the same field shape as DTO",
            dto.fields(), validation.fields());
        // name is @required → not optional in the documented DTO shape.
        FieldShape nameShape = field(dto.fields(), "name");
        assertEquals("String", nameShape.type());
        assertEquals(false, nameShape.optional());

        // PAYLOAD symbol carries the resolved payload-VO field shapes.
        ApiUnit summary = unit(m, "SummaryOutput");
        ApiSymbol payload = symbol(summary, ApiSymbolKind.PAYLOAD, "SummaryOutputPayload");
        assertTrue("PAYLOAD fields non-empty", !payload.fields().isEmpty());

        ApiUnit address = unit(m, "Address");
        assertEquals("VO Address → MODEL only", EnumSet.of(ApiSymbolKind.MODEL), kinds(address));

        ApiUnit tmpl = unit(m, "SummaryOutput");
        assertEquals("template unit kind", "template", tmpl.kind());
        assertTrue("PAYLOAD SummaryOutputPayload", has(tmpl, ApiSymbolKind.PAYLOAD, "SummaryOutputPayload"));
        assertTrue("RENDER SummaryOutputRenderHelper", has(tmpl, ApiSymbolKind.RENDER, "SummaryOutputRenderHelper"));
        assertTrue("PROMPT SummaryOutputPrompt", has(tmpl, ApiSymbolKind.PROMPT, "SummaryOutputPrompt"));
        assertTrue("OUTPUT_PARSER SummaryOutputParser", has(tmpl, ApiSymbolKind.OUTPUT_PARSER, "SummaryOutputParser"));
    }

    // ----- test helpers ------------------------------------------------------

    private static ApiUnit unit(JavaApiModel m, String node) {
        for (ApiUnit u : m.units()) {
            if (u.node().equals(node)) return u;
        }
        throw new AssertionError("no unit named '" + node + "' in " + m.units());
    }

    private static boolean has(ApiUnit u, ApiSymbolKind kind, String name) {
        for (ApiSymbol s : u.symbols()) {
            if (s.kind() == kind && s.name().equals(name)) return true;
        }
        return false;
    }

    private static boolean hasName(ApiUnit u, ApiSymbolKind kind, String name) {
        return has(u, kind, name);
    }

    private static ApiSymbol symbol(ApiUnit u, ApiSymbolKind kind, String name) {
        for (ApiSymbol s : u.symbols()) {
            if (s.kind() == kind && s.name().equals(name)) return s;
        }
        throw new AssertionError("no " + kind + " '" + name + "' in " + u.symbols());
    }

    private static FieldShape field(java.util.List<FieldShape> fs, String name) {
        for (FieldShape f : fs) {
            if (f.name().equals(name)) return f;
        }
        throw new AssertionError("no field shape named '" + name + "' in " + fs);
    }

    private static Set<ApiSymbolKind> kinds(ApiUnit u) {
        Set<ApiSymbolKind> out = EnumSet.noneOf(ApiSymbolKind.class);
        for (ApiSymbol s : u.symbols()) out.add(s.kind());
        return out;
    }
}

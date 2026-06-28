package com.metaobjects.generator.apidocs;

import com.metaobjects.MetaData;
import com.metaobjects.generator.spring.LlmTraceHelperGenerator;
import com.metaobjects.generator.spring.SpringControllerGenerator;
import com.metaobjects.generator.spring.SpringDtoGenerator;
import com.metaobjects.generator.spring.SpringFilterAllowlistGenerator;
import com.metaobjects.generator.spring.SpringM2mSupport;
import com.metaobjects.generator.spring.SpringNaming;
import com.metaobjects.generator.spring.SpringOutputParserGenerator;
import com.metaobjects.generator.spring.SpringOutputPromptGenerator;
import com.metaobjects.generator.spring.SpringPayloadGenerator;
import com.metaobjects.generator.spring.SpringRenderHelperGenerator;
import com.metaobjects.generator.spring.SpringRepositoryGenerator;
import com.metaobjects.io.util.IOUtil;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.object.MetaObject;
import com.metaobjects.template.MetaTemplate;
import com.metaobjects.template.OutputTemplate;
import com.metaobjects.template.TemplateConstants;

import java.util.ArrayList;
import java.util.List;

/**
 * Builds a {@link JavaApiModel} — the per-project enumeration of the generated
 * Java SDK surface — from a loaded {@link MetaDataLoader}.
 *
 * <p>This is the <i>accurate-by-construction</i> half of the api-docs pipeline:
 * every documented symbol name comes from the {@link SpringNaming} /
 * {@link SpringM2mSupport} name seam (never re-concatenated here), and every
 * inclusion decision comes from the corresponding generator's
 * {@code appliesTo(...)} predicate (never re-implemented here). The result is
 * that what this builder documents == what the generators emit, by sharing the
 * single source of truth rather than mirroring it.</p>
 *
 * <h2>Per-category enumeration</h2>
 * <ul>
 *   <li><b>Objects</b> (iterated via {@link MetaDataLoader#getMetaObjects()}):
 *       each object yields a {@link ApiSymbolKind#MODEL} symbol. Entities
 *       ({@code object.entity}) additionally yield DTO / VALIDATION / DATA_ACCESS /
 *       REST / FILTER / TRACE symbols gated by the matching {@code appliesTo}. A
 *       projection ({@code object.projection}) is a read-only model and yields a
 *       read DTO only (no VALIDATION / DATA_ACCESS / REST / FILTER — those
 *       generators gate on a writable table entity and skip a projection). A value
 *       object ({@code object.value}) yields MODEL only.</li>
 *   <li><b>Templates</b> (iterated via {@code loader.getRoot().getChildren()}
 *       filtered to {@link MetaTemplate}): each template yields PAYLOAD / RENDER /
 *       PROMPT / OUTPUT_PARSER symbols gated by the matching {@code appliesTo}.</li>
 * </ul>
 *
 * <h2>Field shapes</h2>
 * <ul>
 *   <li>DTO and VALIDATION symbols carry the entity's per-field shape via
 *       {@link JavaFieldShapes#dtoFields(MetaObject)}; PAYLOAD symbols carry the
 *       template's payload shape via
 *       {@link JavaFieldShapes#payloadFields(com.metaobjects.MetaData, MetaDataLoader)}.
 *       Both derive types/optionality from the real generators (drift-proof).</li>
 *   <li>A VALIDATION symbol is emitted alongside each DTO (the Jakarta
 *       constraints live on the DTO record), carrying the same required/optional
 *       field shape.</li>
 * </ul>
 *
 * <h2>Deferred</h2>
 * <ul>
 *   <li>EXTRACTOR is emitted per concrete flavored OBJECT by
 *       {@code JavaObjectCodeGenerator} only when run with a concrete
 *       {@code flavor} arg (pojoAware / valueObject); that is a generator-config
 *       choice not present in the loaded metadata, and there is no
 *       {@code appliesTo} predicate for it. To stay drift-proof (document only
 *       what the loaded model determines), no EXTRACTOR symbol is emitted here.</li>
 *   <li>{@code example} (symbol- and unit-level) and {@code throwsNote} are null
 *       — filled in later phases. {@code returns} is populated where a single
 *       return surface is meaningful (DATA_ACCESS, RENDER); null otherwise.</li>
 * </ul>
 */
public final class JavaApiModelBuilder {

    /** Build the SDK-surface model for {@code project} from the loaded {@code loader}. */
    public JavaApiModel build(MetaDataLoader loader, String project) {
        List<ApiUnit> units = new ArrayList<>();

        // Objects: one unit per object.entity / object.value (entity vs value drives
        // which symbol categories appliesTo lets through).
        for (MetaObject obj : loader.getMetaObjects()) {
            ApiUnit unit = buildObjectUnit(obj, loader);
            if (unit != null) {
                units.add(unit);
            }
        }

        // Templates: one unit per template.* node under the model root.
        for (MetaData child : loader.getRoot().getChildren()) {
            if (child instanceof MetaTemplate tmpl) {
                units.add(buildTemplateUnit(tmpl, loader));
            }
        }

        return new JavaApiModel(project, units);
    }

    // ----- objects -----------------------------------------------------------

    private ApiUnit buildObjectUnit(MetaObject obj, MetaDataLoader loader) {
        String[] split = SpringNaming.splitFqn(obj.getName());
        String javaPkg = SpringNaming.toJavaPackage(split[0]);
        String shortName = split[1];
        boolean entity = MetaObject.SUBTYPE_ENTITY.equals(obj.getSubType());
        boolean projection = MetaObject.SUBTYPE_PROJECTION.equals(obj.getSubType());
        String unitKind = entity ? "entity" : projection ? "projection" : "value";

        List<ApiSymbol> symbols = new ArrayList<>();

        // MODEL — documented only for concrete objects. Abstract objects cannot be
        // instantiated, so we do not document a MODEL symbol for them (documented is a
        // subset of generated). A concrete value object / projection → MODEL only (plus
        // a read DTO for a projection, below).
        if (!IOUtil.isAbstract(obj)) {
            symbols.add(symbol(
                shortName, ApiSymbolKind.MODEL, fqn(javaPkg, shortName),
                "class " + shortName,
                entity ? "the in-memory model object"
                    : projection ? "the in-memory read model (read-only projection)"
                    : "the in-memory value object"));
        }

        // DTO — the wire shape. Emitted for any concrete object.entity OR concrete
        // object.projection (a projection is a read-only wire model). The inclusion
        // decision is delegated to the generator's appliesTo so documented == generated.
        if (SpringDtoGenerator.appliesTo(obj)) {
            String dto = SpringNaming.dtoName(shortName);
            List<FieldShape> dtoFields = JavaFieldShapes.dtoFields(obj);
            symbols.add(symbolWithFields(
                dto, ApiSymbolKind.DTO, fqn(javaPkg, dto),
                "record " + dto,
                projection ? "the read-only wire / serialization shape"
                    : "the wire / serialization shape",
                dtoFields));

            // VALIDATION — the validated create/update payload shape. Documented only
            // for an entity: a projection is read-only and is never a create/update
            // body, so no write-validation surface is documented for it. The Jakarta
            // constraints live on the SAME DTO record's components, so the validation
            // symbol names the DTO record and carries the same required/optional shape.
            if (entity) {
                symbols.add(symbolWithFields(
                    dto, ApiSymbolKind.VALIDATION, fqn(javaPkg, dto),
                    "record " + dto,
                    "Bean-validation (Jakarta) constraints on the create/update payload",
                    dtoFields));
            }
        }

        // DATA_ACCESS / REST / FILTER / TRACE — the write + queryable surfaces. Each
        // generator's appliesTo gates on a writable table entity and returns false for a
        // projection (and for a value object), so a projection is documented as read DTO
        // only, never a repository / controller / filter / trace surface.

        // DATA_ACCESS — one repository interface symbol; signature lists the
        // CRUD methods plus one find<Rel> per resolved M:N.
        if (SpringRepositoryGenerator.appliesTo(obj)) {
            String repo = SpringNaming.repositoryName(shortName);
            String dto = SpringNaming.dtoName(shortName);
            symbols.add(symbol(
                repo, ApiSymbolKind.DATA_ACCESS, fqn(javaPkg, repo),
                repositorySignature(repo, dto, obj, loader),
                "data access — consumer implements this interface",
                "Optional<" + dto + "> / List<" + dto + "> / boolean"));
        }

        // REST — one symbol per verb+path the controller registers.
        if (SpringControllerGenerator.appliesTo(obj)) {
            addRestSymbols(symbols, obj, javaPkg, shortName, loader);
        }

        // FILTER — the per-entity sort/filter allowlist.
        if (SpringFilterAllowlistGenerator.appliesTo(obj)) {
            String filter = SpringNaming.filterAllowlistName(shortName);
            symbols.add(symbol(
                filter, ApiSymbolKind.FILTER, fqn(javaPkg, filter),
                "final class " + filter,
                "the sortable-field + filter-operator allowlist"));
        }

        // TRACE — the LLM-trace persistence helper (only when a prompt with
        // @responseRef is present, per the generator's appliesTo).
        if (LlmTraceHelperGenerator.appliesTo(obj)) {
            String trace = SpringNaming.traceHelperName(shortName);
            symbols.add(symbol(
                trace, ApiSymbolKind.TRACE, fqn(javaPkg, trace),
                "final class " + trace,
                "persists an LLM call trace as a typed object"));
        }

        // An object that yields no symbols (e.g. an abstract object: no MODEL, and
        // every entity generator's appliesTo also skips abstracts) produces no unit
        // at all — never an empty unit.
        if (symbols.isEmpty()) {
            return null;
        }
        return new ApiUnit(shortName, javaPkg, unitKind, symbols, null);
    }

    private void addRestSymbols(List<ApiSymbol> symbols, MetaObject obj,
                                String javaPkg, String shortName, MetaDataLoader loader) {
        String controllerFqn = fqn(javaPkg, SpringNaming.controllerName(shortName));
        String base = SpringNaming.controllerPath(shortName);
        addRest(symbols, controllerFqn, "GET " + base, "list with pagination / sort / filters");
        addRest(symbols, controllerFqn, "GET " + base + "/{id}", "fetch one by id");
        addRest(symbols, controllerFqn, "POST " + base, "create");
        addRest(symbols, controllerFqn, "PATCH " + base + "/{id}", "update");
        addRest(symbols, controllerFqn, "DELETE " + base + "/{id}", "delete");
        for (SpringM2mSupport.M2mNav nav : SpringM2mSupport.resolve(obj, loader)) {
            addRest(symbols, controllerFqn,
                "GET " + base + "/{id}/" + nav.relationName(),
                "M:N traversal — the related " + nav.targetShortName() + " rows");
        }
    }

    private void addRest(List<ApiSymbol> symbols, String controllerFqn, String verbPath, String usage) {
        symbols.add(symbol(verbPath, ApiSymbolKind.REST, controllerFqn, verbPath, usage));
    }

    /** Stable human signature listing the repository interface methods + M:N finders. */
    private String repositorySignature(String repo, String dto, MetaObject obj, MetaDataLoader loader) {
        StringBuilder sb = new StringBuilder();
        sb.append("interface ").append(repo).append(" {\n");
        sb.append("    List<").append(dto).append("> list(int limit, int offset, SortClause sort, List<FilterPredicate> filters);\n");
        sb.append("    long count(List<FilterPredicate> filters);\n");
        sb.append("    Optional<").append(dto).append("> findById(Long id);\n");
        sb.append("    ").append(dto).append(" create(").append(dto).append(" dto);\n");
        sb.append("    Optional<").append(dto).append("> update(Long id, ").append(dto).append(" dto);\n");
        sb.append("    boolean delete(Long id);\n");
        for (SpringM2mSupport.M2mNav nav : SpringM2mSupport.resolve(obj, loader)) {
            sb.append("    List<").append(nav.targetDtoType()).append("> ")
              .append(SpringRepositoryGenerator.m2mFinderName(nav.relationName())).append("(Long sourceId);\n");
        }
        sb.append("}");
        return sb.toString();
    }

    // ----- templates ---------------------------------------------------------

    private ApiUnit buildTemplateUnit(MetaTemplate tmpl, MetaDataLoader loader) {
        String[] split = SpringNaming.splitFqn(tmpl.getName());
        String javaPkg = SpringNaming.toJavaPackage(split[0]);
        String shortName = split[1];
        String promptsPkg = SpringNaming.promptsPackage(javaPkg);

        List<ApiSymbol> symbols = new ArrayList<>();

        if (SpringPayloadGenerator.appliesTo(tmpl, loader)) {
            String payload = SpringNaming.payloadName(shortName);
            symbols.add(symbolWithFields(
                payload, ApiSymbolKind.PAYLOAD, fqn(promptsPkg, payload),
                "record " + payload,
                "the typed payload projection bound to the template",
                JavaFieldShapes.payloadFields(tmpl, loader)));
        }
        if (SpringRenderHelperGenerator.appliesTo(tmpl, loader)) {
            String render = SpringNaming.renderHelperName(shortName);
            // The render helper's return type keys off @kind: email → EmailDocument,
            // document (the default) → String. Read the own attr the same way the
            // render-helper generator does (default document) to stay drift-proof.
            String renderReturns = isEmailKind(tmpl) ? "EmailDocument" : "String";
            symbols.add(symbol(
                render, ApiSymbolKind.RENDER, fqn(promptsPkg, render),
                "final class " + render,
                "renders the output template against a payload",
                renderReturns));
        }
        if (SpringOutputPromptGenerator.appliesTo(tmpl, loader)) {
            String prompt = SpringNaming.promptName(shortName);
            symbols.add(symbol(
                prompt, ApiSymbolKind.PROMPT, fqn(promptsPkg, prompt),
                "final class " + prompt,
                "builds the output-format prompt fragment"));
        }
        if (SpringOutputParserGenerator.appliesTo(tmpl, loader)) {
            String parser = SpringNaming.parserName(shortName);
            symbols.add(symbol(
                parser, ApiSymbolKind.OUTPUT_PARSER, fqn(promptsPkg, parser),
                "final class " + parser,
                "parses model output back into the typed payload"));
        }

        return new ApiUnit(shortName, javaPkg, "template", symbols, null);
    }

    /** True when the template's {@code @kind} (own attr, default {@code document}) is {@code email}. */
    private static boolean isEmailKind(MetaTemplate tmpl) {
        if (tmpl instanceof OutputTemplate
                && tmpl.hasMetaAttr(TemplateConstants.ATTR_KIND, false)) {
            String v = tmpl.getMetaAttr(TemplateConstants.ATTR_KIND, false).getValueAsString();
            return TemplateConstants.KIND_EMAIL.equals(v);
        }
        return false;
    }

    // ----- helpers -----------------------------------------------------------

    private static ApiSymbol symbol(String name, ApiSymbolKind kind, String importFqn,
                                    String signature, String usage) {
        return symbol(name, kind, importFqn, signature, usage, null);
    }

    private static ApiSymbol symbol(String name, ApiSymbolKind kind, String importFqn,
                                    String signature, String usage, String returns) {
        return symbolWithFields(name, kind, importFqn, signature, usage, returns, List.of());
    }

    private static ApiSymbol symbolWithFields(String name, ApiSymbolKind kind, String importFqn,
                                              String signature, String usage, List<FieldShape> fields) {
        return symbolWithFields(name, kind, importFqn, signature, usage, null, fields);
    }

    private static ApiSymbol symbolWithFields(String name, ApiSymbolKind kind, String importFqn,
                                              String signature, String usage, String returns,
                                              List<FieldShape> fields) {
        return new ApiSymbol(
            name, kind, importFqn, signature,
            List.of(), usage, returns, null, null, fields);
    }

    private static String fqn(String javaPkg, String shortName) {
        return (javaPkg == null || javaPkg.isEmpty()) ? shortName : javaPkg + "." + shortName;
    }
}

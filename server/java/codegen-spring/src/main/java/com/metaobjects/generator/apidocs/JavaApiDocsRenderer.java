package com.metaobjects.generator.apidocs;

import com.metaobjects.render.Escapers;
import com.metaobjects.render.Provider;
import com.metaobjects.render.RenderRequest;
import com.metaobjects.render.Renderer;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Renders the {@link JavaApiModel} IR into Java-idiomatic api-doc markdown via the
 * production JVM {@link Renderer} (metaobjects-render) + classpath Mustache templates
 * under {@code /templates/api/} (resolved through {@link ClasspathTemplateProvider}).
 *
 * <p>One IR, three forms — all derived from the SAME model, never re-derived:
 * <ul>
 *   <li>{@link #renderUnitPage(ApiUnit, String)} — a per-unit HUMAN page (entity OR
 *       template), symbols grouped into ordered sections;</li>
 *   <li>{@link #renderIndex(JavaApiModel, DocsPaths.Layout)} — the consolidated index
 *       (one bullet per unit, entities vs templates), with collision-safe relative
 *       hrefs computed via {@link DocsPaths};</li>
 *   <li>{@link #renderAgentApi(JavaApiModel)} — the token-frugal AGENT form (per unit,
 *       symbols grouped under their import FQN).</li>
 * </ul>
 *
 * <p>This class is PRESENTATION ONLY: every symbol name comes from the IR (which keys
 * off the {@code SpringNaming} seam) and every path comes from {@link DocsPaths} — the
 * renderer never re-derives a name or a path. It builds a logic-light view-model per
 * page and hands it to the shared {@link Renderer} (markdown escaping = identity, so
 * the templates own all markdown literally).
 */
public final class JavaApiDocsRenderer {

    private static final String ENTITY_PAGE_REF = "api/entity-api";
    private static final String INDEX_REF = "api/index";
    private static final String AGENT_REF = "api/agent-api";

    private final Renderer renderer = new Renderer();
    private final Provider provider = new ClasspathTemplateProvider();

    // ------------------------------------------------------------------------
    // Section ORDER + HEADING per ApiSymbolKind. A unit's page renders only the
    // kinds it actually carries, always in this canonical order (so two runs over
    // the same model are byte-stable regardless of symbol order). DTO rides with
    // the Model section heading (the wire shape of the model).
    // ------------------------------------------------------------------------
    private static final List<ApiSymbolKind> KIND_ORDER = List.of(
        ApiSymbolKind.MODEL,
        ApiSymbolKind.DTO,
        ApiSymbolKind.DATA_ACCESS,
        ApiSymbolKind.REST,
        ApiSymbolKind.VALIDATION,
        ApiSymbolKind.EXTRACTOR,
        ApiSymbolKind.RENDER,
        ApiSymbolKind.PAYLOAD,
        ApiSymbolKind.PROMPT,
        ApiSymbolKind.OUTPUT_PARSER,
        ApiSymbolKind.FILTER,
        ApiSymbolKind.TRACE);

    private static String heading(ApiSymbolKind kind) {
        switch (kind) {
            case MODEL: return "Model";
            case DTO: return "DTO";
            case DATA_ACCESS: return "Data access";
            case REST: return "REST";
            case VALIDATION: return "Validation";
            case EXTRACTOR: return "Extractor";
            case RENDER: return "Render";
            case PAYLOAD: return "Payload";
            case PROMPT: return "Prompt";
            case OUTPUT_PARSER: return "Output parser";
            case FILTER: return "Filter";
            case TRACE: return "Trace";
            default: throw new IllegalArgumentException("unmapped kind: " + kind);
        }
    }

    /** Lowercase summary label per kind (keeps the proper-noun acronyms intact). */
    private static String summaryLabel(ApiSymbolKind kind) {
        switch (kind) {
            case MODEL: return "model";
            case DTO: return "DTO";
            case DATA_ACCESS: return "data access";
            case REST: return "REST";
            case VALIDATION: return "validation";
            case EXTRACTOR: return "extractor";
            case RENDER: return "render";
            case PAYLOAD: return "payload";
            case PROMPT: return "prompt";
            case OUTPUT_PARSER: return "output parser";
            case FILTER: return "filter";
            case TRACE: return "trace";
            default: throw new IllegalArgumentException("unmapped kind: " + kind);
        }
    }

    // ------------------------------------------------------------------------
    // Per-unit HUMAN page (entity OR template — keyed on unit.kind()).
    // ------------------------------------------------------------------------

    /**
     * Render one per-unit human reference page. {@code modelHref} (when non-null) is a
     * pre-computed relative href back to this unit's model/metadata page — the caller
     * (the Mojo) derives it via {@link DocsPaths#modelCrossHref}; the renderer only
     * places it. Pass {@code null} to omit the cross-link.
     */
    public String renderUnitPage(ApiUnit unit, String modelHref) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("node", unit.node());
        if (modelHref != null && !modelHref.isEmpty()) {
            payload.put("modelHref", modelHref);
        }
        payload.put("sections", sections(unit));
        return render(ENTITY_PAGE_REF, payload);
    }

    /** Group a unit's symbols into ordered sections (one per present kind). */
    private static List<Map<String, Object>> sections(ApiUnit unit) {
        List<Map<String, Object>> sections = new ArrayList<>();
        for (ApiSymbolKind kind : KIND_ORDER) {
            List<Map<String, Object>> symbols = new ArrayList<>();
            for (ApiSymbol sym : unit.symbols()) {
                if (sym.kind() == kind) {
                    symbols.add(symbolView(sym));
                }
            }
            if (symbols.isEmpty()) {
                continue;
            }
            Map<String, Object> section = new LinkedHashMap<>();
            section.put("heading", heading(kind));
            section.put("symbols", symbols);
            sections.add(section);
        }
        return sections;
    }

    private static Map<String, Object> symbolView(ApiSymbol sym) {
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("signature", sym.signature());
        view.put("usage", sym.usage());
        view.put("importFqn", sym.importFqn());
        if (sym.returns() != null && !sym.returns().isEmpty()) {
            view.put("returns", sym.returns());
        }
        if (sym.throwsNote() != null && !sym.throwsNote().isEmpty()) {
            view.put("throwsNote", sym.throwsNote());
        }
        List<Map<String, Object>> rows = fieldRows(sym.fields());
        if (!rows.isEmpty()) {
            view.put("hasFields", Boolean.TRUE);
            view.put("fieldRows", rows);
        }
        return view;
    }

    /** Escape a markdown table cell whose text may contain a {@code |} (enum value lists do). */
    private static String mdCell(String text) {
        return text.replace("|", "\\|");
    }

    /** Field / Type / Required / Notes rows; required = !optional rendered yes/no. */
    private static List<Map<String, Object>> fieldRows(List<FieldShape> fields) {
        List<Map<String, Object>> rows = new ArrayList<>();
        for (FieldShape f : fields) {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("field", f.name());
            row.put("type", mdCell(f.type()));
            row.put("required", f.optional() ? "no" : "yes");
            row.put("notes", mdCell(f.note() == null ? "" : f.note()));
            rows.add(row);
        }
        return rows;
    }

    // ------------------------------------------------------------------------
    // Consolidated index (README.md).
    // ------------------------------------------------------------------------

    /**
     * Render the consolidated api index (one bullet per unit, entities vs templates),
     * placed at the api root ({@code README.md}). Each unit's href is the relative link
     * from the index to the unit's page in the given {@code layout}.
     */
    public String renderIndex(JavaApiModel model, DocsPaths.Layout layout) {
        List<ApiUnit> entities = new ArrayList<>();
        List<ApiUnit> templates = new ArrayList<>();
        for (ApiUnit u : model.units()) {
            if ("template".equals(u.kind())) {
                templates.add(u);
            } else {
                entities.add(u);
            }
        }
        entities.sort(Comparator.comparing(ApiUnit::node));
        templates.sort(Comparator.comparing(ApiUnit::node));

        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("title", "API Reference");
        payload.put("intro", "Generated public API surface, one page per entity and output template.");
        payload.put("hasEntities", !entities.isEmpty());
        payload.put("entities", indexRows(entities, layout));
        payload.put("hasTemplates", !templates.isEmpty());
        payload.put("templates", indexRows(templates, layout));
        return render(INDEX_REF, payload);
    }

    private static List<Map<String, Object>> indexRows(List<ApiUnit> units, DocsPaths.Layout layout) {
        List<Map<String, Object>> rows = new ArrayList<>();
        for (ApiUnit u : units) {
            // The index lives at the api root (README.md); link to each unit's page via
            // the same DocsPaths math the emission uses, so it resolves in BOTH layouts.
            String href = DocsPaths.surfaceCrossHref(
                "README.md", DocsPaths.docPageOutputPath(layout, u.pkg(), u.node()));
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("node", u.node());
            row.put("href", href);
            row.put("summary", summary(u));
            row.put("symbolCount", u.symbols().size());
            rows.add(row);
        }
        return rows;
    }

    /** A one-line summary of a unit's symbol counts per kind, in canonical order. */
    private static String summary(ApiUnit unit) {
        List<String> parts = new ArrayList<>();
        for (ApiSymbolKind kind : KIND_ORDER) {
            int n = 0;
            for (ApiSymbol s : unit.symbols()) {
                if (s.kind() == kind) {
                    n++;
                }
            }
            if (n == 0) {
                continue;
            }
            String label = summaryLabel(kind);
            parts.add(n == 1 ? label : n + " " + label);
        }
        return parts.isEmpty() ? "no public symbols" : String.join(", ", parts);
    }

    // ------------------------------------------------------------------------
    // Condensed AGENT form (AGENT-API.md).
    // ------------------------------------------------------------------------

    /**
     * Render the condensed agent/LLM form: per unit, symbols grouped under a single
     * import-FQN header then one compact {@code `signature` — usage} line each. NO
     * prose/field-tables (token budget). Units + symbols keep their IR order.
     */
    public String renderAgentApi(JavaApiModel model) {
        List<Map<String, Object>> units = new ArrayList<>();
        for (ApiUnit u : model.units()) {
            if (u.symbols().isEmpty()) {
                continue;
            }
            Map<String, Object> unitView = new LinkedHashMap<>();
            unitView.put("node", u.node());
            unitView.put("groups", agentGroups(u));
            units.add(unitView);
        }
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("title", "Agent API Reference");
        payload.put("project", model.project());
        payload.put("importNote", "Imports are fully-qualified types in your repository's source set.");
        payload.put("units", units);
        return render(AGENT_REF, payload);
    }

    /** Group a unit's symbols by import FQN (first-appearance order), one header each. */
    private static List<Map<String, Object>> agentGroups(ApiUnit unit) {
        Map<String, List<Map<String, Object>>> byFqn = new LinkedHashMap<>();
        for (ApiSymbol s : unit.symbols()) {
            Map<String, Object> line = new LinkedHashMap<>();
            line.put("signature", s.signature());
            line.put("usage", s.usage());
            byFqn.computeIfAbsent(s.importFqn(), k -> new ArrayList<>()).add(line);
        }
        List<Map<String, Object>> groups = new ArrayList<>();
        for (Map.Entry<String, List<Map<String, Object>>> e : byFqn.entrySet()) {
            Map<String, Object> group = new LinkedHashMap<>();
            group.put("importFqn", e.getKey());
            group.put("symbols", e.getValue());
            groups.add(group);
        }
        return groups;
    }

    // ------------------------------------------------------------------------

    private String render(String ref, Map<String, Object> payload) {
        return renderer.render(new RenderRequest(
            null, ref, payload, provider, Escapers.FORMAT_MARKDOWN, null, null));
    }
}

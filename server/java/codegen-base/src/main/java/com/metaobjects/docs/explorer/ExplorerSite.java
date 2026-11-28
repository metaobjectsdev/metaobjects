package com.metaobjects.docs.explorer;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.metaobjects.docsview.DocsView;
import com.metaobjects.docsview.ExplorerModelScript;
import com.metaobjects.template.TemplateConstants;

import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/**
 * The model explorer as one browser app over the docs view, written with no Node on the path: the
 * JVM side of TypeScript's {@code generateExplorerSite} ({@code output: "app"}). The Java and Kotlin
 * {@code docs-site} generators both write through here.
 *
 * <p>What it writes, relative to the site directory:</p>
 * <pre>
 *   index.html, assets/explorer-app.js,          the app: the same bytes in every port, from the
 *   assets/cytoscape.min.js,                     repository's explorer-app/ (synced into this
 *   assets/3d-force-graph.min.js                 jar by scripts/sync-explorer-app.sh)
 *   assets/explorer.css, assets/explorer.js      the theme, or the project's owned copy
 *   explorer-model.js                            the docs view, the prompt texts, the title, the
 *                                                footer and any owned templates, as one script
 *   explorer-stamp.js                            the model's hash, which the open app polls
 *   explorer.json                                the docs view itself, byte for byte
 * </pre>
 *
 * <p>The page-per-screen static export ({@code output: "static"}) draws its pages with the
 * TypeScript page code and stays in TypeScript.</p>
 */
public final class ExplorerSite {

    private ExplorerSite() {}

    /** The data files the app reads, beside its shell. */
    public static final String MODEL_FILE = "explorer-model.js";
    public static final String STAMP_FILE = "explorer-stamp.js";
    public static final String VIEW_FILE = "explorer.json";

    /** The app's files: every port ships the same bytes (TypeScript's {@code EXPLORER_APP_FILES}). */
    public static final List<String> APP_FILES = List.of(
        "index.html",
        "assets/explorer-app.js",
        "assets/explorer.css",
        "assets/explorer.js",
        "assets/cytoscape.min.js",
        "assets/3d-force-graph.min.js");

    /** The theme pair a project may own ({@code assets/} under the owned docs-site directory). */
    public static final List<String> THEME_ASSETS = List.of("explorer.css", "explorer.js");

    /** The templates an owned theme may replace; the app uses an owned one in place of its own. */
    public static final List<String> TEMPLATE_NAMES = List.of(
        "explorer-head.mustache",
        "explorer-foot.mustache",
        "explorer-card.mustache",
        "explorer-overview.html.mustache",
        "explorer-map.html.mustache",
        "explorer-object.html.mustache",
        "explorer-node.html.mustache",
        "explorer-prompt.html.mustache",
        "explorer-prompts.html.mustache",
        "explorer-requirements.html.mustache",
        "explorer-requirement.html.mustache",
        "explorer-matrix.html.mustache",
        "explorer-trace.html.mustache",
        "explorer-gaps.html.mustache",
        "explorer-api.html.mustache",
        "explorer-model.html.mustache",
        "explorer-package.html.mustache");

    /** Where this jar carries its copy of {@code explorer-app/}. */
    static final String APP_RESOURCE_ROOT = "metaobjects/explorer-app/";

    /**
     * What the site is built from.
     *
     * @param view       the docs view ({@link DocsView#build})
     * @param title      the project's name, as the header and the home page print it
     * @param footer     printed in every footer; {@code ""} for none
     * @param texts      prompt text by template node id
     * @param assetsDir  an owned theme directory (holding {@code explorer.css}, {@code explorer.js}), or null
     * @param templatesDir an owned templates directory, or null
     */
    public record Input(JsonObject view, String title, String footer, Map<String, String> texts,
                        Path assetsDir, Path templatesDir) {}

    /** Every file of the site, site-relative, in write order. */
    public static Map<String, String> emit(Input in) {
        Map<String, String> files = new LinkedHashMap<>();
        for (String f : APP_FILES) {
            String asset = f.startsWith("assets/") ? f.substring("assets/".length()) : null;
            if (asset != null && THEME_ASSETS.contains(asset)) continue;
            files.put(f, resource(f));
        }
        for (String a : THEME_ASSETS) {
            String owned = readIfPresent(in.assetsDir(), a);
            files.put("assets/" + a, owned != null ? owned : resource("assets/" + a));
        }
        Map<String, String> templates = new TreeMap<>();
        for (String name : TEMPLATE_NAMES) {
            String owned = readIfPresent(in.templatesDir(), name);
            if (owned != null) templates.put(name, owned);
        }
        ModelScript model = modelScript(in.title(), in.footer(), in.texts(), templates, in.view());
        files.put(MODEL_FILE, model.script());
        files.put(STAMP_FILE, stampScript(model.stamp()));
        files.put(VIEW_FILE, DocsView.serialize(in.view()));
        return files;
    }

    /** The app's data script and the stamp it carries. */
    public record ModelScript(String script, String stamp) {}

    /**
     * The app's data file: one script setting {@code window.MO_MODEL}, whose stamp the stamp file
     * repeats ({@link ExplorerModelScript}, the same bytes as TypeScript's {@code explorerModelScript}).
     */
    public static ModelScript modelScript(String title, String footer, Map<String, String> texts,
                                          Map<String, String> templates, JsonObject view) {
        ExplorerModelScript m = ExplorerModelScript.of(title, footer, texts, templates, view);
        return new ModelScript(m.script(), m.stamp());
    }

    /** The file the app polls. */
    public static String stampScript(String stamp) {
        return ExplorerModelScript.stampScript(stamp);
    }

    /**
     * Each prompt's {@code .mustache} text from the directories its {@code @textRef} resolves in,
     * by template node id. A ref that is absolute or climbs out with {@code ..} is not read, so a
     * model cannot pull an arbitrary file into a published page.
     */
    public static Map<String, String> readPromptTexts(JsonObject view, List<Path> dirs) {
        Map<String, String> out = new TreeMap<>();
        for (JsonElement el : view.getAsJsonArray("nodes")) {
            JsonObject n = el.getAsJsonObject();
            String ref = null;
            for (JsonElement a : n.getAsJsonArray("attrs")) {
                JsonObject attr = a.getAsJsonObject();
                if (TemplateConstants.ATTR_TEXT_REF.equals(attr.get("name").getAsString())
                        && attr.get("value").isJsonPrimitive() && attr.get("value").getAsJsonPrimitive().isString()) {
                    ref = attr.get("value").getAsString();
                }
            }
            if (ref == null) continue;
            String[] segments = ref.split("[\\\\/]", -1);
            boolean unsafe = Path.of(ref).isAbsolute() || ref.startsWith("/") || ref.startsWith("\\");
            for (String s : segments) if (s.isEmpty() || s.equals("..")) unsafe = true;
            if (unsafe) continue;
            for (Path d : dirs) {
                Path p = d;
                for (int i = 0; i < segments.length; i++) {
                    p = p.resolve(i == segments.length - 1 ? segments[i] + ".mustache" : segments[i]);
                }
                if (Files.isRegularFile(p)) {
                    out.put(n.get("id").getAsString(), read(p));
                    break;
                }
            }
        }
        return out;
    }

    private static String readIfPresent(Path dir, String name) {
        if (dir == null) return null;
        Path p = dir.resolve(name);
        return Files.isRegularFile(p) ? read(p) : null;
    }

    private static String read(Path p) {
        try {
            return Files.readString(p, StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new UncheckedIOException("docs-site: could not read " + p, e);
        }
    }

    /** A file of this jar's copy of the explorer app. */
    static String resource(String rel) {
        String path = APP_RESOURCE_ROOT + rel;
        try (InputStream in = ExplorerSite.class.getClassLoader().getResourceAsStream(path)) {
            if (in == null) throw new IllegalStateException("docs-site: the explorer app file " + path + " is not on the classpath");
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new UncheckedIOException("docs-site: could not read " + path, e);
        }
    }
}

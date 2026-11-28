package com.metaobjects.docsview;

import com.google.gson.JsonObject;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.Map;
import java.util.TreeMap;

/**
 * The explorer app's two data scripts, serialized beside the docs view they carry: the same shape
 * and bytes as TypeScript's {@code explorerModelScript} and {@code explorerStampScript}
 * ({@code @metaobjectsdev/docs-site}).
 *
 * @param script {@code window.MO_MODEL = {...};} — the view, the prompt texts, the title, the
 *               footer and any owned templates
 * @param stamp  the first 16 hex digits of the SHA-256 of the model's compact JSON without the stamp
 */
public record ExplorerModelScript(String script, String stamp) {

    /** The model script for these inputs; texts and templates are written in key order. */
    public static ExplorerModelScript of(String title, String footer, Map<String, String> texts,
                                         Map<String, String> templates, JsonObject view) {
        JsonObject rest = new JsonObject();
        rest.addProperty("title", title);
        rest.addProperty("footer", footer == null ? "" : footer);
        rest.add("texts", sortedStrings(texts));
        rest.add("templates", sortedStrings(templates));
        rest.add("view", view);
        String json = DocsViewJson.compact(rest);
        String stamp = sha256(json).substring(0, 16);
        return new ExplorerModelScript("window.MO_MODEL = {\"stamp\":" + DocsViewJson.quote(stamp) + "," + json.substring(1) + ";\n", stamp);
    }

    /** The stamp file the open app polls: {@code window.MO_STAMP = "<stamp>";}. */
    public static String stampScript(String stamp) {
        return "window.MO_STAMP = " + DocsViewJson.quote(stamp) + ";\n";
    }

    private static JsonObject sortedStrings(Map<String, String> m) {
        JsonObject o = new JsonObject();
        for (Map.Entry<String, String> e : new TreeMap<>(m == null ? Map.<String, String>of() : m).entrySet()) {
            o.addProperty(e.getKey(), e.getValue());
        }
        return o;
    }

    private static String sha256(String s) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(s.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }
}

package com.metaobjects.io.json;

import com.google.gson.JsonElement;
import com.metaobjects.MetaData;
import com.metaobjects.MetaRoot;
import com.metaobjects.docsview.DocsView;

/**
 * UI-1 — the metadata API contract.
 *
 * <p>Java ships the helper and not a mount: {@code core-spring} carries
 * {@code spring-context} but no {@code spring-web}, and adding a web dependency
 * for one endpoint would put it on every consumer. Mount it yourself:
 *
 * <pre>
 * &#64;GetMapping(value = "/api" + MetaEndpoint.META_ROUTE_PATH,
 *             produces = MediaType.APPLICATION_JSON_VALUE)
 * public String meta() { return MetaEndpoint.metaJson(root); }
 * </pre>
 *
 * <p>Guard that route with your own authorization — {@code /_meta} publishes the
 * shape of the model, though no row data.
 *
 * <p>Beside it, {@link #META_DOCS_ROUTE_PATH} serves the same model as its docs view, the
 * document the model explorer reads ({@code docs/features/metadata-api.md}). Build one
 * {@link Docs} per loaded model, keep it, and answer from it:
 *
 * <pre>
 * private final MetaEndpoint.Docs docs = MetaEndpoint.docs(root);
 *
 * &#64;GetMapping("/api" + MetaEndpoint.META_DOCS_ROUTE_PATH)
 * public ResponseEntity&lt;String&gt; docs(&#64;RequestHeader(value = "If-None-Match", required = false) String tag) {
 *   var ok = docs.matches(tag) ? ResponseEntity.status(HttpStatus.NOT_MODIFIED) : ResponseEntity.ok();
 *   ok.eTag(docs.etag()).cacheControl(CacheControl.noCache()).contentType(MediaType.APPLICATION_JSON);
 *   return docs.matches(tag) ? ok.build() : ok.body(docs.body());
 * }
 * </pre>
 */
public final class MetaEndpoint {

    private MetaEndpoint() {}

    /**
     * The endpoint path, mounted under the host's API prefix. A cross-port contract
     * value — one browser read-model works against every backend.
     */
    public static final String META_ROUTE_PATH = "/_meta";

    /**
     * The response body: the model as EFFECTIVE canonical JSON, so a browser reading
     * it never resolves {@code extends} itself.
     */
    public static String metaJson(MetaData root) {
        return CanonicalJsonSerializer.canonicalSerializeEffective(root);
    }

    /**
     * The docs view endpoint's path, mounted under the host's API prefix beside
     * {@link #META_ROUTE_PATH}. A cross-port contract value: the model explorer reads
     * {@code GET {apiPrefix}/_meta/docs} from any backend.
     */
    public static final String META_DOCS_ROUTE_PATH = META_ROUTE_PATH + "/docs";

    /**
     * The {@code GET {apiPrefix}/_meta/docs} response body: the loaded model's docs view, built
     * from the model alone (no verify payload, no generation manifest, which a running
     * application does not hold), with the same bytes every port writes for the same model.
     */
    public static String metaDocsJson(MetaRoot root) {
        return metaDocsJson(root, null);
    }

    /** {@link #metaDocsJson(MetaRoot)} with the routes the application mounts
     *  ({@code [{ node, method, path }]}, {@code node} a resolution key), listed on each node. */
    public static String metaDocsJson(MetaRoot root, JsonElement routes) {
        return DocsView.serialize(DocsView.build(root, null, null, routes));
    }

    /** The docs view of one loaded model, built once: the model is immutable after load. */
    public static Docs docs(MetaRoot root) {
        return new Docs(metaDocsJson(root));
    }

    /** {@link #docs(MetaRoot)} with the application's routes. */
    public static Docs docs(MetaRoot root, JsonElement routes) {
        return new Docs(metaDocsJson(root, routes));
    }

    /** A built docs view body and its strong {@code ETag}. */
    public static final class Docs {
        private final String body;
        private final String etag;

        private Docs(String body) {
            this.body = body;
            this.etag = metaDocsEtag(body);
        }

        public String body() { return body; }

        public String etag() { return etag; }

        /** Whether an {@code If-None-Match} value names this body's tag (or is {@code *}): answer 304. */
        public boolean matches(String ifNoneMatch) { return etagMatches(ifNoneMatch, etag); }
    }

    /**
     * A strong ETag for a docs view body: its length and the 32-bit FNV-1a hash of its UTF-16
     * code units, quoted, the same value TypeScript's mount sends. The contract is only that the
     * tag changes when the body does; a client compares it and never parses it.
     */
    public static String metaDocsEtag(String body) {
        int h = 0x811c9dc5;
        for (int i = 0; i < body.length(); i++) {
            h ^= body.charAt(i);
            h *= 0x01000193;
        }
        String hex = Integer.toHexString(h);
        return "\"" + Integer.toHexString(body.length()) + "-" + "0".repeat(8 - hex.length()) + hex + "\"";
    }

    /** Whether an {@code If-None-Match} header value names {@code etag} (or is {@code *}). */
    public static boolean etagMatches(String ifNoneMatch, String etag) {
        if (ifNoneMatch == null || ifNoneMatch.isEmpty()) return false;
        for (String t : ifNoneMatch.split(",")) {
            String v = t.trim();
            if (v.startsWith("W/")) v = v.substring(2);
            if (v.equals("*") || v.equals(etag)) return true;
        }
        return false;
    }
}

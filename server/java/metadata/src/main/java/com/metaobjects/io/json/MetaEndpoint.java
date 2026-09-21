package com.metaobjects.io.json;

import com.metaobjects.MetaData;

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
}

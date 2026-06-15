/*
 * Copyright 2003 Doug Mealing LLC dba Meta Objects
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
package com.metaobjects;

import com.metaobjects.field.MetaField;
import com.metaobjects.object.MetaObject;
import com.metaobjects.registry.MetaDataRegistry;
import com.metaobjects.validator.MetaValidator;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.List;

/**
 * MetaRoot — the tree-root node for a loaded metadata document.
 *
 * <p>Type: {@code metadata}, subType: {@code root}. Mirrors the TypeScript
 * {@code MetaRoot} class; extends {@link MetaData} directly with no model
 * wrapper or metaOf() indirection.</p>
 *
 * <p>As of H3a Task 4, {@code MetaDataLoader} is a plain class (no longer a
 * {@link MetaData}) that <em>produces</em> a {@code MetaRoot}. The MetaRoot is
 * the actual tree-root node — all loaded objects/fields attach as its children.
 * The loader registers itself on the root via {@link #setLoader}, so that
 * {@link MetaData#getLoader()} (which walks up to the root) can still hand
 * back the owning loader for every node in the tree.</p>
 *
 * @author Doug Mealing
 * @version 6.0.0
 * @since H3a
 * @see MetaData#TYPE_METADATA
 * @see MetaData#SUBTYPE_ROOT
 * @see com.metaobjects.loader.MetaDataLoader
 */
public class MetaRoot extends MetaData {

    private static final Logger log = LoggerFactory.getLogger(MetaRoot.class);

    /**
     * The MetaDataLoader that produced and owns this root node.
     * Set by the loader during construction; allows {@link MetaData#getLoader()}
     * to resolve the owning loader by walking up to the root.
     */
    private transient com.metaobjects.loader.MetaDataLoader owningLoader;

    /**
     * True when the root's name was synthesized from an empty/null loader name
     * (cross-port parity: TS / C# / Python all treat "no authored package" as
     * absence, never as a literal "root" package). Set by {@link
     * com.metaobjects.loader.MetaDataLoader} when it falls back to the
     * sentinel; the canonical serializer reads this to suppress emission of a
     * spurious top-level {@code package} key.
     */
    private transient boolean synthesizedName = false;

    // metadata.root accepts the same top-level children as metadata.base; it is
    // the concrete tree-root produced by MetaDataLoader. Its registration is wired
    // into the ServiceLoader bootstrap (CoreTypeMetaDataProvider), invoked on first
    // MetaDataRegistry.getInstance() — including isolated registries created via
    // MetaDataRegistry.createWithCoreProviders(). A self-registering static{} block
    // here is intentionally absent: bootstrapping the registry from this class's
    // <clinit> created a class-init cycle (see the matching note in MetaData).

    /**
     * Registers the metadata.root type with the supplied registry.
     * Invoked via CoreTypeMetaDataProvider on the ServiceLoader bootstrap.
     *
     * @param registry the registry to register with
     */
    public static void registerTypes(MetaDataRegistry registry) {
        try {
            // ADR-0006 Rule 1 — a bare `metadata:` YAML key fuses to `metadata.root`.
            // Register the default subType UNCONDITIONALLY, before the type-registration
            // idempotency guard below. Otherwise, when the metadata.root TYPE is already
            // registered (e.g. a fresh runtime MetaDataLoader bootstrap, or a registry
            // pre-seeded on another path), this method returned early and never set the
            // default — so a bare `metadata:` root failed to desugar with
            // "type 'metadata' has no default subType".
            registry.setDefaultSubType(TYPE_METADATA, SUBTYPE_ROOT);
            // Idempotent: skip if metadata.root is already registered (the
            // provider may run against a registry that already has it).
            if (registry.isRegistered(TYPE_METADATA, SUBTYPE_ROOT)) {
                return;
            }
            // FR-033 (sub-step B2b) — metadata.root is the document-root WRAPPER, not
            // declared in any spec/metamodel/*.json provider file (both this port and
            // the TS reference HAND-CODE the root; it is the single documented
            // hand-coded exception to the JSON-sourced model). The manifest's
            // STRUCTURAL children block must byte-match the cross-port golden:
            // description "Root metadata document" and EXACTLY the four genuinely-open
            // structural wildcards a document root legitimately holds — object / field
            // / validator / template (mirrors the TS reference core-types.ts
            // `def(TYPE_METADATA, SUBTYPE_ROOT, "Root metadata document",
            // [wildcard(TYPE_OBJECT), wildcard(TYPE_FIELD), wildcard(TYPE_VALIDATOR),
            // wildcard(TYPE_TEMPLATE)])`). The previously-registered
            // view/identity/relationship/layout STRUCTURAL root wildcards are removed
            // to match the strict contract.
            //
            // The any-attr wildcard (attr/"*"/"*") is RETAINED: it is NOT a structural
            // child (the emitter classifies attr-typed wildcards into the attrs facet,
            // not the children graph, so root still emits attrs:[] and the four
            // children — byte-identical to the golden), and the Java loader runtime
            // legitimately attaches metadata attributes directly to the loader root
            // node (e.g. document-level attrs via MetaRoot.addMetaAttr). Dropping it
            // would break that runtime capability without changing the manifest.
            registry.registerType(MetaRoot.class, def -> def
                .type(TYPE_METADATA).subType(SUBTYPE_ROOT)
                .description("Root metadata document")
                .optionalChild(MetaObject.TYPE_OBJECT, "*", "*")
                .optionalChild(MetaField.TYPE_FIELD, "*", "*")
                .optionalChild(MetaValidator.TYPE_VALIDATOR, "*", "*")
                .optionalChild(com.metaobjects.template.TemplateConstants.TYPE_TEMPLATE, "*", "*")
                .optionalChild(com.metaobjects.attr.MetaAttribute.TYPE_ATTR, "*", "*")
            );
            log.debug("Registered MetaRoot type (metadata.root) with unified registry");
        } catch (Exception e) {
            log.error("Failed to register MetaRoot type with unified registry", e);
        }
    }

    /**
     * Constructs a MetaRoot with the given fully-qualified name.
     *
     * @param name the fully-qualified name of this root node (e.g. the package
     *             or document identifier)
     */
    public MetaRoot(String name) {
        super(TYPE_METADATA, SUBTYPE_ROOT, name);
    }

    /**
     * Returns the MetaDataLoader that produced this root, or {@code null} if
     * this root was constructed without a loader.
     *
     * @return the owning loader, or {@code null}
     */
    @Override
    public com.metaobjects.loader.MetaDataLoader getLoader() {
        return owningLoader;
    }

    /**
     * Associates this root with the loader that produced it.
     * Called by {@link com.metaobjects.loader.MetaDataLoader} during construction.
     *
     * @param loader the owning loader
     */
    public void setLoader(com.metaobjects.loader.MetaDataLoader loader) {
        this.owningLoader = loader;
    }

    /** True when this root's name is the synthesized sentinel (no authored package). */
    public boolean hasSynthesizedName() {
        return synthesizedName;
    }

    /** Loader-only: mark this root as having a synthesized (non-authored) name. */
    public void markSynthesizedName() {
        this.synthesizedName = true;
    }

    /**
     * Returns all {@code object} children of this root node.
     *
     * @return list of MetaObject children; empty list if none
     */
    public List<MetaObject> objects() {
        return useCache("objects()", () -> getChildren(MetaObject.class, false));
    }

    /**
     * Returns all {@code field} children of this root node.
     * Root-level fields are rare but legal (e.g. shared abstract id fields).
     *
     * @return list of MetaField children; empty list if none
     */
    public List<MetaField> fields() {
        return useCache("fields()", () -> getChildren(MetaField.class, false));
    }

    /**
     * Finds an {@code object} child by name.
     *
     * @param name the object name to look up
     * @return the matching MetaObject, or {@code null} if not found
     */
    public MetaObject findObject(String name) {
        return useCache("findObject()", name, n -> {
            try {
                return getChild(n, MetaObject.class, false);
            } catch (MetaDataNotFoundException e) {
                return null;
            }
        });
    }
}

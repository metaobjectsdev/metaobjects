/*
 * Copyright 2003 Doug Mealing LLC dba Meta Objects. All Rights Reserved.
 *
 * This software is the proprietary information of Doug Mealing LLC dba Meta Objects.
 * Use is subject to license terms.
 */
package com.metaobjects;

import com.metaobjects.attr.MetaAttribute;
import com.metaobjects.field.MetaField;
import com.metaobjects.object.MetaObject;
import com.metaobjects.registry.MetaDataRegistry;
import com.metaobjects.validator.MetaValidator;
import com.metaobjects.view.MetaView;
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

    // Self-registration of the metadata.root type with the unified registry.
    // metadata.root accepts the same top-level children as metadata.base; it is
    // the concrete tree-root produced by MetaDataLoader.
    static {
        try {
            MetaDataRegistry.getInstance().registerType(MetaRoot.class, def -> def
                .type(TYPE_METADATA).subType(SUBTYPE_ROOT)
                .description("Root metadata node — tree root produced by MetaDataLoader")

                // ROOT LEVEL accepts all top-level metadata types
                .optionalChild(MetaObject.TYPE_OBJECT, "*", "*")            // Any object type
                .optionalChild(MetaField.TYPE_FIELD, "*", "*")              // Any field type
                .optionalChild(MetaAttribute.TYPE_ATTR, "*", "*")           // Any attribute type
                .optionalChild(MetaValidator.TYPE_VALIDATOR, "*", "*")      // Any validator type
                .optionalChild(MetaView.TYPE_VIEW, "*", "*")                // Any view type
                .optionalChild(com.metaobjects.identity.MetaIdentity.TYPE_IDENTITY, "*", "*")        // Any identity type
                .optionalChild(com.metaobjects.relationship.MetaRelationship.TYPE_RELATIONSHIP, "*", "*") // Any relationship type
                .optionalChild("layout", "*", "*")                          // Any layout type (root-level shared layouts)
                .optionalChild(com.metaobjects.template.TemplateConstants.TYPE_TEMPLATE, "*", "*") // Any template type (FR-004)
            );
            // ADR-0006 Rule 1 — bare `metadata:` YAML key fuses to `metadata.root`.
            MetaDataRegistry.getInstance().setDefaultSubType(TYPE_METADATA, SUBTYPE_ROOT);
            log.debug("Registered MetaRoot type (metadata.root) with unified registry");
        } catch (Exception e) {
            log.error("Failed to register MetaRoot type with unified registry", e);
        }
    }

    /**
     * Registers the metadata.root type with the supplied registry.
     * Provided for parity with {@link MetaData#registerTypes(MetaDataRegistry)};
     * the static initializer already self-registers against the singleton.
     *
     * @param registry the registry to register with
     */
    public static void registerTypes(MetaDataRegistry registry) {
        try {
            registry.registerType(MetaRoot.class, def -> def
                .type(TYPE_METADATA).subType(SUBTYPE_ROOT)
                .description("Root metadata node — tree root produced by MetaDataLoader")
                .optionalChild(MetaObject.TYPE_OBJECT, "*", "*")
                .optionalChild(MetaField.TYPE_FIELD, "*", "*")
                .optionalChild(MetaAttribute.TYPE_ATTR, "*", "*")
                .optionalChild(MetaValidator.TYPE_VALIDATOR, "*", "*")
                .optionalChild(MetaView.TYPE_VIEW, "*", "*")
                .optionalChild(com.metaobjects.identity.MetaIdentity.TYPE_IDENTITY, "*", "*")
                .optionalChild(com.metaobjects.relationship.MetaRelationship.TYPE_RELATIONSHIP, "*", "*")
                .optionalChild("layout", "*", "*")
                .optionalChild(com.metaobjects.template.TemplateConstants.TYPE_TEMPLATE, "*", "*")
            );
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

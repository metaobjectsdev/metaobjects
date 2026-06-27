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

import com.metaobjects.attr.BooleanAttribute;
import com.metaobjects.attr.MetaAttribute;
import com.metaobjects.attr.StringAttribute;
import com.metaobjects.field.MetaField;
// ✅ MIGRATED: MetaKey import removed - using MetaRelationship instead
import com.metaobjects.object.MetaObject;
import com.metaobjects.validator.MetaValidator;
import com.metaobjects.view.MetaView;
import com.metaobjects.loader.MetaDataLoader;
// Using unified registry instead
import com.metaobjects.registry.MetaDataRegistry;
import com.metaobjects.constraint.ConstraintEnforcer;
import com.metaobjects.constraint.PlacementConstraint;
import com.metaobjects.cache.CacheStrategy;
import com.metaobjects.cache.HybridCache;
import com.metaobjects.collections.IndexedMetaDataCollection;
import com.metaobjects.source.CodeSource;
import com.metaobjects.source.ErrorSource;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.Serializable;
import java.lang.ref.WeakReference;
import java.lang.reflect.InvocationTargetException;
import java.util.*;
import java.util.function.Predicate;
import java.util.stream.Stream;

/**
 * MetaData represents the core metadata definition in the MetaObjects framework.
 * 
 * <p>MetaData follows a <strong>READ-OPTIMIZED WITH CONTROLLED MUTABILITY</strong> design pattern 
 * analogous to Java's Class/Field reflection system with dynamic class loading. MetaData objects 
 * are loaded once during application startup and optimized for heavy read access throughout 
 * the application lifetime.</p>
 * 
 * <strong>Architecture Pattern:</strong>
 * <ul>
 * <li><strong>Load Once</strong>: Like ClassLoader, expensive startup for permanent benefit</li>
 * <li><strong>Read Many</strong>: Optimized for thousands of concurrent read operations</li>
 * <li><strong>Thread Safe</strong>: Immutable after loading, no synchronization needed for reads</li>
 * <li><strong>Cleanup-Friendly</strong>: WeakHashMap and weak references keep the registry safe under dynamic class loading and prevent ClassLoader leaks</li>
 * <li><strong>Memory Efficient</strong>: Smart caching balances performance with memory cleanup</li>
 * </ul>
 * 
 * <strong>Usage Examples:</strong>
 * <pre>{@code
 * // Loading Phase - Happens once at startup
 * MetaDataLoader loader = MetaDataLoader.fromResources("myLoader",
 *     Arrays.asList("com/example/metadata.json"));
 * // OR: loader = new MetaDataLoader(...); loader.setSourceURIs(...); loader.init();
 * 
 * // Runtime Phase - All operations are READ-ONLY
 * MetaObject userMeta = loader.getMetaObjectByName("User");  // O(1) lookup
 * MetaField field = userMeta.getMetaField("email");          // Cached access
 * }</pre>
 * 
 * <strong>Performance Characteristics:</strong>
 * <ul>
 * <li><strong>Loading Phase</strong>: 100ms-1s (acceptable one-time cost)</li>
 * <li><strong>Runtime Reads</strong>: 1-10μs (cached, immutable access)</li>
 * <li><strong>Memory Overhead</strong>: 10-50MB (permanent metadata residence)</li>
 * <li><strong>Concurrent Readers</strong>: Unlimited (no lock contention)</li>
 * </ul>
 * 
 * @author Doug Mealing
 * @version 6.0.0
 * @since 1.0
 * @see MetaDataLoader
 * @see com.metaobjects.object.MetaObject
 * @see com.metaobjects.field.MetaField
 */
public class MetaData implements Cloneable, Serializable {

    private static final Logger log = LoggerFactory.getLogger(MetaData.class);

    // Type-safe class constants for common usage
    public static final Class<MetaData> METADATA_CLASS = MetaData.class;

    // === SEPARATORS ===
    public final static String PKG_SEPARATOR = "::";
    public final static String SEPARATOR = PKG_SEPARATOR;

    // === UNIVERSAL ATTRIBUTE NAMES (apply to all MetaData) ===
    /** Universal attribute for abstract metadata marker */
    public static final String ATTR_IS_ABSTRACT = "isAbstract";

    /** Universal attribute for description */
    public static final String ATTR_DESCRIPTION = "description";

    /** Standard attribute name for 'name' */
    public static final String ATTR_NAME = "name";

    /** Standard attribute name for 'type' */
    public static final String ATTR_TYPE = "type";

    /** Standard attribute name for 'subType' */
    public static final String ATTR_SUBTYPE = "subType";

    /** Standard attribute name for 'package' */
    public static final String ATTR_PACKAGE = "package";

    /** Standard attribute name for 'children' */
    public static final String ATTR_CHILDREN = "children";

    /** Standard attribute name for 'metadata' (root element) */
    public static final String ATTR_METADATA = "metadata";

    // === VALIDATION PATTERNS ===
    /** Valid name pattern for MetaData identifiers */
    public static final String VALID_NAME_PATTERN = "^[a-zA-Z][a-zA-Z0-9_]*$";

    // === ROOT TYPE CONSTANTS ===
    /** Root metadata type constant - MetaData owns this concept */
    public static final String TYPE_METADATA = "metadata";

    /** Root metadata subtype for metadata file structure */
    public static final String SUBTYPE_BASE = "base";

    /** Root metadata subtype for the tree-root node (MetaRoot) */
    public static final String SUBTYPE_ROOT = "root";

    // Registered via CoreTypeMetaDataProvider on the ServiceLoader bootstrap.
    /**
     * Register MetaData as metadata.base with abstract requirements constraints.
     * This creates metadata.base which defines metadata file structure and enforces
     * that most metadata types must be abstract under the root (except objects).
     *
     * @param registry The MetaDataRegistry to register with
     */
    public static void registerTypes(MetaDataRegistry registry) {
        try {
            // Check if MetaData base type is already registered to prevent duplicates
            if (registry.hasConstraint("metadata.base.description.placement")) {
                log.debug("MetaData base type already registered, skipping");
                return;
            }

            registry.registerType(MetaData.class, def -> def
                .type(TYPE_METADATA).subType(SUBTYPE_BASE)
                .description("Base metadata type for inheritance hierarchy - enforces abstract requirements")

                // COMMON ATTRIBUTES available to all metadata types
                .optionalAttribute(ATTR_DESCRIPTION, StringAttribute.SUBTYPE_STRING)  // Description attribute for all metadata
                .optionalAttribute(ATTR_IS_ABSTRACT, BooleanAttribute.SUBTYPE_BOOLEAN)  // Abstract flag for all metadata

                // ROOT LEVEL can contain top-level metadata types
                .optionalChild(MetaObject.TYPE_OBJECT, "*", "*")      // Any object type
                .optionalChild(MetaField.TYPE_FIELD, "*", "*")       // Any field type (if abstract)
                .optionalChild(MetaAttribute.TYPE_ATTR, "*", "*")        // Any attribute (if abstract)
                .optionalChild(MetaValidator.TYPE_VALIDATOR, "*", "*")   // Any validator (if abstract)
                .optionalChild(MetaView.TYPE_VIEW, "*", "*")        // Any view (if abstract)
            );

            log.debug("Registered root MetaData type (metadata.base) with unified registry");
            
            // Setup abstract requirements constraints
            setupRootAbstractConstraints(registry);

        } catch (Exception e) {
            log.error("Failed to register root MetaData type with unified registry", e);
        }
    }
    
    /**
     * Setup abstract requirements constraints for metadata.base children.
     * Future defaults: new metadata types must be abstract under metadata.base.
     */
    private static void setupRootAbstractConstraints(MetaDataRegistry registry) {

        // Check if constraints are already registered to prevent duplicates during Maven plugin execution
        if (registry.hasConstraint("metadata.base.objects")) {
            log.debug("Root abstract constraints already registered, skipping");
            return;
        }

        // OBJECTS can be abstract or concrete under metadata.base
        registry.addConstraint(PlacementConstraint.allowChildType(
            "metadata.base.objects",
            "metadata.base can contain objects",
            TYPE_METADATA, SUBTYPE_BASE,        // Parent: metadata.base
            MetaObject.TYPE_OBJECT, "*"         // Child: object.*
        ));

        // FIELDS under metadata.base
        registry.addConstraint(PlacementConstraint.allowChildType(
            "metadata.base.fields",
            "metadata.base can contain fields",
            TYPE_METADATA, SUBTYPE_BASE,        // Parent: metadata.base
            MetaField.TYPE_FIELD, "*"           // Child: field.*
        ));

        // ATTRIBUTES under metadata.base
        registry.addConstraint(new PlacementConstraint(
            "metadata.base.attributes",
            "metadata.base can contain attributes",
            TYPE_METADATA, SUBTYPE_BASE,    // Parent: metadata.base
            MetaAttribute.TYPE_ATTR, "*",   // Child: attr.*
            null,                           // No name constraint
            true                            // Allowed
        ));

        // VALIDATORS under metadata.base
        registry.addConstraint(new PlacementConstraint(
            "metadata.base.validators",
            "metadata.base can contain validators",
            TYPE_METADATA, SUBTYPE_BASE,         // Parent: metadata.base
            MetaValidator.TYPE_VALIDATOR, "*",   // Child: validator.*
            null,                                // No name constraint
            true                                 // Allowed
        ));

        // VIEWS under metadata.base
        registry.addConstraint(new PlacementConstraint(
            "metadata.base.views",
            "metadata.base can contain views",
            TYPE_METADATA, SUBTYPE_BASE,    // Parent: metadata.base
            MetaView.TYPE_VIEW, "*",        // Child: view.*
            null,                           // No name constraint
            true                            // Allowed
        ));

        // ✅ MIGRATED: MetaKey constraint removed - keys are now handled via:
        // - MetaIdentity children (for primary and secondary keys)
        // - MetaRelationship children (for foreign key relationships)
        
        // FUTURE DEFAULT: Any new metadata types must be abstract under metadata.base
        // (Individual new types can override this by adding their own constraints)
        
        log.debug("Set up abstract requirements constraints for metadata.base");
    }

    /**
     * Alternative registerTypes() method with no parameters for backward compatibility.
     */
    public static void registerTypes() {
        registerTypes(MetaDataRegistry.getInstance());
    }

    // NOTE: metadata.base registration is performed by CoreTypeMetaDataProvider
    // (the ServiceLoader bootstrap), invoked on first MetaDataRegistry.getInstance().
    // A static{} block here that called getInstance() during MetaData.<clinit> is
    // intentionally absent: because the field/object/etc. providers call
    // registerTypes() on MetaData subclasses, bootstrapping the registry from this
    // base class's initializer created a class-init cycle (a subclass's static
    // logger could be observed null, aborting provider load and leaving only
    // field.base registered). Registration via the provider is the single source.

    // Unified caching strategy
    private final CacheStrategy cache = new HybridCache();
    
    // Indexed collection for O(1) child lookups
    private final IndexedMetaDataCollection children = new IndexedMetaDataCollection();
    

    // NEW v6.0: Type/subtype as first-class concept  
    private final MetaDataTypeId typeId;

    // LEGACY: Keep for backward compatibility during transition
    private final String type;
    private final String subType;
    private final String name;

    private final String shortName;
    private final String pkg;
    
    // Type system integration

    private MetaData superData = null;

    // WeakReference prevents circular references and memory leaks in parent-child relationships
    private WeakReference<MetaData> parentRef = null;
    private volatile MetaDataLoader loader = null;
    private ClassLoader metaDataClassLoader=null;

    // FR5a / ADR-0009 — Loader error envelope + source-on-node.
    //
    // Every metadata node carries its own provenance. `source` is always populated;
    // the default for any node not built by a loader phase is CodeSource.DEFAULT
    // (format == "code"). The loader's parser overwrites this with a JsonSource /
    // YamlSource / MergedSource / ResolvedSource / DatabaseSource as it builds the
    // tree. Mirrors C# MetaData.Source ({ get; private set; }) — settable through
    // setSource(), frozen after freezeSource() is called.
    private ErrorSource source = CodeSource.DEFAULT;
    private boolean sourceFrozen = false;

    // Tracks whether this node's package was explicitly authored in the source
    // file (i.e. the parser saw a `package` key in the node's body). Used by the
    // canonical serializer to round-trip a redundantly re-authored package
    // declaration that equals the parent's package — e.g. an `object.entity`
    // that re-declares `"package": "acme::blog"` even though the root already
    // declares it. Without this flag the "differs from parent" heuristic in
    // CanonicalJsonSerializer would suppress that re-declaration and break
    // byte-parity with the TS / Python oracles.
    private boolean packageAuthored = false;

    // The raw `extends` (super) reference string EXACTLY as authored in the
    // source file (e.g. "Product", "acme::catalog::Product", a relative ref).
    // The parser resolves this string to a concrete super node (getSuperData),
    // but the canonical serializer must echo the AUTHORED form verbatim — never
    // a recomputed short-vs-FQN form — to stay byte-identical with the TS / C# /
    // Python oracles (which all preserve and re-emit the raw `superRef`). See
    // CanonicalJsonSerializer's `extends` emission and the TS `model.superRef`.
    private String authoredSuperRef = null;

    // FR-024 D2: true when the parser AUTO-GENERATED this node's name (the author
    // omitted it). Unlike TS/Python (which leave a nameless node's name === ""),
    // this port auto-names auto-naming types (identity/source/view/validator/origin),
    // so a post-load "is this identity nameless?" check needs this parser-set flag.
    private boolean autoNamed = false;

    /** True when the parser auto-generated this node's name (no author-supplied name). */
    public boolean isAutoNamed() { return autoNamed; }

    /** Records that the parser auto-generated this node's name. */
    public void setAutoNamed(boolean autoNamed) { this.autoNamed = autoNamed; }

    /**
     * Constructs a MetaData object with enhanced type system integration.
     * 
     * <p>This constructor creates a new MetaData instance that will be optimized for
     * read-heavy access patterns throughout its lifetime. The metadata is designed to
     * be loaded once during application startup and accessed frequently at runtime.</p>
     * 
     * <p><strong>Architecture Note:</strong> This is a loading-phase operation. After construction
     * and initialization, the MetaData object becomes effectively immutable for optimal
     * concurrent read performance.</p>
     * 
     * @param type the type identifier for this metadata (e.g., "object", "field", "loader")
     * @param subType the subtype identifier providing more specific categorization 
     *                (e.g., "string", "integer", "mapped", "proxy")
     * @param name the fully qualified name of this metadata, may include package separators (::)
     *             for hierarchical organization (e.g., "com::example::User", "email")
     * 
     * @see MetaDataTypeId
     * @see #getType()
     * @see #getSubType()
     * @see #getName()
     * @since 1.0
     */
    public MetaData(String type, String subType, String name ) {

        // Allow null values for testing - validation happens in validate() method
        // if ( type == null ) throw new NullPointerException( "MetaData Type cannot be null" );
        // if ( subType == null ) throw new NullPointerException( "MetaData SubType cannot be null" );
        // if ( name == null ) throw new NullPointerException( "MetaData Name cannot be null" );

        // NEW v6.0: Create MetaDataTypeId (allows nulls for testing)
        this.typeId = (type != null && subType != null) ? 
            new MetaDataTypeId(type, subType) : null;

        // LEGACY: Keep for backward compatibility during transition
        this.type = type;
        this.subType = subType;
        this.name = name;

        // v6.0.0: Validate name during construction
        if (name != null && type != null) {
            validateName(name);
        }

        // Type definition removed - using unified registry
        

        // Cache the shortName and packageName (handle null name)
        if (name != null) {
            int i = name.lastIndexOf(PKG_SEPARATOR);
            if (i >= 0) {
                shortName = name.substring(i + PKG_SEPARATOR.length());
                pkg = name.substring(0, i);
            } else {
                shortName = name;
                pkg = "";
            }
        } else {
            shortName = null;
            pkg = null;
        }

        log.debug("Created MetaData: {}:{}:{}", 
                  type != null ? type : "null", 
                  subType != null ? subType : "null", 
                  name != null ? name : "null");
    }

    // ========== ENHANCED TYPE SYSTEM METHODS ==========

    // Type definition methods removed - using unified registry via ServiceLoader providers
    
    /**
     * Validate MetaData name during construction
     */
    private void validateName(String name) {
        // Attributes may use dotted names to namespace persistence-concern
        // attrs from core attrs (e.g., @db.indexed, @db.column). TS + Python
        // accept these; the cross-port contract requires Java match. Also
        // accept FQN-qualified attr names (`pkg::name::attr` form) which the
        // loader synthesises for cross-package attr lookups.
        if ("attr".equals(type)) {
            if (name.contains("::")) {
                for (String part : name.split("::")) {
                    if (!part.matches("^[a-zA-Z][a-zA-Z0-9_.]*$")) {
                        throw new IllegalArgumentException(
                            "Invalid attr name part '" + part + "' in '" + name
                                + "': must follow pattern ^[a-zA-Z][a-zA-Z0-9_.]*$");
                    }
                }
            } else if (!name.matches("^[a-zA-Z][a-zA-Z0-9_.]*$")) {
                throw new IllegalArgumentException(
                    "Invalid attr name '" + name + "': must follow pattern ^[a-zA-Z][a-zA-Z0-9_.]*$");
            }
            return;
        }
        // Loaders and views can have more flexible naming (allow hyphens). Views
        // also accept package-qualified names because the loader synthesises
        // FQNs like `pkg::Entity::currency1` for unnamed children.
        if ("loader".equals(type) || "view".equals(type)) {
            if (name.contains("::")) {
                for (String part : name.split("::")) {
                    if (!part.matches("^[a-zA-Z][a-zA-Z0-9_-]*$")) {
                        throw new IllegalArgumentException(
                            "Invalid " + type + " name part '" + part + "' in '" + name
                                + "': must follow pattern ^[a-zA-Z][a-zA-Z0-9_-]*$");
                    }
                }
            } else if (!name.matches("^[a-zA-Z][a-zA-Z0-9_-]*$")) {
                throw new IllegalArgumentException(
                    "Invalid " + type + " name '" + name + "': must follow pattern ^[a-zA-Z][a-zA-Z0-9_-]*$");
            }
        } else {
            // Check if this is a package-qualified name
            if (name.contains("::")) {
                // Package-qualified name - validate each part separately
                String[] parts = name.split("::");
                for (String part : parts) {
                    if (!part.matches("^[a-zA-Z][a-zA-Z0-9_]*$")) {
                        throw new IllegalArgumentException(
                            "Constraint violation: Invalid MetaData name part '" + part + "' in '" + name + "': must follow identifier pattern ^[a-zA-Z][a-zA-Z0-9_]*$");
                    }
                }
            } else {
                // Simple name - strict identifier pattern for fields and objects
                if (!name.matches("^[a-zA-Z][a-zA-Z0-9_]*$")) {
                    throw new IllegalArgumentException(
                        "Constraint violation: Invalid MetaData name '" + name + "': must follow identifier pattern ^[a-zA-Z][a-zA-Z0-9_]*$");
                }
            }
        }
    }

    

    // ========== MODERN COLLECTION APIS ==========

    /**
     * Get children as a Stream for functional operations
     */
    public Stream<MetaData> getChildrenStream() {
        return children.stream();
    }

    /**
     * Find children matching a predicate
     */
    public Stream<MetaData> findChildren(Predicate<MetaData> predicate) {
        return children.findMatching(predicate);
    }

    /**
     * Find children of a specific type
     */
    public <T extends MetaData> Stream<T> findChildren(Class<T> type) {
        return children.findByClass(type).stream();
    }

    /**
     * Find child by name (modern Optional-based API) - O(1) operation
     */
    public Optional<MetaData> findChild(String name) {
        return children.findByName(name);
    }

    /**
     * Find child by name and type - O(1) operation (legacy method)
     */
    @Deprecated
    public <T extends MetaData> Optional<T> findChild(String name, Class<T> type) {
        return children.findByName(name)
            .filter(type::isInstance)
            .map(type::cast);
    }

    /**
     * TYPE-AWARE NAMESPACE LOOKUP METHODS - Use these to avoid name conflicts
     */

    /**
     * Find child by name and MetaData type using type-specific namespace - O(1) operation
     */
    public Optional<MetaData> findChildByNameAndType(String name, String metaDataType) {
        return children.findByNameAndType(name, metaDataType);
    }

    /**
     * Require child by name (throws if not found)
     */
    public MetaData requireChild(String name) {
        return findChild(name)
            .orElseThrow(() -> new MetaDataNotFoundException("Child not found: " + name, name));
    }

    /**
     * Require child by name and type
     */
    public <T extends MetaData> T requireChild(String name, Class<T> type) {
        return findChild(name, type)
            .orElseThrow(() -> new MetaDataNotFoundException(
                "Child of type " + type.getSimpleName() + " not found: " + name, name));
    }

    // ========== UNIFIED CACHING ==========

    /**
     * Get cached value with type safety
     */
    public <T> Optional<T> getCacheValue(String key, Class<T> type) {
        return cache.get(key, type);
    }

    /**
     * Set cache value
     */
    public void setCacheValue(String key, Object value) {
        cache.put(key, value);
    }

    /**
     * Compute cache value if absent
     */
    public <T> T computeCacheValue(String key, Class<T> type, java.util.function.Supplier<T> supplier) {
        return cache.computeIfAbsent(key, type, supplier);
    }

    /**
     * Check if cache contains key
     */
    public boolean hasCacheValue(String key) {
        return cache.containsKey(key);
    }

    /**
     * Remove cached value
     */
    public Object removeCacheValue(String key) {
        return cache.remove(key);
    }

    /**
     * Get cache statistics
     */
    public Optional<Object> getCacheStats() {
        return cache.getStats().map(stats -> (Object) stats);
    }


    // ========== ENHANCED ATTRIBUTE MANAGEMENT ==========

    /**
     * Modern attribute access with Optional
     */
    public Optional<MetaAttribute> findAttribute(String name) {
        return findChild(name, MetaAttribute.class);
    }

    /**
     * Require attribute (throws if not found)
     */
    public MetaAttribute requireAttribute(String name) {
        return findAttribute(name)
            .orElseThrow(() -> MetaDataNotFoundException.forAttribute(name, this));
    }

    /**
     * Get all attributes as stream
     */
    public Stream<MetaAttribute> getAttributesStream() {
        return findChildren(MetaAttribute.class);
    }

    /**
     * Check if attribute exists (enhanced version)
     */
    public boolean hasAttributeEnhanced(String name) {
        return findAttribute(name).isPresent();
    }


    /**
     * Checks whether this MetaData is of the specified type.
     * 
     * <p>This is a high-performance comparison method optimized for frequent
     * type checking during runtime operations.</p>
     * 
     * @param type the type to check against
     * @return true if this MetaData has the specified type, false otherwise
     * @throws NullPointerException if type parameter is null
     * @since 1.0
     */
    public boolean isType( String type ) {
        return this.type.equals( type );
    }


    // ========== NEW v6.0 TYPE SYSTEM METHODS ==========

    /**
     * Get the type of this MetaData (modern API)
     * 
     * @return The primary type (e.g., "field", "view", "validator")
     * @since 6.0.0
     */
    public String getType() {
        return typeId != null ? typeId.type() : type;
    }

    /**
     * Get the subtype of this MetaData (modern API)
     * 
     * @return The specific implementation subtype (e.g., "int", "string", "currency")
     * @since 6.0.0
     */
    public String getSubType() {
        return typeId != null ? typeId.subType() : subType;
    }

    /**
     * Get the type ID of this MetaData (modern API)
     * 
     * @return MetaDataTypeId containing both type and subtype
     * @since 6.0.0
     */
    public MetaDataTypeId getTypeId() {
        return typeId;
    }

    /**
     * Check if this MetaData matches a type pattern
     * 
     * @param pattern Pattern like "field.*" or "field.int" where "*" means any
     * @return true if this MetaData matches the pattern
     * @since 6.0.0
     */
    public boolean matchesType(String pattern) {
        return typeId != null && typeId.matches(pattern);
    }

    /**
     * Check if this MetaData matches a type pattern
     * 
     * @param pattern MetaDataTypeId pattern (type or subtype can be "*")
     * @return true if this MetaData matches the pattern
     * @since 6.0.0
     */
    public boolean matchesType(MetaDataTypeId pattern) {
        return typeId != null && typeId.matches(pattern);
    }

    /**
     * Returns whether this MetaData matches specified Type, SubType, and Name
     */
    public boolean isSameType( MetaData md ) {
        return isType( md.type  );
    }

    /**
     * Returns whether MetaData is of the specified Type
     */
    public boolean isTypeSubType( String type, String subType ) {
        return this.type.equals( type ) && this.subType.equals( subType );
    }

    /**
     * Returns whether this MetaData matches specified Type, SubType, and Name
     */
    public boolean isSameTypeSubType( MetaData md ) {
        return isTypeSubType( md.type, md.subType );
    }

    /**
     * Returns the fully qualified name of this MetaData.
     * 
     * <p>The name may include package separators (::) for hierarchical organization.
     * For example: "com::example::User" for an object, or "email" for a simple field.</p>
     * 
     * <p><strong>Performance Note:</strong> This is a cached O(1) operation optimized for
     * frequent access during runtime read operations.</p>
     * 
     * @return the fully qualified name, may contain package separators, or null if not set
     * @see #getShortName()
     * @see #getPackage()
     * @see #PKG_SEPARATOR
     * @since 1.0
     */
    public String getName() {
        return name;
    }

    /**
     * Returns whether this MetaData matches specified Type, SubType, and Name
     */
    public boolean isTypeSubTypeName( String type, String subType, String name ) {
        return this.type.equals( type ) && this.subType.equals( subType ) && this.name.equals( name );
    }

    /**
     * Returns whether this MetaData matches specified Type, SubType, and Name
     * @param md the metadata to compare against
     * @return true if this metadata has the same type, subtype, and name as the specified metadata
     */
    public boolean isSameTypeSubTypeName( MetaData md ) {
        return isTypeSubTypeName( md.type, md.subType, md.name);
    }

    /////////////////////////////////////////////////////
    // Object Instantiation Helpers

    /**
     * Sets the ClassLoader to use for metadata class loading
     * @param <T> the type of metadata to return
     * @param classLoader the ClassLoader to set for metadata operations
     * @return this metadata instance cast to the specified type
     */
    @SuppressWarnings("unchecked")
    public <T extends MetaData> T setMetaDataClassLoader( ClassLoader classLoader ) {
        metaDataClassLoader = classLoader;
        return (T) this;
    }

    protected ClassLoader getDefaultMetaDataClassLoader() {
        return getClass().getClassLoader();
    }

    public ClassLoader getMetaDataClassLoader() {

        if (metaDataClassLoader != null) {
            return metaDataClassLoader;
        }
        else {
            // MetaDataLoader is no longer a MetaData node (H3a Task 4); a node's
            // ClassLoader falls back to the producing loader's ClassLoader.
            MetaDataLoader l = getLoader();
            if ( l != null ) {
                return l.getMetaDataClassLoader();
            }
        }

        return getDefaultMetaDataClassLoader();
    }

    // Loads the specified Class using the proper ClassLoader
    @SuppressWarnings("unchecked")
    public <T> Class<T> loadClass( Class<T> clazz, String name ) throws ClassNotFoundException {
        try {
            Class<?> c = getMetaDataClassLoader().loadClass(name);
            if (!clazz.isAssignableFrom(c)) {
                throw new InvalidValueException("Class [" + c.getName() + "] is not assignable from [" + clazz.getName() + "]");
            }
            return (Class<T>) c;
        }
        catch (ClassNotFoundException e ) {
            log.error( "Could not find class ["+name+"] in MetaDataClassLoader: "+getMetaDataClassLoader());
            throw e;
        }
    }

    // Loads the specified Class using the proper ClassLoader
    public Class<?> loadClass( String name ) throws ClassNotFoundException {
        return loadClass(name, true);
    }

        // Loads the specified Class using the proper ClassLoader
    public Class<?> loadClass( String name, boolean throwError ) throws ClassNotFoundException {
        try {
            return getMetaDataClassLoader().loadClass(name);
        }
        catch (ClassNotFoundException e ) {
            if ( throwError ) {
                log.error("Could not find class [" + name + "] in MetaDataClassLoader: " + getMetaDataClassLoader());
                throw e;
            }
        }
        return null;
    }


    ////////////////////////////////////////////////////
    // SETTER / GETTER METHODS

    
    /**
     * Type-safe utility methods for common type checks
     * @return true if this metadata is a field type, false otherwise
     */
    public boolean isFieldMetaData() {
        return this instanceof com.metaobjects.field.MetaField;
    }
    
    public boolean isObjectMetaData() {
        return this instanceof com.metaobjects.object.MetaObject;
    }
    
    public boolean isAttributeMetaData() {
        return this instanceof com.metaobjects.attr.MetaAttribute;
    }
    
    public boolean isValidatorMetaData() {
        return this instanceof com.metaobjects.validator.MetaValidator;
    }
    
    public boolean isViewMetaData() {
        return this instanceof com.metaobjects.view.MetaView;
    }
    
    /**
     * @deprecated As of H3a Task 4, {@code MetaDataLoader} is no longer a
     *             {@link MetaData} node, so a MetaData instance is never a
     *             loader. Always returns {@code false}.
     */
    @Deprecated
    public boolean isLoaderMetaData() {
        return false;
    }

    /**
     * Walks up the parent hierarchy to the {@link MetaRoot} tree root and
     * returns the {@link MetaDataLoader} that produced it.
     *
     * <p>As of H3a Task 4, {@code MetaDataLoader} is no longer a {@code MetaData}
     * node. The tree root is a {@link MetaRoot}, which holds a back-reference to
     * its owning loader. This method walks to that root and delegates to
     * {@link MetaRoot#getLoader()}.</p>
     *
     * @return the MetaDataLoader that contains this metadata, or null if none found
     */
    public MetaDataLoader getLoader() {

        if (loader == null) {
            synchronized (this) {
                MetaData d = this;
                while (d != null) {
                    if (d instanceof MetaRoot) {
                        loader = ((MetaRoot) d).getLoader();
                        break;
                    }
                    d = d.getParent();
                }
            }
        }

        return loader;
    }

    /**
     * Retrieve the MetaObject package
     * @return the package name of this metadata, or null if not set
     */
    public String getPackage() {
        return pkg;
    }

    /**
     * Returns {@code true} when this node's package was explicitly authored in
     * the source file. See the {@code packageAuthored} field doc for context.
     */
    public boolean isPackageAuthored() {
        return packageAuthored;
    }

    /**
     * Marks this node's package as explicitly authored. Called by the canonical
     * JSON / YAML parser when the body declares a {@code "package"} key.
     */
    public void setPackageAuthored(boolean packageAuthored) {
        this.packageAuthored = packageAuthored;
    }

    /**
     * Returns the raw {@code extends} (super) reference string exactly as it was
     * authored in the source file, or {@code null} if no {@code extends} was
     * authored on this node. The canonical serializer echoes this verbatim. See
     * the {@code authoredSuperRef} field doc for context.
     */
    public String getAuthoredSuperRef() {
        return authoredSuperRef;
    }

    /**
     * Records the raw, as-authored {@code extends} (super) reference string.
     * Called by the canonical JSON / YAML parser when the body declares an
     * {@code "extends"} key, so the serializer can re-emit it verbatim.
     */
    public void setAuthoredSuperRef(String authoredSuperRef) {
        this.authoredSuperRef = authoredSuperRef;
    }

    /**
     * Retrieve the MetaObject short name
     * @return the short name of this metadata without package prefix
     */
    public String getShortName() {
        return shortName;
    }

    /**
     * Sets the parent of the attribute
     * @param parent the parent metadata to attach to this metadata
     */
    protected void attachParent(MetaData parent) {
        parentRef = new WeakReference<>(parent);
        // Re-parenting changes the owning loader; drop the cached loader so the
        // next getLoader() recomputes it from the new parent chain. Load-bearing
        // for per-loader type registries (a node moved/cloned across loaders must
        // validate against the NEW owner's registry, not a stale one). See ADR-0014.
        loader = null;
    }

    /**
     * Gets the parent MetaData.  Be careful as this might not be the
     * same as the metadata you retrieved this from as a child due to
     * inheritance.   Use with care!
     * @return the parent metadata, or null if no parent is set
     */
    public MetaData getParent() {
        if (parentRef == null) {
            return null;
        }
        return parentRef.get();
    }

    /**
     * Sets the Super Data
     * @param superData the super metadata to set
     */
    public void setSuperData(MetaData superData) {
        this.superData = superData;
    }

    /**
     * Gets the Super Data
     * @param <T> the type of metadata to return
     * @return the super metadata cast to the specified type
     */
    @SuppressWarnings("unchecked")
    public <T extends MetaData> T getSuperData() {
        return (T) superData;
    }

    /**
     * Gets the Super Data with type safety - returns Optional to avoid ClassCastException
     * @param <T> the type of metadata to return
     * @param type The expected type of the super data
     * @return Optional containing the super data if it matches the expected type
     */
    public <T extends MetaData> Optional<T> getSuperDataSafe(Class<T> type) {
        return type.isInstance(superData) ? Optional.of(type.cast(superData)) : Optional.empty();
    }

    /**
     * Returns whether this MetaData has a Super MetaData
     * @return SuperData exists
     */
    public boolean hasSuperData() {
        return superData != null;
    }

    ////////////////////////////////////////////////////
    // FR5a / ADR-0009 — Source-on-node provenance

    /**
     * Returns the provenance envelope describing where this node was constructed.
     *
     * <p>Never returns {@code null}: nodes built programmatically (via the public
     * Java API without a loader) default to {@link CodeSource#DEFAULT}. Nodes built
     * by the loader pipeline carry a {@link com.metaobjects.source.JsonSource}
     * (canonical-JSON parse), and post-load phases may overwrite this with a
     * {@link com.metaobjects.source.MergedSource} or
     * {@link com.metaobjects.source.ResolvedSource}.</p>
     *
     * @return the provenance envelope; never {@code null}
     * @since FR5a / ADR-0009
     */
    public ErrorSource getSource() {
        return source;
    }

    /**
     * Sets the provenance envelope for this node.
     *
     * <p>Honors the freeze guard installed by {@link #freezeSource()}: once frozen,
     * any further mutation throws {@link IllegalStateException}. The loader
     * pipeline freezes after construction; this lets phases mutate source during
     * load while preventing accidental mutation by runtime consumers.</p>
     *
     * @param source the provenance envelope; must not be {@code null}
     * @throws NullPointerException if {@code source} is {@code null}
     * @throws IllegalStateException if this node's source is already frozen
     * @since FR5a / ADR-0009
     */
    public void setSource(ErrorSource source) {
        if (source == null) {
            throw new NullPointerException("MetaData source must not be null — use CodeSource.DEFAULT for the no-loader case");
        }
        if (sourceFrozen) {
            throw new IllegalStateException("MetaData source is frozen and cannot be modified: " + this);
        }
        this.source = source;
    }

    /**
     * Marks this node's {@code source} as frozen — subsequent {@link #setSource}
     * calls throw {@link IllegalStateException}.
     *
     * <p>Idempotent: calling on an already-frozen node is a no-op.</p>
     *
     * @since FR5a / ADR-0009
     */
    public void freezeSource() {
        this.sourceFrozen = true;
    }

    /**
     * Returns whether this node's source is currently frozen.
     *
     * @return {@code true} if frozen, {@code false} otherwise
     * @since FR5a / ADR-0009
     */
    public boolean isSourceFrozen() {
        return sourceFrozen;
    }

    ////////////////////////////////////////////////////
    // ATTRIBUTE METHODS

    /**
     * Sets an attribute of the MetaClass
     * @param attr the attribute to add to this metadata
     */
    public void addMetaAttr(MetaAttribute attr) {
        addChild(attr);
    }

    /**
     * Sets an attribute of the MetaClass (type-safe version)
     * @param attr The attribute to add
     */
    public void addMetaAttrSafe(MetaAttribute attr) {
        addChild(attr);
    }

    /**
     * Retrieves an attribute value of the MetaData
     * @param name the name of the attribute to retrieve
     * @return the MetaAttribute with the specified name
     * @throws MetaDataNotFoundException if the attribute is not found
     */
    public MetaAttribute getMetaAttr(String name) throws MetaDataNotFoundException {
        return getMetaAttr(name,true);
    }

    /**
     * Retrieves an attribute value of the MetaData
     * @param name the name of the attribute to retrieve
     * @param includeParentData whether to search parent metadata for the attribute
     * @return the MetaAttribute with the specified name
     * @throws MetaDataNotFoundException if the attribute is not found
     */
    public MetaAttribute getMetaAttr(String name, boolean includeParentData) throws MetaDataNotFoundException {
        try {
            return (MetaAttribute) getChild( name, MetaAttribute.class, includeParentData);
        } catch (MetaDataNotFoundException e) {
            throw MetaDataNotFoundException.forAttribute(name, this);
        }
    }



    /**
     * Checks if this metadata has an attribute with the specified name
     * @param name the name of the attribute to check
     * @return true if the attribute exists, false otherwise
     */
    public boolean hasMetaAttr(String name) {
        return hasMetaAttr(name,true);
    }

    /**
     * Checks if this metadata has an attribute with the specified name
     * @param name the name of the attribute to check
     * @param includeParentData true to include parent data in the search, false to search only this metadata
     * @return true if the attribute exists, false otherwise
     */
    public boolean hasMetaAttr(String name, boolean includeParentData) {
        try {
            if (getChild(name, MetaAttribute.class, includeParentData, false) != null) {
                return true;
            }
        } catch (MetaDataNotFoundException ignored) {}
        
        return false;
    }

    /**
     * Retrieves all attributes for this metadata
     * @return list of all MetaAttribute objects, including parent data
     */
    public List<MetaAttribute> getMetaAttrs() {
        return getMetaAttrs(true);
    }

    /**
     * Retrieves all attributes for this metadata
     * @param includeParentData true to include attributes from parent data, false for only this metadata
     * @return list of MetaAttribute objects based on the includeParentData flag
     */
    public List<MetaAttribute> getMetaAttrs( boolean includeParentData ) {

        return getChildren(MetaAttribute.class, includeParentData);
    }

    /////////////////////////////////////////////////////////////////////////////
    // CHILDREN METHODS

    /**
     * Filters for parent data
     * @param d the metadata to filter
     * @return true if this metadata should be filtered when accessing parent data
     */
    protected boolean filterWhenParentData( MetaData d ) {
        return ( d instanceof MetaAttribute && d.getName().startsWith("_") );
    }

    /**
     * Whether to delete the MetaData if a new one is added
     * @param d MetaData to check
     * @return true if should delete
     */
    protected boolean deleteOnAdd( MetaData d) {

        // TODO: Change these rules to be driven from a MetaData method that is overrideable

        return d instanceof MetaAttribute;
                // || d instanceof MetaField
                //|| d instanceof MetaValidator
                //|| d instanceof MetaView;
    }

    /**
     * Whether the child data exists
     * @param type the type of child to check for
     * @param name the name of the child to check for
     * @return true if a child of the specified type and name exists, false otherwise
     */
    protected boolean hasChildOfType(String type, String name) {
        try {
            getChildOfType( type, name );
            return true;
        } catch (MetaDataNotFoundException e) {
            return false;
        }
    }

    /**
     * Whether the child data exists
     * @param name the name of the child to check for
     * @param c the class type of the child to check for
     * @return true if a child with the specified name and type exists, false otherwise
     */
    public boolean hasChild(String name, Class<? extends MetaData> c) {
        try {
            getChild(name, c);
            return true;
        } catch (MetaDataNotFoundException e) {
            return false;
        }
    }

    /**
     * Adds a child MetaData object of the specified class type. If no class
     * type is set, then a child of the same type is not checked against.
     * @param data the child metadata to add
     */
    public void addChild(MetaData data) throws InvalidMetaDataException {
        addChild(data, true);
    }

    /**
     * Adds a child MetaData object (type-safe version)
     * @param data The child MetaData to add
     */
    public void addChildSafe(MetaData data) throws InvalidMetaDataException {
        addChild(data, true);
    }

    /**
     * Check whether this MetaData is a valid Child to add
     * @param data MetaData to add as a Child
     */
    protected void checkValidChild( MetaData data ) {

        if (data == null) {
            throw new IllegalArgumentException("Cannot add null MetaData");
        }

        // Don't let the same
        if ( this.getType().equals( data.getType())) {
            throw new MetaDataException("You cannot add the same MetaData type to another; this [" + toString() + "], added metadata[" + data.toString() + "]");
        }
    }

    /**
     * Adds a child MetaData object of the specified class type. If no class
     * type is set, then a child of the same type is not checked against.
     * @param data the child metadata to add
     * @param checkExists true to check if child already exists before adding, false to skip check
     */
    public void addChild(MetaData data, boolean checkExists)  throws InvalidMetaDataException {

        checkValidChild( data );

        if (checkExists) {
            try {
                MetaData d = getChildOfType( data.getType(), data.getName() );
                if (d.getParent() == this) {
                    if (deleteOnAdd( d )) {
                        deleteChild(d);
                    } else {
                        throw new InvalidMetaDataException(data, "MetaData already exists in [" + toString() + "] as [" + d + "]");
                    }
                }
            } catch (MetaDataNotFoundException ignored) {
            }
        }
        
        // Resolve the registry from the owning loader so a loader running against
        // its own typeRegistry (multi-tenant, plugin isolation, tests) validates in
        // isolation. Falls back to the global singleton for loader-detached nodes —
        // identical to prior behavior for every consumer that never sets a custom
        // registry (getTypeRegistry() defaults to getInstance()). See
        // docs/superpowers/specs/2026-05-29-java-per-loader-registry-design.md.
        // The ADR-0023 pivot applies to the LOADER default (authored-metadata load
        // measures the sealed, defined-provider-set vocabulary). A loader-detached
        // node (no owning loader) is a programmatic runtime construction — e.g. a
        // downstream module instantiating its own SPI-registered object type
        // (object.managed in om). It keeps the SPI singleton fallback so those
        // runtime types stay constructible. Authored metadata always has an owning
        // loader, so it gets the sealed registry.
        MetaDataLoader owningLoader = getLoader();
        MetaDataRegistry registry = (owningLoader != null)
            ? owningLoader.getTypeRegistry()
            : MetaDataRegistry.getInstance();
        if (!registry.acceptsChild(this.getType(), this.getSubType(),
                                 data.getType(), data.getSubType(), data.getName())) {
            String supportedChildren = registry.getSupportedChildrenDescription(this.getType(), this.getSubType());
            throw new InvalidMetaDataException(data, String.format(
                "%s.%s does not accept child '%s' of type %s.%s. %s",
                this.getType(), this.getSubType(), data.getName(),
                data.getType(), data.getSubType(), supportedChildren));
        }

        // Constraint enforcement during construction, against the resolved registry.
        ConstraintEnforcer constraintEnforcer = ConstraintEnforcer.getInstance();
        constraintEnforcer.enforceConstraintsOnAddChild(this, data, registry);
        
        data.attachParent(this);
        
        // Use indexed collection for O(1) operations
        if (children.add(data)) {
            
            // Flush caches
            flushCaches();
        }
    }

    /**
     * Deletes a child MetaData object of the given class
     * @param type the type of child to delete
     * @param name the name of the child to delete
     */
    public void deleteChildOfType(String type, String name ) {
        MetaData d = getChildOfType(type, name);
        if (d.getParent() == this) {
            if (children.remove(d)) {
                
                flushCaches();
            }
        } else {
            throw new MetaDataNotFoundException("You cannot delete MetaData with type [" + type +"] and name [" + name + "] from SuperData of [" + toString() + "]", name );
        }
    }

    /**
     * Deletes a child MetaData object of the given class
     * @param name the name of the child to delete
     * @param c the class type of the child to delete
     */
    public void deleteChild(String name, Class<? extends MetaData> c) {
        MetaData d = getChild(name, c);
        if (d.getParent() == this) {
            if (children.remove(d)) {
                
                flushCaches();
            }
        } else {
            throw new MetaDataNotFoundException("You cannot delete MetaData with name [" + name + "] from a SuperData of [" + toString() + "]", name );
        }
    }

    /**
     * Deletes a child MetaData object
     * @param data the child metadata to delete
     */
    public void deleteChild(MetaData data) {
        if (data.getParent() != this) {
            throw new IllegalArgumentException("MetaData [" + data.toString() + "] is not a child of [" + toString() + "]");
        }
        
        if (children.remove(data)) {
            
            flushCaches();
        }
    }
    
    /**
     * Returns all MetaData children
     * @return list of all child metadata objects
     */
    public List<MetaData> getChildren() {
        return children.getAll();
    }

    /**
     * Returns all MetaData children which implement the specified class
     * @param type the type of children to retrieve
     * @param includeParentData true to include parent data in search, false for only this metadata
     * @return list of MetaData children of the specified type
     */
    public List<MetaData> getChildrenOfType( String type, boolean includeParentData ) {
        return addChildren( type, MetaData.class, includeParentData );
    }

    /**
     * Returns all MetaData children which implement the specified class
     * @param <T> the type of metadata to return
     * @param c the class type of children to retrieve
     * @return list of children of the specified class type
     */
    public <T extends MetaData> List<T> getChildren(Class<T> c) {
        return addChildren(null, c, true );
    }

    /**
     * Returns all MetaData children which implement the specified class
     * @param <T> the type of metadata to return
     * @param c the class type of children to retrieve
     * @param includeParentData true to include parent data in search, false for only this metadata
     * @return list of children of the specified class type
     */
    public <T extends MetaData> List<T> getChildren(Class<T> c, boolean includeParentData ) {
        return addChildren(null, c, includeParentData );
    }

    /** Retrieve the first matching child metadata */
    /*private <T extends MetaData> T firstChild( String type, Class<T> c, boolean includeParentData ) {

        List<String> keys = new ArrayList<>();
        List<T> items = new ArrayList<>();
        addChildren( keys, items, type, c, includeParentData, false, true );
        return items.iterator().next();
    }*/

    /** Retrieve all matching child metadata */
    private <T extends MetaData> List<T> addChildren( String type, Class<T> c, boolean includeParentData ) {

        List<String> keys = new ArrayList<>();
        List<T> items = new ArrayList<>();
        addChildren( keys, items, type, c, includeParentData, false, false );
        return items;
    }

    /** Add all the matching children to the map - refactored for better maintainability */
    @SuppressWarnings("unchecked")
    private <T extends MetaData> void addChildren( List<String> keys, List<T> items, String type, Class<T> c, boolean includeParentData, boolean isParent, boolean firstOnly ) {
        addLocalChildren(keys, items, type, c, isParent, firstOnly);
        addParentChildren(keys, items, type, c, includeParentData, firstOnly);
    }
    
    /**
     * Adds matching local children to the results
     */
    @SuppressWarnings("unchecked")
    private <T extends MetaData> void addLocalChildren(List<String> keys, List<T> items, String type, Class<T> c, boolean isParent, boolean firstOnly) {
        children.stream()
            .filter(child -> !shouldStopEarly(firstOnly, items))
            .filter(child -> matchesSearchCriteria(child, type, c))
            .filter(child -> shouldIncludeChild(child, isParent, keys))
            .forEach(child -> addChildToResults(child, keys, items));
    }
    
    /**
     * Recursively adds children from parent metadata
     */
    private <T extends MetaData> void addParentChildren(List<String> keys, List<T> items, String type, Class<T> c, boolean includeParentData, boolean firstOnly) {
        if (getSuperData() != null && includeParentData) {
            getSuperData().addChildren(keys, items, type, c, true, true, firstOnly);
        }
    }
    
    /**
     * Checks if we should stop processing early (for firstOnly queries)
     */
    private <T extends MetaData> boolean shouldStopEarly(boolean firstOnly, List<T> items) {
        return firstOnly && !items.isEmpty();
    }
    
    /**
     * Checks if a child matches the search criteria
     */
    private <T extends MetaData> boolean matchesSearchCriteria(MetaData child, String type, Class<T> c) {
        // Match all if no criteria specified
        if (type == null && c == null) {
            return true;
        }
        
        // Match by type and optionally by class
        if (type != null && child.isType(type)) {
            return c == null || c.isInstance(child);
        }
        
        // Match by class only
        return type == null && c != null && c.isInstance(child);
    }
    
    /**
     * Determines if a child should be included based on parent filtering and uniqueness
     */
    private boolean shouldIncludeChild(MetaData child, boolean isParent, List<String> keys) {
        if (isParent && filterWhenParentData(child)) {
            return false;
        }
        
        String key = createChildKey(child);
        return !keys.contains(key);
    }
    
    /**
     * Creates a unique key for a child MetaData object
     */
    private String createChildKey(MetaData child) {
        return String.format("%s-%s", child.getType(), child.getName());
    }
    
    /**
     * Adds a child to the results collections
     */
    @SuppressWarnings("unchecked")
    private <T extends MetaData> void addChildToResults(MetaData child, List<String> keys, List<T> items) {
        String key = createChildKey(child);
        keys.add(key);
        items.add((T) child);
    }

    /**
     * Returns the first child record
     * @param <T> the type of metadata to return
     * @param c the class type of child to retrieve
     * @return the first child of the specified type, or null if none found
     */
    public <T extends MetaData> T getFirstChild(Class<T> c) {
        Iterator<T> i = getChildren(c, true).iterator();
        if (!i.hasNext())  return null;
        else return i.next();
    }

    /**
     * Returns the first child record of the specified type
     * @param type the type of child to retrieve
     * @return the first child of the specified type, or null if none found
     */
    public MetaData getFirstChildOfType( String type ) {
        Iterator<MetaData> i = getChildrenOfType( type, true).iterator();
        if (!i.hasNext()) return null;
        else return i.next();
    }

    /**
     * Returns a child by the specified name of the specified class
     *
     * @param type The type of MetaData to retrieve
     * @param name The name of the child to retrieve. A null will return the first matching child.
     * @return the child metadata of the specified type and name
     */
    public final MetaData getChildOfType(String type, String name) throws MetaDataNotFoundException {
        return getChildOfType(type, name, true, true);
    }

    /**
     * Returns a child by the specified name of the specified class
     * @param type the type of MetaData to retrieve
     * @param name the name of the child to retrieve
     * @param includeParentData true to include parent data in search, false for only this metadata
     * @return the child metadata of the specified type and name
     */
    public final MetaData getChildOfType(String type, String name, boolean includeParentData) throws MetaDataNotFoundException {
        return getChildOfType( type, name, includeParentData, true);
    }

    protected final MetaData getChildOfType( String type, String name, boolean includeParentData, boolean shouldThrow) throws MetaDataNotFoundException {
        if ( type == null ) throw new IllegalArgumentException( "The 'type' field was null" );
        return getChildOfTypeOrClass( type, name, MetaData.class, includeParentData, shouldThrow );
    }
    
    /**
     * Returns a child by the specified name of the specified class
     *
     * @param <T> the type of metadata to return
     * @param name The name of the child to retrieve. A null will return the first matching child.
     * @param c The Expected MetaData class to cast to
     * @return the child metadata of the specified name and type
     */
    public <T extends MetaData> T getChild(String name, Class<T> c) throws MetaDataNotFoundException {
        return getChild(name, c, true, true);
    }

    /**
     * Returns a child by the specified name of the specified class
     * @param <T> the type of metadata to return
     * @param name the name of the child to retrieve
     * @param c the class type of the child to retrieve
     * @param includeParentData true to include parent data in search, false for only this metadata
     * @return the child metadata of the specified name and type
     */
    public <T extends MetaData> T getChild(String name, Class<T> c, boolean includeParentData) throws MetaDataNotFoundException {
        return getChild(name, c, includeParentData, true);
    }

    protected <T extends MetaData> T getChild(String name, Class<T> c, boolean includeParentData, boolean shouldThrow) throws MetaDataNotFoundException {
        return (T) getChildOfTypeOrClass( null, name, c, includeParentData, shouldThrow );
    }

    @SuppressWarnings("unchecked")
    private final <T extends MetaData> T getChildOfTypeOrClass( String type, String name, Class<T> c, boolean includeParentData, boolean shouldThrow) throws MetaDataNotFoundException {

        // OPTIMIZED: Use type-specific namespace lookup when both type and name are provided
        if (type != null && name != null) {
            Optional<MetaData> found = children.findByNameAndType(name, type);
            if (found.isPresent()) {
                MetaData d = found.get();
                // Verify class matches if specified
                if (c == null || c.isInstance(d)) {
                    return (T) d;
                }
            }
        }

        // FALLBACK: Linear search for complex queries or when type-specific lookup fails
        for (MetaData d : children.getAll()) {

            // Make sure the types match if not null
            if ( type != null && !d.isType(type)) continue;

            // Make sure the class matches if not null
            if ( c != null && !c.isInstance(d)) continue;

            // Make sure the name matches if it's not null
            if ( name != null && !d.getName().equals(name)) continue;

            // If we made it this far, then return the child
            return (T) d;
        }

        // If it wasn't found above, see if it exists in the parent class
        if (getSuperData() != null && includeParentData) {

            try {
                T md = (T) getSuperData().getChildOfTypeOrClass( type, name, c, true, shouldThrow);

                // Filter out Attributes that are prefixed with _ as they do not get inherited
                if (md != null && !filterWhenParentData(md)) return md;
            }
            catch (MetaDataNotFoundException ignore ) {}
        }
        
        if (shouldThrow) {
            throw new MetaDataNotFoundException( "MetaData child of class [" + c + "] with name [" + name + "] not found in [" + toString() + "]", name );
        } else {
            return null;
        }
    }

    /**
     * Clears all children
     */
    public void clearChildren() {
        if ( !children.isEmpty() ) {
            children.clear();
            flushCaches();
        }
    }

    /**
     * Clears all children of the specified type
     * @param type the type of children to clear, null to clear all children
     */
    public void clearChildrenOfType( String type ) {
        boolean removed = false;
        List<MetaData> toRemove = children.stream()
            .filter(d -> type == null || d.isType(type))
            .toList();
        
        for (MetaData child : toRemove) {
            if (children.remove(child)) {
                removed = true;
            }
        }
        
        if (removed) flushCaches();
    }

    /**
     * Clears all children of the specified MetaData class
     * @param c the class type of children to clear, null to clear all children
     */
    public void clearChildren(Class<? extends MetaData> c) {
        boolean removed = false;
        List<MetaData> toRemove = children.stream()
            .filter(d -> c == null || c.isInstance(d))
            .toList();
        
        for (MetaData child : toRemove) {
            if (children.remove(child)) {
                removed = true;
            }
        }
        
        if (removed) flushCaches();
    }

    ////////////////////////////////////////////////////
    // MISC METHODS
    

    /**
     * Overload the MetaData.  Used with overlays
     * @param <T> the type of metadata to return
     * @return The wrapped MetaData
     */
    public <T extends MetaData> T overload()  {
        @SuppressWarnings("unchecked")
        T d = (T) clone();
        d.clearChildren();
        d.setSuperData(this);
        return d;
    }

    /**
     * Clones this MetaData object
     */
    @Override
    public Object clone() {

        MetaData v = newInstanceFromClass( getClass(), type, subType, name );

        v.superData = superData;
        v.parentRef = parentRef;
        // Do NOT inherit the source's cached loader — the clone resolves its own
        // from its (new) parent chain on next getLoader(). The overlay / super-
        // resolution path re-parents clones; a copied stale loader would validate
        // against the wrong per-loader type registry (ADR-0014).
        v.loader = null;
        // Used to provide support for OSGi and Maven Mojos
        v.metaDataClassLoader = metaDataClassLoader;

        // FR5a / ADR-0009 — preserve provenance across clone(). The overlay path
        // (overload() → clone()) would otherwise reset source to CodeSource.DEFAULT,
        // dropping the node's parse-time JsonSource. The clone inherits this node's
        // source unfrozen so FR5c can later set a MergedSource envelope post-clone.
        v.source = this.source;
        v.sourceFrozen = false;

        for (MetaData md : getChildren()) {
            v.addChild((MetaData) md.clone());
        }

        return v;
    }

    /**
     * Create a newInstance of the specified MetaData class given the specified type, subType, and name
     * @param <T> the type of metadata to return
     * @param c the class of metadata to instantiate
     * @param typeName the type name for the new instance
     * @param subTypeName the subtype name for the new instance
     * @param fullname the full name for the new instance
     * @return The newly created MetaData instance
     */
    public <T extends MetaData> T newInstanceFromClass( Class<T> c, String typeName, String subTypeName, String fullname) {

        T md;

        try {
            try {
                md = c.getConstructor(String.class, String.class, String.class).newInstance(typeName, subTypeName, fullname);
            } catch (NoSuchMethodException e) {
                try {
                    md = c.getConstructor(String.class, String.class).newInstance(typeName, fullname);
                } catch (NoSuchMethodException e2) {
                    try {
                        md = c.getConstructor(String.class).newInstance(fullname);
                    } catch (NoSuchMethodException e3) {
                        md = c.getConstructor().newInstance();
                    }
                }
            }
        } catch (InvocationTargetException | IllegalAccessException | InstantiationException | NoSuchMethodException e) {
            throw new MetaDataException("Could not create new instance of " +
                    getNewInstanceErrorStr(typeName, subTypeName, fullname) + ": " + e.getMessage(), e);
        }

        if (!md.getType().equals(typeName))
            throw new MetaDataException("Unexpected type ["+md.getType()+"] after creating new MetaData "+
                    getNewInstanceErrorStr(typeName, subTypeName, fullname) + ": " + md);

        if (!md.getSubType().equals(subTypeName))
            throw new MetaDataException("Unexpected subType ["+md.getSubType()+"] after creating new MetaData "+
                    getNewInstanceErrorStr(typeName, subTypeName, fullname) + ": " + md);

        if (!md.getName().equals(fullname))
            throw new MetaDataException("Unexpected name ["+md.getName()+"] after creating new MetaData "+
                    getNewInstanceErrorStr(typeName, subTypeName, fullname) + ": " + md);

        return md;
    }

    private String getNewInstanceErrorStr(String typeName, String subTypeName, String fullname) {
        return "[" + getClass().getName() + "] with type:subType:name [" + typeName +
                    ":" + subTypeName + ":" + fullname + "]";
    }


    //////////////////////////////////////////////////////////////////////////////
    // Cache Methods

    public interface GetValueForCache<T> {
        T get();
    };

    protected final Object CACHE_NULL = new Object();

    public <T> T useCache( String cacheKey, GetValueForCache<T> getter ) {
        Object o = getCacheValue( cacheKey );
        if ( o != null && o == CACHE_NULL ) return null;
        @SuppressWarnings("unchecked")
        T cacheValue = (T) o;
        if ( cacheValue == null ) {
            cacheValue = getter.get();
            setCacheValue( cacheKey, cacheValue );
        }
        return cacheValue;
    }

    public interface GetValueForCacheWithArg<T,A> {
        T get(A arg);
    };

    /**
     * The arg.toString() is appended to the CacheKeyPrefix
     * @param <T> the type of value to cache and return
     * @param <A> the type of argument passed to the getter
     * @param cacheKeyPrefix the prefix for the cache key
     * @param arg the argument to pass to the getter and append to cache key
     * @param getter the function to call if cache miss occurs
     * @return the cached value or result from getter function
     */
    public <T,A> T useCache( String cacheKeyPrefix, A arg, GetValueForCacheWithArg<T,A> getter ) {
        final String CACHE_KEY = cacheKeyPrefix+"{"+arg+"}";
        Object o = getCacheValue( CACHE_KEY );
        if ( o != null && o == CACHE_NULL ) return null;
        @SuppressWarnings("unchecked")
        T cacheValue = (T) o;
        if ( cacheValue == null ) {
            cacheValue = getter.get(arg);
            setCacheValue( CACHE_KEY, cacheValue );
        }
        return cacheValue;
    }

    /**
     * Sets a cache value for this piece of MetaData (legacy method)
     * @param key the cache key
     * @param value the value to cache
     */
    public void setCacheValue(Object key, Object value) {
        cache.put(key, value);
    }

    /**
     * Retrieves a cache value for this piece of MetaData (legacy method)
     * @param key the cache key to retrieve
     * @return the cached value, or null if not found
     */
    public Object getCacheValue(Object key) {
        return cache.get(key);
    }

    /**
     * This is called when the MetaData is modified
     */
    protected void flushCaches() {

        // Clear unified cache
        cache.clear();

        // Clear the super data caches
        if ( getSuperData() != null ) getSuperData().flushCaches();
    }

    //////////////////////////////////////////////////////////////////////////////
    // Misc Methods

    @Override
    public boolean equals(Object o) {
        if (this == o) return true;
        if (o == null || getClass() != o.getClass()) return false;
        MetaData metaData = (MetaData) o;
        return Objects.equals(children, metaData.children) &&
                Objects.equals(type, metaData.type) &&
                Objects.equals(subType, metaData.subType) &&
                Objects.equals(name, metaData.name);
                // Exclude superData and parentRef to avoid circular references
    }

    @Override
    public int hashCode() {
        // Exclude superData and parentRef to avoid circular reference issues
        return Objects.hash(children, type, subType, name);
    }

    /**
     * Get the toString Prefix
     * @return the prefix string for toString representation
     */
    protected String getToStringPrefix() {
        String className = getClass().getSimpleName();
        String typeName = getType() != null ? getType() : "null";
        String subTypeName = getSubType() != null ? getSubType() : "null";
        String name = getName() != null ? getName() : "null";
        return className + "[" + typeName +":" + subTypeName + "]{" + name + "}";
    }

    /**
     * Returns a string representation of the MetaData
     */
    @Override
    public String toString() {
        // Avoid circular references in toString
        if (getParent() == null ) {
            return getToStringPrefix();
        } else {
            // Use parent's name instead of full toString to avoid circular references
            return getToStringPrefix() + "@" + (getParent().getName() != null ? getParent().getName() : "null");
        }
    }
}

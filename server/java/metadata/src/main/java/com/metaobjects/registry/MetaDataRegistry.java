package com.metaobjects.registry;

import com.metaobjects.MetaData;
import com.metaobjects.MetaDataException;
import com.metaobjects.MetaDataTypeId;
import com.metaobjects.attr.MetaAttribute;
import com.metaobjects.attr.BooleanAttribute;
import com.metaobjects.attr.StringAttribute;
import com.metaobjects.constraint.*;
import com.metaobjects.field.MetaField;
import com.metaobjects.object.MetaObject;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.lang.reflect.Constructor;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Consumer;
import java.util.stream.Collectors;
import java.util.Comparator;

/**
 * Unified registry for MetaData type definitions with integrated child requirements.
 * 
 * <p>This class replaces the dual registry pattern by providing:</p>
 * 
 * <ul>
 *   <li><strong>Unified Registration:</strong> Single API for type + child requirement registration</li>
 *   <li><strong>Child Validation:</strong> Built-in validation of parent-child relationships</li>
 *   <li><strong>Service Extensions:</strong> Global child requirements from service providers</li>
 *   <li><strong>Thread-Safe:</strong> Optimized for read-heavy workloads with concurrent access</li>
 * </ul>
 * 
 * <strong>Registration Examples:</strong>:
 * 
 * <pre>{@code
 * // Register a field type with attributes
 * MetaDataRegistry.getInstance().registerType(StringField.class, def -> def
 *     .type("field").subType("string")
 *     .description("String field with pattern validation")
 *     .optionalAttribute("pattern", "string")
 *     .optionalAttribute("required", "boolean")
 * );
 * 
 * // Register an object type that accepts fields
 * MetaDataRegistry.getInstance().registerType(MetaObject.class, def -> def
 *     .type("object").subType("base")
 *     .optionalChild("field", "*", "*")  // Any field type, any name
 * );
 * }</pre>
 * 
 * @since 6.0.0
 */
public class MetaDataRegistry {
    
    private static final Logger log = LoggerFactory.getLogger(MetaDataRegistry.class);
    
    private static volatile MetaDataRegistry instance;
    private static final Object INSTANCE_LOCK = new Object();
    
    private final ServiceRegistry serviceRegistry;
    private final Map<MetaDataTypeId, TypeDefinition> typeDefinitions = new ConcurrentHashMap<>();
    private final Map<String, List<ChildRequirement>> globalRequirements = new ConcurrentHashMap<>();
    private final Set<TypeDefinition> deferredInheritanceTypes = ConcurrentHashMap.newKeySet();

    /**
     * Per-type designated default subType — queried by the YAML desugar (ADR-0006 Rule 1)
     * to resolve a bare {@code metadata:} / {@code object:} key to its fused form
     * (e.g. {@code metadata.root}, {@code object.entity}). Mirrors the TypeScript
     * {@code TypeRegistry._defaultSubTypes} and Python {@code _default_sub_types}.
     */
    private final Map<String, String> defaultSubTypes = new ConcurrentHashMap<>();

    // Integrated constraint system (merged from ConstraintRegistry)
    private final List<Constraint> constraints = Collections.synchronizedList(new ArrayList<>());
    private volatile boolean constraintsInitialized = false;
    private volatile boolean strictDuplicateDetection = true; // Enable strict checking by default

    /**
     * Common attributes — attributes valid on any node (every type / every subType).
     * Cross-language commonAttrs contract: TS {@code registerCommonAttrs}, C#
     * {@code RegisterCommonAttrs}, Python {@code register_common_attrs}. In Java,
     * providers register via {@link #registerCommonAttribute(String, String, boolean)}.
     * Keyed by attr name (bare, no {@code @} prefix).
     */
    private final Map<String, CommonAttributeDef> commonAttributes = new ConcurrentHashMap<>();

    /**
     * Fully-global parent-key tier in {@link #globalRequirements} — matches any
     * (parentType, parentSubType). Used by {@link #registerCommonAttribute} so
     * common attrs surface on every node via {@link #acceptsChild} /
     * {@link #getChildRequirements}.
     */
    private static final String UNIVERSAL_PARENT_KEY = "*.*";

    private volatile boolean initialized = false;

    /**
     * ADR-0023 Decision 2 — sealed state. Once {@code true}, every mutating
     * registration entry point throws {@link com.metaobjects.ErrorCode#ERR_REGISTRY_SEALED}.
     * The metaobjects library seals its registry after the agreed metamodel
     * providers bootstrap, so codegen generators cannot self-register made-up
     * metamodel attributes post-bootstrap. A downstream app that genuinely needs
     * to extend the vocabulary simply never seals (or composes its own registry
     * via {@link com.metaobjects.loader.MetaDataLoader#setTypeRegistry}).
     */
    private volatile boolean sealed = false;

    /**
     * Seal the registry: after this call every mutating registration entry point
     * ({@link #register}/{@link #registerType}/{@link #extendType}/
     * {@link #registerCommonAttribute}/{@link #addConstraint}/
     * {@link #registerConstraint}/{@link #setDefaultSubType}/
     * {@link #addGlobalChildRequirement}/{@link #registerProviders}) throws
     * {@link com.metaobjects.ErrorCode#ERR_REGISTRY_SEALED}. Idempotent — sealing
     * an already-sealed registry is a no-op. Reads are unaffected.
     */
    public void seal() {
        this.sealed = true;
    }

    /**
     * @return {@code true} if this registry has been {@link #seal() sealed}.
     */
    public boolean isSealed() {
        return sealed;
    }

    /**
     * Guard invoked at the top of every mutating registration entry point.
     *
     * @param operation a short label for the attempted mutation (used in the
     *                  error message; identifies which registration was rejected)
     * @throws MetaDataException with {@link com.metaobjects.ErrorCode#ERR_REGISTRY_SEALED}
     *                           if the registry is sealed
     */
    private void checkNotSealed(String operation) {
        if (sealed) {
            throw new MetaDataException(
                "Registry is sealed (ADR-0023): " + operation + " is not permitted after "
                + "metamodel bootstrap. Made-up metamodel attributes/types are structurally "
                + "disallowed — a new metamodel attribute requires a registered provider + human "
                + "agreement, not a post-bootstrap registration. Downstream apps that need to "
                + "extend the vocabulary must compose their own (unsealed) registry.",
                com.metaobjects.ErrorCode.ERR_REGISTRY_SEALED);
        }
    }

    /**
     * Get the singleton instance
     * 
     * @return Global MetaDataRegistry instance
     */
    public static MetaDataRegistry getInstance() {
        if (instance == null) {
            synchronized (INSTANCE_LOCK) {
                if (instance == null) {
                    instance = new MetaDataRegistry();
                    // Load service providers to ensure they're available for parsing
                    instance.ensureInitialized();
                }
            }
        }
        return instance;
    }

    /**
     * Create a fresh, isolated registry pre-populated with the standard core
     * types via the same ServiceLoader bootstrap {@link #getInstance()} uses.
     *
     * <p>Unlike {@link #getInstance()} (a process-global singleton), each call
     * returns an independent registry. Hand it to a loader via
     * {@link com.metaobjects.loader.MetaDataLoader#setTypeRegistry} to run that
     * loader against an isolated type system (multi-tenant, plugin isolation,
     * tests). Register additional/extension types onto the returned instance
     * before use.</p>
     *
     * @return a new registry populated with the core type vocabulary
     */
    public static MetaDataRegistry createWithCoreProviders() {
        MetaDataRegistry registry = new MetaDataRegistry();
        registry.ensureInitialized();
        return registry;
    }

    /**
     * Create registry with custom service registry
     *
     * @param serviceRegistry Service registry for extensions
     */
    public MetaDataRegistry(ServiceRegistry serviceRegistry) {
        this.serviceRegistry = Objects.requireNonNull(serviceRegistry, "ServiceRegistry cannot be null");
        log.debug("Created MetaDataRegistry with {}", serviceRegistry.getDescription());
    }
    
    /**
     * Create registry with default service registry
     */
    public MetaDataRegistry() {
        this(ServiceRegistryFactory.getDefault());
    }

    // =========================================================================
    // Programmatic provider composition (mirrors composeRegistry in TS /
    // compose_registry in Python). Use this when you want explicit, in-process
    // control over which providers register types — tests, embedded scenarios
    // where ServiceLoader is awkward, and conditional / framework-driven
    // composition. ServiceLoader auto-discovery via {@link #getInstance()} is
    // the default for typical applications and stays unchanged.
    // =========================================================================

    /**
     * Compose a fresh {@link MetaDataRegistry} from the given providers and
     * return it. Mirrors {@code composeRegistry(providers)} in the TypeScript
     * port and {@code compose_registry(providers)} in the Python port.
     *
     * <p>Providers are topologically sorted by their declared dependencies
     * (stable sort — providers with no ordering constraint between them keep
     * input order), then each provider's {@link MetaDataTypeProvider#registerTypes}
     * runs against the new registry.</p>
     *
     * @param providers the providers to compose; must not contain duplicate
     *                  ids, missing dependencies, or dependency cycles
     * @return a new registry with all provider types registered
     * @throws MetaDataException with {@link com.metaobjects.ErrorCode#ERR_PROVIDER_DUPLICATE_ID},
     *                           {@link com.metaobjects.ErrorCode#ERR_PROVIDER_MISSING_DEPENDENCY},
     *                           or {@link com.metaobjects.ErrorCode#ERR_PROVIDER_DEPENDENCY_CYCLE}
     *                           if the provider set is malformed.
     */
    public static MetaDataRegistry compose(Collection<MetaDataTypeProvider> providers) {
        Objects.requireNonNull(providers, "providers must not be null");
        MetaDataRegistry registry = new MetaDataRegistry();
        registry.registerProviders(providers);
        return registry;
    }

    /**
     * Register a collection of providers into THIS registry. Strict
     * counterpart to ServiceLoader auto-discovery — duplicate ids, missing
     * dependencies, and dependency cycles throw {@link MetaDataException}
     * with the matching {@link com.metaobjects.ErrorCode} rather than logging
     * warnings and continuing.
     *
     * @param providers the providers to register
     * @throws MetaDataException on duplicate id, missing dependency, or cycle
     */
    public synchronized void registerProviders(Collection<MetaDataTypeProvider> providers) {
        Objects.requireNonNull(providers, "providers must not be null");
        checkNotSealed("registerProviders");
        List<MetaDataTypeProvider> ordered = resolveDependenciesStrict(providers);
        for (MetaDataTypeProvider provider : ordered) {
            try {
                provider.registerTypes(this);
                if (!deferredInheritanceTypes.isEmpty()) {
                    resolveDeferredInheritance();
                }
            } catch (com.metaobjects.MetaDataException e) {
                throw e;
            } catch (Exception e) {
                com.metaobjects.MetaDataException wrap = new com.metaobjects.MetaDataException(
                    "Provider '" + provider.getProviderId() + "' failed during registerTypes: " + e.getMessage(),
                    com.metaobjects.ErrorCode.ERR_UNKNOWN);
                wrap.initCause(e);
                throw wrap;
            }
        }
    }

    /**
     * Register a MetaData type with fluent configuration
     *
     * @param clazz Implementation class
     * @param configurator Configuration function for the type definition
     */
    public void registerType(Class<? extends MetaData> clazz,
                                   Consumer<TypeDefinitionBuilder> configurator) {
        checkNotSealed("registerType");
        TypeDefinitionBuilder builder = TypeDefinitionBuilder.forClass(clazz);
        builder.withRegistry(this);  // Provide registry reference for auto-constraint generation
        configurator.accept(builder);
        this.register(builder.build());
    }

    /**
     * Extend an existing registered type with additional attributes/children.
     * This allows service providers to add their own attributes to core types
     * without modifying the core type definitions.
     *
     * @param metaDataClass The implementation class of the type to extend
     * @param extension Configuration function for additional attributes/children
     * @return This registry instance for chaining
     * @throws IllegalArgumentException if the type is not already registered
     */
    public MetaDataRegistry extendType(Class<? extends MetaData> metaDataClass, Consumer<TypeDefinitionBuilder> extension) {
        Objects.requireNonNull(metaDataClass, "MetaData class cannot be null");
        Objects.requireNonNull(extension, "Extension function cannot be null");
        checkNotSealed("extendType");

        // Find the registered type definition by implementation class
        TypeDefinition existing = null;
        MetaDataTypeId typeIdToExtend = null;

        for (Map.Entry<MetaDataTypeId, TypeDefinition> entry : typeDefinitions.entrySet()) {
            if (entry.getValue().getImplementationClass().equals(metaDataClass)) {
                existing = entry.getValue();
                typeIdToExtend = entry.getKey();
                break;
            }
        }

        if (existing == null) {
            throw new IllegalArgumentException(
                "Type must be registered before extension: " + metaDataClass.getName() +
                ". Available types: " + getRegisteredTypeNames()
            );
        }

        // Create a builder from the existing definition.
        // Wire the registry so that auto-generated constraints (e.g. the .array
        // constraint that marks isArray=true in the manifest) are registered during
        // build(). Without withRegistry() the constraints stay in the builder and are
        // lost, causing the manifest to report isArray=false for array-typed attrs.
        TypeDefinitionBuilder builder = TypeDefinitionBuilder.from(existing).withRegistry(this);

        // Apply the extension
        extension.accept(builder);

        // Update the registered type with extended definition
        TypeDefinition extendedDefinition = builder.build();
        typeDefinitions.put(typeIdToExtend, extendedDefinition);

        log.debug("Extended type: {} with additional attributes/children",
                 typeIdToExtend.toQualifiedName());

        return this;
    }

    /**
     * FR-033 — apply a concern provider's {@code extends} directives (read from the
     * embedded {@code spec/metamodel/<provider>.json}) onto the registered types,
     * re-homing the provider's attrs out of the CORE type classes and into the
     * concern provider. This is the data-driven mechanism the
     * {@code metaobjects-ui} / {@code metaobjects-prompt} providers use — the Java
     * analogue of TS/Python reading the same {@code extends} blocks.
     *
     * <p>For each directive, the target subtypes are resolved: an exact subtype, a
     * list, or the {@code "*"} wildcard expanded via {@code subtypeExpansion} (when no
     * explicit expansion is supplied for a wildcarded type, the wildcard is expanded
     * to every CURRENTLY-REGISTERED subtype of that type — matching the historical
     * {@code @xmlText} loop that iterated the registered field subtypes). Each attr is
     * added to the resolved subtype's {@link TypeDefinition} via the same builder DSL
     * the core type classes use ({@code optionalAttributeWithConstraints} /
     * {@code requiredAttributeWithConstraints} + {@code .ofType(...)} +
     * {@code .asArray()}/{@code .asSingle()}), with {@code withRegistry(this)} set so
     * the {@code .asArray()} cardinality constraint is registered (the manifest reads
     * it to mark {@code isArray}).</p>
     *
     * <p>A duplicate attr on a subtype trips the {@link TypeDefinitionBuilder}'s
     * already-exists guard — the intended backstop ensuring an attr is registered by
     * exactly ONE provider (no double-registration with core).</p>
     *
     * @param reader           the parsed spec reader (source of the extends directives)
     * @param providerName     the concern provider name (e.g. {@code "metaobjects-ui"})
     * @param subtypeExpansion explicit {@code "*"}-expansion per type, or empty to fall
     *                         back to the currently-registered subtypes of the type
     */
    public synchronized void applyProviderExtends(
            com.metaobjects.registry.spec.SpecMetamodelReader reader,
            String providerName,
            Map<String, List<String>> subtypeExpansion) {
        Objects.requireNonNull(reader, "reader must not be null");
        Objects.requireNonNull(providerName, "providerName must not be null");
        checkNotSealed("applyProviderExtends");

        for (com.metaobjects.registry.spec.SpecMetamodelReader.ExtendsDirective d
                : reader.extendsDirectives(providerName)) {
            List<String> targets;
            if (d.wildcardSubType()) {
                List<String> explicit = subtypeExpansion != null ? subtypeExpansion.get(d.type()) : null;
                if (explicit != null) {
                    targets = explicit;
                } else {
                    // Fall back to the currently-registered subtypes of the type
                    // (matches the historical @xmlText loop over registered fields).
                    targets = new ArrayList<>();
                    for (MetaDataTypeId id : getRegisteredTypes()) {
                        if (id.type().equals(d.type())) {
                            targets.add(id.subType());
                        }
                    }
                }
            } else {
                targets = d.subTypes();
            }
            for (String subType : targets) {
                applyExtendsAttrs(d.type(), subType, d.attrs());
            }
        }
    }

    /**
     * FR-033 helper — add a directive's attrs to one registered {@code (type, subType)}
     * via the builder DSL, then re-register the rebuilt definition.
     */
    private void applyExtendsAttrs(String type, String subType,
            List<com.metaobjects.registry.spec.SpecMetamodelReader.ExtendsAttr> attrs) {
        MetaDataTypeId typeId = new MetaDataTypeId(type, subType);
        TypeDefinition existing = typeDefinitions.get(typeId);
        if (existing == null) {
            throw new MetaDataException(
                "FR-033 applyProviderExtends: target type must be registered before extension: "
                        + typeId.toQualifiedName());
        }

        TypeDefinitionBuilder builder = TypeDefinitionBuilder.from(existing);
        builder.withRegistry(this); // so .asArray() cardinality constraints are registered
        for (com.metaobjects.registry.spec.SpecMetamodelReader.ExtendsAttr a : attrs) {
            com.metaobjects.registry.AttributeConstraintBuilder acb = a.required()
                    ? builder.requiredAttributeWithConstraints(a.name())
                    : builder.optionalAttributeWithConstraints(a.name());
            com.metaobjects.registry.AttributeConstraintBuilder.AttributeTypeBuilder atb =
                    acb.ofType(extendsValueTypeToAttrSubtype(a.valueType()));
            if (a.isArray()) {
                atb.asArray();
            } else {
                atb.asSingle();
            }
        }
        register(builder.build());
    }

    /** Map a spec {@code valueType} string to the Java attr subtype constant. */
    private static String extendsValueTypeToAttrSubtype(String valueType) {
        if (valueType == null) {
            throw new MetaDataException("FR-033 applyProviderExtends: attr valueType must not be null");
        }
        switch (valueType) {
            case "string":     return com.metaobjects.attr.StringAttribute.SUBTYPE_STRING;
            case "boolean":    return com.metaobjects.attr.BooleanAttribute.SUBTYPE_BOOLEAN;
            case "int":        return com.metaobjects.attr.IntAttribute.SUBTYPE_INT;
            case "properties": return com.metaobjects.attr.PropertiesAttribute.SUBTYPE_PROPERTIES;
            case "filter":     return com.metaobjects.attr.FilterAttribute.SUBTYPE_FILTER;
            default:
                throw new MetaDataException(
                        "FR-033 applyProviderExtends: unsupported attr valueType '" + valueType + "'");
        }
    }


    /**
     * Register a type definition with inheritance resolution
     *
     * @param definition Complete type definition
     */
    public void register(TypeDefinition definition) {
        checkNotSealed("register(TypeDefinition)");
        MetaDataTypeId typeId = new MetaDataTypeId(definition.getType(), definition.getSubType());

        TypeDefinition existing = typeDefinitions.get(typeId);
        if (existing != null && !existing.getImplementationClass().equals(definition.getImplementationClass())) {
            throw new MetaDataException(
                "Type already registered with different implementation: " + typeId.toQualifiedName() +
                ". Existing: " + existing.getImplementationClass().getName() +
                ", New: " + definition.getImplementationClass().getName()
            );
        }

        // Resolve inheritance if this type has a parent
        resolveInheritance(definition);

        typeDefinitions.put(typeId, definition);
        log.debug("Registered type: {} -> {} (parent: {})", typeId.toQualifiedName(),
                 definition.getImplementationClass().getSimpleName(),
                 definition.hasParent() ? definition.getParentQualifiedName() : "none");
    }

    /**
     * Resolve inheritance for a type definition by populating inherited requirements from parent
     *
     * @param definition Type definition to resolve inheritance for
     */
    private void resolveInheritance(TypeDefinition definition) {
        if (!definition.hasParent()) {
            return; // No inheritance to resolve
        }

        MetaDataTypeId parentTypeId = new MetaDataTypeId(definition.getParentType(), definition.getParentSubType());
        TypeDefinition parentDefinition = typeDefinitions.get(parentTypeId);

        if (parentDefinition == null) {
            // Defer inheritance resolution for later when parent might be available
            deferredInheritanceTypes.add(definition);
            log.debug("Deferring inheritance for {} - parent {} not yet registered",
                    definition.getQualifiedName(), parentTypeId.toQualifiedName());
            return;
        }

        // Delegate to extracted method for consistency
        resolveInheritanceForDefinition(definition, parentDefinition);
    }
    
    /**
     * Create a new MetaData instance
     * 
     * @param <T> Expected MetaData type
     * @param type Primary type (e.g., "field", "object")
     * @param subType Specific subtype (e.g., "string", "int")
     * @param name Instance name
     * @return New MetaData instance
     */
    @SuppressWarnings("unchecked")
    public <T extends MetaData> T createInstance(String type, String subType, String name) {
        Objects.requireNonNull(type, "Type cannot be null");
        Objects.requireNonNull(subType, "SubType cannot be null");
        Objects.requireNonNull(name, "Name cannot be null");
        
        MetaDataTypeId typeId = new MetaDataTypeId(type, subType);
        TypeDefinition definition = typeDefinitions.get(typeId);
        
        if (definition == null) {
            throw new MetaDataException(
                "No type registered for: " + typeId.toQualifiedName() +
                ". Available types: " + getRegisteredTypeNames(),
                com.metaobjects.ErrorCode.ERR_UNKNOWN_SUBTYPE
            );
        }
        
        try {
            Class<? extends MetaData> implClass = definition.getImplementationClass();
            
            // Try the standard 3-parameter constructor first
            try {
                Constructor<? extends MetaData> constructor = implClass.getConstructor(
                    String.class, String.class, String.class);
                return (T) constructor.newInstance(type, subType, name);
            } catch (NoSuchMethodException e) {
                // Fall back to other constructor patterns
                try {
                    Constructor<? extends MetaData> constructor = implClass.getConstructor(
                        String.class, String.class);
                    return (T) constructor.newInstance(subType, name);
                } catch (NoSuchMethodException e2) {
                    Constructor<? extends MetaData> constructor = implClass.getConstructor(String.class);
                    return (T) constructor.newInstance(name);
                }
            }
            
        } catch (Exception e) {
            throw new MetaDataException(
                "Failed to create instance of type: " + typeId.toQualifiedName() +
                " with class: " + definition.getImplementationClass().getName(),
                null, null, e, java.util.Collections.emptyMap(),
                com.metaobjects.ErrorCode.ERR_UNKNOWN);
        }
    }
    
    /**
     * Get type definition by type and subtype
     *
     * @param type Primary type
     * @param subType Specific subtype
     * @return TypeDefinition if found, null otherwise
     */
    public TypeDefinition getTypeDefinition(String type, String subType) {
        return typeDefinitions.get(new MetaDataTypeId(type, subType));
    }

    /**
     * Get type definition by MetaDataTypeId
     *
     * @param typeId Type identifier
     * @return TypeDefinition if found, null otherwise
     */
    public TypeDefinition getTypeDefinition(MetaDataTypeId typeId) {
        return typeDefinitions.get(typeId);
    }
    
    /**
     * Check if a parent type accepts a specific child
     * 
     * @param parentType Parent type (e.g., "field", "object")
     * @param parentSubType Parent subType (e.g., "string", "base")
     * @param childType Child type (e.g., "attr", "field")
     * @param childSubType Child subType (e.g., "string", "boolean")
     * @param childName Child name (e.g., "pattern", "required")
     * @return true if the parent accepts this child
     */
    public boolean acceptsChild(String parentType, String parentSubType,
                              String childType, String childSubType, String childName) {
        TypeDefinition parentDef = getTypeDefinition(parentType, parentSubType);
        if (parentDef == null) {
            return false;
        }
        
        // Check type-specific requirements
        if (parentDef.acceptsChild(childType, childSubType, childName)) {
            return true;
        }
        
        // Check global requirements (from service providers)
        String parentKey = parentType + "." + parentSubType;
        List<ChildRequirement> globalReqs = globalRequirements.get(parentKey);
        if (globalReqs != null) {
            for (ChildRequirement req : globalReqs) {
                if (req.matches(childType, childSubType, childName)) {
                    return true;
                }
            }
        }
        
        // Check wildcard global requirements (matches any subType under this parent type)
        String wildcardKey = parentType + ".*";
        List<ChildRequirement> wildcardReqs = globalRequirements.get(wildcardKey);
        if (wildcardReqs != null) {
            for (ChildRequirement req : wildcardReqs) {
                if (req.matches(childType, childSubType, childName)) {
                    return true;
                }
            }
        }

        // Check fully-global universal requirements (common attributes on any node)
        List<ChildRequirement> universalReqs = globalRequirements.get(UNIVERSAL_PARENT_KEY);
        if (universalReqs != null) {
            for (ChildRequirement req : universalReqs) {
                if (req.matches(childType, childSubType, childName)) {
                    return true;
                }
            }
        }

        return false;
    }

    /**
     * Get all child requirements for a parent type
     * 
     * @param parentType Parent type
     * @param parentSubType Parent subType
     * @return List of all child requirements (type-specific + global)
     */
    public List<ChildRequirement> getChildRequirements(String parentType, String parentSubType) {
        List<ChildRequirement> requirements = new ArrayList<>();
        
        // Add type-specific requirements
        TypeDefinition parentDef = getTypeDefinition(parentType, parentSubType);
        if (parentDef != null) {
            requirements.addAll(parentDef.getChildRequirements());
        }
        
        // Add global requirements
        String parentKey = parentType + "." + parentSubType;
        List<ChildRequirement> globalReqs = globalRequirements.get(parentKey);
        if (globalReqs != null) {
            requirements.addAll(globalReqs);
        }
        
        // Add wildcard global requirements
        String wildcardKey = parentType + ".*";
        List<ChildRequirement> wildcardReqs = globalRequirements.get(wildcardKey);
        if (wildcardReqs != null) {
            requirements.addAll(wildcardReqs);
        }

        // Add fully-global universal requirements (common attributes on any node)
        List<ChildRequirement> universalReqs = globalRequirements.get(UNIVERSAL_PARENT_KEY);
        if (universalReqs != null) {
            requirements.addAll(universalReqs);
        }

        return requirements;
    }
    
    /**
     * Get a specific child requirement by name
     * 
     * @param parentType Parent type
     * @param parentSubType Parent subType
     * @param childName Child name to look up
     * @return ChildRequirement if found, null otherwise
     */
    public ChildRequirement getChildRequirement(String parentType, String parentSubType, String childName) {
        // Check type-specific requirements first
        TypeDefinition parentDef = getTypeDefinition(parentType, parentSubType);
        if (parentDef != null) {
            ChildRequirement req = parentDef.getChildRequirement(childName);
            if (req != null) {
                return req;
            }
        }
        
        // Check global requirements
        List<ChildRequirement> allReqs = getChildRequirements(parentType, parentSubType);
        for (ChildRequirement req : allReqs) {
            if (childName.equals(req.getName())) {
                return req;
            }
        }
        
        return null;
    }
    
    /**
     * Add a global child requirement (used by service providers)
     *
     * @param parentType Parent type pattern ("field", "object", "*")
     * @param parentSubType Parent subType pattern ("string", "base", "*")
     * @param requirement Child requirement to add
     */
    public void addGlobalChildRequirement(String parentType, String parentSubType, ChildRequirement requirement) {
        checkNotSealed("addGlobalChildRequirement");
        String key = parentType + "." + parentSubType;
        globalRequirements.computeIfAbsent(key, k -> new ArrayList<>()).add(requirement);

        log.debug("Added global child requirement: {} accepts {}", key, requirement.getDescription());
    }

    // ========== COMMON ATTRIBUTES (cross-language commonAttrs contract) ==========

    /**
     * Register a "common attribute" — one that is valid on every node (any type /
     * any subType). Cross-language parity: TS {@code registerCommonAttrs}, C#
     * {@code RegisterCommonAttrs}, Python {@code register_common_attrs}.
     *
     * <p>Wires three things in one call:</p>
     * <ul>
     *   <li>A global {@link ChildRequirement} under the {@code "*.*"} key so
     *       {@link #acceptsChild} returns {@code true} for this attr on any parent.</li>
     *   <li>A wildcard {@link PlacementConstraint} so {@link ConstraintEnforcer}
     *       permits the placement on any parent.</li>
     *   <li>For {@code isArray=true} attrs, a globally-applicable array
     *       {@link CustomConstraint} keyed as {@code "*.*.<name>.array"} so the
     *       bare-string → single-element-array desugar in
     *       {@code CanonicalJsonParser.processAttributes} fires for any parent.</li>
     * </ul>
     *
     * <p>Idempotent: re-registering the same attr name is a no-op.</p>
     *
     * @param name      bare attribute name (no {@code @} prefix; e.g. {@code "description"})
     * @param valueType attribute value subtype (e.g. {@link StringAttribute#SUBTYPE_STRING},
     *                  {@link BooleanAttribute#SUBTYPE_BOOLEAN})
     * @param isArray   {@code true} if the attribute holds an array of {@code valueType}
     */
    public void registerCommonAttribute(String name, String valueType, boolean isArray) {
        if (name == null || name.isEmpty()) {
            throw new IllegalArgumentException("Common attribute name must not be null or empty");
        }
        if (valueType == null || valueType.isEmpty()) {
            throw new IllegalArgumentException("Common attribute valueType must not be null or empty");
        }

        // Idempotent: skip re-registration of the same attr name (allows tests that
        // re-initialise the registry to not blow up on duplicate constraints). This
        // precedes the seal guard so a no-op re-registration never trips the seal.
        if (commonAttributes.containsKey(name)) {
            return;
        }
        checkNotSealed("registerCommonAttribute(" + name + ")");

        CommonAttributeDef def = new CommonAttributeDef(name, valueType, isArray);
        commonAttributes.put(name, def);

        // 1. Global ChildRequirement under the UNIVERSAL_PARENT_KEY tier — makes
        //    acceptsChild() return true for this attr on any (parentType, parentSubType) pair.
        ChildRequirement req = new ChildRequirement(name, MetaAttribute.TYPE_ATTR, valueType, false);
        addGlobalChildRequirement("*", "*", req);

        // 2. Wildcard PlacementConstraint — the enforcer's appliesTo() honours "*.*"
        //    parent patterns natively.
        String placementId = "common." + name + ".placement";
        if (!hasConstraint(placementId)) {
            addConstraint(new PlacementConstraint(
                placementId,
                "Common attribute '" + name + "' is allowed on any node",
                "*", "*",                              // parent: anything
                MetaAttribute.TYPE_ATTR, valueType, name, // child: attr.<valueType>[name]
                true));
        }

        // 3. For array attrs: globally-applicable array CustomConstraint keyed as
        //    "*.*.<name>.array" — looked up by CanonicalJsonParser's bare-string
        //    desugar (with a wildcard fallback) so `"x"` becomes `["x"]`.
        if (isArray) {
            String arrayConstraintId = "*.*." + name + ".array";
            if (!hasConstraint(arrayConstraintId)) {
                addConstraint(new CustomConstraint(
                    arrayConstraintId,
                    "Common attribute '" + name + "' must be array-shaped on any node",
                    (metadata) -> true, // applies to any node (per-attr presence checked in validator)
                    (metadata, value) -> isArrayShapedValue(value),
                    "Array shape validation"));
            }
        }

        log.debug("Registered common attribute: @{} ({}{})",
            name, valueType, isArray ? "[]" : "");
    }

    /**
     * Look up a common attribute definition by name.
     *
     * @param name bare attribute name (no {@code @} prefix)
     * @return the definition, or {@code null} if not registered as a common attribute
     */
    public CommonAttributeDef getCommonAttribute(String name) {
        return commonAttributes.get(name);
    }

    /**
     * Whether any common attribute is registered.
     *
     * @return {@code true} if the registry has at least one common attribute
     */
    public boolean hasCommonAttributes() {
        return !commonAttributes.isEmpty();
    }

    /**
     * Return every registered common attribute definition. Used by the SP-G
     * registry-conformance manifest emitter (the cross-port {@code commonAttrs}
     * facet). The order is unspecified — callers that need byte-stability sort
     * by {@link CommonAttributeDef#name()}.
     *
     * @return an unmodifiable snapshot of all registered common attributes
     */
    public Collection<CommonAttributeDef> getCommonAttributes() {
        return List.copyOf(commonAttributes.values());
    }

    /**
     * FR-033 (sub-step B1) — source every type / attr / common-attr <em>description</em>
     * (+ optional {@code rules}/{@code example}/{@code whenToUse}) from the shared
     * {@code spec/metamodel/*.json} (the cross-port single source of truth, read by
     * {@link com.metaobjects.registry.spec.SpecMetamodelReader}) onto this registry.
     *
     * <p>Applied DURING composition, BEFORE {@link #seal()} (the type definitions are
     * immutable, so each {@link TypeDefinition} carrying a JSON description is rebuilt
     * and re-put; each attr {@link ChildRequirement} that the JSON describes is copied
     * with its {@code docDescription}; each {@link CommonAttributeDef} is replaced by a
     * copy carrying the universal {@code *.*} description). Descriptions come from the
     * JSON ONLY — never hand-copied — so they are byte-identical to the TS reference.</p>
     *
     * <p>Where Java registers an attr the JSON does NOT describe for that subtype (or
     * vice-versa) this is left untouched — that scoping mismatch is reconciled in
     * sub-step B2; B1 applies descriptions only where they match.</p>
     *
     * @param reader the parsed embedded spec/metamodel reader
     */
    public synchronized void applySpecDescriptions(com.metaobjects.registry.spec.SpecMetamodelReader reader) {
        Objects.requireNonNull(reader, "reader must not be null");
        checkNotSealed("applySpecDescriptions");

        // Pass 1 — rebuild every TypeDefinition with the JSON type docs + per-attr
        // doc descriptions on its DIRECT (+ wildcard) child requirements.
        for (Map.Entry<MetaDataTypeId, TypeDefinition> entry : new ArrayList<>(typeDefinitions.entrySet())) {
            MetaDataTypeId id = entry.getKey();
            TypeDefinition def = entry.getValue();

            com.metaobjects.registry.spec.SpecMetamodelReader.DocFacet typeDoc =
                    reader.typeDoc(id.type(), id.subType());
            String description = (typeDoc != null && typeDoc.description() != null)
                    ? typeDoc.description() : def.getDescription();
            String rules = typeDoc != null ? typeDoc.rules() : def.getRules();
            String example = typeDoc != null ? typeDoc.example() : def.getExample();
            String whenToUse = typeDoc != null ? typeDoc.whenToUse() : def.getWhenToUse();

            // Rebuild the DIRECT child requirements, threading attr doc descriptions.
            Map<String, ChildRequirement> directReqs = new LinkedHashMap<>();
            for (ChildRequirement req : def.getDirectChildRequirements()) {
                ChildRequirement rebuilt = req;
                if (MetaAttribute.TYPE_ATTR.equals(req.getExpectedType())
                        && req.getName() != null && !"*".equals(req.getName())) {
                    com.metaobjects.registry.spec.SpecMetamodelReader.AttrEntry attrDoc =
                            reader.attrDoc(id.type(), id.subType(), req.getName());
                    if (attrDoc != null && attrDoc.description() != null) {
                        rebuilt = req.withDocDescription(attrDoc.description());
                    }
                    // ADR-0036 Wave 1 (decision 5) — thread the attr's closed
                    // value-set onto the requirement so the manifest can emit it.
                    if (attrDoc != null && attrDoc.allowedValues() != null) {
                        rebuilt = rebuilt.withAllowedValues(attrDoc.allowedValues());
                    }
                }
                String key = rebuilt.getName();
                if (key == null || "*".equals(key)) {
                    key = "*:" + rebuilt.getExpectedType() + ":" + rebuilt.getExpectedSubType();
                }
                directReqs.put(key, rebuilt);
            }

            TypeDefinition rebuiltDef = new TypeDefinition(
                    def.getImplementationClass(), id.type(), id.subType(), description,
                    directReqs, def.getParentType(), def.getParentSubType(),
                    rules, example, whenToUse, def.getParents());
            // Preserve singleton-cardinality + config-driven default name across the
            // doc-slot rebuild (constructor does not carry them).
            rebuiltDef.setMaxOccurs(def.getMaxOccurs());
            rebuiltDef.setDefaultName(def.getDefaultName());
            rebuiltDef.setReferences(def.getReferences());
            rebuiltDef.setValidator(def.getValidator());
            typeDefinitions.put(id, rebuiltDef);
        }

        // Pass 2 — re-resolve inheritance so each child re-inherits the REBUILT parent
        // requirements (carrying descriptions). Crucially, an inherited attr req is
        // re-described against the CHILD's own (type, subType): the JSON sometimes
        // scopes an attr to a concrete subtype (e.g. @discriminator on object.entity)
        // while Java declares it on the base (object.base) and inherits it. Describing
        // the inherited copy by the child subtype lands the JSON description on the
        // child where the cross-port golden carries it, and correctly leaves it empty
        // on a sibling the JSON does NOT scope it to. Where Java's inheritance direction
        // disagrees with the JSON scope, that is the B2 scoping reconciliation — B1 only
        // applies the description where the JSON declares it for that subtype.
        for (TypeDefinition def : new ArrayList<>(typeDefinitions.values())) {
            if (def.hasParent()) {
                TypeDefinition parent = typeDefinitions.get(
                        new MetaDataTypeId(def.getParentType(), def.getParentSubType()));
                if (parent != null) {
                    resolveInheritanceForDefinition(def, parent);
                    describeInheritedAttrs(def, reader);
                }
            }
        }

        // Pass 3 — common-attr descriptions from the universal *.* documentation entry.
        for (Map.Entry<String, CommonAttributeDef> e : new ArrayList<>(commonAttributes.entrySet())) {
            com.metaobjects.registry.spec.SpecMetamodelReader.AttrEntry doc =
                    reader.commonAttrDoc(e.getKey());
            if (doc != null && doc.description() != null) {
                commonAttributes.put(e.getKey(), e.getValue().withDescription(doc.description()));
            }
        }

        // Pass 4 (FR-033 B2a) — REPLACE each declared type's STRUCTURAL child
        // requirements with the strict cross-port graph from spec/metamodel/*.json
        // (extendsBase-composed), carrying cardinality (min/max/named). Java
        // registers broad/inherited structural wildcards (e.g. object.base accepts
        // field/object/identity/attr/validator/view/layout/relationship/source/
        // template; every field subtype inherits attr/validator/view/origin); the
        // strict graph is the INTERSECTION the cross-port golden carries. The attr
        // child requirements + the any-attr wildcard + placement/validation
        // constraints + factories/bindings are left UNTOUCHED (attr scoping is B2b).
        // Types NOT declared in the JSON (metadata.root, attr.*, object.managed,
        // the generic view.* controls) keep their existing structural children.
        applyStrictStructuralChildren(reader);

        // Pass 5 (FR-033 B2b) — PRUNE each declared type's LOGICAL (INCLUDED) attr
        // requirements down to the strict per-subtype allow-list the cross-port
        // golden carries (sourced from spec/metamodel/*.json, extendsBase- and
        // extends-composed). Java registers some attrs broadly (e.g. @maxLength /
        // @storage / @objectRef / @autoSet / @precision / @scale on field.base +
        // every field subtype, or @discriminator/@discriminatorValue on object.base
        // inherited by value/projection); the strict graph scopes each to exactly
        // the subtypes the JSON declares (e.g. @maxLength → field.string only,
        // @precision/@scale → field.decimal, @storage/@objectRef → field.object,
        // @autoSet → field.date/time/timestamp, @discriminator* → object.entity).
        // CARVED-OUT attrs (the classifyPerTypeAttr exclusions — isArray/isAbstract/
        // extends/implements/isInterface/object/objectAdapter/description) are LEFT
        // REGISTERED: the emitter drops them from the manifest anyway and the loader
        // needs them (e.g. an authored `extends:`). Only the INCLUDED logical attrs
        // are pruned, which also TIGHTENS the loader — a misplaced attr (e.g.
        // @maxLength on field.boolean) now → ERR_UNKNOWN_ATTR. Types NOT declared in
        // the JSON keep their attrs untouched (no JSON-sourced strict set exists).
        applyStrictAttrScoping(reader);
    }

    /**
     * FR-033 (sub-step B2b) — Pass 5 of {@link #applySpecDescriptions}. For every
     * registered {@code (type, subType)} the spec declares, drop every LOGICAL
     * ({@link RegistryManifest.ExclusionReason#INCLUDED}) attr requirement whose name
     * is NOT in the strict per-subtype allow-list
     * ({@link com.metaobjects.registry.spec.SpecMetamodelReader#strictAttrNames}).
     * Carved-out attrs (structural keywords / native bindings / the per-type
     * {@code description} dup) are preserved — they are excluded from the manifest by
     * the emitter and the loader still needs them. Pruning is applied to BOTH the
     * direct and the inherited attr requirements (the strict set is per-subtype, so a
     * subtype no longer keeps a broadly-inherited attr the JSON does not scope to it).
     */
    private void applyStrictAttrScoping(com.metaobjects.registry.spec.SpecMetamodelReader reader) {
        for (Map.Entry<MetaDataTypeId, TypeDefinition> entry : new ArrayList<>(typeDefinitions.entrySet())) {
            MetaDataTypeId id = entry.getKey();
            TypeDefinition def = entry.getValue();

            if (!reader.isDeclared(id.type(), id.subType())) {
                continue; // not in the spec → keep Java's existing attr scoping
            }

            Set<String> allow = reader.strictAttrNames(id.type(), id.subType());

            // Rebuild DIRECT requirements, dropping disallowed INCLUDED attrs.
            Map<String, ChildRequirement> directReqs = new LinkedHashMap<>();
            for (ChildRequirement req : def.getDirectChildRequirements()) {
                if (isPrunableAttr(req) && !allow.contains(req.getName())) {
                    continue; // logical attr not scoped to this subtype → prune
                }
                directReqs.put(directKey(req), req);
            }

            TypeDefinition rebuilt = new TypeDefinition(
                    def.getImplementationClass(), id.type(), id.subType(), def.getDescription(),
                    directReqs, def.getParentType(), def.getParentSubType(),
                    def.getRules(), def.getExample(), def.getWhenToUse(), def.getParents());

            // Re-populate inherited requirements, dropping disallowed INCLUDED attrs.
            Map<String, ChildRequirement> inherited = new LinkedHashMap<>();
            for (Map.Entry<String, ChildRequirement> e : def.getInheritedChildRequirements().entrySet()) {
                ChildRequirement req = e.getValue();
                if (isPrunableAttr(req) && !allow.contains(req.getName())) {
                    continue; // logical attr not scoped to this subtype → prune
                }
                inherited.put(e.getKey(), req);
            }
            rebuilt.populateInheritedRequirements(inherited);
            // Preserve singleton-cardinality + config-driven default name across the
            // strict-attr-pruning rebuild (constructor does not carry them).
            rebuilt.setMaxOccurs(def.getMaxOccurs());
            rebuilt.setDefaultName(def.getDefaultName());
            rebuilt.setReferences(def.getReferences());
            rebuilt.setValidator(def.getValidator());

            typeDefinitions.put(id, rebuilt);
        }
    }

    /**
     * FR-033 (sub-step B2b) — true when a requirement is a NAMED, LOGICAL attr the
     * strict per-subtype scoping may prune: an {@code attr}-typed requirement with a
     * concrete (non-wildcard) name that the manifest classifies as
     * {@link RegistryManifest.ExclusionReason#INCLUDED}. Returns false for the
     * any-attr wildcard, structural placement rules, and the carved-out attrs
     * (structural keywords / native bindings / the {@code description} common-attr
     * dup) — those are left registered.
     */
    private static boolean isPrunableAttr(ChildRequirement req) {
        if (!MetaAttribute.TYPE_ATTR.equals(req.getExpectedType())) {
            return false; // structural placement rule
        }
        String name = req.getName();
        if (name == null || "*".equals(name)) {
            return false; // the any-attr wildcard
        }
        return RegistryManifest.classifyPerTypeAttr(name)
                == RegistryManifest.ExclusionReason.INCLUDED;
    }

    /**
     * FR-033 (sub-step B2a) — Pass 4 of {@link #applySpecDescriptions}. For every
     * registered {@code (type, subType)} the spec declares, rebuild its
     * {@link TypeDefinition} so its STRUCTURAL (non-attr) child requirements are
     * EXACTLY the strict {@code spec/metamodel/*.json} graph (extendsBase-composed,
     * carrying {@code min}/{@code max}/{@code named}). The attr child requirements
     * (direct + inherited) and the placement/validation constraints are preserved
     * verbatim; only the structural requirements are swapped. Inherited structural
     * requirements are stripped (the strict graph is computed per-subtype, so a
     * subtype no longer inherits the parent's broad structural wildcards).
     */
    private void applyStrictStructuralChildren(com.metaobjects.registry.spec.SpecMetamodelReader reader) {
        for (Map.Entry<MetaDataTypeId, TypeDefinition> entry : new ArrayList<>(typeDefinitions.entrySet())) {
            MetaDataTypeId id = entry.getKey();
            TypeDefinition def = entry.getValue();

            if (!reader.isDeclared(id.type(), id.subType())) {
                continue; // not in the spec → keep Java's existing structural children
            }

            // Rebuild DIRECT requirements: keep non-structural (attrs + constraints),
            // drop the broad structural wildcards, add the strict structural graph.
            Map<String, ChildRequirement> directReqs = new LinkedHashMap<>();
            for (ChildRequirement req : def.getDirectChildRequirements()) {
                if (isStructuralPlacement(req)) {
                    continue; // dropped — replaced by the strict graph below
                }
                directReqs.put(directKey(req), req);
            }
            for (com.metaobjects.registry.spec.SpecMetamodelReader.StructChild sc
                    : reader.structuralChildren(id.type(), id.subType())) {
                ChildRequirement req = ChildRequirement.structural(
                        sc.childName(), sc.childType(), sc.childSubType(),
                        sc.min(), sc.max(), sc.maxIsNull(), sc.named());
                directReqs.put(directKey(req), req);
            }

            TypeDefinition rebuilt = new TypeDefinition(
                    def.getImplementationClass(), id.type(), id.subType(), def.getDescription(),
                    directReqs, def.getParentType(), def.getParentSubType(),
                    def.getRules(), def.getExample(), def.getWhenToUse(), def.getParents());

            // Re-populate inherited requirements minus the parent's structural
            // wildcards (the strict graph is per-subtype, NOT inherited). The
            // inherited ATTR requirements (carrying their descriptions) are kept.
            Map<String, ChildRequirement> inheritedNonStructural = new LinkedHashMap<>();
            for (Map.Entry<String, ChildRequirement> e : def.getInheritedChildRequirements().entrySet()) {
                if (!isStructuralPlacement(e.getValue())) {
                    inheritedNonStructural.put(e.getKey(), e.getValue());
                }
            }
            rebuilt.populateInheritedRequirements(inheritedNonStructural);
            // Preserve singleton-cardinality + config-driven default name across the
            // structural-graph rebuild (constructor does not carry them).
            rebuilt.setMaxOccurs(def.getMaxOccurs());
            rebuilt.setDefaultName(def.getDefaultName());
            rebuilt.setReferences(def.getReferences());
            rebuilt.setValidator(def.getValidator());

            typeDefinitions.put(id, rebuilt);
        }
    }

    /**
     * FR-033 (sub-step B2a) — true when a requirement is a STRUCTURAL placement rule
     * (a non-attr, concrete child type — {@code field}/{@code validator}/{@code view}/
     * {@code origin}/{@code identity}/{@code source}/{@code relationship}/
     * {@code template}/{@code layout}/{@code object}/…), as opposed to an attr
     * requirement, the any-{@code *} wildcard, or a placement/validation constraint.
     * These are the requirements Pass 4 replaces with the strict graph.
     */
    private static boolean isStructuralPlacement(ChildRequirement req) {
        if (req.isPlacementConstraint() || req.isValidationConstraint()) {
            return false;
        }
        String type = req.getExpectedType();
        return type != null && !"*".equals(type) && !MetaAttribute.TYPE_ATTR.equals(type);
    }

    /** The TypeDefinition direct-requirement map key (name, or a wildcard tuple key). */
    private static String directKey(ChildRequirement req) {
        String key = req.getName();
        if (key == null || "*".equals(key)) {
            key = "*:" + req.getExpectedType() + ":" + req.getExpectedSubType();
        }
        return key;
    }

    /**
     * FR-033 (sub-step B1) — re-describe a definition's INHERITED attr requirements
     * against the definition's OWN {@code (type, subType)}, so a JSON description that
     * the spec scopes to a concrete subtype lands on the inherited copy where the
     * cross-port golden carries it. Replaces each inherited attr requirement with a
     * doc-described copy when the spec describes that attr for this subtype.
     */
    private void describeInheritedAttrs(TypeDefinition def,
                                        com.metaobjects.registry.spec.SpecMetamodelReader reader) {
        Map<String, ChildRequirement> inherited = def.getInheritedChildRequirements();
        if (inherited.isEmpty()) {
            return;
        }
        Map<String, ChildRequirement> redescribed = new LinkedHashMap<>(inherited);
        boolean changed = false;
        for (Map.Entry<String, ChildRequirement> e : inherited.entrySet()) {
            ChildRequirement req = e.getValue();
            if (!MetaAttribute.TYPE_ATTR.equals(req.getExpectedType())
                    || req.getName() == null || "*".equals(req.getName())) {
                continue;
            }
            com.metaobjects.registry.spec.SpecMetamodelReader.AttrEntry doc =
                    reader.attrDoc(def.getType(), def.getSubType(), req.getName());
            if (doc == null) {
                continue;
            }
            ChildRequirement rebuilt = req;
            boolean reqChanged = false;
            if (doc.description() != null && !doc.description().equals(req.getDocDescription())) {
                rebuilt = rebuilt.withDocDescription(doc.description());
                reqChanged = true;
            }
            // ADR-0036 Wave 1 (decision 5) — thread the inherited attr's closed
            // value-set onto its per-subtype copy (e.g. @dbColumnType /
            // @sortableDefaultOrder inherited from field.base onto every field
            // subtype) so the manifest emits it on every subtype the golden carries.
            if (doc.allowedValues() != null && !doc.allowedValues().equals(req.getAllowedValues())) {
                rebuilt = rebuilt.withAllowedValues(doc.allowedValues());
                reqChanged = true;
            }
            if (reqChanged) {
                redescribed.put(e.getKey(), rebuilt);
                changed = true;
            }
        }
        if (changed) {
            def.populateInheritedRequirements(redescribed);
        }
    }

    /**
     * Lightweight array-shape predicate for common-array-attr validation. Mirrors
     * the per-type {@code AttributeConstraintBuilder.isArrayValue} contract:
     * {@code null} is permitted (optional), bracketed or comma-delimited string
     * forms are permitted. The actual structured list value (post-desugar) is a
     * {@code List<?>} which we also accept.
     *
     * <p>The empty-string acceptance is the desugar-invariant case (not author
     * input): the canonical bare-string desugar in CanonicalJsonParser may emit
     * an empty token through {@code convertJsonArrayToCommaDelimited} for an
     * empty JSON array {@code []}. Authored empty values arrive as {@code null}
     * via the optional-attr path.</p>
     */
    private static boolean isArrayShapedValue(Object value) {
        if (value == null) return true; // optional
        if (value instanceof List<?>) return true;
        if (value instanceof String s) {
            return (s.startsWith("[") && s.endsWith("]")) || s.contains(",")
                || s.isEmpty(); // empty post-desugar (see Javadoc)
        }
        return false;
    }

    // ========== UNIFIED CONSTRAINT SUPPORT ==========

    /**
     * @deprecated Legacy method for backward compatibility during constraint system migration.
     * Use addConstraint() with concrete constraint classes instead.
     */
    @Deprecated
    public void registerPlacementConstraint(String constraintId, String description,
                                           Object parentMatcher,
                                           Object childMatcher) {
        log.warn("Using deprecated registerPlacementConstraint() method. Consider migrating to addConstraint() with concrete constraint classes.");
        // No-op for backward compatibility during migration
    }

    /**
     * @deprecated Legacy method for backward compatibility during constraint system migration.
     * Use addConstraint() with concrete constraint classes instead.
     */
    @Deprecated
    public void registerValidationConstraint(String constraintId, String description,
                                            Object applicabilityTest,
                                            Object valueValidator) {
        log.warn("Using deprecated registerValidationConstraint() method. Consider migrating to addConstraint() with concrete constraint classes.");
        // No-op for backward compatibility during migration
    }


    
    /**
     * Get human-readable description of supported children for error messages
     * 
     * @param parentType Parent type
     * @param parentSubType Parent subType
     * @return Description of all supported children
     */
    public String getSupportedChildrenDescription(String parentType, String parentSubType) {
        TypeDefinition typeDef = getTypeDefinition(parentType, parentSubType);
        StringBuilder result = new StringBuilder();
        
        // Include the type's own description
        if (typeDef != null && typeDef.getDescription() != null) {
            result.append(typeDef.getDescription());
        }
        
        List<ChildRequirement> requirements = getChildRequirements(parentType, parentSubType);
        
        if (!requirements.isEmpty()) {
            List<String> descriptions = requirements.stream()
                .map(ChildRequirement::getDescription)
                .collect(Collectors.toList());
            
            if (result.length() > 0) {
                result.append(". ");
            }
            result.append("Supports: ").append(String.join(", ", descriptions));
        } else if (result.length() == 0) {
            return "No children supported";
        }
        
        return result.toString();
    }
    
    /**
     * Check if a type is registered
     * 
     * @param type Primary type
     * @param subType Specific subtype
     * @return true if registered
     */
    public boolean isRegistered(String type, String subType) {
        return typeDefinitions.containsKey(new MetaDataTypeId(type, subType));
    }
    
    /**
     * Check if any type is registered with the given primary type name
     * 
     * @param type Primary type name (e.g., "field", "view", "validator")
     * @return true if any subtype is registered for this primary type
     */
    public boolean hasType(String type) {
        Objects.requireNonNull(type, "Type cannot be null");
        
        return typeDefinitions.keySet().stream()
            .anyMatch(typeId -> type.equals(typeId.type()));
    }
    
    // Deprecated loader registration methods removed
    
    /**
     * Get all registered type identifiers
     * 
     * @return Set of registered MetaDataTypeId instances
     */
    public Set<MetaDataTypeId> getRegisteredTypes() {
        return Set.copyOf(typeDefinitions.keySet());
    }
    
    /**
     * Designate the default subType for a bare {@code type} YAML key (ADR-0006 Rule 1).
     *
     * <p>Mirrors {@code TypeRegistry.setDefaultSubType} in TS / {@code set_default_sub_type}
     * in Python. Used by {@link com.metaobjects.loader.parser.yaml.YamlDesugar} when
     * resolving sugared {@code metadata:} / {@code object:} keys to their fused form.
     * The last registration wins.</p>
     *
     * @param type    primary type identifier (e.g. {@code "metadata"}, {@code "object"});
     *                must not be {@code null}
     * @param subType default subType to attach when the YAML key omits it (e.g. {@code "root"},
     *                {@code "entity"}); must not be {@code null}
     */
    public void setDefaultSubType(String type, String subType) {
        Objects.requireNonNull(type, "Type cannot be null");
        Objects.requireNonNull(subType, "SubType cannot be null");
        checkNotSealed("setDefaultSubType(" + type + ")");
        defaultSubTypes.put(type, subType);
    }

    /**
     * Return the designated default subType for {@code type}, or {@code null} if none.
     *
     * <p>Mirrors {@code TypeRegistry.defaultSubTypeOf} in TS / {@code default_sub_type_of}
     * in Python.</p>
     *
     * @param type primary type identifier; must not be {@code null}
     * @return the designated default subType, or {@code null} when no default was registered
     */
    public String defaultSubTypeOf(String type) {
        Objects.requireNonNull(type, "Type cannot be null");
        return defaultSubTypes.get(type);
    }
    
    /**
     * Get all registered type names for display
     * 
     * @return Set of qualified type names like "field.string", "object.base"
     */
    public Set<String> getRegisteredTypeNames() {
        return typeDefinitions.keySet().stream()
            .map(MetaDataTypeId::toQualifiedName)
            .collect(Collectors.toSet());
    }
    
    /**
     * Get all type definitions
     * 
     * @return Collection of all registered type definitions
     */
    public Collection<TypeDefinition> getAllTypeDefinitions() {
        return Collections.unmodifiableCollection(typeDefinitions.values());
    }
    
    /**
     * Clear all registrations (primarily for testing)
     */
    public void clear() {
        typeDefinitions.clear();
        globalRequirements.clear();
        initialized = false;
        log.debug("Cleared all type registrations");
    }
    
    /**
     * Get registry statistics
     * 
     * @return RegistryStats with type counts and service information
     */
    public RegistryStats getStats() {
        Map<String, Integer> typesByPrimary = new HashMap<>();
        for (MetaDataTypeId typeId : typeDefinitions.keySet()) {
            typesByPrimary.merge(typeId.type(), 1, Integer::sum);
        }
        
        int globalRequirementCount = globalRequirements.values().stream()
            .mapToInt(List::size)
            .sum();
        
        return new RegistryStats(
            typeDefinitions.size(),
            typesByPrimary,
            globalRequirementCount,
            serviceRegistry.getDescription(),
            getValidationConstraintTypeSummary()
        );
    }
    
    /**
     * Ensure service-based extensions are loaded
     */
    private void ensureInitialized() {
        if (!initialized) {
            synchronized (this) {
                if (!initialized) {
                    loadServiceProviders();
                    initialized = true;
                }
            }
        }
    }
    
    
    
    // Legacy provider loading removed - using unified plugin approach
    

    /**
     * Find a type for extension by type and subtype.
     *
     * <p>This method returns a TypeExtensionBuilder that allows service providers
     * to add optional attributes and child requirements to existing types.</p>
     *
     * @param type The primary type (e.g., "field", "object")
     * @param subType The subtype (e.g., "string", "pojo")
     * @return TypeExtensionBuilder for extending the type
     * @throws IllegalArgumentException if the type is not found
     */
    public TypeExtensionBuilder findType(String type, String subType) {
        MetaDataTypeId typeId = new MetaDataTypeId(type, subType);
        TypeDefinition existing = typeDefinitions.get(typeId);

        if (existing == null) {
            // Try to be helpful with error message
            String availableTypes = typeDefinitions.keySet().stream()
                .filter(id -> id.type().equals(type))
                .map(id -> id.type() + "." + id.subType())
                .collect(Collectors.joining(", "));

            if (availableTypes.isEmpty()) {
                availableTypes = typeDefinitions.keySet().stream()
                    .limit(10)
                    .map(id -> id.type() + "." + id.subType())
                    .collect(Collectors.joining(", "));
                throw new IllegalArgumentException(
                    "Type '" + type + "." + subType + "' not found. No types with primary type '" + type + "' are registered. " +
                    "Available types include: " + availableTypes);
            } else {
                throw new IllegalArgumentException(
                    "Type '" + type + "." + subType + "' not found. Available " + type + " types: " + availableTypes);
            }
        }

        return new TypeExtensionBuilder(this, existing, typeId);
    }

    /**
     * Load service providers via ServiceLoader to extend MetaData types.
     *
     * <p>This method discovers MetaDataTypeProvider implementations from META-INF/services files
     * and delegates to them to extend existing MetaData types with service-specific attributes.</p>
     *
     * <p>Providers are loaded in dependency order using topological sorting to ensure proper
     * dependency resolution. This replaces the fragile priority-based system with explicit dependencies.</p>
     */
    private void loadServiceProviders() {
        try {
            // Get all MetaDataTypeProvider implementations via ServiceLoader
            Collection<MetaDataTypeProvider> providers = serviceRegistry.getServices(MetaDataTypeProvider.class);

            if (providers.isEmpty()) {
                log.debug("No MetaDataTypeProvider services found");
                return;
            }

            // Resolve dependencies using topological sort
            List<MetaDataTypeProvider> resolvedProviders = resolveDependencies(providers);

            log.debug("Loading {} MetaDataTypeProvider services in dependency order", resolvedProviders.size());

            // Register type extensions from each provider in dependency order
            for (MetaDataTypeProvider provider : resolvedProviders) {
                try {
                    long startTime = System.currentTimeMillis();
                    provider.registerTypes(this);

                    // Resolve any deferred inheritance after each provider completes
                    if (!deferredInheritanceTypes.isEmpty()) {
                        resolveDeferredInheritance();
                    }

                    long duration = System.currentTimeMillis() - startTime;

                    String depsStr = provider.getDependencies().length > 0 ?
                        String.join(",", provider.getDependencies()) : "none";

                    log.debug("Loaded provider: {} (id: {}, deps: {}) in {}ms - {}",
                             provider.getClass().getSimpleName(),
                             provider.getProviderId(),
                             depsStr,
                             duration,
                             provider.getDescription());

                } catch (Exception e) {
                    log.error("Failed to load MetaDataTypeProvider: {} - {}",
                             provider.getClass().getName(), e.getMessage(), e);
                    // Continue with other providers - don't fail completely
                }
            }

            log.debug("Successfully loaded {} MetaDataTypeProvider services", resolvedProviders.size());

        } catch (Exception e) {
            log.error("Error during service provider loading: {}", e.getMessage(), e);
        }
    }

    /**
     * Resolve provider dependencies using topological sorting.
     *
     * <p>This algorithm ensures that providers are loaded in the correct order
     * by analyzing their dependency graph. It detects circular dependencies and
     * missing dependencies to prevent runtime errors.</p>
     *
     * @param providers Collection of providers to sort
     * @return List of providers in dependency order
     * @throws IllegalStateException if circular dependencies are detected
     */
    private List<MetaDataTypeProvider> resolveDependencies(Collection<MetaDataTypeProvider> providers) {
        // Build provider map by ID for fast lookup
        Map<String, MetaDataTypeProvider> providerMap = new HashMap<>();
        for (MetaDataTypeProvider provider : providers) {
            String id = provider.getProviderId();
            if (providerMap.containsKey(id)) {
                log.warn("Duplicate provider ID '{}': {} and {}. Using first occurrence.",
                        id, providerMap.get(id).getClass().getName(), provider.getClass().getName());
            } else {
                providerMap.put(id, provider);
            }
        }

        // Validate dependencies and detect missing ones
        Set<String> missingDeps = new HashSet<>();
        for (MetaDataTypeProvider provider : providers) {
            for (String dep : provider.getDependencies()) {
                if (!providerMap.containsKey(dep)) {
                    missingDeps.add(dep + " (required by " + provider.getProviderId() + ")");
                }
            }
        }

        if (!missingDeps.isEmpty()) {
            log.warn("Missing provider dependencies: {}. These will be ignored.", String.join(", ", missingDeps));
        }

        // Perform topological sort using Kahn's algorithm
        List<MetaDataTypeProvider> result = new ArrayList<>();
        Set<String> visited = new HashSet<>();
        Set<String> visiting = new HashSet<>();

        // Try to visit each provider
        for (MetaDataTypeProvider provider : providers) {
            if (!visited.contains(provider.getProviderId())) {
                topologicalSort(provider, providerMap, visited, visiting, result);
            }
        }

        return result;
    }

    /**
     * Recursive topological sort implementation with cycle detection.
     *
     * @param provider Current provider being processed
     * @param providerMap Map of provider ID to provider instance
     * @param visited Set of completely processed providers
     * @param visiting Set of providers currently being processed (for cycle detection)
     * @param result Result list in topological order
     * @throws IllegalStateException if a circular dependency is detected
     */
    private void topologicalSort(MetaDataTypeProvider provider,
                                Map<String, MetaDataTypeProvider> providerMap,
                                Set<String> visited,
                                Set<String> visiting,
                                List<MetaDataTypeProvider> result) {

        String providerId = provider.getProviderId();

        // Check for circular dependency
        if (visiting.contains(providerId)) {
            throw new IllegalStateException("Circular dependency detected involving provider: " + providerId);
        }

        // Skip if already processed
        if (visited.contains(providerId)) {
            return;
        }

        // Mark as currently being processed
        visiting.add(providerId);

        // Process dependencies first
        for (String depId : provider.getDependencies()) {
            MetaDataTypeProvider dependency = providerMap.get(depId);
            if (dependency != null) {
                topologicalSort(dependency, providerMap, visited, visiting, result);
            }
            // Note: Missing dependencies are already logged in resolveDependencies()
        }

        // Mark as completely processed
        visiting.remove(providerId);
        visited.add(providerId);

        // Add to result
        result.add(provider);
    }

    /**
     * Strict counterpart to {@link #resolveDependencies(Collection)}. Used by
     * the programmatic {@link #compose(Collection)} / {@link #registerProviders(Collection)}
     * entry points to match the cross-port error contract: duplicate ids,
     * missing dependencies, and dependency cycles throw {@link com.metaobjects.MetaDataException}
     * with the matching {@link com.metaobjects.ErrorCode} rather than logging and continuing.
     */
    private List<MetaDataTypeProvider> resolveDependenciesStrict(Collection<MetaDataTypeProvider> providers) {
        Map<String, MetaDataTypeProvider> providerMap = new HashMap<>();
        for (MetaDataTypeProvider provider : providers) {
            String id = provider.getProviderId();
            if (providerMap.containsKey(id)) {
                throw new com.metaobjects.MetaDataException(
                    "Duplicate provider id '" + id + "': "
                        + providerMap.get(id).getClass().getName() + " vs "
                        + provider.getClass().getName(),
                    com.metaobjects.ErrorCode.ERR_PROVIDER_DUPLICATE_ID,
                    com.metaobjects.source.CodeSource.DEFAULT);
            }
            providerMap.put(id, provider);
        }

        List<String> missing = new ArrayList<>();
        for (MetaDataTypeProvider provider : providers) {
            for (String dep : provider.getDependencies()) {
                if (!providerMap.containsKey(dep)) {
                    missing.add(dep + " (required by " + provider.getProviderId() + ")");
                }
            }
        }
        if (!missing.isEmpty()) {
            throw new com.metaobjects.MetaDataException(
                "Missing provider dependencies: " + String.join(", ", missing),
                com.metaobjects.ErrorCode.ERR_PROVIDER_MISSING_DEPENDENCY,
                com.metaobjects.source.CodeSource.DEFAULT);
        }

        List<MetaDataTypeProvider> result = new ArrayList<>();
        Set<String> visited = new HashSet<>();
        Set<String> visiting = new HashSet<>();
        for (MetaDataTypeProvider provider : providers) {
            if (!visited.contains(provider.getProviderId())) {
                topologicalSortStrict(provider, providerMap, visited, visiting, result);
            }
        }
        return result;
    }

    private void topologicalSortStrict(MetaDataTypeProvider provider,
                                       Map<String, MetaDataTypeProvider> providerMap,
                                       Set<String> visited,
                                       Set<String> visiting,
                                       List<MetaDataTypeProvider> result) {
        String providerId = provider.getProviderId();
        if (visiting.contains(providerId)) {
            throw new com.metaobjects.MetaDataException(
                "Circular dependency detected involving provider: " + providerId,
                com.metaobjects.ErrorCode.ERR_PROVIDER_DEPENDENCY_CYCLE,
                com.metaobjects.source.CodeSource.DEFAULT);
        }
        if (visited.contains(providerId)) {
            return;
        }
        visiting.add(providerId);
        for (String depId : provider.getDependencies()) {
            MetaDataTypeProvider dependency = providerMap.get(depId);
            if (dependency != null) {
                topologicalSortStrict(dependency, providerMap, visited, visiting, result);
            }
        }
        visiting.remove(providerId);
        visited.add(providerId);
        result.add(provider);
    }

    /**
     * Resolve deferred inheritance for types whose parents weren't available during initial registration.
     * This method should be called after all static type registrations have completed.
     *
     * @return Number of deferred types that were successfully resolved
     */
    public int resolveDeferredInheritance() {
        if (deferredInheritanceTypes.isEmpty()) {
            return 0;
        }

        Set<TypeDefinition> resolved = new HashSet<>();
        Set<TypeDefinition> stillDeferred = new HashSet<>();

        for (TypeDefinition definition : deferredInheritanceTypes) {
            MetaDataTypeId parentTypeId = new MetaDataTypeId(definition.getParentType(), definition.getParentSubType());
            TypeDefinition parentDefinition = typeDefinitions.get(parentTypeId);

            if (parentDefinition != null) {
                try {
                    // Resolve inheritance now that parent is available
                    resolveInheritanceForDefinition(definition, parentDefinition);
                    resolved.add(definition);
                    log.debug("Resolved deferred inheritance for {} from parent {}",
                            definition.getQualifiedName(), parentTypeId.toQualifiedName());
                } catch (Exception e) {
                    log.warn("Failed to resolve deferred inheritance for {}: {}",
                            definition.getQualifiedName(), e.getMessage());
                    stillDeferred.add(definition);
                }
            } else {
                stillDeferred.add(definition);
                log.warn("Parent type {} still not found for {} during deferred resolution",
                        parentTypeId.toQualifiedName(), definition.getQualifiedName());
            }
        }

        // Update deferred set with remaining unresolved types
        deferredInheritanceTypes.clear();
        deferredInheritanceTypes.addAll(stillDeferred);

        int resolvedCount = resolved.size();
        if (resolvedCount > 0) {
            log.debug("Resolved deferred inheritance for {} types, {} still deferred",
                    resolvedCount, stillDeferred.size());
        }

        return resolvedCount;
    }

    /**
     * Extract the inheritance resolution logic so it can be reused for deferred resolution
     */
    private void resolveInheritanceForDefinition(TypeDefinition definition, TypeDefinition parentDefinition) {
        // Get all requirements from parent (direct + inherited)
        Map<String, ChildRequirement> parentRequirements = new HashMap<>();

        // Add parent's direct requirements using proper key generation logic
        for (ChildRequirement req : parentDefinition.getDirectChildRequirements()) {
            String key = req.getName();
            if ("*".equals(key)) {
                // For wildcard requirements, create unique keys to avoid overwrites
                key = "*:" + req.getExpectedType() + ":" + req.getExpectedSubType();
            }
            parentRequirements.put(key, req);
        }

        // Add parent's inherited requirements (recursive inheritance) - these already use unique keys
        parentRequirements.putAll(parentDefinition.getInheritedChildRequirements());

        // Populate inherited requirements in the child definition
        definition.populateInheritedRequirements(parentRequirements);

        log.debug("Inheritance resolved for {}: {} requirements inherited from parent {}",
                definition.getQualifiedName(), parentRequirements.size(),
                parentDefinition.getQualifiedName());
    }

    // ========== REGISTRY HEALTH VALIDATION ==========

    /**
     * Validate registry consistency and architectural compliance.
     * This method performs deferred validation after all registrations complete
     * to avoid order dependency issues during static initialization.
     *
     * @return RegistryHealthReport with validation results and recommendations
     */
    public RegistryHealthReport validateConsistency() {
        RegistryHealthReport report = new RegistryHealthReport();

        // Ensure all types are loaded
        ensureInitialized();

        // Collect statistics for the report
        populateRegistryStatistics(report);

        // Validate base type consistency
        validateBaseTypeConsistency(report);

        // Validate inheritance patterns
        validateInheritancePatterns(report);

        // Validate structural integrity
        validateStructuralIntegrity(report);

        return report;
    }

    /**
     * Populate registry statistics in the health report
     */
    private void populateRegistryStatistics(RegistryHealthReport report) {
        Map<String, Set<String>> typeToSubTypes = new HashMap<>();
        Set<String> allTypes = new HashSet<>();

        for (MetaDataTypeId typeId : typeDefinitions.keySet()) {
            String type = typeId.type();
            String subType = typeId.subType();

            allTypes.add(type);
            typeToSubTypes.computeIfAbsent(type, k -> new HashSet<>()).add(subType);
        }

        report.addMetadata("totalTypes", typeDefinitions.size());
        report.addMetadata("primaryTypes", allTypes.size());
        report.addMetadata("typeToSubTypes", typeToSubTypes);
    }

    /**
     * Validate that all type families have base subtypes
     */
    private void validateBaseTypeConsistency(RegistryHealthReport report) {
        Map<String, Set<String>> typeToSubTypes = getTypeToSubTypesMap();
        Set<String> typesWithBase = new HashSet<>();
        Set<String> typesWithoutBase = new HashSet<>();

        for (String type : typeToSubTypes.keySet()) {
            if (typeToSubTypes.get(type).contains("base")) {
                typesWithBase.add(type);
            } else {
                typesWithoutBase.add(type);
            }
        }

        report.addMetadata("typesWithBase", typesWithBase);
        report.addMetadata("typesWithoutBase", typesWithoutBase);
        report.addMetadata("missingBaseTypes", typesWithoutBase);

        // Add warnings for missing base types
        for (String type : typesWithoutBase) {
            report.addWarning("Type family '" + type + "' missing recommended base subtype");
            report.addRecommendation("Consider adding " + type + ".base for inheritance support");
        }

        // Log success for types with bases
        if (!typesWithBase.isEmpty()) {
            report.addMetadata("baseTypeCompliance",
                String.format("%d/%d type families have base subtypes",
                    typesWithBase.size(), typeToSubTypes.size()));
        }
    }

    /**
     * Validate inheritance patterns are working correctly
     */
    private void validateInheritancePatterns(RegistryHealthReport report) {
        int typesWithInheritance = 0;
        int typesInheritingFromBase = 0;
        List<String> inheritanceChain = new ArrayList<>();

        for (TypeDefinition definition : typeDefinitions.values()) {
            if (definition.hasParent()) {
                typesWithInheritance++;
                inheritanceChain.add(definition.getQualifiedName() + " → " + definition.getParentQualifiedName());

                if ("base".equals(definition.getParentSubType())) {
                    typesInheritingFromBase++;
                }
            }
        }

        report.addMetadata("typesWithInheritance", typesWithInheritance);
        report.addMetadata("typesInheritingFromBase", typesInheritingFromBase);
        report.addMetadata("inheritanceChains", inheritanceChain);

        // Check if inheritance is being utilized effectively
        if (typesWithInheritance == 0) {
            report.addWarning("No types use inheritance - consider using base types for shared attributes");
        } else if (typesInheritingFromBase == 0) {
            report.addWarning("Types have inheritance but none inherit from base types");
        }

        // Check for deferred inheritance issues
        if (!deferredInheritanceTypes.isEmpty()) {
            report.addError("Unresolved inheritance dependencies: " +
                deferredInheritanceTypes.size() + " types have missing parent types");

            for (TypeDefinition deferred : deferredInheritanceTypes) {
                report.addError("Type " + deferred.getQualifiedName() +
                    " cannot find parent " + deferred.getParentQualifiedName());
            }
        }
    }

    /**
     * Validate structural integrity of the registry
     */
    private void validateStructuralIntegrity(RegistryHealthReport report) {
        // Check for duplicate implementations
        Map<Class<?>, List<String>> implementationToTypes = new HashMap<>();

        for (Map.Entry<MetaDataTypeId, TypeDefinition> entry : typeDefinitions.entrySet()) {
            Class<?> implClass = entry.getValue().getImplementationClass();
            String typeName = entry.getKey().toQualifiedName();

            implementationToTypes.computeIfAbsent(implClass, k -> new ArrayList<>()).add(typeName);
        }

        // Report duplicate implementations (usually indicates problems)
        for (Map.Entry<Class<?>, List<String>> entry : implementationToTypes.entrySet()) {
            if (entry.getValue().size() > 1) {
                report.addWarning("Class " + entry.getKey().getSimpleName() +
                    " implements multiple types: " + entry.getValue());
            }
        }

        // Validate core types are present
        validateCoreTypesPresent(report);
    }

    /**
     * Validate that expected core types are registered
     */
    private void validateCoreTypesPresent(RegistryHealthReport report) {
        String[] expectedCoreTypes = {
            "field.base", "object.base", "attr.base", "validator.base", "relationship.base"
        };

        List<String> missingCoreTypes = new ArrayList<>();
        for (String coreType : expectedCoreTypes) {
            String[] parts = coreType.split("\\.");
            if (!isRegistered(parts[0], parts[1])) {
                missingCoreTypes.add(coreType);
            }
        }

        if (!missingCoreTypes.isEmpty()) {
            report.addError("Missing core base types: " + missingCoreTypes);
            report.addRecommendation("Ensure all base types are registered during static initialization");
        } else {
            report.addMetadata("coreTypesComplete", "All expected core base types present");
        }
    }

    /**
     * Get type to subtypes mapping for analysis
     */
    private Map<String, Set<String>> getTypeToSubTypesMap() {
        Map<String, Set<String>> typeToSubTypes = new HashMap<>();

        for (MetaDataTypeId typeId : typeDefinitions.keySet()) {
            typeToSubTypes.computeIfAbsent(typeId.type(), k -> new HashSet<>()).add(typeId.subType());
        }

        return typeToSubTypes;
    }

    /**
     * Check if registry has any missing base types
     *
     * @return true if any type families are missing base subtypes
     */
    public boolean hasMissingBaseTypes() {
        return !getMissingBaseTypes().isEmpty();
    }

    /**
     * Get set of type names that are missing base subtypes
     *
     * @return Set of type names missing base subtypes
     */
    public Set<String> getMissingBaseTypes() {
        Map<String, Set<String>> typeToSubTypes = getTypeToSubTypesMap();
        Set<String> missingBases = new HashSet<>();

        for (String type : typeToSubTypes.keySet()) {
            if (!typeToSubTypes.get(type).contains("base")) {
                missingBases.add(type);
            }
        }

        return missingBases;
    }

    // ====================== INTEGRATED CONSTRAINT SYSTEM ======================

    /**
     * Load core constraints into the registry (migrated from ConstraintRegistry)
     */
    private void loadCoreConstraints() {
        if (constraintsInitialized) {
            return;
        }

        synchronized (this) {
            if (constraintsInitialized) {
                return;
            }

            try {
                // Temporarily disable strict duplicate detection during initialization
                boolean wasStrictDetection = strictDuplicateDetection;
                disableStrictDuplicateDetection();

                // Load essential constraints using concrete classes
                loadPlacementConstraints();

                // Load all constraints previously provided by ConstraintProviders
                loadCodegenConstraints();
                loadCoreIOConstraints();
                loadWebConstraints();

                // Re-enable strict detection after initialization
                if (wasStrictDetection) {
                    enableStrictDuplicateDetection();
                }

                log.debug("Loaded {} core constraints using concrete constraint classes",
                         constraints.size());
                constraintsInitialized = true;

            } catch (Exception e) {
                log.error("Error loading core constraints: {}", e.getMessage(), e);
                // Re-enable strict detection even on error
                enableStrictDuplicateDetection();
            }
        }
    }

    /**
     * Load naming pattern constraints
     */

    /**
     * Load placement constraints
     */
    private void loadPlacementConstraints() {
        // StringField can optionally have maxLength attribute
        addConstraint(new PlacementConstraint(
            "stringfield.maxlength.placement",
            "String fields can have maxLength attribute",
            "field.string",         // Parent pattern
            "attr.int[maxLength]",  // Child pattern
            true                    // Allowed
        ));

        // MetaField can optionally have required attribute
        addConstraint(new PlacementConstraint(
            "field.required.placement",
            "Fields can have required attribute",
            MetaField.TYPE_FIELD, "*",                          // Parent: field.*
            MetaAttribute.TYPE_ATTR, BooleanAttribute.SUBTYPE_BOOLEAN, "required", // Child: attr.boolean[required]
            true                                                // Allowed
        ));
    }

    /**
     * Load code generation constraints (from former CodegenConstraintProvider)
     */
    private void loadCodegenConstraints() {
        // JPA generation control attributes
        addJpaGenerationConstraints();

        // Field behavior attributes (codegen-specific)
        addFieldBehaviorConstraints();
    }

    private void addJpaGenerationConstraints() {
        // PLACEMENT CONSTRAINT: skipJpa attribute can be placed on MetaObjects
        addConstraint(new PlacementConstraint(
            "codegen.skipJpa.object.placement",
            "skipJpa attribute can be placed on MetaObjects to skip JPA generation",
            MetaObject.TYPE_OBJECT, "*",            // Parent: object.*
            MetaAttribute.TYPE_ATTR, "*", "skipJpa", // Child: attr.*[skipJpa]
            true                                    // Allowed
        ));

        // VALIDATION CONSTRAINT: skipJpa must be boolean
        addConstraint(new EnumConstraint(
            "codegen.skipJpa.validation",
            "skipJpa must be a boolean value (true/false)",
            "attr",                 // Target type
            "*",                    // Any subtype
            "skipJpa",              // Target name
            Set.of("true", "false"), // Allowed values
            false,                  // Case insensitive
            true                    // Allow null (optional)
        ));

        // PLACEMENT CONSTRAINT: skipJpa attribute can be placed on MetaFields
        addConstraint(new PlacementConstraint(
            "codegen.skipJpa.field.placement",
            "skipJpa attribute can be placed on MetaFields to skip JPA generation",
            MetaField.TYPE_FIELD, "*",              // Parent: field.*
            MetaAttribute.TYPE_ATTR, "*", "skipJpa", // Child: attr.*[skipJpa]
            true                                    // Allowed
        ));
    }

    private void addFieldBehaviorConstraints() {
        // PLACEMENT CONSTRAINT: collection attribute can be placed on MetaFields
        addConstraint(new PlacementConstraint(
            "codegen.collection.placement",
            "collection attribute can be placed on MetaFields to indicate collection type",
            MetaField.TYPE_FIELD, "*",                  // Parent: field.*
            MetaAttribute.TYPE_ATTR, "*", "collection", // Child: attr.*[collection]
            true                                        // Allowed
        ));

        // VALIDATION CONSTRAINT: collection must be boolean
        addConstraint(new EnumConstraint(
            "codegen.collection.validation",
            "collection must be a boolean value (true/false)",
            "attr",                     // Target type
            "*",                        // Any subtype
            "collection",               // Target name
            Set.of("true", "false"),    // Allowed values
            false,                      // Case insensitive
            true                        // Allow null (optional)
        ));

        // PLACEMENT CONSTRAINT: isSearchable attribute can be placed on MetaFields
        addConstraint(new PlacementConstraint(
            "codegen.isSearchable.placement",
            "isSearchable attribute can be placed on MetaFields for search functionality",
            MetaField.TYPE_FIELD, "*",                      // Parent: field.*
            MetaAttribute.TYPE_ATTR, "*", "isSearchable",   // Child: attr.*[isSearchable]
            true                                            // Allowed
        ));

        // VALIDATION CONSTRAINT: isSearchable must be boolean
        addConstraint(new EnumConstraint(
            "codegen.isSearchable.validation",
            "isSearchable must be a boolean value (true/false)",
            "attr",                     // Target type
            "*",                        // Any subtype
            "isSearchable",             // Target name
            Set.of("true", "false"),    // Allowed values
            false,                      // Case insensitive
            true                        // Allow null (optional)
        ));
    }

    /**
     * Load core I/O constraints (from former CoreIOConstraintProvider)
     */
    private void loadCoreIOConstraints() {
        // XML name mapping attributes
        addXmlNamingConstraints();

        // XML behavior control attributes
        addXmlBehaviorConstraints();
    }

    private void addXmlNamingConstraints() {
        // PLACEMENT CONSTRAINT: xmlName attribute can be placed on any MetaData
        addConstraint(new PlacementConstraint(
            "coreio.xmlName.placement",
            "xmlName attribute can be placed on any MetaData for XML element naming",
            "*", "*",                               // Parent: *.* (any metadata)
            MetaAttribute.TYPE_ATTR, "*", "xmlName", // Child: attr.*[xmlName]
            true                                    // Allowed
        ));

        // VALIDATION CONSTRAINT: xmlName must be valid XML identifier
        addConstraint(new RegexConstraint(
            "coreio.xmlName.validation",
            "xmlName must be a valid XML element name",
            "attr",                     // Target type
            "*",                        // Any subtype
            "xmlName",                  // Target name
            "^[a-zA-Z_][a-zA-Z0-9_.-]{0,99}$", // XML name pattern with length limit
            true                        // Allow null (optional)
        ));
    }

    private void addXmlBehaviorConstraints() {
        // PLACEMENT CONSTRAINT: xmlTyped attribute can be placed on MetaObjects
        addConstraint(new PlacementConstraint(
            "coreio.xmlTyped.placement",
            "xmlTyped attribute can be placed on MetaObjects for type information in XML",
            MetaObject.TYPE_OBJECT, "*",                // Parent: object.*
            MetaAttribute.TYPE_ATTR, "*", "xmlTyped",   // Child: attr.*[xmlTyped]
            true                                        // Allowed
        ));

        // VALIDATION CONSTRAINT: xmlTyped must be boolean
        addConstraint(new EnumConstraint(
            "coreio.xmlTyped.validation",
            "xmlTyped must be a boolean value (true/false)",
            "attr",                     // Target type
            "*",                        // Any subtype
            "xmlTyped",                 // Target name
            Set.of("true", "false"),    // Allowed values
            false,                      // Case insensitive
            true                        // Allow null (optional)
        ));

        // PLACEMENT CONSTRAINT: xmlWrap attribute can be placed on MetaFields
        addConstraint(new PlacementConstraint(
            "coreio.xmlWrap.placement",
            "xmlWrap attribute can be placed on MetaFields for XML wrapping behavior",
            MetaField.TYPE_FIELD, "*",              // Parent: field.*
            MetaAttribute.TYPE_ATTR, "*", "xmlWrap", // Child: attr.*[xmlWrap]
            true                                    // Allowed
        ));

        // VALIDATION CONSTRAINT: xmlWrap must be boolean
        addConstraint(new EnumConstraint(
            "coreio.xmlWrap.validation",
            "xmlWrap must be a boolean value (true/false)",
            "attr",                     // Target type
            "*",                        // Any subtype
            "xmlWrap",                  // Target name
            Set.of("true", "false"),    // Allowed values
            false,                      // Case insensitive
            true                        // Allow null (optional)
        ));

        // PLACEMENT CONSTRAINT: xmlIgnore attribute can be placed on MetaFields
        addConstraint(new PlacementConstraint(
            "coreio.xmlIgnore.placement",
            "xmlIgnore attribute can be placed on MetaFields to exclude from XML serialization",
            MetaField.TYPE_FIELD, "*",                  // Parent: field.*
            MetaAttribute.TYPE_ATTR, "*", "xmlIgnore",  // Child: attr.*[xmlIgnore]
            true                                        // Allowed
        ));

        // VALIDATION CONSTRAINT: xmlIgnore must be boolean
        addConstraint(new EnumConstraint(
            "coreio.xmlIgnore.validation",
            "xmlIgnore must be a boolean value (true/false)",
            "attr",                     // Target type
            "*",                        // Any subtype
            "xmlIgnore",                // Target name
            Set.of("true", "false"),    // Allowed values
            false,                      // Case insensitive
            true                        // Allow null (optional)
        ));
    }

    /**
     * Load web constraints (from former WebConstraintProvider)
     */
    private void loadWebConstraints() {
        // HTML input type validation for form generation
        addHtmlInputTypeConstraints();

        // CSS class and HTML ID validation
        addCssAndHtmlConstraints();

        // Form label and UI text constraints
        addFormTextConstraints();

        // Security constraints for web content
        addSecurityConstraints();
    }

    private void addHtmlInputTypeConstraints() {
        // PLACEMENT CONSTRAINT: htmlInputType attribute can be placed on string fields
        addConstraint(new PlacementConstraint(
            "web.htmlInputType.placement",
            "htmlInputType attribute can be placed on string fields for form generation",
            "field.string",             // Parent pattern (string fields only)
            "attr.*[htmlInputType]",    // Child pattern
            true                        // Allowed
        ));

        // VALIDATION CONSTRAINT: htmlInputType must be valid HTML input type
        addConstraint(new EnumConstraint(
            "web.htmlInputType.validation",
            "htmlInputType must be a valid HTML input type",
            "attr",                     // Target type
            "*",                        // Any subtype
            "htmlInputType",            // Target name
            Set.of("text", "password", "email", "url", "tel", "search", // Standard HTML input types
                   "number", "range", "date", "datetime-local", "time", "month", "week",
                   "color", "file", "image", "hidden", "checkbox", "radio",
                   "submit", "button", "reset"),
            false,                      // Case insensitive
            true                        // Allow null (optional)
        ));
    }

    private void addCssAndHtmlConstraints() {
        // PLACEMENT CONSTRAINT: CSS class attributes
        addConstraint(new PlacementConstraint(
            "web.cssClass.placement",
            "cssClass attribute can be placed on any MetaData for styling",
            "*", "*",                                   // Parent: *.* (any metadata)
            MetaAttribute.TYPE_ATTR, "*", "cssClass",   // Child: attr.*[cssClass]
            true                                        // Allowed
        ));

        // VALIDATION CONSTRAINT: CSS class names must follow valid pattern with length limit
        addConstraint(new RegexConstraint(
            "web.cssClass.validation",
            "CSS class names must follow valid CSS identifier pattern and be <= 50 chars",
            "attr",                     // Target type
            "*",                        // Any subtype
            "cssClass",                 // Target name
            "^[a-zA-Z][a-zA-Z0-9_-]{0,49}$", // CSS class pattern with 50 char limit
            true                        // Allow null (optional)
        ));

        // PLACEMENT CONSTRAINT: HTML ID attributes
        addConstraint(new PlacementConstraint(
            "web.htmlId.placement",
            "htmlId attribute can be placed on any MetaData for DOM identification",
            "*", "*",                               // Parent: *.* (any metadata)
            MetaAttribute.TYPE_ATTR, "*", "htmlId", // Child: attr.*[htmlId]
            true                                    // Allowed
        ));

        // VALIDATION CONSTRAINT: HTML ID must follow valid pattern
        addConstraint(new RegexConstraint(
            "web.htmlId.validation",
            "HTML ID must follow valid HTML identifier pattern",
            "attr",                     // Target type
            "*",                        // Any subtype
            "htmlId",                   // Target name
            "^[a-zA-Z][a-zA-Z0-9_-]*$", // HTML ID pattern
            true                        // Allow null (optional)
        ));
    }

    private void addFormTextConstraints() {
        // PLACEMENT CONSTRAINT: Form label attributes
        addConstraint(new PlacementConstraint(
            "web.formLabel.placement",
            "formLabel attribute can be placed on fields for form generation",
            MetaField.TYPE_FIELD, "*",                      // Parent: field.*
            MetaAttribute.TYPE_ATTR, "*", "formLabel",      // Child: attr.*[formLabel]
            true                                            // Allowed
        ));

        // VALIDATION CONSTRAINT: Form labels must be non-empty and within length limits
        addConstraint(new LengthConstraint(
            "web.formLabel.validation",
            "Form labels must be non-empty and within 1-100 characters",
            "attr",                     // Target type
            "*",                        // Any subtype
            "formLabel",                // Target name
            1,                          // Min length
            100,                        // Max length
            false                       // Don't allow null (required)
        ));

        // PLACEMENT CONSTRAINT: Placeholder text attributes
        addConstraint(new PlacementConstraint(
            "web.placeholder.placement",
            "placeholder attribute can be placed on string fields for input hints",
            "field.string",             // Parent pattern (string fields only)
            "attr.*[placeholder]",      // Child pattern
            true                        // Allowed
        ));

        // VALIDATION CONSTRAINT: Placeholder text length limits
        addConstraint(new LengthConstraint(
            "web.placeholder.validation",
            "Placeholder text must be within 200 character limit",
            "attr",                     // Target type
            "*",                        // Any subtype
            "placeholder",              // Target name
            null,                       // No min length
            200,                        // Max length
            true                        // Allow null (optional)
        ));

        // PLACEMENT CONSTRAINT: Validation message attributes
        addConstraint(new PlacementConstraint(
            "web.validationMessage.placement",
            "validationMessage attribute can be placed on any MetaData for error display",
            "*", "*",                                           // Parent: *.* (any metadata)
            MetaAttribute.TYPE_ATTR, "*", "validationMessage", // Child: attr.*[validationMessage]
            true                                                // Allowed
        ));

        // VALIDATION CONSTRAINT: Validation message length limits
        addConstraint(new LengthConstraint(
            "web.validationMessage.validation",
            "Validation messages must be within 500 character limit",
            "attr",                     // Target type
            "*",                        // Any subtype
            "validationMessage",        // Target name
            null,                       // No min length
            500,                        // Max length
            true                        // Allow null (optional)
        ));

        // PLACEMENT CONSTRAINT: Help text attributes
        addConstraint(new PlacementConstraint(
            "web.helpText.placement",
            "helpText attribute can be placed on any MetaData for user guidance",
            "*", "*",                               // Parent: *.* (any metadata)
            MetaAttribute.TYPE_ATTR, "*", "helpText", // Child: attr.*[helpText]
            true                                    // Allowed
        ));

        // VALIDATION CONSTRAINT: Help text length limits
        addConstraint(new LengthConstraint(
            "web.helpText.validation",
            "Help text must be within 1000 character limit",
            "attr",                     // Target type
            "*",                        // Any subtype
            "helpText",                 // Target name
            null,                       // No min length
            1000,                       // Max length
            true                        // Allow null (optional)
        ));
    }

    private void addSecurityConstraints() {
        // VALIDATION CONSTRAINT: String fields should not contain script tags (XSS prevention)
        addConstraint(new RegexConstraint(
            "web.xss.validation",
            "String fields should not contain script tags for security",
            "field",                    // Target type
            "string",                   // String subtype only
            "*",                        // Any field name
            "^(?!.*<script).*$",        // Regex pattern: no <script tags (case insensitive)
            true                        // Allow null (optional)
        ));
    }


    /**
     * Add a constraint to the registry with context-aware duplicate detection.
     * <p>
     * Re-adding an <em>identical</em> constraint (same id, same constraint class,
     * same description) is idempotent — a no-op rather than an error — so a
     * registry re-init that replays provider constraint registration (e.g. after
     * {@code clear()}) does not fail. A genuine conflict (same id but a different
     * constraint class or description) still throws when strict detection is
     * enabled, preserving ADR-0023 strict provenance.
     * @param constraint The constraint to add
     * @throws MetaDataException if a constraint with the same ID but a conflicting
     *         definition already exists and strict detection is enabled
     */
    public void addConstraint(Constraint constraint) {
        if (constraint == null) {
            log.warn("Attempted to add null constraint");
            return;
        }
        checkNotSealed("addConstraint(" + constraint.getConstraintId() + ")");

        // Check for duplicate constraint IDs only when strict detection is enabled
        String constraintId = constraint.getConstraintId();
        if (constraintId != null && strictDuplicateDetection) {
            Optional<Constraint> existing = constraints.stream()
                .filter(c -> constraintId.equals(c.getConstraintId()))
                .findFirst();

            if (existing.isPresent()) {
                // Idempotent re-registration: an IDENTICAL constraint (same id, same
                // class, same description) being added again is a benign re-init — e.g.
                // a test calls clear() (which resets `initialized`, NOT the constraints),
                // and a later type access re-runs loadServiceProviders, replaying every
                // provider's constraint registration. Treat that as a no-op rather than
                // a fatal duplicate; this is the intermittent full-reactor failure
                // ("DUPLICATE CONSTRAINT DETECTED: object.base.implements.array …").
                // A GENUINE conflict (same id but a DIFFERENT definition — different
                // constraint class or description) still throws, preserving ADR-0023
                // strict provenance and the registry-conformance gate.
                Constraint ex = existing.get();
                boolean identical = ex.getClass() == constraint.getClass()
                    && Objects.equals(ex.getDescription(), constraint.getDescription());
                if (identical) {
                    log.debug("Idempotent re-registration of identical constraint: {}", constraintId);
                    return;
                }
                String errorMessage = String.format(
                    "DUPLICATE CONSTRAINT DETECTED: Constraint ID '%s' already registered!\n\n" +
                    "This usually indicates a test registry isolation problem:\n" +
                    "  • Existing: %s [%s]\n" +
                    "  • Attempted: %s [%s]\n\n" +
                    "SOLUTION: If this is a test class, extend SharedRegistryTestBase instead of:\n" +
                    "  ❌ MetaDataRegistry registry = MetaDataRegistry.getInstance();\n" +
                    "  ✅ public class YourTest extends SharedRegistryTestBase { ... }\n\n" +
                    "This prevents registry conflicts between tests on different platforms (Windows/Linux).\n" +
                    "See CLAUDE.md for detailed explanation of the shared registry pattern.",
                    constraintId,
                    existing.get().getClass().getSimpleName(), existing.get().getDescription(),
                    constraint.getClass().getSimpleName(), constraint.getDescription()
                );

                log.error("Duplicate constraint registration detected: {}", constraintId);
                throw new MetaDataException(errorMessage);
            }
        } else if (constraintId != null && !strictDuplicateDetection) {
            // In non-strict mode, just warn about duplicates but allow them
            boolean hasDuplicate = constraints.stream()
                .anyMatch(c -> constraintId.equals(c.getConstraintId()));
            if (hasDuplicate) {
                log.debug("Allowing duplicate constraint during initialization: {}", constraintId);
                return; // Skip adding duplicate in non-strict mode
            }
        }

        constraints.add(constraint);
        log.debug("Added constraint: {} [{}]", constraint.getType(), constraint.getDescription());
    }

    /**
     * Temporarily disable strict duplicate detection (for initialization)
     */
    public void disableStrictDuplicateDetection() {
        this.strictDuplicateDetection = false;
        log.debug("Disabled strict duplicate constraint detection");
    }

    /**
     * Re-enable strict duplicate detection (for normal operation)
     */
    public void enableStrictDuplicateDetection() {
        this.strictDuplicateDetection = true;
        log.debug("Enabled strict duplicate constraint detection");
    }

    /**
     * Check if a constraint with the given ID already exists
     * @param constraintId The constraint ID to check for
     * @return true if a constraint with this ID exists, false otherwise
     */
    public boolean hasConstraint(String constraintId) {
        if (constraintId == null) {
            return false;
        }
        return constraints.stream()
            .anyMatch(c -> constraintId.equals(c.getConstraintId()));
    }

    /**
     * Get all validation constraints (unified constraint system)
     * @return List of all registered validation constraints
     */
    public List<Constraint> getAllValidationConstraints() {
        if (!constraintsInitialized) {
            loadCoreConstraints();
        }
        return new ArrayList<>(constraints);
    }

    /**
     * Get placement validation constraints (unified constraint system)
     * @return List of placement constraints
     */
    public List<PlacementConstraint> getPlacementValidationConstraints() {
        return getAllValidationConstraints().stream()
            .filter(c -> c instanceof PlacementConstraint)
            .map(c -> (PlacementConstraint) c)
            .collect(Collectors.toList());
    }

    /**
     * Get field validation constraints (unified constraint system)
     * @return List of validation constraints
     */
    public List<CustomConstraint> getFieldValidationConstraints() {
        return getAllValidationConstraints().stream()
            .filter(c -> c instanceof CustomConstraint)
            .map(c -> (CustomConstraint) c)
            .collect(Collectors.toList());
    }

    /**
     * Get validation constraints by type
     * @param constraintType The constraint type to filter by
     * @return List of constraints matching the type
     */
    public List<Constraint> getValidationConstraintsByType(String constraintType) {
        return getAllValidationConstraints().stream()
            .filter(c -> constraintType.equals(c.getType()))
            .collect(Collectors.toList());
    }

    /**
     * Get total number of registered validation constraints
     * @return Count of all validation constraints
     */
    public int getValidationConstraintCount() {
        if (!constraintsInitialized) {
            loadCoreConstraints();
        }
        return constraints.size();
    }

    /**
     * Get summary of validation constraint types and counts
     * @return Map of constraint type to count
     */
    public Map<String, Integer> getValidationConstraintTypeSummary() {
        return getAllValidationConstraints().stream()
            .collect(Collectors.groupingBy(
                Constraint::getType,
                Collectors.collectingAndThen(Collectors.counting(), Long::intValue)
            ));
    }

    /**
     * Register a constraint using concrete constraint classes
     *
     * @param constraint The constraint to register
     */
    public void registerConstraint(Constraint constraint) {
        addConstraint(constraint);
    }

    /**
     * Check if constraint providers have been loaded
     *
     * @return true if providers have been loaded
     */
    public boolean isConstraintsInitialized() {
        return constraintsInitialized;
    }

    /**
     * Force reload of constraint providers (primarily for testing)
     */
    public void reloadConstraints() {
        synchronized (this) {
            constraints.clear();
            constraintsInitialized = false;
            loadCoreConstraints();
        }
    }

    /**
     * Registry statistics record with constraint information
     */
    public record RegistryStats(
        int totalTypes,
        Map<String, Integer> typesByPrimary,
        int globalRequirements,
        String serviceRegistryDescription,
        Map<String, Integer> constraintStats
    ) {}
}

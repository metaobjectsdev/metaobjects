# Loader System Architecture

The MetaObjects core module provides a comprehensive file-based loading system that implements the READ-OPTIMIZED WITH CONTROLLED MUTABILITY pattern. The loader system is responsible for discovering, loading, and parsing metadata files from various sources while maintaining the framework's performance characteristics.

## Core Architecture Overview

The loader system follows a **ClassLoader pattern** analogous to Java's class loading mechanism:

- **Load once at startup**: Metadata loaded into permanent memory structures
- **Read many at runtime**: Ultra-fast cached access with no synchronization
- **OSGi compatibility**: WeakReference patterns for bundle lifecycle management
- **Multiple source support**: Files, directories, URIs, classpath resources, and in-memory strings

## MetaDataLoader

### Purpose and Design

`MetaDataLoader` is the single, unified loader for all metadata sources — files, directories, URIs, classpath resources, and in-memory strings. There is no longer a subclass-per-source-kind: one loader class accepts any `MetaDataSource` implementation.

**Key Features**:
- **Multi-format support**: JSON and XML metadata with automatic parser selection by file extension or explicit `MetaDataFormat`
- **ClassLoader integration**: OSGi-compatible class loading with fallback chains
- **Source flexibility**: Local files, directories, URIs, classpath resources, and in-memory strings — all via the same `MetaDataSource` SPI
- **Static factory ergonomics**: `MetaDataLoader.fromDirectory(...)`, `fromUris(...)`, `fromResources(...)`, `fromString(...)`
- **Performance optimization**: In-memory caching and lazy initialization

### Basic Usage

**Load from a directory (recursive by default)**:
```java
// Scan a directory; format inferred per file by extension
MetaDataLoader loader = MetaDataLoader.fromDirectory(
    "myLoader",
    Path.of("/metadata")
);

// Access loaded metadata
MetaObject userMeta = loader.getMetaObjectByName("User");
MetaField emailField = userMeta.getMetaField("email");
```

**Load from classpath resources**:
```java
MetaDataLoader loader = MetaDataLoader.fromResources(
    "myLoader",
    List.of("user-metadata.json", "product-metadata.xml")
);
```

**URI-based loading**:
```java
List<URI> uris = List.of(
    URI.create("file:///metadata/core-types.json"),
    URI.create("classpath://com/mycompany/metadata/business-types.xml"),
    URI.create("https://api.example.com/metadata/external-types.json")
);

MetaDataLoader loader = MetaDataLoader.fromUris("uriLoader", uris);
```

**Inline string loading** (handy for tests and code-driven definitions):
```java
String json = "{\"metadata\":{\"package\":\"demo\",\"children\":[...]}}";
MetaDataLoader loader = MetaDataLoader.fromString(
    "inlineLoader",
    json,
    MetaDataSource.MetaDataFormat.JSON
);
```

### Advanced Configuration

**Custom LoaderOptions**:
```java
// shouldRegister, verbose, strict
LoaderOptions opts = LoaderOptions.create(false, true, true);

MetaDataLoader loader = MetaDataLoader.fromResources(
    "advancedLoader",
    List.of("core-metadata.json"),
    opts
);
```

**OSGi ClassLoader Integration**:
```java
ClassLoader bundleClassLoader = MyBundle.class.getClassLoader();

MetaDataLoader loader = new MetaDataLoader("osgiLoader");
loader.setMetaDataClassLoader(bundleClassLoader);

// Build any source(s) — the loader uses the bundle ClassLoader for
// classpath:// resolution on classpath-backed UriSources.
loader.load(List.of(new FileSource(Path.of("/metadata/bundle-metadata.json"))));
loader.init();
```

## Source System

### MetaDataSource implementations

The source system provides flexible metadata discovery via the `MetaDataSource` SPI. Four built-in implementations live in `com.metaobjects.loader`:

#### FileSource

**Purpose**: Load metadata from a single local file. Format is inferred from the extension, or pass an explicit `MetaDataFormat`.

```java
import com.metaobjects.loader.FileSource;

FileSource source = new FileSource(Path.of("/project/metadata/core.json"));

// Or with an explicit format:
FileSource xmlSource = new FileSource(
    Path.of("/project/metadata/types.dat"),
    MetaDataSource.MetaDataFormat.XML
);
```

#### DirectorySource

**Purpose**: Expand a directory into one `FileSource` per metadata file inside it. Recursive by default; exclusions and recursion are configurable.

```java
import com.metaobjects.loader.DirectorySource;

// Default: recursive, no exclusions
DirectorySource dir = new DirectorySource(Path.of("/project/metadata"));

// With options
DirectorySource customized = new DirectorySource(
    Path.of("/project/metadata"),
    new DirectorySource.Options()
        .setRecurse(false)
        .setExclude(List.of("archive.json", "draft.xml"))
);

// Expand to a list of FileSources you can hand to a loader
List<MetaDataSource> sources = customized.expandToList();
```

`MetaDataLoader.fromDirectory(name, path)` and `MetaDataLoader.fromDirectory(name, path, opts)` are convenience wrappers around `DirectorySource` + `load(...)` + `init()`.

#### UriSource

**Purpose**: Load metadata from a single URI (classpath, file, http(s), jar).

```java
import com.metaobjects.loader.UriSource;

UriSource source = new UriSource(URI.create("classpath://metadata/core-types.json"));
```

**URI Schemes Supported**:
- `file://` — Local filesystem access
- `classpath://` — Classpath resource loading (uses the loader's `MetaDataClassLoader`)
- `http://` / `https://` — Remote metadata loading
- `jar://` — JAR file resource access

#### InMemoryStringSource

**Purpose**: Provide metadata directly as an in-memory string — perfect for tests, snapshots, or code-generated definitions. The default id is `"<inline>"`.

```java
import com.metaobjects.loader.InMemoryStringSource;
import com.metaobjects.loader.MetaDataSource;

InMemoryStringSource source = new InMemoryStringSource(
    jsonContent,
    "fixture://user-spec",                       // id (defaults to "<inline>")
    MetaDataSource.MetaDataFormat.JSON
);
```

## ClassLoader Integration

### OSGi Compatibility

The loader system is designed for complex ClassLoader scenarios including OSGi bundles:

**ClassLoader Chain Resolution**:
```java
// Sources backed by the classpath use a sophisticated ClassLoader chain
URL resource = getResourceViaClassLoaderChain(filename);

// Resolution order:
// 1. Source class ClassLoader (OSGi bundle ClassLoader)
// 2. Configured loader ClassLoader (from setMetaDataClassLoader)
// 3. System ClassLoader (fallback)
```

**Bundle Lifecycle Management**:
```java
public class OSGIMetaDataBundle implements BundleActivator {

    private MetaDataLoader loader;

    @Override
    public void start(BundleContext context) throws Exception {
        // Create loader with bundle ClassLoader
        loader = new MetaDataLoader("bundleLoader");
        loader.setMetaDataClassLoader(getClass().getClassLoader());

        // Load bundle-specific metadata via a classpath URI
        loader.load(List.of(
            new UriSource(URI.create("classpath://bundle-metadata.json"))
        ));
        loader.init();

        // Register as OSGi service
        context.registerService(MetaDataLoader.class, loader, null);
    }

    @Override
    public void stop(BundleContext context) throws Exception {
        // Loader cleanup handled by WeakReference patterns
        // No explicit cleanup needed
        loader = null;
    }
}
```

### Class Loading for Metadata Types

The loader system supports loading Java classes referenced in metadata:

```java
// loadClass() uses the ClassLoader chain for type resolution
Class<?> customFieldClass = loader.loadClass("com.mycompany.CustomField");

// Useful for dynamic type loading in metadata definitions
{
  "field": {
    "name": "customField",
    "type": "custom",
    "implementationClass": "com.mycompany.CustomField"
  }
}
```

## Parser Integration

### Automatic Parser Selection

The loader automatically selects the appropriate parser based on each source's `MetaDataFormat` — inferred from the file extension for `FileSource`/`DirectorySource`/`UriSource`, or supplied explicitly for `InMemoryStringSource`:

- `JSON` → `JsonMetaDataParser`
- `XML` → `XMLMetaDataParser`

**Supported File Types**:
- `.json` — JSON metadata files with inline attribute support
- `.xml` — XML metadata files with schema validation

### Parser Configuration

**JSON Parser Integration**:
```java
// JsonMetaDataParser automatically handles:
// - Inline attribute syntax (@-prefixed)
// - Cross-file reference resolution
// - Type-aware attribute casting
// - Package overlay patterns

// Example metadata with inline attributes
{
  "metadata": {
    "package": "com_example_model",
    "children": [
      {
        "field": {
          "name": "email",
          "type": "string",
          "@required": true,           // Boolean attribute
          "@maxLength": 255,           // Integer attribute
          "@pattern": "^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$"
        }
      }
    ]
  }
}
```

**XML Parser Integration**:
```java
// XMLMetaDataParser automatically handles:
// - XSD schema validation
// - Namespace-aware parsing
// - Inline attribute syntax (no prefix required)
// - Complex type hierarchies

<!-- Example XML with inline attributes -->
<metadata package="com_example_model">
  <children>
    <field name="email" type="string" required="true" maxLength="255"
           pattern="^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$" />
  </children>
</metadata>
```

## Performance Characteristics

### Memory Management

The loader system implements the READ-OPTIMIZED architecture:

**Loading Phase (Startup)**:
- **Duration**: 100ms - 1s for typical metadata sets
- **Memory Usage**: 10-50MB for metadata definitions
- **CPU**: Intensive parsing and validation during init()
- **I/O**: Sequential file reading with buffering

**Runtime Phase (Application Lifetime)**:
- **Access Time**: 1-10μs for cached metadata lookups
- **Memory Model**: Permanent residence, no garbage collection
- **CPU**: Zero parsing overhead, direct object access
- **Concurrency**: Unlimited concurrent readers with no contention

### Caching Strategy

**Dual Cache Architecture**:
```java
// MetaDataLoader maintains efficient caching
private final Map<String, MetaObject> objectCache = new ConcurrentHashMap<>();
private final Map<String, MetaField> fieldCache = new ConcurrentHashMap<>();

// Computed value cache (WeakHashMap for OSGi compatibility)
private final Map<Object, Object> computedCache =
    Collections.synchronizedMap(new WeakHashMap<>());
```

**Cache Benefits**:
- **Permanent Cache**: Core metadata lookups never require recomputation
- **Computed Cache**: Derived values cached but can be GC'd under memory pressure
- **OSGi Safety**: WeakHashMap allows bundle unloading without memory leaks
- **Thread Safety**: ConcurrentHashMap provides lock-free concurrent access

### File I/O Optimization

**Efficient File Loading**:
```java
// All sources are read into memory during initialization
for (MetaDataSource source : sources) {
    String content = source.read();              // pulled once at init
    parse(content, source.getFormat(), source.getId());
}
```

**I/O Strategy Benefits**:
- **Sequential Access**: All sources read sequentially during startup
- **Memory Buffering**: Complete content loaded into memory
- **No Runtime I/O**: Zero file system access after initialization
- **Error Isolation**: Source loading errors detected immediately during init()

## Error Handling and Diagnostics

### Comprehensive Error Context

**MetaDataException Integration**:
```java
try {
    loader.init();
} catch (MetaDataException e) {
    // Rich error context provided
    System.err.println("Loading failed: " + e.getMessage());
    System.err.println("Source: " + e.getSource());

    if (e.getMetaDataPath().isPresent()) {
        System.err.println("Path: " + e.getMetaDataPath().get());
    }

    if (e.getCause() instanceof IOException) {
        System.err.println("File I/O issue: " + e.getCause().getMessage());
    }
}
```

**Common Error Scenarios**:

| Error Type | Cause | Resolution |
|------------|-------|------------|
| `IllegalStateException` | No sources configured | Call `load(sources)` (or a `from...` factory) before `init()` |
| `MetaDataException: file not found` | Missing metadata file | Verify file paths and ClassLoader setup |
| `MetaDataException: unsupported file type` | Unknown extension | Use `.json` or `.xml`, or pass an explicit `MetaDataFormat` |
| `ClassNotFoundException` | Missing implementation class | Add required classes to ClassLoader path |
| `ConstraintViolationException` | Invalid metadata structure | Fix metadata to comply with constraints |

### Debugging and Monitoring

**Verbose Logging Configuration**:
```java
LoaderOptions opts = LoaderOptions.create(false, true, false); // verbose=true
MetaDataLoader loader = MetaDataLoader.fromResources(
    "debugLoader",
    List.of("user-metadata.json"),
    opts
);

// Produces detailed logging:
// INFO - METADATA - (3) Source Files Loaded in MetaDataLoader{name=debugLoader}
// DEBUG - LOADING: user-metadata.json
```

**Load Monitoring**:
```java
// Track loading performance
long startTime = System.currentTimeMillis();
MetaDataLoader loader = MetaDataLoader.fromResources(
    "monitored",
    List.of("user-metadata.json")
);
long loadTime = System.currentTimeMillis() - startTime;

System.out.println("Loaded " + loader.getMetaObjects().size() +
                   " metadata objects in " + loadTime + "ms");
```

## Integration Patterns

### Spring Framework Integration

**Spring Bean Configuration**:
```java
@Configuration
public class MetaDataConfiguration {

    @Bean
    @Primary
    public MetaDataLoader primaryMetaDataLoader() {
        return MetaDataLoader.fromResources(
            "primary",
            List.of("core-metadata.json", "business-metadata.xml")
        );
    }

    @Bean
    @Qualifier("external")
    public MetaDataLoader externalMetaDataLoader(Environment environment) {
        String metadataUrl = environment.getProperty("metadata.external.url");
        List<URI> uris = List.of(URI.create(metadataUrl));
        return MetaDataLoader.fromUris("external", uris);
    }
}
```

**Spring Boot Auto-Configuration**:
```java
@ConfigurationProperties(prefix = "metaobjects.loader")
public class MetaDataLoaderProperties {
    private List<String> sources = new ArrayList<>();
    private String sourceDirectory = "metadata";
    private boolean verbose = false;
    private boolean strict = true;

    // Getters and setters...
}

@AutoConfiguration
@EnableConfigurationProperties(MetaDataLoaderProperties.class)
public class MetaDataLoaderAutoConfiguration {

    @Bean
    @ConditionalOnMissingBean
    public MetaDataLoader metaDataLoader(MetaDataLoaderProperties properties) {
        LoaderOptions opts = LoaderOptions.create(
            false,                       // shouldRegister
            properties.isVerbose(),
            properties.isStrict()
        );

        // Resolve sources against a base directory
        List<String> resources = properties.getSources().stream()
            .map(s -> properties.getSourceDirectory() + "/" + s)
            .toList();

        return MetaDataLoader.fromResources("autoConfigured", resources, opts);
    }
}
```

### Maven Plugin Integration

**Plugin Configuration**:
```xml
<plugin>
    <groupId>com.metaobjects</groupId>
    <artifactId>metaobjects-maven-plugin</artifactId>
    <configuration>
        <loader>
            <classname>com.metaobjects.loader.MetaDataLoader</classname>
            <name>maven-build-loader</name>
            <sourceDir>${project.basedir}/src/main/resources/metadata</sourceDir>
            <sources>
                <source>core-types.json</source>
                <source>business-types.xml</source>
            </sources>
        </loader>
    </configuration>
</plugin>
```

**Plugin Configuration Processing**:
```java
// MetaDataLoader.configure() handles Maven plugin args
@Override
public void configure(LoaderConfiguration config) {
    Map<String, String> args = config.getArguments();
    String sourceDir = args.get("sourceDir");
    List<String> rawSources = config.getSources();

    // Resolve to absolute paths and build FileSources
    List<MetaDataSource> sources = rawSources.stream()
        .map(s -> (MetaDataSource) new FileSource(Path.of(sourceDir, s)))
        .toList();

    load(sources);
    super.configure(config);
}
```

### Multi-Module Projects

**Shared Metadata Loading**:
```java
// Parent module: Core metadata loader
public class CoreMetaDataModule {

    public static MetaDataLoader createCoreLoader() {
        return MetaDataLoader.fromResources(
            "core",
            List.of("base-types.json", "core-constraints.json")
        );
    }
}

// Child module: Extended metadata loader
public class BusinessMetaDataModule {

    public static MetaDataLoader createBusinessLoader() {
        // Load core types first
        MetaDataLoader coreLoader = CoreMetaDataModule.createCoreLoader();

        MetaDataLoader loader = new MetaDataLoader("business");
        loader.addParentLoader(coreLoader);

        // Add business-specific metadata
        loader.load(List.of(
            new UriSource(URI.create("classpath://business-objects.xml")),
            new UriSource(URI.create("classpath://workflow-types.json"))
        ));
        return loader.init();
    }
}
```

## Best Practices

### Source Selection

**Choose `MetaDataLoader.fromDirectory(...)` when**:
- Loading from a development environment with local files
- Using Maven/Gradle build-time metadata processing
- Working with file-based metadata editing workflows
- You want recursive expansion with optional exclusions

**Choose `MetaDataLoader.fromResources(...)` when**:
- Loading from classpath resources in packaged applications
- Building cloud-native applications with bundled metadata
- You want simple, ClassLoader-friendly source lookup

**Choose `MetaDataLoader.fromUris(...)` when**:
- Integrating with external metadata services
- Mixing local files, classpath resources, and HTTP sources in a single loader
- Loading from remote configuration endpoints

**Choose `MetaDataLoader.fromString(...)` when**:
- Writing tests with inline fixtures
- Driving the loader from code-generated metadata
- Snapshotting metadata for reproducible diagnostics

### Performance Optimization

**For Large Metadata Sets**:
```java
// Quiet, strict, register-globally-disabled options
LoaderOptions opts = LoaderOptions.create(false, false, true);

MetaDataLoader loader = MetaDataLoader.fromDirectory(
    "optimized",
    Path.of("/project/metadata"),
    opts
);
```

**For Memory-Constrained Environments**:
```java
// Load only essential metadata via explicit resource list
MetaDataLoader loader = MetaDataLoader.fromResources(
    "minimal",
    List.of("essential-types.json")
);
```

### Error Resilience

**Graceful Degradation**:
```java
public class ResilientMetaDataLoader {

    public MetaDataLoader createResilientLoader() {
        try {
            // Attempt primary loading
            return MetaDataLoader.fromDirectory(
                "primary",
                Path.of("/etc/myapp/metadata")
            );
        } catch (MetaDataException e) {
            log.warn("Primary metadata loading failed, using fallback", e);

            // Fall back to embedded classpath resources
            return MetaDataLoader.fromResources(
                "fallback",
                List.of("metadata/embedded-types.json")
            );
        }
    }
}
```

**Validation and Recovery**:
```java
public class ValidatingMetaDataLoader {

    public MetaDataLoader createValidatedLoader() {
        try {
            MetaDataLoader loader = MetaDataLoader.fromResources(
                "validated",
                List.of("core-metadata.json")
            );

            // Validate loaded metadata
            validateMetaDataConsistency(loader);
            validateConstraintIntegrity(loader);

            return loader;

        } catch (ValidationException e) {
            // Attempt recovery or provide detailed diagnostics
            generateValidationReport(e);
            throw new MetaDataException("Metadata validation failed", e);
        }
    }
}
```

This loader system provides the foundation for all metadata access in MetaObjects applications, implementing the READ-OPTIMIZED WITH CONTROLLED MUTABILITY pattern while maintaining flexibility for diverse deployment scenarios.

# MetaObjects Spring Integration

This module provides comprehensive Spring Framework integration for MetaObjects, including auto-configuration, dependency injection, and Spring Boot support.

## Spring Boot starter

Add the single starter dependency:

    <dependency>
        <groupId>com.metaobjects</groupId>
        <artifactId>metaobjects-spring-boot-starter</artifactId>
        <version>7.1.1-SNAPSHOT</version>
    </dependency>

On Spring Boot 3, this auto-configures the metadata-loader registry and — when a
`DataSource` is present — a transaction-aware `ObjectManagerDB`.

Properties:

| Property | Default | Description |
|---|---|---|
| `metaobjects.metadata-sources` | (none) | Loader source URIs/resources. |
| `metaobjects.omdb.dialect` | (auto) | `postgres`/`mysql`/`mssql`/`oracle`/`derby`. Auto-detected from the DataSource when blank. |
| `metaobjects.omdb.enforce-transaction` | `false` | Require an active transaction for writes. |

Define your own `ObjectManagerDB` bean to opt out of the autoconfigured one.

## 🚀 **Quick Start**

### **Add Dependency**
```xml
<dependency>
    <groupId>com.metaobjects</groupId>
    <artifactId>metaobjects-core-spring</artifactId>
    <version>7.0.0</version>
</dependency>
```
*Note: pulls in `metaobjects-metadata` transitively.*

### **Spring Boot Auto-Configuration**
Add to your `application.properties`:
```properties
# Optional: Configure MetaObjects (defaults shown)
metaobjects.auto-configuration.enabled=true
metaobjects.loader.name=primaryLoader
metaobjects.loader.sources=classpath:metadata/
```

### **Basic Usage**
```java
@RestController
public class MetaDataController {
    
    @Autowired
    private MetaDataService metaDataService;
    
    @GetMapping("/metadata/{objectName}")
    public ResponseEntity<List<String>> getFieldNames(@PathVariable String objectName) {
        Optional<MetaObject> metaObject = metaDataService.findMetaObjectByNameOptional(objectName);
        
        if (metaObject.isPresent()) {
            List<String> fieldNames = metaObject.get().getMetaFields().stream()
                .map(MetaField::getName)
                .collect(Collectors.toList());
            return ResponseEntity.ok(fieldNames);
        }
        
        return ResponseEntity.notFound().build();
    }
}
```

## 🎯 **Integration Options**

### **Option 1: MetaDataService (Recommended)**
High-level service wrapper with convenience methods:
```java
@Component
public class UserService {
    
    @Autowired
    private MetaDataService metaDataService;
    
    public boolean validateUser(String userData) {
        // Optional-based null-safe access
        Optional<MetaObject> userMeta = metaDataService.findMetaObjectByNameOptional("User");
        
        if (userMeta.isPresent()) {
            // Check if specific objects exist
            boolean hasRequiredFields = metaDataService.metaObjectExists("User");
            
            // Get all available MetaObjects
            List<MetaObject> allObjects = metaDataService.getAllMetaObjects();
            
            return true;
        }
        
        return false;
    }
}
```

### **Option 2: Direct MetaDataLoader (Backward Compatible)**
Direct access to MetaDataLoader instances:
```java
@Service
public class MetaDataProcessor {
    
    @Autowired
    private MetaDataLoader primaryMetaDataLoader;
    
    public void processMetadata() {
        // Traditional MetaDataLoader API
        MetaObject userMeta = primaryMetaDataLoader.getMetaObjectByName("User");
        List<MetaField> fields = userMeta.getMetaFields();
        
        // Process fields...
    }
}
```

### **Option 3: Full Registry Access (Advanced)**
Complete registry control for complex scenarios:
```java
@Configuration
public class MetaDataConfiguration {
    
    @Autowired
    private MetaDataLoaderRegistry metaDataLoaderRegistry;
    
    @Bean
    public CustomMetaDataProcessor customProcessor() {
        // Advanced registry operations
        for (MetaDataLoader loader : metaDataLoaderRegistry.getDataLoaders()) {
            // Process each registered loader
        }
        
        return new CustomMetaDataProcessor();
    }
}
```

## ⚙️ **Auto-Configuration Features**

### **MetaDataAutoConfiguration**
Automatically configures:
- **MetaDataService**: High-level service wrapper
- **MetaDataLoaderRegistry**: Registry for multiple loaders
- **Primary MetaDataLoader**: Default loader for backward compatibility

### **Conditional Configuration**
```java
@ConditionalOnProperty(name = "metaobjects.auto-configuration.enabled", havingValue = "true", matchIfMissing = true)
@Configuration
public class MetaDataAutoConfiguration {
    // Auto-configuration implementation
}
```

### **Custom Loader Configuration**
```java
@Configuration
public class CustomMetaDataConfiguration {
    
    @Bean
    @Primary
    public MetaDataLoader customMetaDataLoader() throws Exception {
        SimpleLoader loader = new SimpleLoader("custom");
        loader.setSourceURIs(Arrays.asList(
            URI.create("classpath:metadata/custom-metadata.json")
        ));
        loader.init();
        return loader;
    }
}
```

## 🔧 **Configuration Properties**

### **Application Properties**
```properties
# Enable/disable auto-configuration
metaobjects.auto-configuration.enabled=true

# Primary loader configuration
metaobjects.loader.name=primaryLoader
metaobjects.loader.sources=classpath:metadata/

# Registry settings
metaobjects.registry.auto-discovery=true
```

### **YAML Configuration**
```yaml
metaobjects:
  auto-configuration:
    enabled: true
  loader:
    name: primaryLoader
    sources:
      - classpath:metadata/user-metadata.json
      - classpath:metadata/product-metadata.json
  registry:
    auto-discovery: true
```

## 🧪 **Testing Integration**

### **Test Configuration**
```java
@TestConfiguration
public class TestMetaDataConfiguration {
    
    @Bean
    @Primary
    public MetaDataLoader testMetaDataLoader() throws Exception {
        SimpleLoader loader = new SimpleLoader("test");
        loader.setSourceURIs(Arrays.asList(
            URI.create("classpath:test-metadata/test-objects.json")
        ));
        loader.init();
        return loader;
    }
}
```

### **Integration Tests**
```java
@SpringBootTest
class MetaDataServiceIntegrationTest {
    
    @Autowired
    private MetaDataService metaDataService;
    
    @Test
    void testMetaObjectDiscovery() {
        List<MetaObject> allObjects = metaDataService.getAllMetaObjects();
        assertThat(allObjects).isNotEmpty();
        
        Optional<MetaObject> userMeta = metaDataService.findMetaObjectByNameOptional("User");
        assertThat(userMeta).isPresent();
        
        boolean hasUser = metaDataService.metaObjectExists("User");
        assertThat(hasUser).isTrue();
    }
}
```

### **Mock Testing**
```java
@ExtendWith(MockitoExtension.class)
class UserServiceTest {
    
    @Mock
    private MetaDataService metaDataService;
    
    @InjectMocks
    private UserService userService;
    
    @Test
    void testUserValidation() {
        MetaObject userMeta = mock(MetaObject.class);
        when(metaDataService.findMetaObjectByNameOptional("User"))
            .thenReturn(Optional.of(userMeta));
        
        boolean result = userService.validateUser("test data");
        assertThat(result).isTrue();
    }
}
```

## 🌐 **Web Integration**

### **REST Controllers**
```java
@RestController
@RequestMapping("/api/metadata")
public class MetaDataApiController {
    
    @Autowired
    private MetaDataService metaDataService;
    
    @GetMapping("/objects")
    public ResponseEntity<List<String>> getAllObjectNames() {
        List<String> objectNames = metaDataService.getAllMetaObjects().stream()
            .map(MetaObject::getName)
            .collect(Collectors.toList());
        return ResponseEntity.ok(objectNames);
    }
    
    @GetMapping("/objects/{objectName}")
    public ResponseEntity<MetaObjectDto> getMetaObject(@PathVariable String objectName) {
        Optional<MetaObject> metaObject = metaDataService.findMetaObjectByNameOptional(objectName);
        
        return metaObject
            .map(obj -> ResponseEntity.ok(convertToDto(obj)))
            .orElse(ResponseEntity.notFound().build());
    }
    
    @GetMapping("/objects/{objectName}/fields")
    public ResponseEntity<List<FieldDto>> getFields(@PathVariable String objectName) {
        return metaDataService.findMetaObjectByNameOptional(objectName)
            .map(obj -> {
                List<FieldDto> fields = obj.getMetaFields().stream()
                    .map(this::convertFieldToDto)
                    .collect(Collectors.toList());
                return ResponseEntity.ok(fields);
            })
            .orElse(ResponseEntity.notFound().build());
    }
}
```

### **Data Transfer Objects**
```java
public class MetaObjectDto {
    private String name;
    private String packageName;
    private List<FieldDto> fields;
    // getters, setters, constructors
}

public class FieldDto {
    private String name;
    private String type;
    private Map<String, String> attributes;
    // getters, setters, constructors
}
```

## 🔄 **Advanced Patterns**

### **Custom Service Implementations**
```java
@Service
public class CustomMetaDataService {
    
    @Autowired
    private MetaDataLoaderRegistry registry;
    
    public Stream<MetaObject> getAllMetaObjectsStream() {
        return registry.getDataLoaders().stream()
            .flatMap(loader -> loader.getChildren(MetaObject.class).stream());
    }
    
    public Map<String, MetaObject> getMetaObjectsByPackage(String packageName) {
        return getAllMetaObjectsStream()
            .filter(obj -> packageName.equals(obj.getPackage()))
            .collect(Collectors.toMap(MetaObject::getName, Function.identity()));
    }
}
```

### **Event-Driven Updates**
```java
@Component
public class MetaDataEventHandler {
    
    @EventListener
    public void handleMetaDataUpdate(MetaDataUpdateEvent event) {
        // Handle metadata changes
        MetaObject updatedObject = event.getMetaObject();
        // Refresh caches, notify subscribers, etc.
    }
}
```

### **Caching Integration**
```java
@Service
public class CachedMetaDataService {
    
    @Autowired
    private MetaDataService metaDataService;
    
    @Cacheable("metaObjects")
    public Optional<MetaObject> findMetaObjectByNameCached(String name) {
        return metaDataService.findMetaObjectByNameOptional(name);
    }
    
    @CacheEvict(value = "metaObjects", allEntries = true)
    public void clearCache() {
        // Clear all cached metadata
    }
}
```

## 🔍 **Troubleshooting**

### **Common Issues**

#### **Auto-Configuration Not Working**
1. Ensure `metaobjects-core-spring` is on classpath
2. Check `application.properties` for correct configuration
3. Verify Spring Boot version compatibility

#### **MetaDataService Bean Not Found**
```java
// Add explicit configuration if auto-configuration fails
@Configuration
@EnableAutoConfiguration
public class MetaDataConfiguration {
    // Configuration beans
}
```

#### **Multiple Loader Conflicts**
```java
// Use @Primary to designate default loader
@Bean
@Primary
public MetaDataLoader primaryLoader() {
    // Primary loader implementation
}
```

### **Debug Information**
Enable debug logging:
```properties
logging.level.com.metaobjects.spring=DEBUG
logging.level.com.metaobjects.registry=DEBUG
```

## 📊 **Performance Considerations**

### **Lazy Loading**
```java
// MetaDataService uses lazy initialization
@Autowired
private MetaDataService metaDataService; // Fast injection

// Actual metadata loading happens on first access
Optional<MetaObject> user = metaDataService.findMetaObjectByNameOptional("User"); // Triggers loading
```

### **Registry Caching**
- MetaDataLoaderRegistry caches loader discovery
- MetaObject lookups are cached after first access
- Thread-safe for concurrent access

### **Memory Management**
- Uses WeakHashMap patterns to avoid leaking classloaders
- Automatic cleanup when Spring context shuts down
- Minimal memory overhead for Spring integration

## Virtual threads (Java 21)

OMDB is a synchronous JDBC API and is safe to run on JVM virtual threads. An audit of
the OMDB blocking paths found no `synchronized` monitor held across a JDBC call (the only
synchronized methods guard in-memory state — the driver lazy-init, the event-listener
list, and per-object attribute maps), so OMDB does not pin carrier threads.

To run a Spring Boot 3.2+ application's request handling on virtual threads, set:

    spring.threads.virtual.enabled=true

The starter does not enable this for you — it is the application's choice.

---

**This Spring integration provides seamless MetaObjects functionality within Spring applications while maintaining all the framework's powerful features.**
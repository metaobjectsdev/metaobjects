# ObjectManager Persistence Framework

!!! info "Documentation Moved to MetaObjects Dynamic"
    The ObjectManager persistence framework and dynamic object types have been moved to the **MetaObjects Dynamic** project for better architectural separation.

## Quick Links

### 📚 **Complete Documentation**
- **[ObjectManager Persistence Guide](https://github.com/metaobjectsdev/metaobjects-dynamic/docs/src/site/documentation/docs/user-guide/persistence/objectmanager.md)** - Complete setup, configuration, and usage patterns
- **[Dynamic Object Types](https://github.com/metaobjectsdev/metaobjects-dynamic/docs/src/site/documentation/docs/user-guide/objects/dynamic-object-types.md)** - ValueObject, DataObject, ProxyObject implementations

### 🚀 **Getting Started**
- **[Installation Guide](https://github.com/metaobjectsdev/metaobjects-dynamic/docs/src/site/documentation/docs/getting-started/installation.md)** - Dependencies and setup
- **[First Dynamic Object](https://github.com/metaobjectsdev/metaobjects-dynamic/docs/src/site/documentation/docs/getting-started/first-dynamic-object.md)** - Hello World example
- **[Persistence Setup](https://github.com/metaobjectsdev/metaobjects-dynamic/docs/src/site/documentation/docs/getting-started/persistence-setup.md)** - ObjectManager configuration

## Why the Move?

The architectural split provides better separation of concerns:

### **MetaObjects Core** (This Project)
- ✅ **Metadata Framework**: Type system, constraints, validation
- ✅ **Code Generation**: Template-based generation framework
- ✅ **Loading System**: JSON/XML metadata parsing and loading
- ✅ **Service Registry**: Provider-based type registration

### **MetaObjects Dynamic** (Separate Project)
- 🔄 **Runtime Object Construction**: ValueObject, DataObject, ProxyObject
- 🔄 **Persistence Framework**: ObjectManagerDB, ObjectManagerNoSQL
- 🔄 **Dynamic Property Access**: Runtime property manipulation
- 🔄 **Template Generation**: ValueObject/DataObject code generation

## Migration Path

If you're adopting ObjectManager on 7.0.0, depend on `metaobjects-om` (for the runtime metadata-driven CRUD API) plus the relational implementation `metaobjects-omdb`. The metadata core is pulled in transitively.

```xml
<dependency>
    <groupId>com.metaobjects</groupId>
    <artifactId>metaobjects-om</artifactId>
    <version>7.0.0</version>
</dependency>
<dependency>
    <groupId>com.metaobjects</groupId>
    <artifactId>metaobjects-omdb</artifactId>
    <version>7.0.0</version>
</dependency>
```

Optional: `metaobjects-omdb-ktx` adds a Kotlin facade (`QueryDsl`) over OMDB. `metaobjects-dynamic-core` adds runtime-dynamic metadata loading.

### 2. Update Imports

**Change package imports:**
```java
// OLD - Core project packages
import com.metaobjects.manager.ObjectManager;
import com.metaobjects.object.value.ValueObject;

// NEW - Dynamic project packages
import com.metaobjects.dynamic.manager.ObjectManager;
import com.metaobjects.dynamic.object.ValueObject;
```

### 3. No Code Changes Required

Your existing ObjectManager code should work without changes once the imports are updated.

## Quick Example

Here's a simple example of what ObjectManager provides (see full documentation in Dynamic project):

```java
// 1. Define metadata (same as before)
MetaObject userMeta = loader.getMetaObjectByName("User");

// 2. Create dynamic object
ValueObject user = new ValueObject();
user.setMetaData(userMeta);
user.setAttrValue("username", "john_doe");
user.setAttrValue("email", "john@example.com");

// 3. Persist with ObjectManager
ObjectManagerDB objectManager = new ObjectManagerDB();
objectManager.setDataSource(dataSource);

ObjectConnection connection = objectManager.getConnection();
try {
    objectManager.createObject(connection, user);
    System.out.println("Created user with ID: " + user.getAttrValue("id"));
} finally {
    connection.close();
}
```

## Architecture Benefits

This separation provides:

- 🎯 **Focused Dependencies**: Include only what you need
- 🔧 **Independent Evolution**: Core and Dynamic can evolve separately
- 📦 **Smaller Artifacts**: Reduced JAR sizes for specific use cases
- 🚀 **Better Testing**: Clearer testing boundaries between metadata and runtime

## Need Help?

- **📖 Documentation**: See the [MetaObjects Dynamic Documentation](https://github.com/metaobjectsdev/metaobjects-dynamic/docs/)
- **💬 Questions**: Open an issue in the [MetaObjects Dynamic repository](https://github.com/metaobjectsdev/metaobjects-dynamic/issues)
- **🔄 Migration Issues**: Check the [migration guide](https://github.com/metaobjectsdev/metaobjects-dynamic/docs/src/site/documentation/docs/migration/)

---

**This architectural split strengthens both projects while maintaining full compatibility for existing ObjectManager users.**
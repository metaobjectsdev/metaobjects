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
package com.metaobjects.util;

import com.metaobjects.MetaData;
import com.metaobjects.MetaDataNotFoundException;
import com.metaobjects.field.MetaField;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.registry.MetaDataLoaderRegistry;
import com.metaobjects.registry.ServiceRegistryFactory;
import com.metaobjects.object.MetaObject;
import com.metaobjects.object.MetaObjectAware;

import java.util.Objects;

/**
 * Utility class providing helper methods for MetaData operations.
 * Contains commonly used operations for working with MetaData objects, loaders, and registries.
 * 
 * @author dmealing
 * @since 1.0
 */
public class MetaDataUtil {

  public final static String ATTR_OBJECT_REF = MetaObject.ATTR_OBJECT_REF;
  public final static String SEP = MetaDataLoader.PKG_SEPARATOR;


  /** Find an actual package traversing parents if needed */
  public static String findPackageForMetaData( MetaData d ) {

    synchronized ( d ) {

      final String KEY = "findPackageForMetaData()";

      String pkg = (String) d.getCacheValue(KEY);

      if (pkg == null) {

        MetaData p = d; // d.getParent();
        pkg = p.getPackage();

        while ((pkg == null || pkg.equals("")) && p != null) {
          p = p.getParent();
          pkg = p != null ? p.getPackage() : "";
        }

        d.setCacheValue( KEY, pkg );
      }

      return pkg;
    }
  }

  public static boolean hasObjectRef( MetaField f ) {
    return f.hasMetaAttr(ATTR_OBJECT_REF);
  }

  /** Gets the MetaObject referenced by this MetaData using the objectRef attribute */
  public static MetaObject getObjectRef( MetaField d ) throws MetaDataNotFoundException {

    synchronized ( d ) {

      final String KEY = "getObjectRef()";

      MetaObject o = (MetaObject) d.getCacheValue(KEY);

      if (o == null) {

          String objectRef = d.getMetaAttr(ATTR_OBJECT_REF).getValueAsString();
          if (objectRef != null) {

            String basePkg = findPackageForMetaData(d);
            String name = expandPackageForMetaDataRef(basePkg, objectRef);

            try {
              o = d.getLoader().getMetaObjectByName(name);
            } catch (MetaDataNotFoundException e) {
              // A bare (non-`::`-prefixed) ref names a SAME-PACKAGE sibling: the cross-port
              // canonical form writes `@objectRef: "Settings"` for a sibling object in the same
              // package (see fixtures/persistence-conformance — AllTypes → Settings). The
              // relative-path expander above only prepends a package for a `::`-/`..::`-prefixed
              // ref, leaving a bare name as-is, which misses the package-qualified registration
              // (`fitness::Settings`). Retry with the declaring node's package prefixed before
              // surfacing the not-found.
              MetaObject resolved = null;
              if (basePkg != null && !basePkg.isEmpty()
                  && !objectRef.contains(SEP)) {
                String qualified = basePkg + SEP + objectRef;
                try {
                  resolved = d.getLoader().getMetaObjectByName(qualified);
                } catch (MetaDataNotFoundException ignored) {
                  // fall through to the original not-found below
                }
              }
              if (resolved == null) throw MetaDataNotFoundException.forObject(name, d);
              o = resolved;
            }
          }

        d.setCacheValue(KEY, o);
      }

      return o;
    }
  }

  /** Expands the provided package if using relative package paths */
  public static String expandPackageForMetaDataRef(String basePkg, String metaDataRef ) {
    return expandPackageFor( basePkg, metaDataRef );
  }

  /** Expands the provided package if using relative package paths */
  public static String expandPackageForPath(String basePkg, String pkgPath ) {
    return expandPackageFor( basePkg, pkgPath );
  }

  /** Child-reference separator for FR-024 dotted child suffixes (e.g. {@code Customer.id}). */
  public final static String CHILD_REF_SEPARATOR = ".";

  /**
   * FR-032 (ADR-0032) — expand an authored metadata reference to its fully-qualified
   * canonical form. This is the Java mirror of the TS {@code expandRef(raw, packageContext)}
   * primitive; it is the single ref-expansion routine the YAML desugar threads over every
   * ref-bearing attr so canonical JSON is FQN-only. Deterministic, NO root fallback:
   *
   * <ul>
   *   <li>bare {@code Name} (no {@code ::}, no leading dot) → {@code <P>::Name} (current
   *       package only; stays bare when {@code P} is empty/root).</li>
   *   <li>qualified {@code pkg::Name} (contains {@code ::}, NOT leading {@code ::}) →
   *       unchanged (absolute from root).</li>
   *   <li>{@code ::Rest} (leading {@code ::}) → strip the leading {@code ::}; the remainder
   *       is absolute from root.</li>
   *   <li>{@code ..::Rest} (one or more leading {@code ..::}) → drop one package segment
   *       from {@code P} per {@code ..::}, then resolve {@code Rest} against the reduced
   *       package. Over-drop throws {@link IllegalStateException}.</li>
   * </ul>
   *
   * <p>The trailing FR-024 dotted child suffix ({@code .child} / {@code .child.grandchild})
   * is preserved verbatim: only the OWNER part (everything before the first dot in the final
   * {@code ::}-segment) is expanded; the {@code .child...} tail is reattached.</p>
   *
   * @param raw            the authored reference (may carry a dotted child tail)
   * @param packageContext the declaring node's effective package
   * @return the fully-qualified canonical reference
   */
  public static String expandRef(String raw, String packageContext) {
    // FR-032 — split off any FR-024 dotted child tail; expand only the owner.
    final int lastSep = raw.lastIndexOf(SEP);
    final int segStart = lastSep == -1 ? 0 : lastSep + SEP.length();
    final int dotInSeg = raw.indexOf(CHILD_REF_SEPARATOR, segStart);
    final String owner = dotInSeg == -1 ? raw : raw.substring(0, dotInSeg);
    final String tail = dotInSeg == -1 ? "" : raw.substring(dotInSeg);
    return expandRefOwner(owner, packageContext) + tail;
  }

  /**
   * FR-032 — expand a reference's OWNER part (no child tail) to its FQN. Mirrors the TS
   * {@code expandOwner}. Throws on parent-relative over-drop.
   */
  private static String expandRefOwner(String owner, String packageContext) {
    final String pkg = (packageContext == null) ? "" : packageContext;

    // root-absolute: leading "::" → strip; the remainder is absolute from root.
    if ( owner.startsWith( SEP )) {
      return owner.substring( SEP.length() );
    }

    // parent-relative: one or more leading "..::".
    final String parentPrefix = ".." + SEP;
    if ( owner.startsWith( parentPrefix )) {
      String rest = owner;
      int levels = 0;
      while ( rest.startsWith( parentPrefix )) {
        levels++;
        rest = rest.substring( parentPrefix.length() );
      }
      String[] pkgParts = pkg.isEmpty() ? new String[0] : pkg.split( SEP );
      if ( levels > pkgParts.length ) {
        throw new IllegalStateException(
            "Relative reference '" + owner + "' over-drops: " + levels
                + " parent level(s) but the package context '" + pkg + "' has only "
                + pkgParts.length + " segment(s)");
      }
      StringBuilder reduced = new StringBuilder();
      for ( int i = 0; i < pkgParts.length - levels; i++ ) {
        if ( reduced.length() > 0 ) reduced.append( SEP );
        reduced.append( pkgParts[i] );
      }
      return reduced.length() != 0 ? reduced + SEP + rest : rest;
    }

    // qualified: contains "::" (not leading) → absolute, unchanged.
    if ( owner.contains( SEP )) {
      return owner;
    }

    // bare name → current package (only). Stays bare when context is empty/root.
    return !pkg.isEmpty() ? pkg + SEP + owner : owner;
  }

  /** Expands the provided value if using relative package paths */
  private static String expandPackageFor(String basePkg, String value ) {

    final String origPkg = value;

    // If there is no base package then handle a few default behaviors
    if ( basePkg == null || basePkg.isEmpty() ) basePkg = "";

    // If it's relative, then strip it off
    if ( value.startsWith( SEP )) {
      value = basePkg + value;
    }

    // Drop down the package paths
    else if ( value.startsWith( ".."+SEP )) {

      // Split out the base package in case we have to traverse downward
      String [] base = basePkg.split( SEP );
      int i = base.length;

      // Trim off all the proceeding dropdown paths
      while (value.startsWith(".."+SEP)) {
        value = value.substring(4);
        i--;
        if (i < 0) throw new IllegalStateException("Base package [" + basePkg + "] cannot drop that many relative paths for [" + origPkg + "]");
      }

      // Reform the package
      for( int x = i-1; x >= 0; x-- ) {
        value = base[x] + SEP + value;
      }
    }

    return value;
  }

  // ========================================================================
  // OSGi-Compatible Registry Helper Methods
  // ========================================================================

  /**
   * Gets an OSGi-compatible MetaDataLoaderRegistry instance.
   * 
   * <p>This helper method centralizes the creation of MetaDataLoaderRegistry instances
   * to ensure consistent OSGi compatibility across the entire codebase. If the registry
   * creation logic needs to change in the future, it only needs to be updated here.</p>
   * 
   * @param context The calling object context (for future extensibility)
   * @return OSGi-compatible MetaDataLoaderRegistry instance
   * @since 6.0.0
   */
  public static MetaDataLoaderRegistry getMetaDataLoaderRegistry(Object context) {
    // If context is a MetaData object, try to find a registry containing its loader
    if (context instanceof MetaData) {
      MetaData metaData = (MetaData) context;
      MetaDataLoader loader = metaData.getLoader();
      if (loader != null) {
        // Create a registry and register this loader
        // This ensures the context loader is available for lookups
        MetaDataLoaderRegistry registry = new MetaDataLoaderRegistry(ServiceRegistryFactory.getDefault());
        registry.registerLoader(loader);
        return registry;
      }
    }
    
    // Default behavior: create new registry with service discovery
    return new MetaDataLoaderRegistry(ServiceRegistryFactory.getDefault());
  }

  /**
   * Finds a MetaObject for the given object instance using OSGi-compatible registry.
   * 
   * <p>This is the preferred replacement for the legacy static 
   * {@code MetaDataRegistry.findMetaObject()} method.</p>
   * 
   * @param obj The object to find metadata for
   * @param context The calling object context (for future extensibility)
   * @return MetaObject that can handle the given object
   * @throws MetaDataNotFoundException if no suitable MetaObject is found
   * @since 6.0.0
   */
  public static MetaObject findMetaObject(Object obj, Object context) throws MetaDataNotFoundException {
    MetaDataLoaderRegistry registry = getMetaDataLoaderRegistry(context);
    return registry.findMetaObject(obj);
  }

  /**
   * Finds a MetaObject by name using OSGi-compatible registry.
   * 
   * <p>This is the preferred replacement for the legacy static 
   * {@code MetaDataRegistry.findMetaObjectByName()} method.</p>
   * 
   * @param name Fully qualified metadata name (e.g., "com.example::User")
   * @param context The calling object context (for future extensibility)
   * @return MetaObject with the specified name
   * @throws MetaDataNotFoundException if no MetaObject with the given name is found
   * @since 6.0.0
   */
  public static MetaObject findMetaObjectByName(String name, Object context) throws MetaDataNotFoundException {
    MetaDataLoaderRegistry registry = getMetaDataLoaderRegistry(context);
    return registry.findMetaObjectByName(name);
  }

  /**
   * Finds a MetaDataLoader by name using OSGi-compatible registry.
   * 
   * <p>This is the preferred replacement for the legacy static 
   * {@code MetaDataRegistry.getDataLoader()} method.</p>
   * 
   * @param loaderName Name of the loader to find
   * @param context The calling object context (for future extensibility)
   * @return MetaDataLoader with the specified name, or null if not found
   * @since 6.0.0
   */
  public static MetaDataLoader findMetaDataLoaderByName(String loaderName, Object context) {
    MetaDataLoaderRegistry registry = getMetaDataLoaderRegistry(context);
    return registry.getDataLoaders().stream()
        .filter(loader -> loaderName.equals(loader.getName()))
        .findFirst()
        .orElse(null);
  }

  /**
   * Gets all registered MetaDataLoaders using OSGi-compatible registry.
   *
   * <p>This is the preferred replacement for the legacy static
   * {@code MetaDataRegistry.getDataLoaders()} method.</p>
   *
   * @param context The calling object context (for future extensibility)
   * @return Collection of all registered MetaDataLoaders
   * @since 6.0.0
   */
  public static java.util.Collection<MetaDataLoader> getAllMetaDataLoaders(Object context) {
    MetaDataLoaderRegistry registry = getMetaDataLoaderRegistry(context);
    return registry.getDataLoaders();
  }

  // ============================================================================
  // SIMPLE PATTERN METHODS - Direct MetaDataLoader Usage
  // ============================================================================

  /**
   * Finds a MetaObject for the given object instance using direct loader access.
   *
   * <p>This is the <strong>simple pattern</strong> for single-loader scenarios.
   * Use this when you have a specific loader and don't need multi-loader registry overhead.</p>
   *
   * @param loader The MetaDataLoader to search
   * @param obj The object to find metadata for
   * @return MetaObject that can handle the given object
   * @throws MetaDataNotFoundException if no suitable MetaObject is found
   * @since 6.0.0
   */
  public static MetaObject findMetaObject(MetaDataLoader loader, Object obj) throws MetaDataNotFoundException {
    Objects.requireNonNull(loader, "MetaDataLoader cannot be null");
    Objects.requireNonNull(obj, "Object to find metadata for cannot be null");

    // Use the loader's getMetaObjectFor method (same pattern as MetaDataLoaderRegistry)
    MetaObject metaObject = loader.getMetaObjectFor(obj);
    if (metaObject != null) {
      return metaObject;
    }

    throw new MetaDataNotFoundException("No MetaObject found for object of type: " + obj.getClass().getName(), obj.getClass().getSimpleName());
  }

  /**
   * Finds a MetaObject by name using direct loader access.
   *
   * <p>This is the <strong>simple pattern</strong> for single-loader scenarios.
   * Use this when you have a specific loader and know the exact metadata name.</p>
   *
   * @param loader The MetaDataLoader to search
   * @param name Fully qualified metadata name (e.g., "com.example::User")
   * @return MetaObject with the specified name
   * @throws MetaDataNotFoundException if no MetaObject with the given name is found
   * @since 6.0.0
   */
  public static MetaObject findMetaObjectByName(MetaDataLoader loader, String name) throws MetaDataNotFoundException {
    Objects.requireNonNull(loader, "MetaDataLoader cannot be null");
    Objects.requireNonNull(name, "MetaObject name cannot be null");

    MetaObject metaObject = loader.getMetaObjectByName(name);
    if (metaObject == null) {
      throw new MetaDataNotFoundException("MetaObject not found: " + name, name);
    }
    return metaObject;
  }

  /**
   * Gets all MetaObjects from a specific loader.
   *
   * <p>This is the <strong>simple pattern</strong> for single-loader scenarios.
   * Use this when you need to enumerate all metadata in a specific loader.</p>
   *
   * @param loader The MetaDataLoader to get objects from
   * @return List of all MetaObjects in the loader
   * @since 6.0.0
   */
  public static java.util.List<MetaObject> getAllMetaObjects(MetaDataLoader loader) {
    Objects.requireNonNull(loader, "MetaDataLoader cannot be null");
    return loader.getChildren(MetaObject.class);
  }

  // ============================================================================
  // COMPLEX PATTERN METHODS - MetaDataLoaderRegistry Usage
  // ============================================================================

  /**
   * Finds a MetaObject for the given object instance using registry lookup.
   *
   * <p>This is the <strong>complex pattern</strong> for multi-loader scenarios.
   * Use this for multi-tenant, plugin systems, or runtime loader switching.</p>
   *
   * @param registry The MetaDataLoaderRegistry to search
   * @param obj The object to find metadata for
   * @return MetaObject that can handle the given object
   * @throws MetaDataNotFoundException if no suitable MetaObject is found
   * @since 6.0.0
   */
  public static MetaObject findMetaObject(MetaDataLoaderRegistry registry, Object obj) throws MetaDataNotFoundException {
    Objects.requireNonNull(registry, "MetaDataLoaderRegistry cannot be null");
    return registry.findMetaObject(obj);
  }

  /**
   * Finds a MetaObject by name using registry lookup.
   *
   * <p>This is the <strong>complex pattern</strong> for multi-loader scenarios.
   * Use this when you need to search across multiple loaders or don't know which loader contains the metadata.</p>
   *
   * @param registry The MetaDataLoaderRegistry to search
   * @param name Fully qualified metadata name (e.g., "com.example::User")
   * @return MetaObject with the specified name
   * @throws MetaDataNotFoundException if no MetaObject with the given name is found
   * @since 6.0.0
   */
  public static MetaObject findMetaObjectByName(MetaDataLoaderRegistry registry, String name) throws MetaDataNotFoundException {
    Objects.requireNonNull(registry, "MetaDataLoaderRegistry cannot be null");
    return registry.findMetaObjectByName(name);
  }
}

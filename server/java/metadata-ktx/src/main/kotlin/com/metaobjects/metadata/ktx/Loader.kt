package com.metaobjects.metadata.ktx

import com.metaobjects.loader.DirectorySource
import com.metaobjects.loader.LoaderOptions
import com.metaobjects.loader.MetaDataLoader
import com.metaobjects.loader.MetaDataSource.MetaDataFormat
import com.metaobjects.registry.MetaDataTypeProvider
import java.net.URI
import java.nio.file.Path

/**
 * Top-level loader factory shortcuts — match the cross-port convention used by
 * the TS and Python implementations. Each shortcut forwards to the corresponding
 * [MetaDataLoader] static factory.
 */

/**
 * The options a `providers` argument rides on. Empty [providers] returns [opts] untouched (so the
 * default load is byte-identical); otherwise the providers are set on [opts], or on the
 * `createManual` defaults (lax, quiet, unregistered) when [opts] is null.
 */
private fun withProviders(opts: LoaderOptions?, providers: List<MetaDataTypeProvider>): LoaderOptions? =
    if (providers.isEmpty()) opts
    else (opts ?: LoaderOptions.create(false, false, false)).setProviders(providers)

/**
 * Load metadata from a filesystem directory; pass [DirectorySource.Options] to tune expansion and
 * [providers] to add a project's own vocabulary (composed after the metamodel set, sealed, strict).
 */
fun loadDirectory(
    name: String,
    directory: Path,
    opts: DirectorySource.Options = DirectorySource.Options(),
    providers: List<MetaDataTypeProvider> = emptyList(),
): MetaDataLoader = MetaDataLoader.fromDirectory(name, directory, opts, null, providers)

/** Load metadata from a list of URIs; pass [LoaderOptions] to tune (e.g. `strict=true`) and [providers] for a project's own vocabulary. */
fun loadUris(
    name: String,
    uris: List<URI>,
    opts: LoaderOptions? = null,
    providers: List<MetaDataTypeProvider> = emptyList(),
): MetaDataLoader = MetaDataLoader.fromUris(name, uris, withProviders(opts, providers))

/** Load metadata from classpath resource paths; pass [LoaderOptions] to tune and [providers] for a project's own vocabulary. */
fun loadResources(
    name: String,
    resources: List<String>,
    opts: LoaderOptions? = null,
    providers: List<MetaDataTypeProvider> = emptyList(),
): MetaDataLoader = MetaDataLoader.fromResources(name, resources, withProviders(opts, providers))

/**
 * Load metadata from a single inline string (defaults to JSON); pass [LoaderOptions] to
 * tune (e.g. `strict=true`), matching [loadUris] and [loadResources].
 *
 * The options parameter is the point: without it this was the ONE loader entry that could
 * not opt into strict, so an inline fixture — which is what every codegen test uses — was
 * always loaded lax and an `errors == []` assertion proved only that the document parses,
 * never that it is legal under the sealed registry (ADR-0023).
 */
fun loadString(
    name: String,
    content: String,
    format: MetaDataFormat = MetaDataFormat.JSON,
    opts: LoaderOptions? = null,
    providers: List<MetaDataTypeProvider> = emptyList(),
): MetaDataLoader = MetaDataLoader.fromString(name, content, format, withProviders(opts, providers))

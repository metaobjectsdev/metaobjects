package com.metaobjects.metadata.ktx

import com.metaobjects.loader.DirectorySource
import com.metaobjects.loader.LoaderOptions
import com.metaobjects.loader.MetaDataLoader
import com.metaobjects.loader.MetaDataSource.MetaDataFormat
import java.net.URI
import java.nio.file.Path

/**
 * Top-level loader factory shortcuts — match the cross-port convention used by
 * the TS and Python implementations. Each shortcut forwards to the corresponding
 * [MetaDataLoader] static factory.
 */

/** Load metadata from a filesystem directory. */
fun loadDirectory(name: String, directory: Path): MetaDataLoader =
    MetaDataLoader.fromDirectory(name, directory)

/** Load metadata from a filesystem directory with [DirectorySource.Options]. */
fun loadDirectory(name: String, directory: Path, opts: DirectorySource.Options): MetaDataLoader =
    MetaDataLoader.fromDirectory(name, directory, opts)

/** Load metadata from a list of URIs. */
fun loadUris(name: String, uris: List<URI>): MetaDataLoader =
    MetaDataLoader.fromUris(name, uris)

/** Load metadata from a list of URIs with [LoaderOptions]. */
fun loadUris(name: String, uris: List<URI>, opts: LoaderOptions?): MetaDataLoader =
    MetaDataLoader.fromUris(name, uris, opts)

/** Load metadata from classpath resource paths. */
fun loadResources(name: String, resources: List<String>): MetaDataLoader =
    MetaDataLoader.fromResources(name, resources)

/** Load metadata from classpath resource paths with [LoaderOptions]. */
fun loadResources(name: String, resources: List<String>, opts: LoaderOptions?): MetaDataLoader =
    MetaDataLoader.fromResources(name, resources, opts)

/** Load metadata from a single inline string (defaults to JSON). */
fun loadString(
    name: String,
    content: String,
    format: MetaDataFormat = MetaDataFormat.JSON,
): MetaDataLoader = MetaDataLoader.fromString(name, content, format)

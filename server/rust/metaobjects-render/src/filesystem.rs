//! A [`Provider`] over a directory of `.mustache` files.
//!
//! The reference `group/source` resolves to `<root>/group/source.mustache`, as it does in
//! every port. A reference that is empty, absolute, or climbs out of the root with `..`
//! resolves to nothing, and so does a file a symbolic link places outside the root.

use std::path::{Component, Path, PathBuf};

use crate::render::Provider;

/// The extension a Mustache template file carries.
pub const MUSTACHE_EXTENSION: &str = ".mustache";

/// Resolves references to `.mustache` files under one directory.
#[derive(Debug, Clone)]
pub struct FilesystemProvider {
    root: PathBuf,
}

impl FilesystemProvider {
    /// A provider over the templates under `root`.
    #[must_use]
    pub fn new(root: impl Into<PathBuf>) -> Self {
        let root = root.into();
        let root = root.canonicalize().unwrap_or(root);
        Self { root }
    }

    /// The directory references resolve under.
    #[must_use]
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// The file `reference` names, when it exists inside the root.
    #[must_use]
    pub fn path_of(&self, reference: &str) -> Option<PathBuf> {
        let mut segments = Vec::new();
        for segment in reference.split('/').filter(|s| !s.is_empty()) {
            let mut components = Path::new(segment).components();
            match (components.next(), components.next()) {
                (Some(Component::Normal(_)), None) => segments.push(segment),
                _ => return None,
            }
        }
        let (last, dirs) = segments.split_last()?;
        let mut path = self.root.clone();
        path.extend(dirs);
        path.push(format!("{last}{MUSTACHE_EXTENSION}"));
        let resolved = path.canonicalize().ok()?;
        (resolved.starts_with(&self.root) && resolved.is_file()).then_some(resolved)
    }
}

impl Provider for FilesystemProvider {
    fn resolve(&self, reference: &str) -> Option<String> {
        std::fs::read_to_string(self.path_of(reference)?).ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_inside_the_root_only() {
        let base = std::env::var_os("DEV_SCRATCH").map_or_else(std::env::temp_dir, PathBuf::from);
        let dir = base.join(format!("mo-fs-provider-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("root/pages")).unwrap();
        std::fs::write(dir.join("root/pages/welcome.mustache"), "Hello {{name}}").unwrap();
        std::fs::write(dir.join("outside.mustache"), "secret").unwrap();
        let p = FilesystemProvider::new(dir.join("root"));
        assert_eq!(
            p.resolve("pages/welcome").as_deref(),
            Some("Hello {{name}}")
        );
        assert_eq!(
            p.resolve("/pages//welcome").as_deref(),
            Some("Hello {{name}}")
        );
        for bad in [
            "../outside",
            "pages/../../outside",
            "",
            "pages/missing",
            "pages",
        ] {
            assert_eq!(p.resolve(bad), None, "{bad}");
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }
}

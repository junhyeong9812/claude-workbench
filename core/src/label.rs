//! Map an edited path to a human "project" label for the change timeline
//! (P2b-2 spec §2 / codex #12).
//!
//! The timeline is a single per-session-root stream, but each item is tagged
//! with the project it belongs to so the UI can group/filter. The label is the
//! directory name of the **nearest ancestor** (at or above the path's folder,
//! up to and including the session `root`) that holds a project marker
//! (`Cargo.toml`, `package.json`, …). This is pure except for marker probes on
//! the filesystem.

use std::path::Path;

use crate::project_type::has_project_marker;

/// The project label for `path` within session `root`:
///
/// - the name of the nearest ancestor directory holding a project marker, else
/// - the name of `root` itself if no marker is found up to the root, else
/// - `"external"` if `path` lies outside `root`.
///
/// Paths are canonicalized where they exist (resolving symlinks and `..`); a
/// path that doesn't exist yet (e.g. a file about to be created) falls back to
/// its nearest existing ancestor. Returns `None` only for degenerate roots with
/// no file name (e.g. `/`).
pub fn nearest_project_marker(path: &Path, root: &Path) -> Option<String> {
    let root = canonical_or_self(root);

    // Scan from the path's containing directory (or the path itself if it's a
    // directory). Canonicalize the start so symlinked paths compare against the
    // canonicalized root.
    let raw_start = if path.is_dir() {
        path.to_path_buf()
    } else {
        path.parent()?.to_path_buf()
    };
    let start = canonical_or_self(&raw_start);

    if !start.starts_with(&root) {
        return Some("external".to_string());
    }

    // `ancestors()` yields deepest-first, so the first marker found is nearest.
    for dir in start.ancestors() {
        if has_project_marker(dir) {
            return dir.file_name().map(|n| n.to_string_lossy().into_owned());
        }
        if dir == root {
            break;
        }
    }
    root.file_name().map(|n| n.to_string_lossy().into_owned())
}

/// Canonicalize `p`, walking up to the nearest existing ancestor if `p` itself
/// doesn't exist (so a not-yet-created file still resolves symlinks in its
/// existing prefix). Falls back to `p` unchanged if nothing resolves.
fn canonical_or_self(p: &Path) -> std::path::PathBuf {
    if let Ok(c) = std::fs::canonicalize(p) {
        return c;
    }
    // `p` doesn't exist: canonicalize the deepest existing ancestor and re-append
    // the remaining (non-existent) tail.
    for ancestor in p.ancestors().skip(1) {
        if let Ok(base) = std::fs::canonicalize(ancestor) {
            if let Ok(tail) = p.strip_prefix(ancestor) {
                return base.join(tail);
            }
        }
    }
    p.to_path_buf()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn touch(path: &Path) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, b"").unwrap();
    }

    #[test]
    fn labels_with_nearest_marker_when_nested() {
        let tmp = tempdir();
        let root = tmp.path();
        // root/ (Cargo.toml) / crates / inner (Cargo.toml) / src / main.rs
        touch(&root.join("Cargo.toml"));
        let inner = root.join("crates/inner");
        touch(&inner.join("Cargo.toml"));
        let file = inner.join("src/main.rs");
        touch(&file);

        // Nearest marker is `inner`, not the outer root.
        assert_eq!(nearest_project_marker(&file, root).as_deref(), Some("inner"));
    }

    #[test]
    fn falls_back_to_root_name_when_no_inner_marker() {
        let tmp = tempdir();
        let root = tmp.path();
        let root = &root.join("myproj");
        touch(&root.join("Cargo.toml"));
        let file = root.join("src/deep/util.rs");
        touch(&file);

        // No marker between the file and `myproj` -> label is the root folder.
        assert_eq!(nearest_project_marker(&file, root).as_deref(), Some("myproj"));
    }

    #[test]
    fn root_label_when_root_has_no_marker_at_all() {
        let tmp = tempdir();
        let root = tmp.path().join("plain");
        let file = root.join("notes/todo.txt");
        touch(&file);
        // No markers anywhere -> still attributes to the session root folder.
        assert_eq!(nearest_project_marker(&file, &root).as_deref(), Some("plain"));
    }

    #[test]
    fn external_when_path_outside_root() {
        let tmp = tempdir();
        let root = tmp.path().join("root");
        let outside = tmp.path().join("elsewhere");
        touch(&root.join("Cargo.toml"));
        touch(&outside.join("file.rs"));
        assert_eq!(
            nearest_project_marker(&outside.join("file.rs"), &root).as_deref(),
            Some("external")
        );
    }

    #[test]
    fn handles_not_yet_existing_file() {
        let tmp = tempdir();
        let root = tmp.path().join("proj");
        touch(&root.join("package.json"));
        // File doesn't exist yet (about to be created by an edit).
        let new_file = root.join("src/new.ts");
        fs::create_dir_all(new_file.parent().unwrap()).unwrap();
        assert_eq!(
            nearest_project_marker(&new_file, &root).as_deref(),
            Some("proj")
        );
    }

    // Minimal tempdir without an external crate: unique dir under the OS temp.
    fn tempdir() -> TempDir {
        let base = std::env::temp_dir();
        // Counter + pid keeps it unique within a test run without Date/rand.
        use std::sync::atomic::{AtomicU64, Ordering};
        static N: AtomicU64 = AtomicU64::new(0);
        let n = N.fetch_add(1, Ordering::Relaxed);
        let dir = base.join(format!("mt-label-{}-{}", std::process::id(), n));
        fs::create_dir_all(&dir).unwrap();
        TempDir { path: dir }
    }

    struct TempDir {
        path: std::path::PathBuf,
    }
    impl TempDir {
        fn path(&self) -> &Path {
            &self.path
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}

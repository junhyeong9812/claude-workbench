//! Headless directory listing with per-directory project-type detection.
//!
//! This lives in `core` (not `src-tauri`) so directory enumeration and the
//! submodule-badge logic can be unit-tested without any GUI/Tauri linkage.

use ignore::WalkBuilder;
use serde::{Deserialize, Serialize};
use std::ffi::OsStr;
use std::io;
use std::path::Path;

use crate::project_type::{detect_project_types, ProjectType};

/// One entry in a directory listing, sent to the webview.
///
/// `project_types` is populated only for directories (via
/// [`detect_project_types`]); files always carry an empty vector.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    #[serde(default)]
    pub project_types: Vec<ProjectType>,
}

/// List the immediate children of `path`.
///
/// Returns `Err` (never panics) if the path is missing, not a directory, or
/// unreadable. Directories are listed before files; each group is sorted by
/// name (case-insensitive). For each directory entry, `project_types` is filled
/// by probing its marker files.
///
/// Entries ignored by `.gitignore`/`.ignore` (at this directory *or* any parent
/// up to the repo root) are filtered out — so `node_modules`, `target`, etc.
/// don't clutter the tree. The traversal is a single level deep (lazy: only the
/// directory the user expanded), and the `ignore` crate tracks the gitignore
/// stack for us. Dotfiles stay visible (they're often useful in a file tree),
/// with the sole exception of the `.git` directory, which is always hidden.
/// gitignore rules only apply inside a git repository (the `ignore` default);
/// a plain folder lists everything except `.git`.
pub fn list_dir<P: AsRef<Path>>(path: P) -> io::Result<Vec<DirEntry>> {
    let root = path.as_ref();
    // Preserve the old contract: surface an io::Error (not a panic) for a
    // missing path or a path that isn't a directory.
    let meta = std::fs::metadata(root)?;
    if !meta.is_dir() {
        return Err(io::Error::new(io::ErrorKind::Other, "not a directory"));
    }

    let walk = WalkBuilder::new(root)
        .max_depth(Some(1)) // immediate children only — keep listing lazy
        .hidden(false) // show dotfiles (.env, .github, .gitignore) ...
        .filter_entry(|e| e.file_name() != OsStr::new(".git")) // ... except .git
        .build();

    let mut entries: Vec<DirEntry> = Vec::new();
    for result in walk {
        let dent = match result {
            Ok(d) => d,
            // Skip entries we can't stat (broken symlink, permissions) rather
            // than failing the whole listing.
            Err(_) => continue,
        };
        // Depth 0 is `root` itself; we only want its children.
        if dent.depth() == 0 {
            continue;
        }
        // Resolve type without following symlinks into errors we can't recover.
        let is_dir = dent.file_type().map(|ft| ft.is_dir()).unwrap_or(false);
        let name = dent.file_name().to_string_lossy().into_owned();
        let entry_path = dent.path().to_path_buf();
        let project_types = if is_dir {
            detect_project_types(&entry_path)
        } else {
            Vec::new()
        };
        entries.push(DirEntry {
            name,
            path: entry_path.to_string_lossy().into_owned(),
            is_dir,
            project_types,
        });
    }

    entries.sort_by(|a, b| match b.is_dir.cmp(&a.is_dir) {
        std::cmp::Ordering::Equal => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        other => other,
    });

    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static COUNTER: AtomicUsize = AtomicUsize::new(0);

    fn temp_dir(tag: &str) -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let mut p = std::env::temp_dir();
        p.push(format!("mt_fs_{tag}_{nanos}_{n}"));
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn lists_subdir_types_and_files() {
        let root = temp_dir("listing");
        // A subdirectory that is a Rust project.
        let sub = root.join("rust-proj");
        fs::create_dir_all(&sub).unwrap();
        fs::write(sub.join("Cargo.toml"), b"").unwrap();
        // A plain file at the root.
        fs::write(root.join("README.md"), b"hello").unwrap();

        let entries = list_dir(&root).unwrap();
        assert_eq!(entries.len(), 2);

        // Directories sort before files.
        let dir_entry = &entries[0];
        assert_eq!(dir_entry.name, "rust-proj");
        assert!(dir_entry.is_dir);
        assert_eq!(dir_entry.project_types, vec![ProjectType::Rust]);

        let file_entry = &entries[1];
        assert_eq!(file_entry.name, "README.md");
        assert!(!file_entry.is_dir);
        assert!(file_entry.project_types.is_empty());
    }

    #[test]
    fn hides_gitignored_and_dotgit_keeps_other_dotfiles() {
        let root = temp_dir("ignore");
        // Make it look like a git repo so .gitignore is honored (the `ignore`
        // crate only applies gitignore rules inside a repository).
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::write(root.join(".gitignore"), b"node_modules/\ntarget/\n").unwrap();
        fs::create_dir_all(root.join("node_modules")).unwrap();
        fs::create_dir_all(root.join("target")).unwrap();
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join(".env"), b"SECRET=1").unwrap();

        let names: Vec<String> = list_dir(&root)
            .unwrap()
            .into_iter()
            .map(|e| e.name)
            .collect();

        assert!(names.contains(&"src".to_string()));
        assert!(
            names.contains(&".env".to_string()),
            "non-git dotfiles stay visible"
        );
        assert!(names.contains(&".gitignore".to_string()));
        assert!(
            !names.contains(&"node_modules".to_string()),
            "gitignored dir hidden"
        );
        assert!(
            !names.contains(&"target".to_string()),
            "gitignored dir hidden"
        );
        assert!(!names.contains(&".git".to_string()), ".git always hidden");
    }

    #[test]
    fn nonexistent_path_is_err_not_panic() {
        let p = PathBuf::from("/this/path/should/not/exist/multi-terminal-xyz");
        assert!(list_dir(&p).is_err());
    }
}

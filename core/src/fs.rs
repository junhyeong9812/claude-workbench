//! Headless directory listing with per-directory project-type detection.
//!
//! This lives in `core` (not `src-tauri`) so directory enumeration and the
//! submodule-badge logic can be unit-tested without any GUI/Tauri linkage.

use ignore::WalkBuilder;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
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
    /// `true` when the entry is ignored by `.gitignore`/`.ignore`. The entry is
    /// still listed (so the tree can dim it rather than hide it); only `.git`
    /// stays fully hidden. Always `false` outside a git repo.
    #[serde(default)]
    pub is_ignored: bool,
}

/// List the immediate children of `path`.
///
/// Returns `Err` (never panics) if the path is missing, not a directory, or
/// unreadable. Directories are listed before files; each group is sorted by
/// name (case-insensitive). For each directory entry, `project_types` is filled
/// by probing its marker files.
///
/// Every child is listed, but entries ignored by `.gitignore`/`.ignore` (at this
/// directory *or* any parent up to the repo root) are flagged `is_ignored: true`
/// so the tree can dim them (à la VS Code) rather than hide them — `node_modules`,
/// `target`, etc. stay visible but muted. The one entry that is always hidden is
/// the `.git` directory. Dotfiles otherwise stay visible (they're often useful in
/// a file tree). gitignore rules only apply inside a git repository (the `ignore`
/// default); in a plain folder every entry comes back `is_ignored: false`.
///
/// This is a two-pass listing: the `ignore` crate walks one level deep (lazy: only
/// the directory the user expanded, gitignore stack tracked for us) to learn which
/// names are *not* ignored, then a plain `read_dir` enumerates everything and marks
/// the rest ignored.
pub fn list_dir<P: AsRef<Path>>(path: P) -> io::Result<Vec<DirEntry>> {
    let root = path.as_ref();
    // Preserve the old contract: surface an io::Error (not a panic) for a
    // missing path or a path that isn't a directory.
    let meta = std::fs::metadata(root)?;
    if !meta.is_dir() {
        return Err(io::Error::new(io::ErrorKind::Other, "not a directory"));
    }

    // Pass 1: the gitignore-aware walk yields exactly the *non-ignored* children.
    // Collect their names so the full listing below can tell ignored from not.
    let walk = WalkBuilder::new(root)
        .max_depth(Some(1)) // immediate children only — keep listing lazy
        .hidden(false) // show dotfiles (.env, .github, .gitignore) ...
        .filter_entry(|e| e.file_name() != OsStr::new(".git")) // ... except .git
        .build();
    let mut not_ignored: HashSet<String> = HashSet::new();
    for result in walk {
        let dent = match result {
            Ok(d) => d,
            // Skip entries we can't stat (broken symlink, permissions).
            Err(_) => continue,
        };
        // Depth 0 is `root` itself; we only want its children.
        if dent.depth() == 0 {
            continue;
        }
        not_ignored.insert(dent.file_name().to_string_lossy().into_owned());
    }

    // Pass 2: enumerate every child, marking those absent from `not_ignored`.
    let mut entries: Vec<DirEntry> = Vec::new();
    for result in std::fs::read_dir(root)? {
        // Skip entries we can't read rather than failing the whole listing.
        let dent = match result {
            Ok(d) => d,
            Err(_) => continue,
        };
        let name = dent.file_name().to_string_lossy().into_owned();
        // `.git` is always hidden (it's excluded from pass 1 too).
        if name == ".git" {
            continue;
        }
        // Resolve type without following symlinks (matches the old walk's
        // `file_type`: a symlink is neither a dir nor probed for project types).
        let is_dir = dent.file_type().map(|ft| ft.is_dir()).unwrap_or(false);
        let entry_path = dent.path();
        let project_types = if is_dir {
            detect_project_types(&entry_path)
        } else {
            Vec::new()
        };
        let is_ignored = !not_ignored.contains(&name);
        entries.push(DirEntry {
            name,
            path: entry_path.to_string_lossy().into_owned(),
            is_dir,
            project_types,
            is_ignored,
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
    fn marks_gitignored_hides_dotgit_keeps_other_dotfiles() {
        let root = temp_dir("ignore");
        // Make it look like a git repo so .gitignore is honored (the `ignore`
        // crate only applies gitignore rules inside a repository).
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::write(root.join(".gitignore"), b"node_modules/\ntarget/\n").unwrap();
        fs::create_dir_all(root.join("node_modules")).unwrap();
        fs::create_dir_all(root.join("target")).unwrap();
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join(".env"), b"SECRET=1").unwrap();

        let entries = list_dir(&root).unwrap();
        let by_name = |n: &str| entries.iter().find(|e| e.name == n);

        // Ignored dirs are now listed, but flagged so the tree can dim them.
        assert!(
            by_name("node_modules").is_some_and(|e| e.is_ignored),
            "gitignored dir listed with is_ignored=true"
        );
        assert!(
            by_name("target").is_some_and(|e| e.is_ignored),
            "gitignored dir listed with is_ignored=true"
        );
        // Tracked entries (incl. non-ignored dotfiles) are listed, not ignored.
        assert!(by_name("src").is_some_and(|e| !e.is_ignored));
        assert!(
            by_name(".env").is_some_and(|e| !e.is_ignored),
            "non-ignored dotfiles stay visible"
        );
        assert!(by_name(".gitignore").is_some_and(|e| !e.is_ignored));
        // .git is still always hidden.
        assert!(by_name(".git").is_none(), ".git always hidden");
    }

    #[test]
    fn plain_folder_marks_nothing_ignored() {
        // Outside a git repo, gitignore rules don't apply: every entry lists
        // with is_ignored=false (even names that look ignorable elsewhere).
        let root = temp_dir("plain");
        fs::create_dir_all(root.join("node_modules")).unwrap();
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("README.md"), b"hi").unwrap();

        let entries = list_dir(&root).unwrap();
        assert_eq!(entries.len(), 3);
        assert!(
            entries.iter().all(|e| !e.is_ignored),
            "no git repo → nothing ignored"
        );
    }

    #[test]
    fn nonexistent_path_is_err_not_panic() {
        let p = PathBuf::from("/this/path/should/not/exist/claude-workbench-xyz");
        assert!(list_dir(&p).is_err());
    }
}

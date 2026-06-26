//! File-name search: match a query against every (gitignore-respecting) **file**
//! under the root (directories and symlinks are skipped — this is a file finder).
//! A query containing glob metacharacters (`*`, `?`, `[`) is treated as a glob
//! (e.g. `*.rs`, `src/**/mod.rs`); otherwise it's a case-insensitive substring
//! match against the path relative to the root.

use std::ffi::OsStr;
use std::path::Path;

use globset::GlobBuilder;
use ignore::WalkBuilder;

use super::FileHit;

/// Returns up to `limit` files under `root` whose relative path matches `query`.
/// An empty query — or a malformed glob — yields no hits.
pub fn search_files(root: impl AsRef<Path>, query: &str, limit: usize) -> Vec<FileHit> {
    let root = root.as_ref();
    let query = query.trim();
    let mut hits = Vec::new();
    if query.is_empty() || limit == 0 {
        return hits;
    }

    // Glob vs substring. A glob compiled with `literal_separator(false)` lets
    // `*.rs` match nested files like `src/a/b.rs`, which is what users expect.
    let glob = if query.contains(['*', '?', '[']) {
        match GlobBuilder::new(query)
            .case_insensitive(true)
            .literal_separator(false)
            .build()
        {
            Ok(g) => Some(g.compile_matcher()),
            Err(_) => return hits, // malformed glob → no results (not a panic)
        }
    } else {
        None
    };
    let needle = query.to_lowercase();

    let walk = WalkBuilder::new(root)
        .hidden(false)
        .filter_entry(|e| e.file_name() != OsStr::new(".git"))
        .build();

    for result in walk {
        if hits.len() >= limit {
            break;
        }
        let dent = match result {
            Ok(d) => d,
            Err(_) => continue,
        };
        if dent.depth() == 0 {
            continue; // the root itself
        }
        // Files only — a directory (or a symlink, which we don't follow) has no
        // peek view, so returning it would be an unopenable result row.
        if !dent.file_type().map(|ft| ft.is_file()).unwrap_or(false) {
            continue;
        }
        let path = dent.path();
        let rel = path
            .strip_prefix(root)
            .unwrap_or(path)
            .to_string_lossy()
            .into_owned();

        let matched = match &glob {
            Some(m) => m.is_match(&rel),
            None => rel.to_lowercase().contains(&needle),
        };
        if !matched {
            continue;
        }

        hits.push(FileHit {
            path: path.to_string_lossy().into_owned(),
            rel,
        });
    }

    hits
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static COUNTER: AtomicUsize = AtomicUsize::new(0);

    fn repo() -> std::path::PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let mut p = std::env::temp_dir();
        p.push(format!("mt_searchfiles_{nanos}_{n}"));
        fs::create_dir_all(p.join(".git")).unwrap();
        fs::write(p.join(".gitignore"), b"ignored/\n").unwrap();
        fs::create_dir_all(p.join("src")).unwrap();
        fs::write(p.join("src/main.rs"), b"fn main() {}").unwrap();
        fs::write(p.join("src/lib.rs"), b"// lib").unwrap();
        fs::write(p.join("README.md"), b"# readme").unwrap();
        fs::create_dir_all(p.join("ignored")).unwrap();
        fs::write(p.join("ignored/secret.rs"), b"// hidden").unwrap();
        p
    }

    #[test]
    fn substring_matches_and_respects_gitignore() {
        let root = repo();
        let names: Vec<String> = search_files(&root, "main", 50)
            .into_iter()
            .map(|h| h.rel)
            .collect();
        assert!(names.iter().any(|r| r.ends_with("main.rs")));
        // The gitignored file must not appear even though it matches ".rs".
        let rs: Vec<String> = search_files(&root, "secret", 50)
            .into_iter()
            .map(|h| h.rel)
            .collect();
        assert!(rs.is_empty(), "gitignored file leaked into results: {rs:?}");
    }

    #[test]
    fn glob_query_matches_extension() {
        let root = repo();
        let rs: Vec<String> = search_files(&root, "*.rs", 50)
            .into_iter()
            .map(|h| h.rel)
            .collect();
        assert!(rs.iter().any(|r| r.ends_with("main.rs")));
        assert!(rs.iter().any(|r| r.ends_with("lib.rs")));
        assert!(!rs.iter().any(|r| r.ends_with("README.md")));
    }

    #[test]
    fn limit_caps_results() {
        let root = repo();
        assert!(search_files(&root, "", 50).is_empty());
        assert_eq!(search_files(&root, "rs", 1).len(), 1);
    }

    #[test]
    fn directories_are_excluded() {
        let root = repo();
        // "src" matches the src/ directory name and the src/*.rs paths, but only
        // the files come back — never the bare directory.
        let rels: Vec<String> = search_files(&root, "src", 50)
            .into_iter()
            .map(|h| h.rel)
            .collect();
        assert!(!rels.iter().any(|r| r == "src"), "directory leaked: {rels:?}");
        assert!(rels.iter().any(|r| r.ends_with("main.rs")));
    }
}

//! Project-wide search: a file-name finder and a file-content (grep) search.
//!
//! Both walk the project tree with the `ignore` crate, so `.gitignore`/`.ignore`
//! rules are honored and `node_modules`/`target`/`.git` never show up in results
//! — the same noise filtering as [`crate::fs::list_dir`], but recursive (this is
//! a whole-tree search, not the lazy one-level tree view). Results are capped by
//! a caller-supplied `limit` so a huge repository can't hang the UI.

mod content;
mod files;

pub use content::search_content;
pub use files::search_files;

use serde::{Deserialize, Serialize};

/// A file whose path matched a file-name query. Directories are not returned —
/// this is a file finder, and an unopenable folder row would be dead UI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileHit {
    /// Absolute path, used to open the file.
    pub path: String,
    /// Path relative to the search root, for display.
    pub rel: String,
}

/// One matching line found by a content (grep) search.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ContentHit {
    /// Absolute path, used to open the file.
    pub path: String,
    /// Path relative to the search root, for display.
    pub rel: String,
    /// 1-based line number of the match.
    pub line: u64,
    /// The matching line, trimmed and length-capped for display.
    pub text: String,
}

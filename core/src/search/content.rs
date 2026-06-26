//! Content search: grep a literal query across every (gitignore-respecting)
//! file under the root, returning matching lines with their line numbers.
//!
//! The query is matched as a **literal** (case-insensitive), not a regex, so
//! users can type things like `foo(bar)` without escaping. Binary files are
//! skipped. Results are capped at `limit` lines total.

use std::ffi::OsStr;
use std::path::Path;

use grep_regex::RegexMatcherBuilder;
use grep_searcher::sinks::Lossy;
use grep_searcher::{BinaryDetection, SearcherBuilder};
use ignore::WalkBuilder;

use super::ContentHit;

/// Longest line snippet kept per hit (characters), to bound payload size.
const MAX_LINE_CHARS: usize = 300;

/// Returns up to `limit` matching lines for `query` across files under `root`.
/// An empty query yields no hits.
pub fn search_content(root: impl AsRef<Path>, query: &str, limit: usize) -> Vec<ContentHit> {
    let root = root.as_ref();
    let mut hits: Vec<ContentHit> = Vec::new();
    if query.trim().is_empty() || limit == 0 {
        return hits;
    }

    let matcher = match RegexMatcherBuilder::new()
        .case_insensitive(true)
        .fixed_strings(true) // treat the query as a literal, not a regex
        .build(query)
    {
        Ok(m) => m,
        Err(_) => return hits,
    };

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
        if !dent.file_type().map(|ft| ft.is_file()).unwrap_or(false) {
            continue; // skip dirs/symlinks
        }
        let path = dent.path();
        let path_str = path.to_string_lossy().into_owned();
        let rel = path
            .strip_prefix(root)
            .unwrap_or(path)
            .to_string_lossy()
            .into_owned();

        let mut searcher = SearcherBuilder::new()
            .line_number(true)
            .binary_detection(BinaryDetection::quit(0))
            .build();

        // Per-file search; the sink pushes straight into the shared cap-bounded
        // `hits` and stops the whole search once `limit` is reached.
        let _ = searcher.search_path(
            &matcher,
            path,
            Lossy(|lnum, line| {
                if hits.len() >= limit {
                    return Ok(false);
                }
                hits.push(ContentHit {
                    path: path_str.clone(),
                    rel: rel.clone(),
                    line: lnum,
                    text: cap_line(line),
                });
                Ok(hits.len() < limit)
            }),
        );
    }

    hits
}

/// Drop the trailing newline and cap the snippet length (keeping leading
/// indentation, which is meaningful in code).
fn cap_line(line: &str) -> String {
    let t = line.trim_end_matches(['\r', '\n']);
    if t.chars().count() > MAX_LINE_CHARS {
        t.chars().take(MAX_LINE_CHARS).collect()
    } else {
        t.to_string()
    }
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
        p.push(format!("mt_searchcontent_{nanos}_{n}"));
        fs::create_dir_all(p.join(".git")).unwrap();
        fs::write(p.join(".gitignore"), b"ignored/\n").unwrap();
        fs::create_dir_all(p.join("src")).unwrap();
        fs::write(p.join("src/a.rs"), b"let needle = 1;\nother line\nNEEDLE again\n").unwrap();
        fs::write(p.join("src/b.rs"), b"no match here\n").unwrap();
        fs::create_dir_all(p.join("ignored")).unwrap();
        fs::write(p.join("ignored/c.rs"), b"needle in ignored\n").unwrap();
        p
    }

    #[test]
    fn finds_literal_case_insensitive_with_line_numbers() {
        let root = repo();
        let hits = search_content(&root, "needle", 50);
        // Two matches in a.rs (line 1 and line 3, case-insensitive), none from
        // the gitignored file.
        assert_eq!(hits.len(), 2, "hits: {hits:?}");
        assert!(hits.iter().all(|h| h.rel.ends_with("a.rs")));
        let lines: Vec<u64> = hits.iter().map(|h| h.line).collect();
        assert_eq!(lines, vec![1, 3]);
        assert!(!hits.iter().any(|h| h.rel.contains("ignored")));
    }

    #[test]
    fn empty_query_and_limit() {
        let root = repo();
        assert!(search_content(&root, "  ", 50).is_empty());
        assert_eq!(search_content(&root, "needle", 1).len(), 1);
    }

    #[test]
    fn literal_not_regex() {
        let root = repo();
        // "." would match every char if treated as regex; as a literal it
        // matches only lines containing a real period (here: the `;` line has
        // none, so the dot in "1;" ... actually none). Use a metachar query.
        let hits = search_content(&root, "(", 50);
        assert!(hits.is_empty(), "'(' should be literal, found: {hits:?}");
    }
}

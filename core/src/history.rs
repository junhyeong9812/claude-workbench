//! A stable, filesystem-safe project key (`<sanitized-basename>-<hash>`), used to
//! name the per-project storage directory under the app data dir.
//!
//! (The ACP-era append-only timeline JSONL store that lived here was removed with
//! the ACP path; architecture A persists session timelines via `snapshot.rs`.
//! Only the project-key helper remains, shared by the snapshot layer.)

use std::path::Path;

/// A stable, filesystem-safe key for a project path: its sanitized final
/// component plus a hash of the full path (so different projects that share a
/// basename never collide).
pub fn project_key(project_path: &str) -> String {
    let base = Path::new(project_path)
        .file_name()
        .map(|s| sanitize(&s.to_string_lossy()))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "root".to_string());
    format!("{base}-{:016x}", fnv1a(project_path.as_bytes()))
}

/// Replace characters unsafe in a path component with `_`.
fn sanitize(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '.' { c } else { '_' })
        .collect()
}

/// FNV-1a 64-bit — a small deterministic hash (std's `DefaultHasher` is seeded
/// randomly, so it can't be used for a stable on-disk key).
fn fnv1a(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf29ce484222325;
    for &b in bytes {
        hash ^= b as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_key_is_stable_and_distinguishes_paths() {
        assert_eq!(project_key("/a/b/proj"), project_key("/a/b/proj"));
        assert_ne!(project_key("/a/proj"), project_key("/b/proj"));
        assert!(project_key("/home/x/acp-test").starts_with("acp-test-"));
    }
}

//! Optional on-disk persistence of terminal scrollback.
//!
//! **Opt-in only** (review F11): terminal output can contain secrets (tokens,
//! pasted passwords), so the frontend persists scrollback only when the user
//! turns it on. This module is a thin, pure byte store — the policy (when to
//! persist) lives above it.

use std::io;
use std::path::{Path, PathBuf};

/// Cap on persisted bytes — mirrors the in-memory scrollback cap so a restored
/// session can't exceed what a live one holds.
const STORE_CAP: usize = crate::session::DEFAULT_SCROLLBACK_CAP;

/// Reduce a caller-supplied key to a safe single file-name segment (defense in
/// depth against `..`/separator traversal — the key is a frontend panel id).
fn safe_name(key: &str) -> String {
    key.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect()
}

fn file_path(dir: &Path, key: &str) -> PathBuf {
    dir.join(format!("{}.scrollback", safe_name(key)))
}

/// Persist `bytes` (tail-capped) for `key`, atomically (temp + rename) so a crash
/// can't leave a truncated file.
pub fn save(dir: &Path, key: &str, bytes: &[u8]) -> io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let data = if bytes.len() > STORE_CAP {
        &bytes[bytes.len() - STORE_CAP..]
    } else {
        bytes
    };
    let path = file_path(dir, key);
    let tmp = dir.join(format!(".{}.tmp", safe_name(key)));
    std::fs::write(&tmp, data)?;
    std::fs::rename(&tmp, &path).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })
}

/// Load persisted scrollback for `key`, or `None` if absent/unreadable. Reads at
/// most `STORE_CAP` bytes from the **tail**, so a corrupt or externally-grown
/// file can't blow up memory/IO before the cap is applied (review P4-R2).
pub fn load(dir: &Path, key: &str) -> Option<Vec<u8>> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(file_path(dir, key)).ok()?;
    let len = f.metadata().ok()?.len();
    if len > STORE_CAP as u64 {
        f.seek(SeekFrom::End(-(STORE_CAP as i64))).ok()?;
    }
    let mut buf = Vec::new();
    f.take(STORE_CAP as u64).read_to_end(&mut buf).ok()?;
    Some(buf)
}

/// Delete a key's persisted scrollback. A missing file is success.
pub fn delete(dir: &Path, key: &str) -> io::Result<()> {
    match std::fs::remove_file(file_path(dir, key)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static N: AtomicU64 = AtomicU64::new(0);
    fn temp_dir(tag: &str) -> PathBuf {
        let n = N.fetch_add(1, Ordering::Relaxed);
        let d = std::env::temp_dir().join(format!("mt_sb_{tag}_{}_{n}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn round_trip() {
        let d = temp_dir("rt");
        save(&d, "panel-1", b"hello world").unwrap();
        assert_eq!(load(&d, "panel-1").as_deref(), Some(&b"hello world"[..]));
    }

    #[test]
    fn missing_is_none() {
        let d = temp_dir("missing");
        assert!(load(&d, "nope").is_none());
    }

    #[test]
    fn delete_then_none() {
        let d = temp_dir("del");
        save(&d, "k", b"x").unwrap();
        delete(&d, "k").unwrap();
        assert!(load(&d, "k").is_none());
        // deleting a missing key is fine
        delete(&d, "k").unwrap();
    }

    #[test]
    fn cap_keeps_tail() {
        let d = temp_dir("cap");
        let big = vec![b'a'; STORE_CAP + 100];
        let mut data = big.clone();
        data.extend_from_slice(b"TAILMARK");
        save(&d, "k", &data).unwrap();
        let loaded = load(&d, "k").unwrap();
        assert!(loaded.len() <= STORE_CAP);
        assert!(loaded.ends_with(b"TAILMARK"));
    }

    #[test]
    fn key_traversal_is_neutralized() {
        let d = temp_dir("trav");
        // A malicious key must not escape the dir; it just becomes a safe name.
        save(&d, "../../etc/passwd", b"x").unwrap();
        assert_eq!(load(&d, "../../etc/passwd").as_deref(), Some(&b"x"[..]));
        // The escape target was never created.
        assert!(!Path::new("/etc/passwd_attempt").exists());
    }
}

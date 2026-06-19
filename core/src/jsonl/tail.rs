//! Incremental tail of an append-only session JSONL file (P2b-4 Phase B-1).
//!
//! The live timeline is built by following the JSONL transcript the `claude`
//! CLI appends to as a session runs. This module is the **synchronous,
//! offline-testable** read half: [`JsonlTail`] tracks a byte offset and a
//! pending-bytes buffer so each poll returns only the **complete lines** that
//! became available since the last poll, holding back a partial trailing line
//! (a record still mid-write) until its newline arrives. [`SessionTail`] couples
//! a tail to a [`JsonlMapper`], so one `poll()` reads new bytes, applies each
//! complete record, and reports the touched timeline items.
//!
//! No async: the polling cadence (a thread / interval) lives in the Tauri layer
//! (B-2), keeping `core` runtime-free (design D1). Robustness to flush timing is
//! by construction — bytes written in bursts are picked up on the next poll, and
//! a record split across two writes is buffered until complete (so the open
//! question of interactive-mode flush granularity affects latency, not
//! correctness; phase-b-spec §2).

use std::collections::BTreeMap;
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use crate::jsonl::map::JsonlMapper;
use crate::timeline::Timeline;

/// Tracks how far we've consumed an append-only file and buffers a partial
/// trailing line. Pure byte bookkeeping — the only IO is in [`JsonlTail::poll_path`].
#[derive(Debug, Default)]
pub struct JsonlTail {
    /// Bytes consumed from the file so far (the next read seeks here).
    offset: u64,
    /// Bytes read past the last newline — an incomplete line held until the
    /// rest arrives. Kept as raw bytes so a multi-byte UTF-8 char split across
    /// two writes is never decoded mid-character.
    buf: Vec<u8>,
}

impl JsonlTail {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed freshly read bytes; return the complete lines (newline-terminated)
    /// that are now available, in order. A trailing partial line stays buffered.
    pub fn push_bytes(&mut self, new: &[u8]) -> Vec<String> {
        self.buf.extend_from_slice(new);
        let mut lines = Vec::new();
        let mut start = 0;
        for i in 0..self.buf.len() {
            if self.buf[i] == b'\n' {
                // Decode only complete lines, so a UTF-8 boundary that fell
                // inside `buf` (mid-write) is never split.
                lines.push(String::from_utf8_lossy(&self.buf[start..i]).into_owned());
                start = i + 1;
            }
        }
        self.buf.drain(..start);
        lines
    }

    /// Read whatever has been appended to `path` since the last poll and return
    /// the newly-complete lines. If the file is shorter than our offset (it was
    /// truncated or replaced — e.g. the session id was reused), the offset and
    /// partial buffer are reset and the file is re-read from the start.
    pub fn poll_path(&mut self, path: &Path) -> io::Result<Vec<String>> {
        let mut file = File::open(path)?;
        let len = file.metadata()?.len();
        if len < self.offset {
            // Truncated / replaced: start over (append-only assumption broken).
            self.offset = 0;
            self.buf.clear();
        }
        if len == self.offset {
            return Ok(Vec::new());
        }
        file.seek(SeekFrom::Start(self.offset))?;
        let mut chunk = Vec::new();
        let read = file.take(len - self.offset).read_to_end(&mut chunk)?;
        self.offset += read as u64;
        Ok(self.push_bytes(&chunk))
    }
}

/// A [`JsonlTail`] bound to a session file and a [`JsonlMapper`]: one [`poll`]
/// reads new records and folds them into the timeline. This is the entry point
/// the Tauri layer drives on a thread/interval (B-2).
///
/// [`poll`]: SessionTail::poll
pub struct SessionTail {
    path: PathBuf,
    tail: JsonlTail,
    mapper: JsonlMapper,
}

impl SessionTail {
    /// `root` is the session's working directory (for project labels);
    /// `session_id` is the file's UUID (fallback when a record omits it);
    /// `path` is the JSONL file to follow.
    pub fn new(
        root: impl Into<PathBuf>,
        session_id: impl Into<String>,
        path: impl Into<PathBuf>,
    ) -> Self {
        Self {
            path: path.into(),
            tail: JsonlTail::new(),
            mapper: JsonlMapper::new(root, session_id),
        }
    }

    /// Read newly-appended records and apply them. Returns the indices of
    /// timeline items touched this poll (empty when nothing new / no timeline
    /// records). A missing file yields an empty result rather than an error,
    /// since the CLI may not have created it yet.
    pub fn poll(&mut self) -> io::Result<Vec<usize>> {
        let lines = match self.tail.poll_path(&self.path) {
            Ok(lines) => lines,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(e),
        };
        let mut touched = Vec::new();
        for line in &lines {
            touched.extend(self.mapper.apply_line(line));
        }
        Ok(touched)
    }

    pub fn timeline(&self) -> &Timeline {
        self.mapper.timeline()
    }

    /// turn → user prompt text (delegated to the mapper).
    pub fn turns(&self) -> &BTreeMap<u64, String> {
        self.mapper.turns()
    }

    /// turn → concatenated assistant answer text.
    pub fn answers(&self) -> &BTreeMap<u64, String> {
        self.mapper.answers()
    }

    /// turn → YYYY-MM-DD.
    pub fn dates(&self) -> &BTreeMap<u64, String> {
        self.mapper.dates()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::timeline::{AgentStatus, ItemKind};
    use std::io::Write;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn temp_path(tag: &str) -> PathBuf {
        static N: AtomicU64 = AtomicU64::new(0);
        std::env::temp_dir().join(format!(
            "mt-jsonl-tail-{}-{}-{tag}.jsonl",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ))
    }

    // push_bytes: complete lines emit; a trailing partial line is held until its
    // newline arrives in a later push.
    #[test]
    fn push_bytes_holds_partial_line_until_newline() {
        let mut t = JsonlTail::new();
        assert_eq!(t.push_bytes(b"line one\nline t"), vec!["line one".to_string()]);
        // "line t" is incomplete -> buffered, nothing emitted yet.
        assert_eq!(t.push_bytes(b"wo\nline three\n"), vec![
            "line two".to_string(),
            "line three".to_string()
        ]);
        // No trailing data left buffered.
        assert!(t.push_bytes(b"").is_empty());
    }

    // A multi-byte UTF-8 char split across two writes is decoded intact once the
    // line completes (never mid-character).
    #[test]
    fn push_bytes_handles_utf8_split_across_writes() {
        let mut t = JsonlTail::new();
        let s = "héllo-가나다"; // multi-byte chars
        let bytes = s.as_bytes();
        let mid = 2; // split inside 'é' (0xC3 0xA9)
        assert!(t.push_bytes(&bytes[..mid]).is_empty());
        let mut rest = bytes[mid..].to_vec();
        rest.push(b'\n');
        assert_eq!(t.push_bytes(&rest), vec![s.to_string()]);
    }

    // poll_path reads only newly-appended bytes across polls.
    #[test]
    fn poll_path_reads_incrementally() {
        let path = temp_path("incr");
        {
            let mut f = File::create(&path).unwrap();
            f.write_all(b"{\"a\":1}\n").unwrap();
        }
        let mut t = JsonlTail::new();
        assert_eq!(t.poll_path(&path).unwrap(), vec!["{\"a\":1}".to_string()]);
        // Nothing new yet.
        assert!(t.poll_path(&path).unwrap().is_empty());
        // Append more (including a partial line with no newline).
        {
            let mut f = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
            f.write_all(b"{\"b\":2}\n{\"c\":").unwrap();
        }
        assert_eq!(t.poll_path(&path).unwrap(), vec!["{\"b\":2}".to_string()]);
        // Complete the partial line.
        {
            let mut f = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
            f.write_all(b"3}\n").unwrap();
        }
        assert_eq!(t.poll_path(&path).unwrap(), vec!["{\"c\":3}".to_string()]);
        let _ = std::fs::remove_file(&path);
    }

    // A file shorter than the offset (truncated / replaced) resets and re-reads.
    #[test]
    fn poll_path_resets_on_truncation() {
        let path = temp_path("trunc");
        {
            let mut f = File::create(&path).unwrap();
            f.write_all(b"old line one\nold line two\n").unwrap();
        }
        let mut t = JsonlTail::new();
        assert_eq!(t.poll_path(&path).unwrap().len(), 2);
        // Replace with shorter content (offset now exceeds file len).
        {
            let mut f = File::create(&path).unwrap();
            f.write_all(b"fresh\n").unwrap();
        }
        assert_eq!(t.poll_path(&path).unwrap(), vec!["fresh".to_string()]);
        let _ = std::fs::remove_file(&path);
    }

    // SessionTail: a tool_use then (next poll) its tool_result accumulate into
    // one completed timeline item across incremental writes.
    #[test]
    fn session_tail_accumulates_across_polls() {
        let path = temp_path("session");
        let sid = "sess-1";
        let tool_use = format!(
            "{}\n",
            serde_json::json!({
                "type": "assistant", "sessionId": sid,
                "message": { "role": "assistant", "content": [
                    { "type": "tool_use", "id": "t1", "name": "Read",
                      "input": { "file_path": "/work/x.rs" } }
                ] }
            })
        );
        let tool_result = format!(
            "{}\n",
            serde_json::json!({
                "type": "user", "sessionId": sid,
                "message": { "role": "user", "content": [
                    { "type": "tool_result", "tool_use_id": "t1", "content": "ok" }
                ] }
            })
        );

        {
            let mut f = File::create(&path).unwrap();
            f.write_all(tool_use.as_bytes()).unwrap();
        }
        let mut st = SessionTail::new("/work", sid, &path);
        let touched = st.poll().unwrap();
        assert_eq!(touched, vec![0]);
        assert_eq!(st.timeline().items().len(), 1);
        assert_eq!(st.timeline().items()[0].agent_status, AgentStatus::InProgress);
        assert_eq!(st.timeline().items()[0].kind, ItemKind::Read);

        // Append the result; a second poll completes the same item.
        {
            let mut f = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
            f.write_all(tool_result.as_bytes()).unwrap();
        }
        let touched = st.poll().unwrap();
        assert_eq!(touched, vec![0], "same item index touched");
        assert_eq!(st.timeline().items().len(), 1, "merged, not duplicated");
        assert_eq!(st.timeline().items()[0].agent_status, AgentStatus::Completed);
        let _ = std::fs::remove_file(&path);
    }

    // A not-yet-created session file polls empty, not an error.
    #[test]
    fn session_tail_missing_file_is_empty() {
        let path = temp_path("missing");
        let mut st = SessionTail::new("/work", "sess-x", &path);
        assert!(st.poll().unwrap().is_empty());
    }
}

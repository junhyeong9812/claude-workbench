//! Per-session change-timeline **snapshots** (P2b-4 session UX, D-1 persistence).
//!
//! Architecture A keeps its own copy of each Claude session's timeline (the
//! user's D-1 choice) so sessions survive an app restart and can be listed and
//! reopened — independent of the CLI's own transcript. Unlike the ACP path
//! (append-one-line-per-event), we write a **whole-session snapshot** that is
//! *overwritten* on each change: re-tailing the CLI JSONL replays the full
//! state, and overwriting avoids the duplicate/cumulative records that
//! append-per-event produced on resume (codex B-2b F2/F3).
//!
//! Layout (one JSON file per session, keyed by project + session uuid):
//! ```text
//! <base>/projects/<project_key>/claude/<uuid>.json
//! ```

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};

use crate::history::project_key;
use crate::timeline::{TimelineItem, TokenUsage};

/// Process-unique suffix counter for temp files, so concurrent writers (even for
/// the same uuid) never race on a shared temp path (codex session-UX F2).
static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// Reject a uuid that isn't a plain identifier so a command-supplied value can't
/// traverse out of the project's `claude` dir (`..`, `/`, …) — our generated
/// session ids are `[0-9a-f-]` (codex session-UX F5).
pub fn is_safe_uuid(uuid: &str) -> bool {
    !uuid.is_empty()
        && uuid.len() <= 128
        && uuid
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn unique_tmp(dir: &Path, stem: &str) -> PathBuf {
    dir.join(format!(
        "{stem}.{}-{}.tmp",
        std::process::id(),
        TMP_SEQ.fetch_add(1, Ordering::Relaxed)
    ))
}

/// The full persisted state of one session's timeline.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionSnapshot {
    pub uuid: String,
    /// Display name ("Claude N" or a rename).
    pub name: String,
    /// Day the session was last updated (YYYY-MM-DD).
    pub date: String,
    pub items: Vec<TimelineItem>,
    pub turns: Vec<(u64, String)>,
    pub answers: Vec<(u64, String)>,
    pub dates: Vec<(u64, String)>,
    #[serde(default)]
    pub tokens: Vec<(u64, TokenUsage)>,
    /// Current assistant model id (e.g. `claude-opus-4-8`) for the context-window
    /// gauge. `None` for snapshots written before the model was tracked.
    #[serde(default)]
    pub model: Option<String>,
    /// The most recent assistant message's usage (current context occupancy) — the
    /// gauge numerator. `None` for snapshots written before this was tracked.
    #[serde(default)]
    pub last_usage: Option<TokenUsage>,
    /// The session this task continues from (handoff chain). `None` = chain root.
    /// Sourced from the decoupled `<uuid>.task` sidecar on [`load`] (see
    /// [`read_task_meta`]) so the poll thread's body overwrite never clobbers it —
    /// the same decoupling the rename uses (`.name`, codex session-UX F1).
    #[serde(default)]
    pub prev_uuid: Option<String>,
    /// Filesystem path of the handoff summary this task was seeded with, if any.
    /// Also sidecar-sourced.
    #[serde(default)]
    pub summary_path: Option<String>,
    /// AI-generated one-line title of the task (the `<uuid>.title` sidecar), shown
    /// as the prev-task header instead of the generic display name. Sidecar-sourced
    /// on [`load`]; `None` for tasks summarized before titles existed (falls back to
    /// the display name in the UI).
    #[serde(default)]
    pub title: Option<String>,
    /// The handoff summary text itself (the `<uuid>.summary.md` body), surfaced as
    /// the prev-task header's hover tooltip. Sidecar-sourced on [`load`].
    #[serde(default)]
    pub summary: Option<String>,
}

/// A session summarized for the reopen picker.
#[derive(Debug, Clone, Serialize)]
pub struct SnapshotSummary {
    pub uuid: String,
    pub name: String,
    /// First prompt of the session (its lowest turn), shown as subtext.
    pub title: String,
    pub date: String,
    /// Number of tool-call items recorded.
    pub count: usize,
}

fn dir(base: &Path, project: &str) -> PathBuf {
    base.join("projects").join(project_key(project)).join("claude")
}

/// P1: 목록용 요약 사이드카(`<uuid>.meta.json`) — `list()`가 본문(수 MB)을
/// 전문 파싱하지 않고 O(1) 조회한다. 파생 캐시: 본문과 함께 쓰고, 낡음이면
/// 전문 파싱 폴백 + 자가 치유 재생성. 신선도는 3중 검증(듀얼 리뷰 #7):
/// `v == META_V`(요약 규칙 변경 시 전체 무효화) + `body_len` 일치(동초 mtime
/// tie에서 본문만 바뀐 경우 검출) + meta mtime ≥ body mtime. `v`/`body_len`은
/// serde 필수 필드 — 구 스키마 meta는 파싱 실패로 자동 폴백된다.
const META_V: u32 = 1;

#[derive(Serialize, Deserialize)]
struct SnapshotMeta {
    v: u32,
    /// 이 meta가 요약한 본문 JSON의 바이트 길이(신선도 보조 서명).
    body_len: u64,
    name: String,
    title: String,
    date: String,
    count: usize,
}

fn meta_of(snap: &SessionSnapshot, body_len: u64) -> SnapshotMeta {
    SnapshotMeta {
        v: META_V,
        body_len,
        name: snap.name.clone(),
        title: snap
            .turns
            .iter()
            .min_by_key(|(t, _)| *t)
            .map(|(_, p)| p.clone())
            .unwrap_or_default(),
        date: snap.date.clone(),
        count: snap.items.len(),
    }
}

fn write_meta(dir: &Path, uuid: &str, meta: &SnapshotMeta) -> io::Result<()> {
    let json = serde_json::to_string(meta)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    let tmp = unique_tmp(dir, &format!("{uuid}.meta.json"));
    fs::write(&tmp, json)?;
    fs::rename(&tmp, dir.join(format!("{uuid}.meta.json")))
}

/// Write (overwrite) a session snapshot **body** atomically (unique temp +
/// rename). The display name is kept in a separate `.name` file (see
/// [`save_name`]) so a rename and the poll thread never clobber each other.
/// P1: 본문 **다음에** meta 사이드카를 쓴다(가정①: 순서+mtime 비교로 낡은
/// meta는 list()가 무시).
pub fn save(base: &Path, project: &str, snap: &SessionSnapshot) -> io::Result<()> {
    if !is_safe_uuid(&snap.uuid) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "unsafe session id"));
    }
    let dir = dir(base, project);
    fs::create_dir_all(&dir)?;
    let json = serde_json::to_string(snap)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    let body_len = json.len() as u64;
    let tmp_path = unique_tmp(&dir, &format!("{}.json", snap.uuid));
    fs::write(&tmp_path, json)?;
    fs::rename(&tmp_path, dir.join(format!("{}.json", snap.uuid)))?;
    let _ = write_meta(&dir, &snap.uuid, &meta_of(snap, body_len)); // 파생 캐시 — 실패해도 본문이 정본
    Ok(())
}

/// Override a session's display name without touching its timeline body
/// (rename). Decoupled into its own file so the poll thread (sole writer of the
/// `.json`) and a rename write **different** files and can't clobber each other
/// (codex session-UX F1).
pub fn save_name(base: &Path, project: &str, uuid: &str, name: &str) -> io::Result<()> {
    if !is_safe_uuid(uuid) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "unsafe session id"));
    }
    let dir = dir(base, project);
    fs::create_dir_all(&dir)?;
    let tmp_path = unique_tmp(&dir, &format!("{uuid}.name"));
    fs::write(&tmp_path, name)?;
    fs::rename(&tmp_path, dir.join(format!("{uuid}.name")))
}

/// The renamed display name override, if any (else the snapshot's own name).
pub fn read_name(base: &Path, project: &str, uuid: &str) -> Option<String> {
    if !is_safe_uuid(uuid) {
        return None;
    }
    fs::read_to_string(dir(base, project).join(format!("{uuid}.name")))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Task-identity metadata kept in a decoupled `<uuid>.task` sidecar so the poll
/// thread's whole-body overwrite of the `.json` never clobbers it (the same
/// reason a rename lives in `.name` — codex session-UX F1). Holds the handoff
/// chain link (`prev_uuid`) and the seed summary this task started from.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TaskMeta {
    #[serde(default)]
    pub prev_uuid: Option<String>,
    #[serde(default)]
    pub summary_path: Option<String>,
}

/// Persist a session's task metadata to its `<uuid>.task` sidecar (atomic
/// temp+rename). Decoupled from the body so the poll thread and a handoff write
/// **different** files and can't clobber each other.
pub fn save_task_meta(base: &Path, project: &str, uuid: &str, meta: &TaskMeta) -> io::Result<()> {
    if !is_safe_uuid(uuid) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "unsafe session id"));
    }
    // Reject an unsafe chain link at write time too, so a caller bug surfaces here
    // rather than silently truncating the chain later when `load` skips it.
    if let Some(prev) = &meta.prev_uuid {
        if !is_safe_uuid(prev) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "unsafe prev session id",
            ));
        }
    }
    let dir = dir(base, project);
    fs::create_dir_all(&dir)?;
    let json =
        serde_json::to_string(meta).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    let tmp_path = unique_tmp(&dir, &format!("{uuid}.task"));
    fs::write(&tmp_path, json)?;
    fs::rename(&tmp_path, dir.join(format!("{uuid}.task")))
}

/// Read a session's task metadata sidecar, if present and valid (else `None`).
pub fn read_task_meta(base: &Path, project: &str, uuid: &str) -> Option<TaskMeta> {
    if !is_safe_uuid(uuid) {
        return None;
    }
    let text = fs::read_to_string(dir(base, project).join(format!("{uuid}.task"))).ok()?;
    serde_json::from_str(&text).ok()
}

/// Path of a session's handoff-summary sidecar (`<uuid>.summary.md`). `None` for
/// an unsafe uuid. The file may not exist yet — the backend derives this rather
/// than trusting a caller-supplied path (codex P3 D8).
pub fn summary_path(base: &Path, project: &str, uuid: &str) -> Option<PathBuf> {
    if !is_safe_uuid(uuid) {
        return None;
    }
    Some(dir(base, project).join(format!("{uuid}.summary.md")))
}

/// Write (overwrite) a session's handoff summary to its `<uuid>.summary.md`
/// sidecar atomically (temp+rename, so a crash never leaves a partial summary).
/// Returns the final path.
pub fn save_summary(base: &Path, project: &str, uuid: &str, text: &str) -> io::Result<PathBuf> {
    if !is_safe_uuid(uuid) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "unsafe session id"));
    }
    let dir = dir(base, project);
    fs::create_dir_all(&dir)?;
    let tmp_path = unique_tmp(&dir, &format!("{uuid}.summary.md"));
    fs::write(&tmp_path, text)?;
    let final_path = dir.join(format!("{uuid}.summary.md"));
    fs::rename(&tmp_path, &final_path)?;
    Ok(final_path)
}

/// Write (overwrite) a task's one-line title to its `<uuid>.title` sidecar
/// atomically (temp+rename). Decoupled from the body like `.name`/`.task`, so the
/// poll thread's `.json` overwrite can't clobber it. A blank title removes the
/// sidecar (so the UI falls back to the display name) rather than persisting "".
pub fn save_title(base: &Path, project: &str, uuid: &str, title: &str) -> io::Result<()> {
    if !is_safe_uuid(uuid) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "unsafe session id"));
    }
    let dir = dir(base, project);
    fs::create_dir_all(&dir)?;
    let final_path = dir.join(format!("{uuid}.title"));
    let trimmed = title.trim();
    if trimmed.is_empty() {
        // Best-effort cleanup; absence is the "no title" state.
        let _ = fs::remove_file(&final_path);
        return Ok(());
    }
    let tmp_path = unique_tmp(&dir, &format!("{uuid}.title"));
    fs::write(&tmp_path, trimmed)?;
    fs::rename(&tmp_path, final_path)
}

/// The task's one-line title override (`<uuid>.title`), if present and non-empty.
pub fn read_title(base: &Path, project: &str, uuid: &str) -> Option<String> {
    if !is_safe_uuid(uuid) {
        return None;
    }
    fs::read_to_string(dir(base, project).join(format!("{uuid}.title")))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// The task's handoff-summary text (`<uuid>.summary.md`), if present and non-empty
/// — surfaced as the prev-task header hover tooltip.
pub fn read_summary(base: &Path, project: &str, uuid: &str) -> Option<String> {
    if !is_safe_uuid(uuid) {
        return None;
    }
    fs::read_to_string(dir(base, project).join(format!("{uuid}.summary.md")))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// List the saved sessions for a project, newest first (by date, then name).
pub fn list(base: &Path, project: &str) -> Vec<SnapshotSummary> {
    let mut out = Vec::new();
    let entries = match fs::read_dir(dir(base, project)) {
        Ok(e) => e,
        Err(_) => return out, // no sessions yet
    };
    // 자가 치유 재작성은 순회 중 같은 디렉토리에 쓰지 않도록 모아서 순회 후에
    // 일괄 수행한다(read_dir 도중 디렉토리 변형은 POSIX 미정의 — 듀얼 리뷰 #10).
    let mut heals: Vec<(String, SnapshotMeta)> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue; // skip *.json.tmp and strays
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if stem.ends_with(".meta") {
            continue; // 사이드카 자신은 세션 본문이 아니다
        }
        // P1: 신선한 meta 사이드카가 있으면 전문 파싱을 건너뛴다 — 피커
        // 오픈마다 수십 MB 역직렬화하던 병목 제거. 신선도 = 스키마 v 일치 +
        // body_len 일치 + mtime 비교(3중 — 듀얼 리뷰 #7). 낡거나 손상이면
        // 폴백(전문 파싱)이 정확성을 보장하고 meta를 재생성한다(자가 치유).
        let meta_path = path.with_file_name(format!("{stem}.meta.json"));
        let body_md = entry.metadata().ok();
        let body_mtime = body_md.as_ref().and_then(|m| m.modified().ok());
        let body_len = body_md.as_ref().map(|m| m.len());
        let mtime_fresh = matches!(
            (fs::metadata(&meta_path).and_then(|m| m.modified()).ok(), body_mtime),
            (Some(mm), Some(bm)) if mm >= bm
        );
        if mtime_fresh {
            if let Ok(mtext) = fs::read_to_string(&meta_path) {
                if let Ok(meta) = serde_json::from_str::<SnapshotMeta>(&mtext) {
                    if meta.v == META_V && Some(meta.body_len) == body_len {
                        let name = read_name(base, project, stem).unwrap_or(meta.name);
                        out.push(SnapshotSummary {
                            uuid: stem.to_string(),
                            name,
                            title: meta.title,
                            date: meta.date,
                            count: meta.count,
                        });
                        continue;
                    }
                }
            }
        }
        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(snap) = serde_json::from_str::<SessionSnapshot>(&text) else {
            continue;
        };
        heals.push((stem.to_string(), meta_of(&snap, text.len() as u64)));
        let title = snap
            .turns
            .iter()
            .min_by_key(|(t, _)| *t)
            .map(|(_, p)| p.clone())
            .unwrap_or_default();
        // 파일명(stem)이 uuid 정본 — meta 경로와 동일 규칙(듀얼 리뷰 #8: 본문이
        // 다른 uuid를 주장해도 로드 키는 파일명이므로 stem으로 통일).
        let name = read_name(base, project, stem).unwrap_or(snap.name);
        out.push(SnapshotSummary {
            uuid: stem.to_string(),
            name,
            title,
            date: snap.date,
            count: snap.items.len(),
        });
    }
    let d = dir(base, project);
    for (stem, meta) in heals {
        let _ = write_meta(&d, &stem, &meta); // 자가 치유 — 실패해도 폴백이 정확
    }
    out.sort_by(|a, b| b.date.cmp(&a.date).then(a.name.cmp(&b.name)));
    out
}

/// The uuids of every session this app knows about in `project` — i.e. every
/// snapshot **body** on disk.
///
/// This is the authoritative "we own this session" set, and the subtrahend of
/// the external-session difference (`crate::external`): a transcript with no
/// body here was opened outside the app. Deliberately cheaper and stricter than
/// [`list`] — it never parses a body, and it takes the file *name* as the uuid
/// (same rule `load` keys on), so a corrupt or unreadable snapshot still counts
/// as known and can't reappear as "external".
pub fn known_uuids(base: &Path, project: &str) -> std::collections::HashSet<String> {
    let mut out = std::collections::HashSet::new();
    let Ok(entries) = fs::read_dir(dir(base, project)) else { return out };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue; // *.json.tmp, .name, .title, …
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else { continue };
        if stem.ends_with(".meta") {
            continue; // the derived sidecar, not a session
        }
        out.insert(stem.to_string());
    }
    out
}

/// Load one session's full snapshot (for reopen), applying the name override.
/// `None` if absent/corrupt/unsafe id.
pub fn load(base: &Path, project: &str, uuid: &str) -> Option<SessionSnapshot> {
    if !is_safe_uuid(uuid) {
        return None;
    }
    let path = dir(base, project).join(format!("{uuid}.json"));
    let text = fs::read_to_string(path).ok()?;
    let mut snap: SessionSnapshot = serde_json::from_str(&text).ok()?;
    // The requested (filename-derived, already validated) uuid is authoritative —
    // a corrupt body claiming a different uuid must not mislead chain rendering.
    snap.uuid = uuid.to_string();
    if let Some(name) = read_name(base, project, uuid) {
        snap.name = name;
    }
    // Task meta is sidecar-authoritative (the body is overwritten by the poll
    // thread with `None`), so override from the `.task` file when present.
    if let Some(meta) = read_task_meta(base, project, uuid) {
        snap.prev_uuid = meta.prev_uuid;
        snap.summary_path = meta.summary_path;
    }
    // Title/summary live in their own sidecars (generated at handoff) — surfaced as
    // the prev-task header label + hover tooltip.
    snap.title = read_title(base, project, uuid);
    snap.summary = read_summary(base, project, uuid);
    Some(snap)
}

/// Delete a session's snapshot body + name override (the `삭제` action). Missing
/// files / unsafe ids are not an error.
pub fn delete(base: &Path, project: &str, uuid: &str) -> io::Result<()> {
    if !is_safe_uuid(uuid) {
        return Ok(());
    }
    let dir = dir(base, project);
    for path in [
        dir.join(format!("{uuid}.json")),
        dir.join(format!("{uuid}.meta.json")), // 파생 사이드카 동반 삭제(고아 방지)
        dir.join(format!("{uuid}.name")),
        dir.join(format!("{uuid}.task")),
        dir.join(format!("{uuid}.summary.md")),
        dir.join(format!("{uuid}.title")),
    ] {
        match fs::remove_file(path) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::timeline::{Timeline, TimelineItem};
    use std::sync::atomic::{AtomicU64, Ordering};

    fn temp_base(tag: &str) -> PathBuf {
        static N: AtomicU64 = AtomicU64::new(0);
        let d = std::env::temp_dir().join(format!(
            "mt-snap-{}-{}-{tag}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn snap(uuid: &str, name: &str, date: &str, item_count: usize) -> SessionSnapshot {
        // Build `item_count` shells via a Timeline so they're real TimelineItems.
        let mut tl = Timeline::new("/work");
        for i in 0..item_count {
            tl.entry("s", &format!("t{i}"));
        }
        let items: Vec<TimelineItem> = tl.items().to_vec();
        SessionSnapshot {
            uuid: uuid.to_string(),
            name: name.to_string(),
            date: date.to_string(),
            items,
            turns: vec![(1, "first prompt".into())],
            answers: vec![(1, "an answer".into())],
            dates: vec![(1, date.to_string())],
            tokens: vec![],
            model: None,
            last_usage: None,
            prev_uuid: None,
            summary_path: None,
            title: None,
            summary: None,
        }
    }

    #[test]
    fn save_then_load_roundtrips() {
        let base = temp_base("rt");
        let s = snap("u1", "Claude 1", "2026-06-19", 3);
        save(&base, "/home/jun/proj", &s).unwrap();
        let got = load(&base, "/home/jun/proj", "u1").unwrap();
        assert_eq!(got.uuid, "u1");
        assert_eq!(got.name, "Claude 1");
        assert_eq!(got.items.len(), 3);
        assert_eq!(got.turns, vec![(1, "first prompt".to_string())]);
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn save_overwrites_not_appends() {
        let base = temp_base("ov");
        save(&base, "/p", &snap("u1", "n", "2026-06-19", 2)).unwrap();
        save(&base, "/p", &snap("u1", "n", "2026-06-19", 5)).unwrap();
        // Second save replaced the first — count reflects the latest only.
        assert_eq!(load(&base, "/p", "u1").unwrap().items.len(), 5);
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn list_summarizes_newest_first_and_excludes_tmp() {
        let base = temp_base("ls");
        save(&base, "/p", &snap("u1", "Claude 1", "2026-06-18", 1)).unwrap();
        save(&base, "/p", &snap("u2", "Claude 2", "2026-06-20", 4)).unwrap();
        // A stray temp file must not appear as a session.
        fs::write(dir(&base, "/p").join("u3.json.tmp"), b"{}").unwrap();
        let sessions = list(&base, "/p");
        assert_eq!(sessions.len(), 2);
        assert_eq!(sessions[0].uuid, "u2", "newest date first");
        assert_eq!(sessions[0].title, "first prompt");
        assert_eq!(sessions[0].count, 4);
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn delete_removes_and_is_idempotent() {
        let base = temp_base("del");
        save(&base, "/p", &snap("u1", "n", "2026-06-19", 1)).unwrap();
        delete(&base, "/p", "u1").unwrap();
        assert!(load(&base, "/p", "u1").is_none());
        delete(&base, "/p", "u1").unwrap(); // idempotent
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn list_missing_project_is_empty() {
        let base = temp_base("empty");
        assert!(list(&base, "/never").is_empty());
        let _ = fs::remove_dir_all(&base);
    }

    // codex F1: a rename (save_name) is decoupled from the body and survives a
    // later body save (the poll thread re-writing the timeline).
    #[test]
    fn rename_via_name_file_survives_body_resave() {
        let base = temp_base("rename");
        save(&base, "/p", &snap("u1", "Claude 1", "2026-06-19", 1)).unwrap();
        save_name(&base, "/p", "u1", "내 세션").unwrap();
        assert_eq!(load(&base, "/p", "u1").unwrap().name, "내 세션");
        // The poll thread re-saves the body with its own name; the override wins.
        save(&base, "/p", &snap("u1", "Claude 1", "2026-06-20", 3)).unwrap();
        assert_eq!(load(&base, "/p", "u1").unwrap().name, "내 세션");
        assert_eq!(list(&base, "/p")[0].name, "내 세션");
        let _ = fs::remove_dir_all(&base);
    }

    // codex F5: a path-traversal uuid is rejected, not used as a path component.
    #[test]
    fn unsafe_uuid_is_rejected() {
        let base = temp_base("unsafe");
        assert!(save(&base, "/p", &snap("../evil", "n", "d", 1)).is_err());
        assert!(load(&base, "/p", "../evil").is_none());
        assert!(save_name(&base, "/p", "a/b", "x").is_err());
        assert!(save_task_meta(&base, "/p", "../evil", &TaskMeta::default()).is_err());
        assert!(read_task_meta(&base, "/p", "../evil").is_none());
        // An unsafe chain link is rejected at write time (not silently stored).
        assert!(save_task_meta(
            &base,
            "/p",
            "u1",
            &TaskMeta { prev_uuid: Some("../evil".into()), summary_path: None },
        )
        .is_err());
        delete(&base, "/p", "../evil").unwrap(); // no-op, not an error
        let _ = fs::remove_dir_all(&base);
    }

    // A body claiming a different uuid than its filename is normalized to the
    // requested (validated) uuid, so chain rendering can't be misled.
    #[test]
    fn load_normalizes_uuid_to_request() {
        let base = temp_base("norm");
        let d = dir(&base, "/p");
        fs::create_dir_all(&d).unwrap();
        fs::write(
            d.join("u2.json"),
            r#"{"uuid":"u1","name":"n","date":"d","items":[],"turns":[],"answers":[],"dates":[]}"#,
        )
        .unwrap();
        assert_eq!(load(&base, "/p", "u2").unwrap().uuid, "u2");
        let _ = fs::remove_dir_all(&base);
    }

    // A snapshot JSON written before task-meta existed (no prev_uuid/summary_path)
    // still loads — the new fields default to None (serde default, backward compat).
    #[test]
    fn loads_legacy_snapshot_without_task_meta() {
        let base = temp_base("legacy");
        let d = dir(&base, "/p");
        fs::create_dir_all(&d).unwrap();
        let legacy = r#"{"uuid":"u1","name":"n","date":"2026-06-19","items":[],"turns":[],"answers":[],"dates":[]}"#;
        fs::write(d.join("u1.json"), legacy).unwrap();
        let got = load(&base, "/p", "u1").unwrap();
        assert_eq!(got.prev_uuid, None);
        assert_eq!(got.summary_path, None);
        let _ = fs::remove_dir_all(&base);
    }

    // The `.task` sidecar survives a later body re-save (the poll thread rewriting
    // the timeline with prev_uuid: None on the body) — same decoupling as `.name`.
    #[test]
    fn task_meta_sidecar_survives_body_resave() {
        let base = temp_base("taskmeta");
        save(&base, "/p", &snap("u2", "n", "2026-06-19", 1)).unwrap();
        save_task_meta(
            &base,
            "/p",
            "u2",
            &TaskMeta {
                prev_uuid: Some("u1".into()),
                summary_path: Some("/x/summary.md".into()),
            },
        )
        .unwrap();
        // Poll re-saves the body (struct carries prev_uuid: None) — sidecar wins.
        save(&base, "/p", &snap("u2", "n", "2026-06-20", 3)).unwrap();
        let got = load(&base, "/p", "u2").unwrap();
        assert_eq!(got.prev_uuid, Some("u1".to_string()));
        assert_eq!(got.summary_path, Some("/x/summary.md".to_string()));
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn save_summary_roundtrips_and_delete_removes_it() {
        let base = temp_base("summary");
        save(&base, "/p", &snap("u1", "n", "d", 1)).unwrap();
        let p = save_summary(&base, "/p", "u1", "요약 내용").unwrap();
        assert!(p.ends_with("u1.summary.md"));
        assert_eq!(fs::read_to_string(&p).unwrap(), "요약 내용");
        assert_eq!(summary_path(&base, "/p", "u1").unwrap(), p);
        delete(&base, "/p", "u1").unwrap();
        assert!(!p.exists());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn delete_removes_task_sidecar() {
        let base = temp_base("deltask");
        save(&base, "/p", &snap("u1", "n", "d", 1)).unwrap();
        save_task_meta(&base, "/p", "u1", &TaskMeta { prev_uuid: Some("p".into()), summary_path: None }).unwrap();
        delete(&base, "/p", "u1").unwrap();
        assert!(read_task_meta(&base, "/p", "u1").is_none());
        let _ = fs::remove_dir_all(&base);
    }
}

#[cfg(test)]
mod meta_tests {
    use super::*;

    fn temp_base(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("mt-meta-{}-{tag}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn snap(uuid: &str, name: &str, date: &str) -> SessionSnapshot {
        SessionSnapshot {
            uuid: uuid.into(),
            name: name.into(),
            date: date.into(),
            items: Vec::new(),
            turns: vec![(2, "둘째 질문".into()), (1, "첫 질문".into())],
            answers: Vec::new(),
            dates: Vec::new(),
            tokens: Vec::new(),
            model: None,
            last_usage: None,
            prev_uuid: None,
            summary_path: None,
            title: None,
            summary: None,
        }
    }

    /// P1 특성: 신선한 meta 경로와 전문 파싱 폴백이 같은 요약을 낸다.
    #[test]
    fn list_via_meta_equals_full_parse_fallback() {
        let base = &temp_base("eq");
        save(base, "/p", &snap("aaaa-1111", "세션A", "2026-08-01")).unwrap();
        let via_meta = list(base, "/p");
        assert_eq!(via_meta.len(), 1);
        assert_eq!(via_meta[0].title, "첫 질문"); // 최저 턴 프롬프트 = title
        // meta 삭제 → 전문 파싱 폴백이 같은 결과 + 자가 치유로 meta 재생성.
        let meta = base.join("projects").join(project_key("/p")).join("claude").join("aaaa-1111.meta.json");
        fs::remove_file(&meta).unwrap();
        let via_body = list(base, "/p");
        assert_eq!(via_meta[0].uuid, via_body[0].uuid);
        assert_eq!(via_meta[0].title, via_body[0].title);
        assert_eq!(via_meta[0].date, via_body[0].date);
        assert_eq!(via_meta[0].count, via_body[0].count);
        assert!(meta.exists(), "list() 폴백이 meta를 재생성해야 한다");
    }

    /// P1 특성: 낡은 meta(본문이 더 새것)는 무시되고 폴백이 정확성을 지킨다.
    #[test]
    fn stale_meta_falls_back_to_body() {
        let base = &temp_base("stale");
        save(base, "/p", &snap("bbbb-2222", "옛이름", "2026-01-01")).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(15));
        // 본문만 직접 갱신(meta는 낡은 채) — save()를 우회한 외부 쓰기 시뮬레이션.
        let d = base.join("projects").join(project_key("/p")).join("claude");
        let newer = snap("bbbb-2222", "새이름", "2026-08-01");
        fs::write(d.join("bbbb-2222.json"), serde_json::to_string(&newer).unwrap()).unwrap();
        let out = list(base, "/p");
        assert_eq!(out[0].date, "2026-08-01", "낡은 meta가 아니라 본문이 이겨야 한다");
        assert_eq!(out[0].name, "새이름");
    }

    /// #7: 구 스키마 meta(v/body_len 없음)는 mtime이 신선해도 무시 → 폴백.
    /// (기존 필드 의미만 바뀌는 배포에서 무음 오답을 막는 버전 게이트.)
    #[test]
    fn legacy_meta_without_version_falls_back() {
        let base = &temp_base("legacyv");
        save(base, "/p", &snap("dddd-4444", "본문이름", "2026-08-01")).unwrap();
        let d = base.join("projects").join(project_key("/p")).join("claude");
        std::thread::sleep(std::time::Duration::from_millis(15));
        // v 없는 구 스키마 meta(더 새 mtime) — 파싱은 실패해야 한다(필수 필드).
        fs::write(
            d.join("dddd-4444.meta.json"),
            r#"{"name":"옛meta","title":"옛제목","date":"2020-01-01","count":99}"#,
        )
        .unwrap();
        let out = list(base, "/p");
        assert_eq!(out[0].name, "본문이름", "구 스키마 meta가 아니라 본문이 이겨야 한다");
        assert_eq!(out[0].date, "2026-08-01");
    }

    /// #7: body_len 불일치(동초 mtime tie에서 본문만 교체) → stale 판정 폴백.
    #[test]
    fn meta_with_wrong_body_len_falls_back() {
        let base = &temp_base("blen");
        save(base, "/p", &snap("eeee-5555", "이름", "2026-08-01")).unwrap();
        let d = base.join("projects").join(project_key("/p")).join("claude");
        // 본문만 교체(길이 변화). meta를 더 새 mtime으로 재작성해 mtime 검사는
        // 통과시키되 body_len이 어긋나게 한다 — len 서명이 stale을 잡아야 한다.
        let newer = snap("eeee-5555", "새이름", "2026-08-02");
        fs::write(d.join("eeee-5555.json"), serde_json::to_string(&newer).unwrap()).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(15));
        let stale_meta = r#"{"v":1,"body_len":1,"name":"옛이름","title":"옛","date":"2026-01-01","count":0}"#;
        fs::write(d.join("eeee-5555.meta.json"), stale_meta).unwrap();
        let out = list(base, "/p");
        assert_eq!(out[0].date, "2026-08-02", "body_len 불일치 meta는 무시돼야 한다");
        assert_eq!(out[0].name, "새이름");
    }

    /// #8: 본문이 파일명과 다른 uuid를 주장해도 목록 uuid는 파일명(stem) —
    /// meta 경로·load()와 동일 규칙(발산 픽스처).
    #[test]
    fn fallback_uuid_is_filename_stem_not_body_claim() {
        let base = &temp_base("stem");
        let d = base.join("projects").join(project_key("/p")).join("claude");
        fs::create_dir_all(&d).unwrap();
        let body = snap("other-uuid", "이름", "2026-08-01");
        fs::write(d.join("ffff-6666.json"), serde_json::to_string(&body).unwrap()).unwrap();
        let out = list(base, "/p");
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].uuid, "ffff-6666", "로드 키는 파일명이므로 stem이 정본");
        // 자가 치유된 meta 경로로도(재호출) 같은 uuid가 나와야 한다.
        let again = list(base, "/p");
        assert_eq!(again[0].uuid, "ffff-6666");
    }

    /// #9: delete()가 meta 사이드카를 동반 삭제한다(고아 방지).
    #[test]
    fn delete_removes_meta_sidecar() {
        let base = &temp_base("delmeta");
        save(base, "/p", &snap("gggg-7777", "이름", "2026-08-01")).unwrap();
        let meta = base
            .join("projects")
            .join(project_key("/p"))
            .join("claude")
            .join("gggg-7777.meta.json");
        assert!(meta.exists());
        delete(base, "/p", "gggg-7777").unwrap();
        assert!(!meta.exists());
    }

    /// 손상 meta → 폴백 (무음 오류 금지: 결과는 항상 정확).
    #[test]
    fn corrupt_meta_falls_back() {
        let base = &temp_base("corrupt");
        save(base, "/p", &snap("cccc-3333", "이름", "2026-08-01")).unwrap();
        let d = base.join("projects").join(project_key("/p")).join("claude");
        std::thread::sleep(std::time::Duration::from_millis(15));
        fs::write(d.join("cccc-3333.meta.json"), "not-json").unwrap(); // meta가 더 새것 + 손상
        let out = list(base, "/p");
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].name, "이름");
    }
}

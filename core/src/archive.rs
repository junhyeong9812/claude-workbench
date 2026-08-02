//! Session **archive** pipeline: normalize a finished session's JSONL into a
//! stable JSON document and render a self-contained `book.html` for later
//! reading — the "record & review" model that replaces live-observation task
//! chains.
//!
//! Layout (one folder per archived session, keyed by project + session uuid):
//! ```text
//! <archive_root>/<project_key>/sessions/<date>-<slug>-<uuid8>/
//!   session.jsonl     # verbatim copy of the CLI transcript (source untouched)
//!   normalized.json   # versioned, parsed form (schema_version field)
//!   book.html         # self-contained reader (no external requests)
//! ```
//!
//! Invariants:
//! - The **source** transcript is never touched here — callers pass its bytes;
//!   this module only ever writes under `archive_root`.
//! - Re-archiving the same session is **idempotent** per uuid: the previous
//!   folder is replaced (found by its `-<uuid8>` suffix, so a changed title or
//!   date can't leave duplicates). When the previous snapshot's content
//!   differs, it is preserved under `<folder>/history/v-<ts>` instead of
//!   deleted — the latest always sits at the top level, versions inside.
//! - Conversation text reaches `book.html` **only** inside a JSON payload with
//!   every `<` escaped to the JSON escape `\\u003c`, and the embedded renderer builds DOM via
//!   `textContent` only — transcript content can never execute in the viewer.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};

use crate::history::project_key;
use crate::jsonl::JsonlMapper;
use crate::timeline::{TimelineItem, TokenUsage};

/// Bump when the shape of [`NormalizedSession`] changes, so future readers
/// (viewer, MCP indexer) can branch on it instead of guessing.
pub const SCHEMA_VERSION: u32 = 1;

/// Process-unique suffix counter for temp dirs (same rationale as snapshot.rs:
/// concurrent writers must never race on a shared temp path).
static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// In-process serialization of archive-tree writers (`write_archive` ↔
/// `backfill_meta`): lazy 백필이 list 시점에 캡처한 폴더를 재아카이브가
/// 교체하는 사이에 meta를 덮어쓰는 race(F3)를 막는다. 프로세스 밖(CLI 백필
/// 병행 실행)은 못 막는다 — 백필이 쓰기 직전 meta를 재독해 창을 최소화한다.
static WRITE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// One conversation turn of the normalized session: the user's prompt, the
/// assistant's answer, and the tool items that ran in between (seq order).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NormalizedTurn {
    pub turn: u64,
    /// The turn's UTC day (YYYY-MM-DD), if the transcript carried timestamps.
    pub date: Option<String>,
    pub prompt: Option<String>,
    pub answer: Option<String>,
    pub tokens: Option<TokenUsage>,
    pub items: Vec<TimelineItem>,
}

/// The whole archived session in one versioned document — the single input for
/// both `book.html` and any later consumer (viewer pane, MCP index).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NormalizedSession {
    pub schema_version: u32,
    pub uuid: String,
    /// The project root (cwd) the session ran in.
    pub project: String,
    /// One-line session title (AI-generated or the display name fallback).
    pub title: String,
    /// Archive date (YYYY-MM-DD).
    pub date: String,
    pub model: Option<String>,
    /// Sum of all turns' token usage.
    pub total_tokens: TokenUsage,
    /// Non-empty transcript lines that failed to parse as records (truncated
    /// tail mid-write, corrupt lines). Recorded so a normalized/book gap is
    /// diagnosable later instead of silently absent.
    #[serde(default)]
    pub skipped_lines: usize,
    pub turns: Vec<NormalizedTurn>,
}

/// Where an archive write landed.
#[derive(Debug, Clone)]
pub struct ArchiveOutcome {
    pub dir: PathBuf,
    pub book_path: PathBuf,
    /// Whether a previous archive of the same session was replaced.
    pub replaced: bool,
}

/// Small per-session `meta.json`, written alongside the archive so listing the
/// browser tree never has to parse the (potentially large) `normalized.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArchiveMeta {
    pub schema_version: u32,
    pub uuid: String,
    /// Original project root (cwd) — the `project_key` folder name is hashed,
    /// so this is the only way back to the real path.
    pub project: String,
    pub title: String,
    pub date: String,
    pub model: Option<String>,
    /// Conversation turn count (browser subtext).
    pub turns: usize,
    /// When this archive was written (unix seconds). `None` on pre-upgrade
    /// metas until backfill fills it from the snapshot's mtime.
    #[serde(default)]
    pub archived_at: Option<u64>,
    /// Snapshot identity of the archived `session.jsonl` — compared against the
    /// live transcript to tell "아카이브됨(최신)" from "아카이브 이후 작업".
    #[serde(default)]
    pub jsonl_bytes: Option<u64>,
    #[serde(default)]
    pub jsonl_lines: Option<usize>,
    /// uuid of the last transcript record that carried one.
    #[serde(default)]
    pub last_message_uuid: Option<String>,
}

/// Content identity of a transcript snapshot: byte length + non-empty line
/// count + the last record uuid. Two transcripts with equal stats are treated
/// as the same content (the transcript is append-only, so growth is the only
/// change mode we distinguish).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JsonlStat {
    pub bytes: u64,
    pub lines: usize,
    pub last_uuid: Option<String>,
}

impl JsonlStat {
    /// spec §2의 내용 동일성 판별식: 라인 수가 다르면 다른 내용, 같으면
    /// 마지막 uuid로 판별한다. uuid가 없는 전사(레코드에 uuid 필드가 전혀
    /// 없는 비정형)는 바이트 길이로 보수 판정. 버전 생성·unchanged 스킵·
    /// 최신 판별이 전부 이 한 정의를 쓴다 — 세 곳의 "같음"이 갈리면 UI
    /// 분류와 저장 동작이 서로 모순된다.
    pub fn same_content(&self, other: &JsonlStat) -> bool {
        if self.lines != other.lines {
            return false;
        }
        match (&self.last_uuid, &other.last_uuid) {
            (Some(a), Some(b)) => a == b,
            _ => self.bytes == other.bytes,
        }
    }
}

/// Read the last record uuid of a (possibly large) live transcript by reading
/// only its tail window — 최신 판별용(전체 read 회피). 절단된 첫 줄은 버리고
/// 뒤에서부터 파싱한다. 창 안에서 uuid를 못 찾으면 `None`(판별 불가 — 호출자
/// 가 바이트 길이로 폴백).
pub fn tail_last_uuid(path: &Path) -> Option<String> {
    tail_last_uuid_window(path, 256 * 1024)
}

fn tail_last_uuid_window(path: &Path, window: u64) -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = fs::File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    let start = len.saturating_sub(window);
    // 창 시작 1바이트 앞부터 읽는다: 그 바이트가 개행이면 창이 정확히 줄
    // 경계에서 시작한 것 — 첫 줄이 완전하므로 버리지 않는다 (post-fix P3).
    let adj = start.saturating_sub(1);
    f.seek(SeekFrom::Start(adj)).ok()?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf);
    let mut tail: &str = &text;
    if start > 0 {
        // 첫 개행까지가 (잠재적으로) 잘린 앞줄 — 경계 개행이면 정확히 그
        // 개행 하나만 소비된다.
        tail = match tail.find('\n') {
            Some(i) => &tail[i + 1..],
            None => "",
        };
    }
    tail.lines()
        .rev()
        .filter(|l| !l.trim().is_empty())
        .find_map(|l| crate::jsonl::RawRecord::parse_line(l).and_then(|r| r.uuid))
}

/// Compute [`JsonlStat`] over raw transcript bytes. `bytes` is the on-disk
/// length (so it compares against `fs::metadata().len()` of the live file);
/// the last uuid comes from the last parseable record that carries one
/// (records like `summary` lines may not), scanning from the tail so a long
/// transcript stays cheap.
pub fn jsonl_stat(bytes: &[u8]) -> JsonlStat {
    let text = String::from_utf8_lossy(bytes);
    let lines = text.lines().filter(|l| !l.trim().is_empty()).count();
    let last_uuid = text
        .lines()
        .rev()
        .filter(|l| !l.trim().is_empty())
        .find_map(|l| crate::jsonl::RawRecord::parse_line(l).and_then(|r| r.uuid));
    JsonlStat {
        bytes: bytes.len() as u64,
        lines,
        last_uuid,
    }
}

/// The snapshot stats of an archived session folder: the meta fields when all
/// present, else computed from the stored `session.jsonl` (`None` when that is
/// unreadable — e.g. a hand-damaged folder).
pub fn archived_stat(dir: &Path, meta: &ArchiveMeta) -> Option<JsonlStat> {
    if let (Some(bytes), Some(lines)) = (meta.jsonl_bytes, meta.jsonl_lines) {
        return Some(JsonlStat {
            bytes,
            lines,
            last_uuid: meta.last_message_uuid.clone(),
        });
    }
    let raw = fs::read(dir.join("session.jsonl")).ok()?;
    Some(jsonl_stat(&raw))
}

/// Unix seconds now — meta timestamps only (display + history folder names).
fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// One preserved past version of an archived session (`history/v-*`).
#[derive(Debug, Clone)]
pub struct ArchiveHistoryEntry {
    pub dir: PathBuf,
    pub book_path: PathBuf,
    /// When that version was archived (its meta, else the folder-name ts).
    pub archived_at: Option<u64>,
    pub title: String,
    pub turns: usize,
}

/// One archived session as the browser lists it.
#[derive(Debug, Clone)]
pub struct ArchiveSessionEntry {
    pub dir: PathBuf,
    pub book_path: PathBuf,
    /// `summary.md` path when extraction produced one.
    pub summary_path: Option<PathBuf>,
    pub meta: ArchiveMeta,
    /// Preserved past versions, newest first (empty when never re-archived
    /// with changed content).
    pub history: Vec<ArchiveHistoryEntry>,
}

/// All archived sessions of one project, plus its knowledge index if any.
#[derive(Debug, Clone)]
pub struct ArchiveProjectListing {
    /// Original project root path (from the sessions' meta).
    pub project: String,
    pub index_path: Option<PathBuf>,
    /// Newest first (date-prefixed folder names sort that way).
    pub sessions: Vec<ArchiveSessionEntry>,
}

/// Same character policy as the snapshot sidecars, plus a minimum length so the
/// `uuid8` folder suffix is meaningful.
fn is_safe_uuid(uuid: &str) -> bool {
    uuid.len() >= 8
        && uuid.len() <= 128
        && uuid
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn uuid8(uuid: &str) -> String {
    uuid.chars().take(8).collect()
}

/// A filesystem-safe folder slug from a session title. Keeps letters/digits in
/// any script (한글 folder names are fine), turns everything else into `-`,
/// collapses runs, and caps the length. Empty input falls back to `"session"`.
pub fn slugify(s: &str, max_chars: usize) -> String {
    let mut out = String::new();
    let mut last_dash = true; // suppress a leading dash
    for c in s.chars() {
        if c.is_alphanumeric() {
            for lc in c.to_lowercase() {
                out.push(lc);
            }
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
        if out.chars().count() >= max_chars {
            break;
        }
    }
    let trimmed = out.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "session".to_string()
    } else {
        trimmed
    }
}

/// Parse a whole transcript into a [`NormalizedSession`] by replaying it
/// through the shared [`JsonlMapper`] (read-only over the text — the caller
/// owns the file). Items are grouped under the turn they ran in; turn `0`
/// (pre-prompt items) appears only when it has items.
pub fn normalize(
    project: &str,
    uuid: &str,
    title: &str,
    date: &str,
    jsonl_text: &str,
) -> NormalizedSession {
    let mut mapper = JsonlMapper::new(project, uuid);
    let mut skipped_lines = 0usize;
    for line in jsonl_text.lines() {
        // Count what the defensive parser drops (mapper behavior unchanged) —
        // a truncated tail from a live copy shows up here, not as silence.
        if !line.trim().is_empty() && crate::jsonl::RawRecord::parse_line(line).is_none() {
            skipped_lines += 1;
        }
        mapper.apply_line(line);
    }

    let mut items_by_turn: std::collections::BTreeMap<u64, Vec<TimelineItem>> = Default::default();
    for item in mapper.timeline().items() {
        items_by_turn.entry(item.turn).or_default().push(item.clone());
    }

    // A turn exists if it has a prompt, an answer, or items.
    let mut turn_ids: std::collections::BTreeSet<u64> = Default::default();
    turn_ids.extend(mapper.turns().keys().copied());
    turn_ids.extend(mapper.answers().keys().copied());
    turn_ids.extend(items_by_turn.keys().copied());
    turn_ids.remove(&0);

    let mut turns = Vec::new();
    if let Some(pre) = items_by_turn.get(&0) {
        turns.push(NormalizedTurn {
            turn: 0,
            date: None,
            prompt: None,
            answer: None,
            tokens: mapper.tokens().get(&0).copied(),
            items: pre.clone(),
        });
    }
    for t in turn_ids {
        turns.push(NormalizedTurn {
            turn: t,
            date: mapper.dates().get(&t).cloned(),
            prompt: mapper.turns().get(&t).cloned(),
            answer: mapper.answers().get(&t).cloned(),
            tokens: mapper.tokens().get(&t).copied(),
            items: items_by_turn.get(&t).cloned().unwrap_or_default(),
        });
    }

    let mut total_tokens = TokenUsage::default();
    for usage in mapper.tokens().values() {
        total_tokens.add(usage);
    }

    NormalizedSession {
        schema_version: SCHEMA_VERSION,
        uuid: uuid.to_string(),
        project: project.to_string(),
        title: title.to_string(),
        date: date.to_string(),
        model: mapper.model().map(str::to_string),
        total_tokens,
        skipped_lines,
        turns,
    }
}

/// Minimal HTML text escaping for the few template slots (title) that are HTML
/// context. Conversation content never goes through here — it rides in the JSON
/// payload instead (see module docs).
fn html_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
}

/// Render the self-contained reader. The session document is embedded as JSON
/// with **every** `<` escaped to the JSON escape `\\u003c` (valid both as JSON and as a JS
/// string escape), so no transcript content can close the `<script>` element or
/// open a tag; the inline renderer only ever assigns `textContent`.
pub fn render_book_html(session: &NormalizedSession) -> String {
    // 이스케이프 규칙은 core::embed 단일 출처 (P4 — graph와 공용).
    let json = crate::embed::embed_json(session);
    BOOK_TEMPLATE
        .replace("__TITLE__", &html_escape(&session.title))
        .replace("__DATA__", &json)
}

/// Write (or replace) the archive folder for `session`: verbatim `session.jsonl`
/// from `jsonl_bytes`, `normalized.json`, and `book.html`. Builds in a temp dir
/// and renames into place, removing any previous folder for the same uuid first
/// (idempotent re-archive; a crash leaves at worst a `.tmp-` dir, never a
/// half-written final folder).
pub fn write_archive(
    archive_root: &Path,
    project: &str,
    session: &NormalizedSession,
    jsonl_bytes: &[u8],
) -> io::Result<ArchiveOutcome> {
    if !is_safe_uuid(&session.uuid) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "unsafe session id"));
    }
    let sessions_dir = archive_root.join(project_key(project)).join("sessions");
    fs::create_dir_all(&sessions_dir)?;

    let short = uuid8(&session.uuid);
    let final_name = format!("{}-{}-{}", session.date, slugify(&session.title, 40), short);
    let final_dir = sessions_dir.join(&final_name);

    // Build the new content off to the side first.
    let tmp_dir = sessions_dir.join(format!(
        ".tmp-{short}-{}-{}",
        std::process::id(),
        TMP_SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir_all(&tmp_dir)?;
    let stat = jsonl_stat(jsonl_bytes);
    // 이 아래의 발견→치환→이월 시퀀스 전체가 backfill_meta와 직렬화된다(F3).
    let _write_guard = WRITE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let write_all = (|| -> io::Result<()> {
        fs::write(tmp_dir.join("session.jsonl"), jsonl_bytes)?;
        let json = serde_json::to_string_pretty(session)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
        fs::write(tmp_dir.join("normalized.json"), json)?;
        fs::write(tmp_dir.join("book.html"), render_book_html(session))?;
        let meta = ArchiveMeta {
            schema_version: session.schema_version,
            uuid: session.uuid.clone(),
            project: session.project.clone(),
            title: session.title.clone(),
            date: session.date.clone(),
            model: session.model.clone(),
            turns: session.turns.len(),
            archived_at: Some(unix_now()),
            jsonl_bytes: Some(stat.bytes),
            jsonl_lines: Some(stat.lines),
            last_message_uuid: stat.last_uuid.clone(),
        };
        let meta_json = serde_json::to_string_pretty(&meta)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
        fs::write(tmp_dir.join("meta.json"), meta_json)?;
        Ok(())
    })();
    if let Err(e) = write_all {
        let _ = fs::remove_dir_all(&tmp_dir);
        return Err(e);
    }

    // Find the previous archive of THIS session. The ONLY authority is the
    // full uuid in each candidate's `meta.json` — never the folder name: a
    // different session sharing the first 8 uuid chars (even with an identical
    // date+slug) must not be deleted (silent data loss). `.old-*` leftovers
    // from an interrupted replace carry the same meta, so a matching one is
    // reclaimed here too (self-healing cleanup); `.tmp-*` never has final data.
    let suffix = format!("-{short}");
    let mut previous: Vec<(PathBuf, ArchiveMeta)> = Vec::new();
    if let Ok(entries) = fs::read_dir(&sessions_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if !path.is_dir() || name.starts_with(".tmp-") {
                continue;
            }
            if !name.ends_with(&suffix) && !name.starts_with(".old-") {
                continue;
            }
            let meta = fs::read_to_string(path.join("meta.json"))
                .ok()
                .and_then(|t| serde_json::from_str::<ArchiveMeta>(&t).ok());
            if let Some(m) = meta.filter(|m| m.uuid == session.uuid) {
                previous.push((path, m));
            }
        }
    }

    // Replace without a destructive window: move the previous folder(s) aside,
    // land the new one, then resolve the displaced copies. If the final rename
    // fails, the displaced folders are moved back — a crash or error never
    // leaves the session with no archive at all (only extra dot-dirs).
    //
    // Version history: a displaced previous archive whose transcript snapshot
    // DIFFERS from the new one is preserved under `<final>/history/v-<ts>[-i]`
    // instead of deleted (재아카이브가 과거 시점을 지우지 않는다). A previous
    // archive with the SAME snapshot (retitle re-land, crash-leftover reclaim)
    // is dropped as before — content-identical copies are not versions. Either
    // way its own `history/` entries are carried forward first, so versions
    // survive any number of re-archives.
    let replaced = !previous.is_empty();
    let mut displaced: Vec<(PathBuf, PathBuf, Option<String>)> = Vec::new();
    for (i, (old, old_meta)) in previous.iter().enumerate() {
        // Decide BEFORE moving: does the old snapshot differ from the new one?
        // (Unreadable old snapshot counts as different — preserve, never drop.)
        let changed = archived_stat(old, old_meta).is_none_or(|s| !s.same_content(&stat));
        let history_name = changed.then(|| {
            let ts = old_meta
                .archived_at
                .or_else(|| {
                    fs::metadata(old.join("session.jsonl"))
                        .ok()
                        .and_then(|m| m.modified().ok())
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_secs())
                })
                .unwrap_or(0);
            format!("v-{ts}-{i}")
        });
        let aside = sessions_dir.join(format!(
            ".old-{short}-{}-{}-{i}",
            std::process::id(),
            TMP_SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        if let Err(e) = fs::rename(old, &aside) {
            for (orig, moved, _) in &displaced {
                let _ = fs::rename(moved, orig);
            }
            let _ = fs::remove_dir_all(&tmp_dir);
            return Err(e);
        }
        displaced.push((old.clone(), aside, history_name));
    }
    if let Err(e) = fs::rename(&tmp_dir, &final_dir) {
        for (orig, moved, _) in &displaced {
            let _ = fs::rename(moved, orig);
        }
        let _ = fs::remove_dir_all(&tmp_dir);
        return Err(e);
    }
    // Post-land bookkeeping is best-effort: the new archive is already safe.
    // 단, 버전은 어떤 실패 경로에서도 조용히 지워지면 안 된다(spec §2) — 이월
    // 못 한 항목이 남은 aside는 삭제하지 않고 `.old-*`로 보존해 다음 아카이브
    // 가 회수한다(자가치유).
    let history_dir = final_dir.join("history");
    for (_, moved, history_name) in &displaced {
        // Carry the previous folder's own versions forward into the new folder.
        // 이름 충돌은 seq suffix로 유일화(최상위 버전과 동일 전략) — 스킵하면
        // 아래 정리 단계에서 그 버전이 사라진다 (리뷰 F2).
        let old_hist = moved.join("history");
        if old_hist.is_dir() {
            let _ = fs::create_dir_all(&history_dir);
            if let Ok(entries) = fs::read_dir(&old_hist) {
                for e in entries.flatten() {
                    let mut dest = history_dir.join(e.file_name());
                    if dest.exists() {
                        dest = history_dir.join(format!(
                            "{}-{}",
                            e.file_name().to_string_lossy(),
                            TMP_SEQ.fetch_add(1, Ordering::Relaxed)
                        ));
                    }
                    let _ = fs::rename(e.path(), dest);
                }
            }
            // 빈 경우에만 지워진다(remove_dir) — 이월 실패분이 남아 있으면
            // 디렉토리가 남고, 아래에서 aside 전체가 보존된다.
            let _ = fs::remove_dir(&old_hist);
        }
        // 이월이 다 끝났는지 = old history가 더 이상 없는지. 잔여물이 있으면
        // 버전화(rename)도 하지 않고 aside 통째로 남긴다 — 버전 폴더 안에
        // history가 중첩되면 목록에서 보이지 않게 되기 때문(post-fix P2).
        // aside는 다음 아카이브의 회수 경로가 이월을 재시도한다.
        let carry_leftover = moved.join("history").is_dir();
        match history_name {
            Some(name) if !carry_leftover => {
                let _ = fs::create_dir_all(&history_dir);
                let mut dest = history_dir.join(name);
                if dest.exists() {
                    dest = history_dir
                        .join(format!("{name}-{}", TMP_SEQ.fetch_add(1, Ordering::Relaxed)));
                }
                // 실패 시 aside 그대로 — 다음 아카이브가 회수.
                let _ = fs::rename(moved, &dest);
            }
            None if !carry_leftover => {
                let _ = fs::remove_dir_all(moved);
            }
            _ => {} // carry_leftover — aside 보존이 미이월 버전을 지키는 유일한 길
        }
    }
    Ok(ArchiveOutcome {
        book_path: final_dir.join("book.html"),
        dir: final_dir,
        replaced,
    })
}

/// List every archived session under `archive_root`, grouped by project and
/// newest-first within each. Infallible by design (a missing root or a session
/// folder without a readable `meta.json` is simply skipped) — the browser must
/// always render.
pub fn list_archives(archive_root: &Path) -> Vec<ArchiveProjectListing> {
    let mut out = Vec::new();
    let Ok(project_dirs) = fs::read_dir(archive_root) else {
        return out;
    };
    for project_dir in project_dirs.flatten() {
        let pdir = project_dir.path();
        if !pdir.is_dir() {
            continue;
        }
        let mut sessions = Vec::new();
        if let Ok(session_dirs) = fs::read_dir(pdir.join("sessions")) {
            for sdir in session_dirs.flatten() {
                let dir = sdir.path();
                // Skip work dirs (`.tmp-*` / `.old-*` from an interrupted replace).
                if !dir.is_dir()
                    || sdir.file_name().to_string_lossy().starts_with('.')
                {
                    continue;
                }
                let Ok(text) = fs::read_to_string(dir.join("meta.json")) else { continue };
                let Ok(meta) = serde_json::from_str::<ArchiveMeta>(&text) else { continue };
                let summary = dir.join("summary.md");
                sessions.push(ArchiveSessionEntry {
                    book_path: dir.join("book.html"),
                    summary_path: summary.is_file().then_some(summary),
                    history: list_history(&dir),
                    dir,
                    meta,
                });
            }
        }
        if sessions.is_empty() {
            continue;
        }
        sessions.sort_by(|a, b| b.dir.file_name().cmp(&a.dir.file_name()));
        let index = pdir.join("knowledge").join("INDEX.md");
        out.push(ArchiveProjectListing {
            project: sessions[0].meta.project.clone(),
            index_path: index.is_file().then_some(index),
            sessions,
        });
    }
    out.sort_by(|a, b| a.project.cmp(&b.project));
    out
}

/// Preserved past versions under `<session>/history/`, newest first. Each is a
/// full former archive folder; a missing/foreign entry is skipped (a version
/// row must never break the whole listing).
fn list_history(session_dir: &Path) -> Vec<ArchiveHistoryEntry> {
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(session_dir.join("history")) else {
        return out;
    };
    for e in entries.flatten() {
        let dir = e.path();
        if !dir.is_dir() {
            continue;
        }
        let meta = fs::read_to_string(dir.join("meta.json"))
            .ok()
            .and_then(|t| serde_json::from_str::<ArchiveMeta>(&t).ok());
        // Folder name `v-<ts>[-i]` is the fallback timestamp for pre-upgrade metas.
        let name_ts = e
            .file_name()
            .to_string_lossy()
            .strip_prefix("v-")
            .and_then(|s| s.split('-').next().and_then(|t| t.parse::<u64>().ok()))
            .filter(|&t| t > 0);
        let book_path = dir.join("book.html");
        if !book_path.is_file() {
            continue;
        }
        out.push(ArchiveHistoryEntry {
            archived_at: meta.as_ref().and_then(|m| m.archived_at).or(name_ts),
            title: meta.as_ref().map(|m| m.title.clone()).unwrap_or_default(),
            turns: meta.as_ref().map(|m| m.turns).unwrap_or(0),
            book_path,
            dir,
        });
    }
    out.sort_by(|a, b| b.archived_at.cmp(&a.archived_at).then(b.dir.cmp(&a.dir)));
    out
}

/// Fill the snapshot-stat meta fields (`archived_at`/`jsonl_bytes`/`jsonl_lines`/
/// `last_message_uuid`) on every archived session that predates them, computed
/// from the folder's own stored `session.jsonl` (아카이브 시점 스냅샷이므로
/// 재추출 없이 정확하다 — `archived_at`은 그 파일의 mtime). Idempotent: metas
/// that already carry the fields are untouched. Returns `(candidates, filled)`
/// — folders lacking the fields vs. successfully rewritten. Writes are atomic
/// (temp + rename), so a crash never leaves a torn `meta.json`.
pub fn backfill_meta(archive_root: &Path) -> (usize, usize) {
    let mut candidates = 0usize;
    let mut filled = 0usize;
    let missing = |m: &ArchiveMeta| {
        m.jsonl_bytes.is_none() || m.jsonl_lines.is_none() || m.archived_at.is_none()
    };
    for listing in list_archives(archive_root) {
        for s in listing.sessions {
            if !missing(&s.meta) {
                continue;
            }
            // 재아카이브와 직렬화(F3): 잠금 안에서 meta를 재독해, list 시점
            // 이후 폴더가 교체됐으면(uuid 바뀜/이미 채워짐) 건드리지 않는다.
            let _guard = WRITE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
            let Some(mut meta) = fs::read_to_string(s.dir.join("meta.json"))
                .ok()
                .and_then(|t| serde_json::from_str::<ArchiveMeta>(&t).ok())
            else {
                continue;
            };
            if meta.uuid != s.meta.uuid || !missing(&meta) {
                continue; // 그 사이 새 아카이브가 앉음 — 백필 불필요(후보 아님)
            }
            // 후보 집계는 재독 후에 — 잠금 대기 중 재아카이브가 채운 항목을
            // "부분 실패"로 오인하지 않는다 (post-fix P5).
            candidates += 1;
            let jsonl_path = s.dir.join("session.jsonl");
            let Ok(raw) = fs::read(&jsonl_path) else { continue };
            let stat = jsonl_stat(&raw);
            meta.jsonl_bytes = Some(stat.bytes);
            meta.jsonl_lines = Some(stat.lines);
            meta.last_message_uuid = stat.last_uuid;
            if meta.archived_at.is_none() {
                meta.archived_at = fs::metadata(&jsonl_path)
                    .ok()
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs());
            }
            let Ok(json) = serde_json::to_string_pretty(&meta) else { continue };
            let tmp = s.dir.join(".meta.json.tmp");
            if fs::write(&tmp, json).is_ok() && fs::rename(&tmp, s.dir.join("meta.json")).is_ok() {
                filled += 1;
            } else {
                let _ = fs::remove_file(&tmp);
            }
        }
    }
    (candidates, filled)
}

/// The self-contained reader page. Placeholders: `__TITLE__` (HTML-escaped) and
/// `__DATA__` (the `<`-escaped JSON document). No external requests, no
/// innerHTML — content is rendered with `textContent` only.
const BOOK_TEMPLATE: &str = include_str!("../templates/book.html"); // P5 B-a: 외부화(바이트 동일 추출)

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicU64, Ordering};

    const UUID: &str = "abcd1234-5678-90ef-ghij-klmnopqrstuv";

    fn temp_root(tag: &str) -> PathBuf {
        static N: AtomicU64 = AtomicU64::new(0);
        let d = std::env::temp_dir().join(format!(
            "mt-archive-{}-{}-{tag}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn sample_jsonl(prompt: &str) -> String {
        [
            json!({ "type": "user", "sessionId": UUID, "timestamp": "2026-07-19T08:00:00.000Z",
                "message": { "role": "user", "content": prompt } }),
            json!({ "type": "assistant", "sessionId": UUID,
                "message": { "role": "assistant", "model": "claude-opus-4-8",
                    "usage": { "input_tokens": 10, "output_tokens": 5 },
                    "content": [
                        { "type": "text", "text": "answer text" },
                        { "type": "tool_use", "id": "t1", "name": "Read",
                          "input": { "file_path": "/p/src/main.rs" } }
                    ] } }),
            json!({ "type": "user", "sessionId": UUID,
                "message": { "role": "user", "content": [
                    { "type": "tool_result", "tool_use_id": "t1", "content": "file body" }
                ] } }),
        ]
        .map(|v| v.to_string())
        .join("\n")
    }

    fn sample_session(title: &str) -> NormalizedSession {
        normalize("/p", UUID, title, "2026-07-19", &sample_jsonl("do the thing"))
    }

    #[test]
    fn slugify_keeps_letters_collapses_rest() {
        assert_eq!(slugify("아카이브 구조: 전환!", 40), "아카이브-구조-전환");
        assert_eq!(slugify("Fix Bug #12  (retry)", 40), "fix-bug-12-retry");
        assert_eq!(slugify("///", 40), "session");
        assert_eq!(slugify("", 40), "session");
        assert!(slugify(&"가".repeat(100), 10).chars().count() <= 10);
    }

    #[test]
    fn normalize_groups_turns_items_and_totals() {
        let s = sample_session("내 작업");
        assert_eq!(s.schema_version, SCHEMA_VERSION);
        assert_eq!(s.uuid, UUID);
        assert_eq!(s.model.as_deref(), Some("claude-opus-4-8"));
        assert_eq!(s.turns.len(), 1);
        let t = &s.turns[0];
        assert_eq!(t.turn, 1);
        assert_eq!(t.prompt.as_deref(), Some("do the thing"));
        assert_eq!(t.answer.as_deref(), Some("answer text"));
        assert_eq!(t.date.as_deref(), Some("2026-07-19"));
        assert_eq!(t.items.len(), 1);
        assert_eq!(t.items[0].content_text.as_deref(), Some("file body"));
        assert_eq!(s.total_tokens.input, 10);
        assert_eq!(s.total_tokens.output, 5);
    }

    #[test]
    fn book_html_cannot_carry_active_markup_from_transcript() {
        let evil = "</script><script>alert(1)</script><img src=x onerror=alert(2)>";
        let s = normalize("/p", UUID, "t", "2026-07-19", &sample_jsonl(evil));
        assert_eq!(s.turns[0].prompt.as_deref(), Some(evil), "content preserved verbatim");
        let html = render_book_html(&s);
        // No `<` from the transcript survives into markup position.
        assert!(!html.contains("<script>alert"), "script cannot break out");
        assert!(!html.contains("<img src=x"), "no raw tags from content");
        assert!(html.contains("\\u003cscript>alert(1)"), "escaped into the JSON payload");
    }

    #[test]
    fn book_html_title_is_escaped() {
        let mut s = sample_session("t");
        s.title = "<b>제목 & \"인용\"</b>".to_string();
        let html = render_book_html(&s);
        assert!(html.contains("<title>&lt;b&gt;제목 &amp; &quot;인용&quot;&lt;/b&gt;</title>"));
        assert!(!html.contains("<title><b>"));
    }

    #[test]
    fn write_archive_lays_out_files_with_verbatim_jsonl() {
        let root = temp_root("layout");
        let jsonl = sample_jsonl("do the thing");
        let s = sample_session("아카이브 테스트");
        let out = write_archive(&root, "/p", &s, jsonl.as_bytes()).unwrap();
        assert!(!out.replaced);
        assert!(out.dir.file_name().unwrap().to_string_lossy().starts_with("2026-07-19-아카이브-테스트-"));
        assert_eq!(fs::read(out.dir.join("session.jsonl")).unwrap(), jsonl.as_bytes());
        assert!(out.book_path.is_file());
        let norm: NormalizedSession =
            serde_json::from_str(&fs::read_to_string(out.dir.join("normalized.json")).unwrap()).unwrap();
        assert_eq!(norm.uuid, UUID);
        assert_eq!(norm.schema_version, SCHEMA_VERSION);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rearchive_is_idempotent_even_with_new_title() {
        let root = temp_root("idem");
        let jsonl = sample_jsonl("p");
        let s1 = sample_session("첫 제목");
        let out1 = write_archive(&root, "/p", &s1, jsonl.as_bytes()).unwrap();
        assert!(!out1.replaced);
        // Same session again, different title → old folder replaced, not duplicated.
        let s2 = sample_session("다른 제목");
        let out2 = write_archive(&root, "/p", &s2, jsonl.as_bytes()).unwrap();
        assert!(out2.replaced);
        assert!(!out1.dir.exists(), "old folder removed");
        let sessions = out2.dir.parent().unwrap();
        let dirs: Vec<_> = fs::read_dir(sessions).unwrap().flatten().collect();
        assert_eq!(dirs.len(), 1, "exactly one folder per session");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn different_sessions_do_not_collide() {
        let root = temp_root("two");
        let jsonl = sample_jsonl("p");
        let a = sample_session("작업 A");
        let mut b = sample_session("작업 B");
        b.uuid = "ffff9999-1111-2222-3333-444455556666".to_string();
        write_archive(&root, "/p", &a, jsonl.as_bytes()).unwrap();
        let out_b = write_archive(&root, "/p", &b, jsonl.as_bytes()).unwrap();
        assert!(!out_b.replaced, "a different uuid never replaces another session");
        let sessions = out_b.dir.parent().unwrap();
        assert_eq!(fs::read_dir(sessions).unwrap().flatten().count(), 2);
        let _ = fs::remove_dir_all(&root);
    }

    // 리뷰 K1: uuid 앞 8자가 같은 *다른* 세션은 삭제 대상이 아니다 — 판별은
    // 폴더 suffix가 아니라 meta.json의 전체 uuid.
    #[test]
    fn shared_uuid8_prefix_does_not_delete_other_session() {
        let root = temp_root("prefix");
        let jsonl = sample_jsonl("p");
        let a = sample_session("작업 A"); // abcd1234-...
        let mut b = sample_session("작업 B");
        b.uuid = format!("{}-9999-8888-7777-666655554444", &UUID[..8]); // 같은 앞 8자
        let out_a = write_archive(&root, "/p", &a, jsonl.as_bytes()).unwrap();
        let out_b = write_archive(&root, "/p", &b, jsonl.as_bytes()).unwrap();
        assert!(!out_b.replaced, "같은 8자 접두여도 전체 uuid가 다르면 교체 아님");
        assert!(out_a.dir.exists(), "기존 세션 아카이브 보존");
        assert_eq!(
            fs::read_dir(out_b.dir.parent().unwrap()).unwrap().flatten().count(),
            2
        );
        // 같은 세션 재아카이브는 여전히 자신만 교체.
        let out_b2 = write_archive(&root, "/p", &b, jsonl.as_bytes()).unwrap();
        assert!(out_b2.replaced);
        assert!(out_a.dir.exists());
        let _ = fs::remove_dir_all(&root);
    }

    // post-fix P1: 중단된 교체가 남긴 `.old-*`(meta의 uuid 일치)는 다음
    // 아카이브가 회수한다 — 영구 쓰레기가 아니라 자기치유 대상.
    #[test]
    fn interrupted_replace_leftover_is_reclaimed() {
        let root = temp_root("oldreclaim");
        let jsonl = sample_jsonl("p");
        let s = sample_session("복구 테스트");
        let out = write_archive(&root, "/p", &s, jsonl.as_bytes()).unwrap();
        let sessions = out.dir.parent().unwrap().to_path_buf();
        // 크래시 시나리오 재현: 최종 폴더가 `.old-*`로만 남아 있는 상태.
        let leftover = sessions.join(".old-crashed-1");
        fs::rename(&out.dir, &leftover).unwrap();
        assert!(list_archives(&root).is_empty(), "dot-dir는 목록에 안 보임");
        // 재아카이브가 leftover를 회수하고 정상 폴더 하나만 남긴다.
        let out2 = write_archive(&root, "/p", &s, jsonl.as_bytes()).unwrap();
        assert!(out2.replaced, "leftover 회수도 교체로 집계");
        assert!(!leftover.exists());
        assert_eq!(fs::read_dir(&sessions).unwrap().flatten().count(), 1);
        assert_eq!(list_archives(&root)[0].sessions.len(), 1);
        let _ = fs::remove_dir_all(&root);
    }

    // 리뷰 K12: U+2028/2029(JS 라인 종결자)는 JSON 페이로드에서 이스케이프된다.
    #[test]
    fn book_html_escapes_js_line_separators() {
        let s = normalize("/p", UUID, "t", "2026-07-19", &sample_jsonl("줄\u{2028}분리\u{2029}끝"));
        let html = render_book_html(&s);
        assert!(!html.contains('\u{2028}') && !html.contains('\u{2029}'));
        assert!(html.contains("\\u2028") && html.contains("\\u2029"));
    }

    #[test]
    fn list_archives_reads_meta_and_flags_summary() {
        let root = temp_root("list");
        let jsonl = sample_jsonl("p");
        let out = write_archive(&root, "/p", &sample_session("목록 테스트"), jsonl.as_bytes()).unwrap();
        let listed = list_archives(&root);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].project, "/p");
        assert_eq!(listed[0].index_path, None, "지식 없으면 인덱스 없음");
        let s = &listed[0].sessions[0];
        assert_eq!(s.meta.uuid, UUID);
        assert_eq!(s.meta.title, "목록 테스트");
        assert_eq!(s.meta.turns, 1);
        assert_eq!(s.summary_path, None);
        assert_eq!(s.book_path, out.book_path);
        // summary.md가 생기면 플래그가 선다.
        fs::write(out.dir.join("summary.md"), "요약").unwrap();
        let again = list_archives(&root);
        assert!(again[0].sessions[0].summary_path.is_some());
        // 없는 루트는 빈 목록 (에러 아님).
        assert!(list_archives(&root.join("nope")).is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    // 명세 load-bearing 가정 1: 아카이브된 session.jsonl의 stat이 원본과 같은
    // 방식으로 비교 가능하다 — 바이트 그대로 복사이므로 stat도 동일해야 한다.
    #[test]
    fn meta_snapshot_stat_matches_source_transcript() {
        let root = temp_root("stat");
        let jsonl = sample_jsonl("p");
        let out = write_archive(&root, "/p", &sample_session("스탯"), jsonl.as_bytes()).unwrap();
        let meta: ArchiveMeta =
            serde_json::from_str(&fs::read_to_string(out.dir.join("meta.json")).unwrap()).unwrap();
        let src = jsonl_stat(jsonl.as_bytes());
        let archived = fs::read(out.dir.join("session.jsonl")).unwrap();
        assert_eq!(jsonl_stat(&archived), src, "복사본 stat = 원본 stat");
        assert_eq!(meta.jsonl_bytes, Some(src.bytes));
        assert_eq!(meta.jsonl_lines, Some(src.lines));
        assert_eq!(meta.last_message_uuid, src.last_uuid);
        assert!(meta.archived_at.is_some_and(|t| t > 0));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn jsonl_stat_counts_lines_and_finds_last_uuid() {
        let text = format!(
            "{}\n\n{}\nnot-json\n",
            json!({"type":"user","uuid":"u-1","message":{"role":"user","content":"a"}}),
            json!({"type":"assistant","uuid":"u-2","message":{"role":"assistant","content":[]}}),
        );
        let s = jsonl_stat(text.as_bytes());
        assert_eq!(s.lines, 3, "빈 줄 제외");
        assert_eq!(s.last_uuid.as_deref(), Some("u-2"), "파싱 불가 꼬리는 건너뛰고 마지막 uuid");
        assert_eq!(s.bytes, text.len() as u64);
    }

    // 내용이 달라진 재아카이브 → 이전본은 history/로 보존, 또 재아카이브해도
    // 기존 버전이 최신 폴더로 이월된다.
    #[test]
    fn changed_rearchive_preserves_previous_as_history() {
        let root = temp_root("hist");
        let v1 = sample_jsonl("첫 작업");
        let out1 = write_archive(&root, "/p", &sample_session("t"), v1.as_bytes()).unwrap();
        assert!(list_archives(&root)[0].sessions[0].history.is_empty());

        let v2 = format!("{v1}\n{}", json!({"type":"user","uuid":"u-new","message":{"role":"user","content":"more"}}));
        let out2 = write_archive(&root, "/p", &sample_session("t"), v2.as_bytes()).unwrap();
        assert!(out2.replaced);
        assert_eq!(out1.dir, out2.dir, "같은 제목·날짜 → 같은 최신 경로에 안착");
        assert_eq!(
            fs::read(out2.dir.join("session.jsonl")).unwrap(),
            v2.as_bytes(),
            "최신 폴더 내용은 새 스냅샷"
        );
        let listed = &list_archives(&root)[0].sessions[0];
        assert_eq!(listed.history.len(), 1, "이전본이 버전으로 보존");
        assert!(listed.history[0].book_path.is_file());
        let old_jsonl = fs::read(listed.history[0].dir.join("session.jsonl")).unwrap();
        assert_eq!(old_jsonl, v1.as_bytes(), "버전 내용 = 이전 스냅샷 그대로");

        // 한 번 더 변경 재아카이브 → 버전 2개, 전부 이월.
        let v3 = format!("{v2}\n{}", json!({"type":"user","uuid":"u-3","message":{"role":"user","content":"x"}}));
        write_archive(&root, "/p", &sample_session("t"), v3.as_bytes()).unwrap();
        let listed = &list_archives(&root)[0].sessions[0];
        assert_eq!(listed.history.len(), 2, "기존 버전 이월 + 새 버전");
        let _ = fs::remove_dir_all(&root);
    }

    // 내용이 같은 재아카이브(retitle re-land) → 버전 생성 없음, history는 이월.
    #[test]
    fn same_content_rearchive_does_not_stack_versions() {
        let root = temp_root("same");
        let v1 = sample_jsonl("작업");
        write_archive(&root, "/p", &sample_session("가제"), v1.as_bytes()).unwrap();
        // 내용 변경 1회로 버전 하나 만들어 둠.
        let v2 = format!("{v1}\n{}", json!({"type":"user","uuid":"u-n","message":{"role":"user","content":"m"}}));
        write_archive(&root, "/p", &sample_session("가제"), v2.as_bytes()).unwrap();
        // 같은 내용으로 제목만 바꿔 재land — 버전이 늘면 안 되고 기존 버전은 유지.
        write_archive(&root, "/p", &sample_session("추출된 제목"), v2.as_bytes()).unwrap();
        let listed = &list_archives(&root)[0].sessions[0];
        assert_eq!(listed.meta.title, "추출된 제목");
        assert_eq!(listed.history.len(), 1, "동일 내용 re-land는 버전을 쌓지 않음");
        let _ = fs::remove_dir_all(&root);
    }

    // 구버전 메타 백필: 필드 없는 meta.json을 저장된 session.jsonl로 채운다(멱등).
    #[test]
    fn backfill_fills_missing_stat_fields_idempotently() {
        let root = temp_root("backfill");
        let jsonl = sample_jsonl("p");
        let out = write_archive(&root, "/p", &sample_session("백필"), jsonl.as_bytes()).unwrap();
        // 구버전 메타 재현: 새 필드를 벗겨낸 meta.json으로 되돌린다.
        let mut v: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(out.dir.join("meta.json")).unwrap()).unwrap();
        let obj = v.as_object_mut().unwrap();
        for k in ["archived_at", "jsonl_bytes", "jsonl_lines", "last_message_uuid"] {
            obj.remove(k);
        }
        fs::write(out.dir.join("meta.json"), v.to_string()).unwrap();

        let (candidates, filled) = backfill_meta(&root);
        assert_eq!((candidates, filled), (1, 1));
        let meta: ArchiveMeta =
            serde_json::from_str(&fs::read_to_string(out.dir.join("meta.json")).unwrap()).unwrap();
        let src = jsonl_stat(jsonl.as_bytes());
        assert_eq!(meta.jsonl_bytes, Some(src.bytes));
        assert_eq!(meta.jsonl_lines, Some(src.lines));
        assert_eq!(meta.last_message_uuid, src.last_uuid);
        assert!(meta.archived_at.is_some(), "mtime 기반 archived_at");
        assert_eq!(meta.title, "백필", "기존 필드 보존");
        // 멱등: 두 번째 호출은 후보 0.
        assert_eq!(backfill_meta(&root), (0, 0));
        let _ = fs::remove_dir_all(&root);
    }

    // F4: 내용 동일성은 라인+uuid가 판별식, uuid 부재 시에만 바이트 폴백.
    #[test]
    fn same_content_prefers_uuid_over_bytes() {
        let a = JsonlStat { bytes: 100, lines: 3, last_uuid: Some("u1".into()) };
        // 바이트가 달라도(공백 차이 등) 라인+uuid 같으면 같은 내용.
        let b = JsonlStat { bytes: 101, lines: 3, last_uuid: Some("u1".into()) };
        assert!(a.same_content(&b));
        // 길이 같아도 uuid 다르면 다른 내용 (재작성 방어).
        let c = JsonlStat { bytes: 100, lines: 3, last_uuid: Some("u2".into()) };
        assert!(!a.same_content(&c));
        // uuid 없는 전사는 바이트로 보수 판정.
        let d = JsonlStat { bytes: 100, lines: 3, last_uuid: None };
        let e = JsonlStat { bytes: 100, lines: 3, last_uuid: None };
        let f = JsonlStat { bytes: 90, lines: 3, last_uuid: None };
        assert!(d.same_content(&e));
        assert!(!d.same_content(&f));
        // 라인 수가 다르면 무조건 다름.
        let g = JsonlStat { bytes: 100, lines: 4, last_uuid: Some("u1".into()) };
        assert!(!a.same_content(&g));
    }

    #[test]
    fn tail_last_uuid_reads_only_tail() {
        let root = temp_root("tail");
        let p = root.join("s.jsonl");
        let mut text = String::new();
        for i in 0..50 {
            text.push_str(&json!({"type":"user","uuid":format!("u-{i}"),"message":{"role":"user","content":"x"}}).to_string());
            text.push('\n');
        }
        text.push_str("truncated-garbage-tail");
        fs::write(&p, &text).unwrap();
        assert_eq!(tail_last_uuid(&p).as_deref(), Some("u-49"), "파싱 불가 꼬리 건너뜀");
        let _ = fs::remove_dir_all(&root);
    }

    // post-fix P3: 창이 정확히 줄 경계에서 시작하면 첫 줄은 완전한 레코드다 —
    // 버리면 안 된다.
    #[test]
    fn tail_window_on_exact_line_boundary_keeps_first_line() {
        let root = temp_root("tailb");
        let p = root.join("s.jsonl");
        let head = json!({"type":"user","uuid":"u-head","message":{"role":"user","content":"x"}}).to_string();
        let target = json!({"type":"user","uuid":"u-target","message":{"role":"user","content":"y"}}).to_string();
        // 창 안 마지막 줄들은 uuid가 없어, 첫 줄(u-target)이 창 안 유일한 uuid.
        let filler = json!({"type":"system"}).to_string();
        let text = format!("{head}\n{target}\n{filler}\n{filler}\n");
        fs::write(&p, &text).unwrap();
        // 창 시작 = target 줄의 첫 바이트 (정확한 경계).
        let window = (text.len() - head.len() - 1) as u64;
        assert_eq!(
            tail_last_uuid_window(&p, window).as_deref(),
            Some("u-target"),
            "경계 첫 줄 보존"
        );
        // 창이 줄 중간에서 시작하면 그 잘린 줄은 버린다 → head/target 못 보고 None.
        assert_eq!(tail_last_uuid_window(&p, window - 5), None, "잘린 첫 줄은 폐기");
        let _ = fs::remove_dir_all(&root);
    }

    // F2: 이월 대상 history 이름이 충돌해도 버전이 사라지지 않는다 — suffix로
    // 유일화되어 양쪽 다 보존.
    #[test]
    fn carry_forward_name_collision_preserves_both_versions() {
        let root = temp_root("carry");
        let v1 = sample_jsonl("일");
        let out1 = write_archive(&root, "/p", &sample_session("t"), v1.as_bytes()).unwrap();
        let sessions = out1.dir.parent().unwrap().to_path_buf();
        // 크래시 leftover 재현: 같은 uuid의 .old- 폴더가 최신 폴더와 같은 이름의
        // history 항목을 갖고 있다.
        let mk_hist = |base: &Path| {
            let h = base.join("history").join("v-111-0");
            fs::create_dir_all(&h).unwrap();
            fs::write(h.join("book.html"), "old book").unwrap();
        };
        mk_hist(&out1.dir);
        let leftover = sessions.join(".old-crash-x");
        fs::create_dir_all(&leftover).unwrap();
        fs::copy(out1.dir.join("meta.json"), leftover.join("meta.json")).unwrap();
        fs::write(leftover.join("session.jsonl"), "different-content\n").unwrap();
        fs::write(leftover.join("book.html"), "b").unwrap();
        mk_hist(&leftover);

        // 내용이 달라진 재아카이브 — 최신 폴더·leftover 둘 다 치환된다.
        let v2 = format!("{v1}\n{}", json!({"type":"user","uuid":"u-n","message":{"role":"user","content":"m"}}));
        let out2 = write_archive(&root, "/p", &sample_session("t"), v2.as_bytes()).unwrap();
        let hist = out2.dir.join("history");
        let names: Vec<String> = fs::read_dir(&hist)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        let collided = names.iter().filter(|n| n.starts_with("v-111-0")).count();
        assert_eq!(collided, 2, "충돌한 이월 항목 양쪽 다 보존: {names:?}");
        // 치환된 두 이전본(내용 상이)도 버전으로 존재 — 총 4개.
        assert_eq!(names.len(), 4, "이월 2 + 새 버전 2: {names:?}");
        assert!(
            !fs::read_dir(&sessions).unwrap().flatten().any(|e| e
                .file_name()
                .to_string_lossy()
                .starts_with(".old-")),
            "이월 완료 후 aside 잔존 없음"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn unsafe_or_short_uuid_is_rejected() {
        let root = temp_root("unsafe");
        let mut s = sample_session("t");
        s.uuid = "../../evil".to_string();
        assert!(write_archive(&root, "/p", &s, b"{}").is_err());
        s.uuid = "short".to_string();
        assert!(write_archive(&root, "/p", &s, b"{}").is_err());
        let _ = fs::remove_dir_all(&root);
    }
}

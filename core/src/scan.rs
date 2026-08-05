//! Scanning `~/.claude/projects` for session transcripts + probing their meta.
//!
//! The CLI writes each session to `~/.claude/projects/<cwd-slug>/<uuid>.jsonl`.
//! We deliberately do **not** predict the slug (see [`crate::jsonl::locate`] —
//! the rewrite rule for unusual characters is unverified); a one-level scan
//! finds every transcript regardless of how its slug was derived, and the `cwd`
//! recorded *inside* the transcript is the authoritative project.
//!
//! This module is the single source for that scan. It was promoted out of the
//! `archive-backfill` binary (which inlined it) so the app's external-session
//! listing and the backfill CLI cannot drift apart.

use std::fs::File;
use std::io::{self, BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

/// A transcript file found by [`scan_transcripts`].
#[derive(Debug, Clone)]
pub struct Transcript {
    /// Session uuid — the file stem, which is the id `--resume` takes.
    pub uuid: String,
    pub path: PathBuf,
    pub mtime: SystemTime,
}

/// Filters applied while walking the projects root.
#[derive(Debug, Clone, Default)]
pub struct ScanOpts {
    /// Skip `-tmp-…` slug directories (transcripts whose cwd was under `/tmp`).
    /// Those are throwaway scratch sessions — including our own extraction runs,
    /// whose mtimes are always the freshest and would otherwise eat a `--limit`
    /// budget whole. The filter belongs at scan level because `--limit` is
    /// applied before any transcript is probed.
    pub skip_tmp_slugs: bool,
    /// Keep only transcripts modified at or after this instant.
    pub modified_since: Option<SystemTime>,
}

/// Walk the immediate subdirectories of `projects_root` and return every
/// `<uuid>.jsonl` passing `opts`.
///
/// Unreadable project subdirectories and entries with unreadable metadata are
/// skipped, not fatal — one bad directory must never hide the rest. A missing
/// `projects_root` is an error the caller reports (the backfill CLI dies on it;
/// the app treats it as "no sessions").
pub fn scan_transcripts(projects_root: &Path, opts: &ScanOpts) -> io::Result<Vec<Transcript>> {
    let mut out = Vec::new();
    for dir in std::fs::read_dir(projects_root)?.flatten() {
        let dir_path = dir.path();
        if !dir_path.is_dir() {
            continue;
        }
        if opts.skip_tmp_slugs
            && dir.file_name().to_string_lossy().starts_with("-tmp-")
        {
            continue;
        }
        let Ok(files) = std::fs::read_dir(&dir_path) else { continue };
        for f in files.flatten() {
            let path = f.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let Ok(meta) = f.metadata() else { continue };
            let Ok(mtime) = meta.modified() else { continue };
            if let Some(since) = opts.modified_since {
                if mtime < since {
                    continue;
                }
            }
            let Some(uuid) = path.file_stem().map(|s| s.to_string_lossy().to_string()) else {
                continue;
            };
            out.push(Transcript { uuid, path, mtime });
        }
    }
    Ok(out)
}

/// Meta folded out of a transcript's records.
///
/// Every field is best-effort: a transcript whose records we can't parse yields
/// an all-`None` probe rather than an error.
#[derive(Debug, Clone, Default)]
pub struct Probe {
    /// The **first** `cwd` seen — the directory the session was started in, and
    /// the only directory `--resume` accepts (see the module docs of
    /// `commands::claude::spawn`).
    pub cwd: Option<String>,
    /// Date (`YYYY-MM-DD`) of the **last** timestamp seen.
    pub date: Option<String>,
    /// The session's first user prompt starts with the knowledge-extraction
    /// marker — i.e. this transcript is a by-product of *our own* archive
    /// pipeline, not a user session (feedback-loop defence #2; cwd isolation
    /// is #1).
    pub is_extraction: bool,
    /// The first user prompt, verbatim (untruncated — callers cut to taste).
    pub first_prompt: Option<String>,
    /// The CLI's own generated title (`ai-title` record), if it wrote one.
    pub ai_title: Option<String>,
    /// Set once the first user prompt has been consumed, so later user messages
    /// don't overwrite it.
    seen_first_prompt: bool,
}

impl Probe {
    /// Fold one transcript line in. Unparseable lines are skipped.
    pub fn feed_line(&mut self, line: &str) {
        let Some(rec) = crate::jsonl::RawRecord::parse_line(line) else { return };
        if self.cwd.is_none() {
            self.cwd = rec.cwd.clone();
        }
        if let Some(ts) = rec.timestamp.as_deref().and_then(|t| t.get(..10)) {
            self.date = Some(ts.to_string());
        }
        if let Some(t) = rec.ai_title.as_deref() {
            let t = t.trim();
            if !t.is_empty() {
                self.ai_title = Some(t.to_string());
            }
        }
        if !self.seen_first_prompt {
            if let Some(msg) = &rec.message {
                if msg.role.as_deref() == Some("user") {
                    if let Some(crate::jsonl::Content::Text(p)) = &msg.content {
                        self.seen_first_prompt = true;
                        self.is_extraction =
                            p.trim_start().starts_with(crate::knowledge::EXTRACTION_MARKER);
                        self.first_prompt = Some(p.clone());
                    }
                }
            }
        }
    }

    /// A one-line display title: the CLI's own title, else the first prompt cut
    /// to `max_chars` **characters** (not bytes — prompts are usually Korean).
    pub fn title(&self, max_chars: usize) -> Option<String> {
        if let Some(t) = &self.ai_title {
            return Some(t.clone());
        }
        let p = self.first_prompt.as_deref()?.trim();
        if p.is_empty() {
            return None;
        }
        let one_line = p.split('\n').next().unwrap_or(p).trim();
        let src = if one_line.is_empty() { p } else { one_line };
        let mut s: String = src.chars().take(max_chars).collect();
        if src.chars().count() > max_chars {
            s.push('…');
        }
        Some(s)
    }
}

/// Probe a transcript already held in memory (the backfill CLI reads the whole
/// file to group by project, then drops the text).
pub fn probe_transcript(text: &str) -> Probe {
    let mut p = Probe::default();
    for line in text.lines() {
        p.feed_line(line);
    }
    p
}

/// Probe only the **head** of a transcript — enough for cwd/title without
/// reading gigabytes (the projects root is ~1.5 GB across a few hundred files,
/// and the listing path touches all of them).
///
/// Stops after `max_records` parsed lines or `max_bytes` consumed, whichever
/// comes first. `date` is therefore the last timestamp *in the head*, not in the
/// file — listers should use the file mtime for "last active" instead.
pub fn probe_head(path: &Path, max_records: usize, max_bytes: u64) -> io::Result<Probe> {
    Ok(fold_head(path, max_records, max_bytes, |_| false)?.probe)
}

/// Read only far enough to learn **which directory** the session ran in.
///
/// The listing path has to ask this of every transcript in the projects root
/// just to find the handful belonging to one project, so it must be cheap: the
/// first record carrying a `cwd` ends the read. Measured on a real 341-file /
/// 1.5 GB corpus this is the difference between ~5 s and ~50 ms for a listing.
///
/// A transcript whose budget runs out before any `cwd` appears is dropped from
/// the listing, which is invisible to the user — so say so on stderr rather than
/// letting a session disappear in silence.
pub fn probe_cwd(path: &Path) -> io::Result<Option<String>> {
    let scan = fold_head(path, CWD_RECORDS, CWD_BYTES, |p| p.cwd.is_some())?;
    if scan.probe.cwd.is_none() && scan.exhausted {
        eprintln!(
            "scan: cwd를 찾기 전에 예산({CWD_RECORDS}레코드/{CWD_BYTES}바이트)이 소진돼 \
             건너뜁니다 — {}",
            path.display()
        );
    }
    Ok(scan.probe.cwd)
}

/// [`fold_head`]'s outcome: the folded probe, plus whether the read stopped
/// because a budget ran out (as opposed to reaching EOF or the caller's `stop`).
struct HeadScan {
    probe: Probe,
    exhausted: bool,
    /// Bytes actually pulled off the disk, including those drained and thrown
    /// away. Exposed so the budget can be asserted rather than assumed — the
    /// scan itself never consults it, so it is dead outside the tests.
    #[cfg_attr(not(test), allow(dead_code))]
    bytes_read: u64,
    /// Largest single record held in memory at once — the memory bound this
    /// function promises, made observable for the same reason.
    #[cfg_attr(not(test), allow(dead_code))]
    peak_buffer: u64,
}

/// Fold the head of `path` into a [`Probe`], stopping at the record budget, the
/// **total** byte budget, or when `stop` is satisfied.
///
/// `max_bytes` is a ceiling on the whole scan, not a reason to abandon it at the
/// first big record. An earlier version broke out as soon as one record pushed
/// the total past the limit, which made the budget a lottery: the largest single
/// record in the real corpus is 253 KB against a 256 KB budget, so any transcript
/// with a slightly fatter preamble would have been dropped from the listing with
/// no trace (review #5). Now an oversized record is *skipped* — it is far too big
/// to be the small `cwd`-carrying record, and parsing it is pure waste — and the
/// scan continues until the total budget is actually spent.
///
/// The budget is enforced **on the read**, not after it. A plain `read_until`
/// grows its buffer until it meets a newline, so one pathological record would
/// be pulled into memory whole and only then measured against the limit — the
/// cap would be a report, not a constraint (audit B4). Each record is therefore
/// read through a `take(MAX_RECORD_BYTES)`, and a line that outgrows that is
/// drained to the newline without ever being stored, with the drained bytes
/// counted so the total budget still ends the scan.
fn fold_head(
    path: &Path,
    max_records: usize,
    max_bytes: u64,
    stop: impl Fn(&Probe) -> bool,
) -> io::Result<HeadScan> {
    let mut probe = Probe::default();
    let mut reader = BufReader::new(File::open(path)?);
    let mut consumed: u64 = 0;
    let mut peak_buffer: u64 = 0;
    let mut buf = Vec::new();
    let mut records = 0usize;
    macro_rules! done {
        ($exhausted:expr) => {
            return Ok(HeadScan {
                probe,
                exhausted: $exhausted,
                bytes_read: consumed,
                peak_buffer,
            })
        };
    }
    loop {
        if records >= max_records || consumed >= max_bytes {
            done!(true);
        }
        buf.clear();
        // Bounded read: at most one record's cap lands in `buf`, and a record is
        // never split mid-line into invalid JSON (hook attachments run to
        // hundreds of KB, so a split would be silent corruption, not an error).
        let n = (&mut reader).take(MAX_RECORD_BYTES).read_until(b'\n', &mut buf)? as u64;
        if n == 0 {
            done!(false); // EOF
        }
        records += 1;
        consumed += n;
        peak_buffer = peak_buffer.max(n);
        if buf.last() != Some(&b'\n') && n == MAX_RECORD_BYTES {
            // The record outgrew the buffer cap: throw the rest away unread
            // rather than growing to hold it.
            let (skipped, end) =
                discard_to_newline(&mut reader, max_bytes.saturating_sub(consumed))?;
            consumed += skipped;
            match end {
                DrainEnd::Newline => continue, // truncated → nothing worth parsing
                DrainEnd::Eof => done!(false), // file ended inside it — not a budget problem
                DrainEnd::Budget => done!(true),
            }
        }
        // A complete record, or the file's last line with no trailing newline.
        probe.feed_line(&String::from_utf8_lossy(&buf));
        if stop(&probe) {
            done!(false);
        }
    }
}

/// Why [`discard_to_newline`] stopped. The caller reacts differently to each:
/// only `Budget` means the scan was cut short.
enum DrainEnd {
    /// Reached the end of the record — carry on with the next one.
    Newline,
    /// The file ended inside the record; the scan is complete, not truncated.
    Eof,
    /// The byte budget ran out mid-record.
    Budget,
}

/// Skip past the next newline **without storing anything**, reading at most
/// `budget` bytes. The skipped count is returned in every case — the caller must
/// charge those bytes to the budget even when giving up, or `bytes_read` would
/// under-report the IO actually performed.
fn discard_to_newline(reader: &mut impl BufRead, budget: u64) -> io::Result<(u64, DrainEnd)> {
    let mut skipped: u64 = 0;
    loop {
        let chunk = reader.fill_buf()?;
        if chunk.is_empty() {
            return Ok((skipped, DrainEnd::Eof));
        }
        match chunk.iter().position(|b| *b == b'\n') {
            Some(i) => {
                reader.consume(i + 1);
                return Ok((skipped + i as u64 + 1, DrainEnd::Newline));
            }
            None => {
                let len = chunk.len();
                reader.consume(len);
                skipped += len as u64;
                if skipped >= budget {
                    return Ok((skipped, DrainEnd::Budget));
                }
            }
        }
    }
}

/// Head-probe budget used by the session listing: enough records to pass the
/// `mode`/`permission-mode`/`attachment` preamble and reach the first user
/// message and the CLI's `ai-title`.
pub const HEAD_RECORDS: usize = 400;
/// Byte ceiling for [`probe_head`] — a single hook attachment record can be
/// huge, so cap the work per file regardless of record count.
pub const HEAD_BYTES: u64 = 2 * 1024 * 1024;
/// [`probe_cwd`] budget. The `cwd` sits within the first few records (median
/// offset in the real corpus: ~4 KB), but the preamble carries none, so the
/// budget is generous — it is a backstop against a pathological file, not a
/// tuning knob, and a normal transcript stops at its first `cwd` long before it.
const CWD_RECORDS: usize = 256;
const CWD_BYTES: u64 = 1024 * 1024;
/// Records bigger than this are counted against the budget but not parsed: a
/// record this size is a hook attachment or a pasted blob, never the small
/// `cwd`/title record we are looking for.
const MAX_RECORD_BYTES: u64 = 256 * 1024;

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::Duration;

    fn temp_root(tag: &str) -> PathBuf {
        static N: AtomicU64 = AtomicU64::new(0);
        let d = std::env::temp_dir().join(format!(
            "mt-scan-{}-{}-{tag}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn write(root: &Path, slug: &str, uuid: &str, body: &str) -> PathBuf {
        let dir = root.join(slug);
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join(format!("{uuid}.jsonl"));
        std::fs::write(&p, body).unwrap();
        p
    }

    #[test]
    fn scan_finds_transcripts_and_skips_non_jsonl() {
        let root = temp_root("find");
        write(&root, "-home-jun-a", "u1", "{}\n");
        write(&root, "-home-jun-b", "u2", "{}\n");
        std::fs::write(root.join("-home-jun-a").join("notes.txt"), "x").unwrap();
        // A stray file directly at the root is not a project directory.
        std::fs::write(root.join("stray.jsonl"), "{}\n").unwrap();

        let mut got: Vec<String> = scan_transcripts(&root, &ScanOpts::default())
            .unwrap()
            .into_iter()
            .map(|t| t.uuid)
            .collect();
        got.sort();
        assert_eq!(got, vec!["u1", "u2"]);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn scan_skips_tmp_slugs_only_when_asked() {
        let root = temp_root("tmp");
        write(&root, "-home-jun-a", "keep", "{}\n");
        write(&root, "-tmp-scratch", "drop", "{}\n");

        let all = scan_transcripts(&root, &ScanOpts::default()).unwrap();
        assert_eq!(all.len(), 2);
        let kept = scan_transcripts(
            &root,
            &ScanOpts { skip_tmp_slugs: true, ..Default::default() },
        )
        .unwrap();
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].uuid, "keep");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn scan_applies_mtime_cutoff() {
        let root = temp_root("mtime");
        write(&root, "-home-jun-a", "u1", "{}\n");
        // Everything just written is newer than "an hour ago" and older than
        // "an hour from now".
        let past = SystemTime::now() - Duration::from_secs(3600);
        let future = SystemTime::now() + Duration::from_secs(3600);
        assert_eq!(
            scan_transcripts(&root, &ScanOpts { modified_since: Some(past), ..Default::default() })
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            scan_transcripts(
                &root,
                &ScanOpts { modified_since: Some(future), ..Default::default() }
            )
            .unwrap()
            .len(),
            0
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn scan_missing_root_is_an_error() {
        let root = temp_root("missing");
        assert!(scan_transcripts(&root.join("nope"), &ScanOpts::default()).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    const SAMPLE: &str = concat!(
        r#"{"type":"mode","mode":"normal"}"#,
        "\n",
        "not json at all\n",
        r#"{"type":"user","cwd":"/home/jun/proj","timestamp":"2026-08-01T10:00:00Z","message":{"role":"user","content":"첫 프롬프트\n둘째 줄"}}"#,
        "\n",
        r#"{"type":"assistant","cwd":"/elsewhere","timestamp":"2026-08-02T11:00:00Z","message":{"role":"assistant","content":[]}}"#,
        "\n",
        r#"{"type":"user","timestamp":"2026-08-03T12:00:00Z","message":{"role":"user","content":"둘째 프롬프트"}}"#,
        "\n",
    );

    #[test]
    fn probe_takes_first_cwd_first_prompt_and_last_date() {
        let p = probe_transcript(SAMPLE);
        assert_eq!(p.cwd.as_deref(), Some("/home/jun/proj"));
        assert_eq!(p.date.as_deref(), Some("2026-08-03"));
        assert_eq!(p.first_prompt.as_deref(), Some("첫 프롬프트\n둘째 줄"));
        assert!(!p.is_extraction);
    }

    #[test]
    fn probe_flags_our_own_extraction_transcripts() {
        let line = format!(
            r#"{{"type":"user","cwd":"/tmp/x","message":{{"role":"user","content":"{} 어쩌고"}}}}"#,
            crate::knowledge::EXTRACTION_MARKER
        );
        assert!(probe_transcript(&line).is_extraction);
    }

    #[test]
    fn title_prefers_ai_title_then_first_prompt_line() {
        let p = probe_transcript(SAMPLE);
        // No ai-title record → first prompt's first line, char-truncated.
        assert_eq!(p.title(40).as_deref(), Some("첫 프롬프트"));
        assert_eq!(p.title(3).as_deref(), Some("첫 프…")); // 문자 단위 절단(바이트 아님)

        let with_title = format!("{SAMPLE}{}\n", r#"{"type":"ai-title","aiTitle":"멋진 제목"}"#);
        assert_eq!(probe_transcript(&with_title).title(40).as_deref(), Some("멋진 제목"));
    }

    #[test]
    fn title_is_none_without_any_prompt() {
        assert_eq!(probe_transcript(r#"{"type":"mode"}"#).title(40), None);
    }

    #[test]
    fn probe_head_stops_at_the_record_budget() {
        let root = temp_root("head");
        let path = write(&root, "-p", "u", SAMPLE);
        // Only the preamble + first user record: the later 2026-08-03 timestamp
        // is beyond the budget, so the head's date stops at the first record
        // that carried one.
        let head = probe_head(&path, 3, HEAD_BYTES).unwrap();
        assert_eq!(head.cwd.as_deref(), Some("/home/jun/proj"));
        assert_eq!(head.date.as_deref(), Some("2026-08-01"));
        // Full budget reaches the end and matches the in-memory probe.
        let full = probe_head(&path, HEAD_RECORDS, HEAD_BYTES).unwrap();
        assert_eq!(full.date.as_deref(), Some("2026-08-03"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn probe_cwd_stops_at_the_first_record_that_has_one() {
        let root = temp_root("cwdonly");
        let path = write(&root, "-p", "u", SAMPLE);
        assert_eq!(probe_cwd(&path).unwrap().as_deref(), Some("/home/jun/proj"));
        // A transcript that never records a cwd yields None rather than hanging
        // on the record budget.
        let none = write(&root, "-p", "v", "{\"type\":\"mode\"}\n");
        assert_eq!(probe_cwd(&none).unwrap(), None);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Regression (review #5): a fat preamble used to end the scan at the first
    /// record that crossed the byte budget, so the `cwd` that came right after it
    /// was never seen and the session vanished from the listing without a trace.
    #[test]
    fn probe_cwd_survives_a_huge_preamble_record() {
        let root = temp_root("fatpreamble");
        // One hook-attachment-sized record (bigger than the per-record parse cap),
        // then the ordinary record that actually carries the cwd.
        let blob = "x".repeat(600_000);
        let body = format!(
            "{}\n{}\n",
            format_args!(r#"{{"type":"attachment","content":"{blob}"}}"#),
            r#"{"type":"user","cwd":"/home/jun/proj","message":{"role":"user","content":"안녕"}}"#
        );
        let path = write(&root, "-p", "u", &body);
        assert_eq!(probe_cwd(&path).unwrap().as_deref(), Some("/home/jun/proj"));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Audit B4: the byte budget has to constrain the read, not merely describe
    /// it afterwards. One gigantic record must neither be pulled into memory in
    /// full nor be drained all the way through.
    #[test]
    fn one_gigantic_record_neither_buffers_nor_reads_past_the_budget() {
        let root = temp_root("giant");
        // 8 MiB on a single line — 8× the total budget, 32× the per-record cap.
        let giant = "x".repeat(8 * 1024 * 1024);
        let body = format!(
            "{}\n{}\n",
            format_args!(r#"{{"type":"attachment","content":"{giant}"}}"#),
            r#"{"type":"user","cwd":"/home/jun/proj","message":{"role":"user","content":"안녕"}}"#
        );
        let path = write(&root, "-p", "u", &body);
        assert!(body.len() as u64 > 8 * CWD_BYTES, "fixture must dwarf the budget");

        let scan = fold_head(&path, CWD_RECORDS, CWD_BYTES, |p| p.cwd.is_some()).unwrap();
        // Memory: never held more than one record's cap at a time.
        assert!(
            scan.peak_buffer <= MAX_RECORD_BYTES,
            "buffered {} bytes against a {MAX_RECORD_BYTES} cap",
            scan.peak_buffer
        );
        // IO: stopped inside the record instead of reading all 8 MiB to find its
        // newline. The bound is the budget plus the one buffer already in hand.
        assert!(
            scan.bytes_read <= CWD_BYTES + MAX_RECORD_BYTES,
            "read {} bytes for a {CWD_BYTES}-byte budget",
            scan.bytes_read
        );
        // The budget really was spent, so the record after it is out of reach —
        // and probe_cwd says so on stderr instead of dropping it in silence.
        assert!(scan.exhausted);
        assert_eq!(scan.probe.cwd, None);
        assert_eq!(probe_cwd(&path).unwrap(), None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn an_oversized_record_is_drained_and_the_scan_continues() {
        let root = temp_root("drain");
        // Past the per-record cap, but draining it still leaves budget — so the
        // cwd on the next line must be found, and nothing is buffered past cap.
        let blob = "y".repeat(400 * 1024);
        let body = format!(
            "{}\n{}\n",
            format_args!(r#"{{"type":"attachment","content":"{blob}"}}"#),
            r#"{"type":"user","cwd":"/home/jun/proj","message":{"role":"user","content":"안녕"}}"#
        );
        let path = write(&root, "-p", "u", &body);
        let scan = fold_head(&path, CWD_RECORDS, CWD_BYTES, |p| p.cwd.is_some()).unwrap();
        assert_eq!(scan.probe.cwd.as_deref(), Some("/home/jun/proj"));
        assert!(!scan.exhausted);
        assert!(scan.peak_buffer <= MAX_RECORD_BYTES);
        // Every byte of the record was accounted for, drained ones included.
        assert!(scan.bytes_read >= blob.len() as u64);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_record_running_to_eof_without_a_newline_is_not_a_budget_failure() {
        let root = temp_root("eofdrain");
        // Oversized *and* unterminated: the scan ends because the file did, so
        // probe_cwd must not report a spent budget for it.
        let path = write(&root, "-p", "u", &format!("{{\"pad\":\"{}\"", "z".repeat(400 * 1024)));
        let scan = fold_head(&path, CWD_RECORDS, CWD_BYTES, |p| p.cwd.is_some()).unwrap();
        assert!(!scan.exhausted);
        assert!(scan.peak_buffer <= MAX_RECORD_BYTES);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn fold_head_reports_whether_a_budget_ran_out() {
        let root = temp_root("exhausted");
        let path = write(&root, "-p", "u", SAMPLE);
        // Stops on the caller's condition → not exhausted.
        let hit = fold_head(&path, 64, 1 << 20, |p| p.cwd.is_some()).unwrap();
        assert!(!hit.exhausted);
        // Reaches EOF without ever matching → not exhausted either (the file
        // genuinely has nothing, which is not a budget problem).
        let none = fold_head(&path, 64, 1 << 20, |_| false).unwrap();
        assert!(!none.exhausted);
        // Runs out of records → exhausted.
        let cut = fold_head(&path, 1, 1 << 20, |p| p.first_prompt.is_some()).unwrap();
        assert!(cut.exhausted);
        // Runs out of bytes → exhausted.
        let cut = fold_head(&path, 64, 1, |p| p.first_prompt.is_some()).unwrap();
        assert!(cut.exhausted);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn probe_head_never_splits_a_long_record() {
        let root = temp_root("longline");
        let big = "x".repeat(200_000);
        let body = format!(
            "{}\n{}\n",
            format_args!(r#"{{"type":"user","cwd":"/home/jun/p","message":{{"role":"user","content":"{big}"}}}}"#),
            r#"{"type":"ai-title","aiTitle":"뒷줄 제목"}"#
        );
        let path = write(&root, "-p", "u", &body);
        // max_bytes is below the first record's length: it is still read whole
        // (so the JSON parses), and the scan then stops.
        let head = probe_head(&path, HEAD_RECORDS, 1024).unwrap();
        assert_eq!(head.cwd.as_deref(), Some("/home/jun/p"));
        assert_eq!(head.ai_title, None); // stopped before the second record
        let _ = std::fs::remove_dir_all(&root);
    }
}

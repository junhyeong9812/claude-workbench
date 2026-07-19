//! `archive-backfill` — 기존 로컬 세션(~/.claude/projects)을 일괄 아카이브하는
//! CLI. 앱 GUI 없이 core 파이프라인(normalize → write_archive → claude 추출 →
//! knowledge → .mcp.json 등록)을 그대로 돌린다.
//!
//! 동시성 모델: **프로젝트 단위 병렬, 프로젝트 내 직렬** — 같은 프로젝트의
//! knowledge/INDEX.md는 공유 자원이라(write_knowledge 참조) 세션 병렬이
//! 금지되고, 서로 다른 프로젝트는 완전히 독립이다.
//!
//! 멱등·자기치유: **summary.md까지 있는** 아카이브만 완료로 보고 skip한다 —
//! core 아카이브만 있고 추출이 실패한 세션은 재실행이 자동으로 재추출한다
//! (리뷰 G2: "추출 실패가 영영 재시도되지 않는" 상태 차단). 추출 실패는
//! ok가 아니라 `부분`으로 집계된다.

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

use core_lib::claude_cli::{run_claude_p, ClaudeOpts};
use core_lib::knowledge::{extraction_prompt, parse_extraction, render_session_for_extraction, write_knowledge};

struct Args {
    days: u64,
    concurrency: usize,
    model: String,
    effort: String,
    projects_root: PathBuf,
    archive_root: PathBuf,
    snapshot_base: PathBuf,
    mcp_bin: PathBuf,
    dry_run: bool,
}

fn die(msg: &str) -> ! {
    eprintln!("archive-backfill: {msg}");
    std::process::exit(2);
}

fn parse_args() -> Args {
    let Some(home) = std::env::var_os("HOME") else {
        die("HOME이 설정돼 있지 않습니다");
    };
    let home = PathBuf::from(home);
    let app_data = home.join(".local/share/com.multiterminal.dev");
    let mut a = Args {
        days: 7,
        concurrency: 3,
        model: "opus".into(),
        effort: "xhigh".into(),
        projects_root: home.join(".claude/projects"),
        archive_root: app_data.join("archive"),
        snapshot_base: app_data,
        mcp_bin: home.join(".local/share/claude-workbench/knowledge-mcp"),
        dry_run: false,
    };
    let mut it = std::env::args().skip(1);
    while let Some(flag) = it.next() {
        let mut val = |it: &mut dyn Iterator<Item = String>| {
            it.next().unwrap_or_else(|| die(&format!("{flag} 뒤에 값이 필요합니다")))
        };
        match flag.as_str() {
            "--days" => {
                a.days = val(&mut it).parse().unwrap_or_else(|_| die("--days는 숫자여야 합니다"))
            }
            "--concurrency" => {
                a.concurrency =
                    val(&mut it).parse().unwrap_or_else(|_| die("--concurrency는 숫자여야 합니다"))
            }
            "--model" => a.model = val(&mut it),
            "--effort" => a.effort = val(&mut it),
            "--projects-root" => a.projects_root = val(&mut it).into(),
            "--archive-root" => a.archive_root = val(&mut it).into(),
            "--snapshot-base" => a.snapshot_base = val(&mut it).into(),
            "--mcp-bin" => a.mcp_bin = val(&mut it).into(),
            "--dry-run" => a.dry_run = true,
            other => die(&format!("알 수 없는 플래그: {other}")),
        }
    }
    a
}

/// A session picked up by the scan.
struct Candidate {
    uuid: String,
    jsonl_path: PathBuf,
}

/// First `cwd` + last timestamp date (YYYY-MM-DD) from the transcript records.
fn probe_transcript(text: &str) -> (Option<String>, Option<String>) {
    let mut cwd = None;
    let mut date = None;
    for line in text.lines() {
        let Some(rec) = core_lib::jsonl::RawRecord::parse_line(line) else { continue };
        if cwd.is_none() {
            cwd = rec.cwd.clone();
        }
        if let Some(ts) = rec.timestamp.as_deref().and_then(|t| t.get(..10)) {
            date = Some(ts.to_string());
        }
    }
    (cwd, date)
}

fn main() {
    let args = parse_args();
    let cutoff = SystemTime::now() - Duration::from_secs(args.days * 24 * 3600);

    // 아카이브 상태: summary까지 있으면 완료(skip), core만 있으면 재추출 대상.
    let mut complete: HashSet<String> = HashSet::new();
    let mut partial: HashSet<String> = HashSet::new();
    for listing in core_lib::archive::list_archives(&args.archive_root) {
        for s in listing.sessions {
            if s.summary_path.is_some() {
                complete.insert(s.meta.uuid);
            } else {
                partial.insert(s.meta.uuid);
            }
        }
    }

    // knowledge-mcp 바이너리 실재 확인 — 없으면 등록을 통째로 생략 (리뷰 G1:
    // 존재하지 않는 명령을 사용자 프로젝트 .mcp.json에 대량 주입 금지).
    let mcp_bin: Option<&Path> = if args.mcp_bin.is_file() {
        Some(&args.mcp_bin)
    } else {
        eprintln!(
            "경고: knowledge-mcp 없음({}) — .mcp.json 등록은 생략합니다",
            args.mcp_bin.display()
        );
        None
    };

    // 스캔: projects_root 1단계 하위의 *.jsonl, mtime 필터.
    let mut candidates: Vec<Candidate> = Vec::new();
    let dirs = std::fs::read_dir(&args.projects_root)
        .unwrap_or_else(|e| die(&format!("projects root 읽기 실패: {e}")));
    for dir in dirs.flatten() {
        if !dir.path().is_dir() {
            continue;
        }
        let Ok(files) = std::fs::read_dir(dir.path()) else { continue };
        for f in files.flatten() {
            let path = f.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let Ok(meta) = f.metadata() else { continue };
            let Ok(mtime) = meta.modified() else { continue };
            if mtime < cutoff {
                continue;
            }
            let Some(uuid) = path.file_stem().map(|s| s.to_string_lossy().to_string()) else {
                continue;
            };
            if complete.contains(&uuid) {
                continue;
            }
            candidates.push(Candidate { uuid, jsonl_path: path });
        }
    }
    println!(
        "후보 {}개 (최근 {}일, 완료 {} skip, 재추출 대상 {}) — model={} effort={} 동시 {}프로젝트",
        candidates.len(),
        args.days,
        complete.len(),
        candidates.iter().filter(|c| partial.contains(&c.uuid)).count(),
        args.model,
        args.effort,
        args.concurrency
    );

    // 프로젝트(cwd)별 그룹핑 — cwd는 레코드에서 읽고, 본문은 여기서 버린다
    // (리뷰 G10: 전 트랜스크립트 동시 메모리 금지 — archive_one이 재읽기).
    let mut by_project: BTreeMap<String, Vec<(Candidate, String)>> = BTreeMap::new();
    let mut skipped_probe = 0usize;
    for c in candidates {
        let Ok(text) = std::fs::read_to_string(&c.jsonl_path) else {
            eprintln!("skip(읽기 실패): {}", c.jsonl_path.display());
            skipped_probe += 1;
            continue;
        };
        let (cwd, date) = probe_transcript(&text);
        drop(text);
        let Some(cwd) = cwd else {
            eprintln!("skip(cwd 레코드 없음): {}", c.uuid);
            skipped_probe += 1;
            continue;
        };
        // 일회성 스크래치 세션(/tmp cwd)은 보존 가치가 없다 — 추출 비용도 아낀다.
        if cwd.starts_with("/tmp/") {
            eprintln!("skip(/tmp 스크래치): {}", c.uuid);
            skipped_probe += 1;
            continue;
        }
        let date = date.unwrap_or_else(|| "unknown".to_string());
        by_project.entry(cwd).or_default().push((c, date));
    }
    println!(
        "프로젝트 {}개, 대상 세션 {}개 (probe skip {})",
        by_project.len(),
        by_project.values().map(Vec::len).sum::<usize>(),
        skipped_probe
    );
    if args.dry_run {
        for (proj, sessions) in &by_project {
            println!("  {proj}: {}개", sessions.len());
        }
        return;
    }

    let opts = ClaudeOpts {
        model: Some(args.model.clone()),
        effort: Some(args.effort.clone()),
    };
    let queue: Mutex<Vec<(String, Vec<(Candidate, String)>)>> =
        Mutex::new(by_project.into_iter().collect());
    // (완전 ok, 부분 — 추출실패, skip, fail)
    let done = Mutex::new((0usize, 0usize, 0usize, 0usize));

    std::thread::scope(|scope| {
        for _ in 0..args.concurrency.max(1) {
            scope.spawn(|| loop {
                let Some((project, sessions)) = queue.lock().unwrap().pop() else { break };
                for (c, date) in sessions {
                    let outcome = archive_one(&args, &opts, mcp_bin, &project, &c, &date);
                    let short = &c.uuid[..8.min(c.uuid.len())];
                    let mut d = done.lock().unwrap();
                    match outcome {
                        Ok((msg, true)) => {
                            d.0 += 1;
                            println!("[ok] {project} {short} — {msg}");
                        }
                        Ok((msg, false)) => {
                            d.1 += 1;
                            println!("[부분(추출실패)] {project} {short} — {msg}");
                        }
                        Err(msg) if msg.starts_with("skip") => {
                            d.2 += 1;
                            println!("[{msg}] {project} {short}");
                        }
                        Err(msg) => {
                            d.3 += 1;
                            eprintln!("[fail] {project} {short} — {msg}");
                        }
                    }
                }
            });
        }
    });

    let (ok, part, skip, fail) = *done.lock().unwrap();
    println!("완료: ok {ok} · 부분(추출실패) {part} · skip {skip} · fail {fail}");
    if part > 0 {
        println!("부분 세션은 재실행 시 자동으로 재추출됩니다 (summary 없는 아카이브 = 재시도 대상).");
    }
}

/// Returns `Ok((message, extraction_ok))` — extraction failure is a *partial*
/// success (core archive landed), never a silent ok (리뷰 G2).
fn archive_one(
    args: &Args,
    opts: &ClaudeOpts,
    mcp_bin: Option<&Path>,
    project: &str,
    c: &Candidate,
    date: &str,
) -> Result<(String, bool), String> {
    let text = std::fs::read_to_string(&c.jsonl_path).map_err(|e| format!("트랜스크립트 읽기: {e}"))?;
    // fallback 제목: 앱 사이드카(.title/.name), 없으면 "Claude".
    let title = core_lib::snapshot::read_title(&args.snapshot_base, project, &c.uuid)
        .or_else(|| core_lib::snapshot::read_name(&args.snapshot_base, project, &c.uuid))
        .unwrap_or_else(|| "Claude".to_string());
    let mut session = core_lib::archive::normalize(project, &c.uuid, &title, date, &text);
    if session.turns.is_empty() {
        return Err("skip(0턴)".to_string());
    }
    let jsonl_bytes = text.as_bytes();

    // ① core 산출물 선착지 (앱 커맨드와 동일한 내구 순서).
    let mut out = core_lib::archive::write_archive(&args.archive_root, project, &session, jsonl_bytes)
        .map_err(|e| format!("write_archive: {e}"))?;

    // ② 추출 — 1회 재시도, 그래도 실패면 부분 성공으로 보고.
    let mut notes = Vec::new();
    let rendered = render_session_for_extraction(&session);
    let prompt = extraction_prompt(&rendered);
    let mut knowledge_files = 0usize;
    let mut extraction_ok = false;
    let raw = run_claude_p(project, &prompt, Duration::from_secs(300), opts)
        .or_else(|e1| {
            notes.push(format!("추출 1차 실패({e1}) — 재시도"));
            run_claude_p(project, &prompt, Duration::from_secs(300), opts)
        });
    match raw {
        Ok(raw) => {
            extraction_ok = true;
            let ex = parse_extraction(&raw);
            let new_title = ex.title.trim();
            if !new_title.is_empty() && new_title != session.title {
                session.title = new_title.to_string();
                match core_lib::archive::write_archive(&args.archive_root, project, &session, jsonl_bytes) {
                    Ok(o) => out = o,
                    Err(e) => notes.push(format!("retitle 실패: {e}")),
                }
            }
            if !ex.summary.trim().is_empty() {
                if let Err(e) = std::fs::write(out.dir.join("summary.md"), &ex.summary) {
                    notes.push(format!("summary 실패: {e}"));
                }
            }
            match write_knowledge(&args.archive_root, project, &c.uuid, date, &ex.entries) {
                Ok(paths) => knowledge_files = paths.len(),
                Err(e) => notes.push(format!("knowledge 실패: {e}")),
            }
        }
        Err(e) => notes.push(format!("추출 실패: {e}")),
    }

    // ③ 프로젝트 폴더가 실재하고 서버 바이너리가 있으면 .mcp.json 등록 (병합·멱등).
    let proj_path = Path::new(project);
    if proj_path.is_dir() {
        if let Some(bin) = mcp_bin {
            let kdir = core_lib::knowledge::knowledge_dir(&args.archive_root, project);
            match core_lib::mcp::register_in_mcp_json(proj_path, bin, &kdir) {
                Ok(true) => notes.push("mcp 등록".to_string()),
                Ok(false) => {}
                Err(e) => notes.push(format!("mcp 등록 실패: {e}")),
            }
        }
    }

    let mut msg = format!("\"{}\" 지식 {}건", session.title, knowledge_files);
    if !notes.is_empty() {
        msg.push_str(&format!(" ({})", notes.join(", ")));
    }
    Ok((msg, extraction_ok))
}

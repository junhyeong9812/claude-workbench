//! `archive-backfill` — 기존 로컬 세션(~/.claude/projects)을 일괄 아카이브하는
//! CLI. 앱 GUI 없이 core 파이프라인(normalize → write_archive → claude 추출 →
//! knowledge → .mcp.json 등록)을 그대로 돌린다.
//!
//! 동시성 모델: **프로젝트 단위 병렬, 프로젝트 내 직렬** — 같은 프로젝트의
//! knowledge/INDEX.md는 공유 자원이라(write_knowledge 참조) 세션 병렬이
//! 금지되고, 서로 다른 프로젝트는 완전히 독립이다.
//!
//! 멱등·자기치유: **추출이 온전히 끝난**(summary.md + `.extraction-ok` 마커)
//! 아카이브만 완료로 보고 skip한다 — 판정식은 `core::archive` 단일 출처
//! (`is_extraction_complete`)라 앱 GUI의 "변경 없음" 판정과 절대 갈라지지
//! 않는다. 추출이 실패했거나 부분 실패한 세션(마커 없음)은 재실행이 자동으로
//! 재추출한다 (리뷰 G2: "추출 실패가 영영 재시도되지 않는" 상태 차단). 추출
//! 실패는 ok가 아니라 `부분`으로 집계된다.

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

use core_lib::claude_cli::ClaudeOpts;

struct Args {
    days: u64,
    /// 이번 실행에서 처리할 최대 세션 수 (mtime 최신순) — 0 = 무제한.
    limit: usize,
    concurrency: usize,
    model: String,
    effort: String,
    projects_root: PathBuf,
    archive_root: PathBuf,
    snapshot_base: PathBuf,
    mcp_bin: PathBuf,
    /// cwd에 이 부분 문자열이 들어가는 프로젝트는 제외 (반복 지정 가능) —
    /// 실험용 프로젝트(acp-test 등)를 백필에서 영구 배제.
    exclude: Vec<String>,
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
        limit: 0,
        concurrency: 3,
        model: "opus".into(),
        effort: "xhigh".into(),
        projects_root: home.join(".claude/projects"),
        archive_root: app_data.join("archive"),
        snapshot_base: app_data,
        mcp_bin: home.join(".local/share/claude-workbench/knowledge-mcp"),
        exclude: Vec::new(),
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
            "--limit" => {
                a.limit = val(&mut it).parse().unwrap_or_else(|_| die("--limit는 숫자여야 합니다"))
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
            "--exclude" => a.exclude.push(val(&mut it)),
            "--dry-run" => a.dry_run = true,
            other => die(&format!("알 수 없는 플래그: {other}")),
        }
    }
    a
}

/// A session picked up by the scan. `core::scan::Transcript` plus nothing — the
/// alias keeps the pipeline's vocabulary while the scan itself lives in core.
type Candidate = core_lib::scan::Transcript;

fn main() {
    let args = parse_args();
    let cutoff = SystemTime::now() - Duration::from_secs(args.days * 24 * 3600);

    // 아카이브 상태 프리스캔 — **비용 최적화**일 뿐, 정본 판정은 run_archive
    // 내부의 is_unchanged_complete(마커 + 내용 동일) 하나다(리뷰: 프리스캔이
    // 마커만 보면 자란 전사가 영영 백필되지 않아 GUI 판정과 갈라진다).
    // 여기서는 "추출 완료" 세션만 표시해 두고, 후보 단계에서 내용 비교를
    // 통과한 것만 제외한다. 마커 도입 이전 백필분은 재추출 대상으로 잡혀
    // 한 번 재추출되고, 그때 마커가 남아 이후로는 양쪽 다 스킵(자기치유).
    // uuid가 두 프로젝트에 존재하면(cwd 변경 세션 — 실측 존재) 어느 쪽이
    // 이 전사의 아카이브인지 프리스캔 단계에선 모른다 → None(모호)로 두고
    // 후보를 유지한다. 정본 판정은 run_archive(프로젝트 스코프 조회)가 한다.
    let mut complete: std::collections::HashMap<String, Option<core_lib::archive::ArchiveSessionEntry>> =
        std::collections::HashMap::new();
    let mut partial: HashSet<String> = HashSet::new();
    for listing in core_lib::archive::list_archives(&args.archive_root) {
        for s in listing.sessions {
            if core_lib::archive::is_extraction_complete(&s) {
                let uuid = s.meta.uuid.clone();
                match complete.entry(uuid) {
                    std::collections::hash_map::Entry::Occupied(mut o) => {
                        o.insert(None); // 충돌 = 모호
                    }
                    std::collections::hash_map::Entry::Vacant(v) => {
                        v.insert(Some(s));
                    }
                }
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

    // 스캔: projects_root 1단계 하위의 *.jsonl, mtime 필터 — 로직 정본은
    // core::scan(앱의 외부 세션 목록과 같은 코드). /tmp cwd의 슬러그("-tmp-…")
    // 제외는 스캔 레벨 옵션: 추출 스크래치 트랜스크립트가 mtime 최신이라
    // --limit 슬롯을 전부 삼키는 것을 막는다(limit은 probe 전에 걸린다).
    let scanned = core_lib::scan::scan_transcripts(
        &args.projects_root,
        &core_lib::scan::ScanOpts {
            skip_tmp_slugs: true,
            modified_since: Some(cutoff),
        },
    )
    .unwrap_or_else(|e| die(&format!("projects root 읽기 실패: {e}")));
    let mut candidates: Vec<Candidate> = Vec::new();
    for c in scanned {
        // 완료여도 전사가 자랐으면 후보 유지 — GUI is_unchanged_complete와
        // 같은 내용 비교(라이브 stat vs 아카이브 meta).
        if let Some(Some(entry)) = complete.get(&c.uuid) {
            if core_lib::archive::live_matches_archive(&c.path, entry) {
                continue;
            }
        }
        candidates.push(c);
    }
    // --limit N: 최신 세션부터 N개만 (0 = 무제한) — "최근 것 50개 더" 류의
    // 점진 백필용.
    if args.limit > 0 && candidates.len() > args.limit {
        candidates.sort_by(|a, b| b.mtime.cmp(&a.mtime));
        candidates.truncate(args.limit);
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
        let Ok(text) = std::fs::read_to_string(&c.path) else {
            eprintln!("skip(읽기 실패): {}", c.path.display());
            skipped_probe += 1;
            continue;
        };
        let core_lib::scan::Probe { cwd, date, is_extraction, .. } =
            core_lib::scan::probe_transcript(&text);
        drop(text);
        if is_extraction {
            eprintln!("skip(추출 세션 — 우리 도구의 부산물): {}", c.uuid);
            skipped_probe += 1;
            continue;
        }
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
        if let Some(pat) = args.exclude.iter().find(|e| cwd.contains(e.as_str())) {
            eprintln!("skip(--exclude {pat}): {}", c.uuid);
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
        ..Default::default()
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
        println!("부분 세션은 재실행 시 자동으로 재추출됩니다 (.extraction-ok 마커 없는 아카이브 = 재시도 대상).");
    }
}

/// Returns `Ok((message, extraction_ok))` — extraction failure is a *partial*
/// success (core archive landed), never a silent ok (리뷰 G2).
///
/// 파이프라인 본체는 `core::archive::run_archive` — 앱 GUI 커맨드와 **같은**
/// 코드다. 이 함수는 CLI 소유 입력(경로·플래그·재시도 횟수)을 채우고 결과를
/// 한 줄로 보고할 뿐이다.
fn archive_one(
    args: &Args,
    opts: &ClaudeOpts,
    mcp_bin: Option<&Path>,
    project: &str,
    c: &Candidate,
    date: &str,
) -> Result<(String, bool), String> {
    // 바이트 그대로 읽는다 — session.jsonl은 verbatim 복사본이어야 한다.
    // NOTE(P6 단일화의 CLI 동작 변경 — 문서화): 구 CLI는 read_to_string이라
    // 비-UTF8 전사를 스킵했지만, 이제 GUI와 같이 바이트로 읽어 verbatim 복사
    // 계약을 지킨다(normalized만 lossy).
    let jsonl_bytes = std::fs::read(&c.path).map_err(|e| format!("트랜스크립트 읽기: {e}"))?;
    // fallback 제목: 앱 사이드카(.title/.name), 없으면 "Claude".
    let title = core_lib::snapshot::read_title(&args.snapshot_base, project, &c.uuid)
        .or_else(|| core_lib::snapshot::read_name(&args.snapshot_base, project, &c.uuid))
        .unwrap_or_else(|| "Claude".to_string());

    let extract = core_lib::archive::claude_extractor(opts, Duration::from_secs(300));
    let run = core_lib::archive::run_archive(
        &core_lib::archive::ArchiveRequest {
            archive_root: &args.archive_root,
            project,
            uuid: &c.uuid,
            fallback_title: &title,
            date,
            jsonl_bytes: &jsonl_bytes,
            mcp_bin,
            // 무인 대량 실행 — 일시적 추출 실패는 1회 재시도로 흡수한다.
            attempts: 2,
            // 백필은 일반 세션만 다룬다(정리 세션 전사는 스캔 단계에서 이미
            // 제외된다) — 라벨 없음 + 추출 그대로.
            kind: None,
            skip_extraction: false,
            summary: None,
        },
        &extract,
    )
    .map_err(|e| match e {
        core_lib::archive::ArchiveError::NoTurns => "skip(0턴)".to_string(),
        core_lib::archive::ArchiveError::Write(e) => format!("write_archive: {e}"),
    })?;

    if run.unchanged {
        return Err("skip(변경 없음)".to_string());
    }
    let mut msg = format!("\"{}\" 지식 {}건", run.title, run.knowledge_files);
    let warnings = run.all_warnings();
    if !warnings.is_empty() {
        msg.push_str(&format!(" ({})", warnings.join(", ")));
    }
    Ok((msg, run.extraction_complete()))
}

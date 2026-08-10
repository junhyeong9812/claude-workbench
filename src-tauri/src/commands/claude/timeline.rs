//! 타임라인 tail·폴링(payload 조립·완료 전이·부모 추론·스냅샷 debounce) —
//! P5 B-c 분할. 순수 함수 5종(cap_content·file_sig·advance_stability·
//! ordered_frames·subagent_parent[_memo])은 특성테스트가 고정(P0~P1).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use core_lib::{TimelineItem, TokenUsage};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

/// The full timeline snapshot for a Claude session, emitted as `claude-timeline`
/// whenever a poll observed any change. Carries the change items **and** the
/// derived conversation turns/answers/dates, so the UI shows plain Q&A turns
/// (no tool calls) too — not only tool items. Re-sending the whole (modest)
/// state keeps the frontend a simple replace.
#[derive(Clone, Serialize)]
struct ClaudeTimelinePayload {
    id: u64,
    items: Vec<TimelineItem>,
    turns: Vec<(u64, String)>,
    answers: Vec<(u64, String)>,
    dates: Vec<(u64, String)>,
    tokens: Vec<(u64, TokenUsage)>,
    /// Current assistant model id (e.g. `claude-opus-4-8`), or `None` if not yet
    /// seen — the frontend maps it to a context-window size for the usage gauge.
    model: Option<String>,
    /// Most recent assistant message's usage = current context occupancy (the gauge
    /// numerator). Distinct from `tokens`, which sums a turn's tool round-trips.
    last_usage: Option<TokenUsage>,
    /// Per-subagent (`Agent`/`Task`) frames in discovery order. Live agents carry
    /// their items inline; **finished** ones carry meta only and the frontend
    /// fetches the body on expand (`claude_subagent_items`) — see
    /// [`SubagentFrame`].
    subagents: Vec<SubagentFrame>,
}

/// One subagent's frame in the payload.
///
/// 메모리 1단계(2026-08-10): 완료 서브에이전트의 items를 매 emit마다 다시 실어
/// 보내던 것이 payload의 **77%**(실측 24.8MB 중 19.2MB)였다. 완료 프레임은
/// 정의상 "더 안 변하는 파일"의 캐시이므로 본문을 빼고(`items: None`) 메타만
/// 싣는다 — 그룹 헤더(진행도·상태)는 메타로 그대로 그려지고, 본문은 사용자가
/// 펼칠 때 `claude_subagent_items`로 조회한다(`claude_item_detail`과 동형).
#[derive(Clone, Serialize)]
struct SubagentFrame {
    id: String,
    /// The timeline item (the spawning `Agent` tool call) the agent nests under —
    /// found by matching the agent id inside that call's result. `None` ⇒ no
    /// known parent (nest under its `turn`). Enables the recursive agent tree.
    parent: Option<String>,
    turn: u64,
    /// 아이템 수(진행도 분모) — 본문이 빠져도 헤더가 같은 값을 보인다.
    total: usize,
    /// `completed` 아이템 수(진행도 분자).
    completed: usize,
    /// 마지막 아이템의 상태 — 본문 없이도 "진행 중" 표시가 동일하게 나온다.
    last_status: Option<core_lib::AgentStatus>,
    /// 본문 캐시 무효화 키 = **파일 서명**(len·mtime ns의 문자열). 완료
    /// 에이전트가 재활성→재구축→재완료하면 transcript 파일이 달라져 서명이
    /// 바뀌므로(AA2 — 듀얼 리뷰 codex), 프론트가 들고 있던 lazy 본문이 stale임을
    /// 안다. revision 합만으로는 재구축 시 revision이 리셋되어 같은 합·다른 내용을
    /// 낼 수 있었다(그 재활성은 백엔드 fp의 `sub_gen`엔 반영됐지만 payload엔
    /// 안 실렸다). 파일 서명은 백엔드가 완료 판정에 이미 쓰는 신호이고, 완료
    /// 안정 구간(DONE_STREAK)엔 값이 고정이라 활성→완료 전이에도 동일하다
    /// (활성 프레임은 인라인 본문이라 서명이 없어도 무방 — `None`).
    sig: Option<String>,
    /// 활성 프레임의 본문. 완료(보존) 프레임은 `None` = "펼칠 때 조회하라".
    items: Option<Vec<TimelineItem>>,
}

/// `FileSig`를 payload용 문자열 서명으로 — u128 mtime은 JS number로 정밀도를
/// 잃으므로 문자열로 싣는다(프론트는 동등성만 본다).
fn sig_string(sig: FileSig) -> String {
    format!("{}-{}", sig.0, sig.1)
}

/// 서브에이전트의 부모(스폰한 `Agent`/`Task` 툴콜) 추론 — 순수 (P0 B1).
/// main 타임라인 → *다른* 에이전트 순으로 첫 매치(결과 텍스트가 agent id를
/// 언급하는 아이템). 자기 transcript는 제외 — 자기 id 에코가 self-parent가
/// 되어 트리에서 사라지는 회귀 방지(codex B1 F1). 동작 보존: 기존 인라인
/// 체인 스캔과 동일한 순회 순서·판정(특성테스트 subagent_parent_*).
/// P1: 표시 계층 content_text 상한 — payload·스냅샷에서만 절단(원본 JSONL·
/// 아카이브는 전문 유지). 절단 아이템은 `content_truncated`로 표시되고
/// 뷰어가 `claude_item_detail`로 원문을 lazy 조회한다.
///
/// 메모리 1단계(2026-08-10): 32KB는 실측상 사실상 무효였다 — 1,591개 중 상한을
/// 넘는 아이템이 59개뿐이라 payload는 24.8MB 그대로였다. 문제는 "거대 아이템"이
/// 아니라 "평균 3KB × 1,591개"이므로 상한을 4KB로 내려 평균 아이템에 실효화한다
/// (메인 5.63MB → 5.24MB, 절단 아이템 59→73개). 2KB는 추가 0.22MB를 얻는 대신
/// 절단 아이템이 148개로 두 배가 되어(그만큼 원문 조회 왕복이 늘어난다) 4KB를
/// 택했다. 절단본은 `content_truncated` + `claude_item_detail` 원문 조회가
/// 이미 덮고 있어 표시 손실은 없다.
pub(super) const CONTENT_CAP: usize = 4 * 1024;

/// UTF-8 경계 보존 절단 — 순수 (P1 특성테스트 대상).
pub(super) fn cap_content(items: &mut [TimelineItem]) {
    for it in items.iter_mut() {
        if let Some(ct) = &it.content_text {
            if ct.len() > CONTENT_CAP {
                let mut n = CONTENT_CAP;
                while n > 0 && !ct.is_char_boundary(n) {
                    n -= 1;
                }
                it.content_text = Some(ct[..n].to_string());
                it.content_truncated = true;
            }
        }
    }
}

/// 파일 서명 (len, mtime ns) — 완료 판정·재활성 감지 입력 (P0 B2, 리뷰
/// 재수정: len 단독은 truncate·동일 길이 재작성·mtime-only 변경을 놓친다).
pub(super) type FileSig = (u64, u128);

fn file_sig(p: &std::path::Path) -> Option<FileSig> {
    let m = std::fs::metadata(p).ok()?;
    let mt = m
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_nanos();
    Some((m.len(), mt))
}

/// P0 B2: 완료된 서브에이전트의 보존 프레임 — tail(파서·버퍼·폴링)은 드롭하고
/// payload에 계속 실릴 items만 남긴다. `sig`는 완료 판정 시점의 파일 서명 —
/// 서명이 달라지면(성장·축소·재작성) tail을 재생성해 재개한다.
pub(super) struct DoneSub {
    pub(super) turn: u64,
    pub(super) sig: FileSig,
    pub(super) items: Vec<TimelineItem>,
    pub(super) rev: u32,
}

/// 파일 서명 안정 스트릭 전이 — 순수 (P0 B2 특성테스트 대상).
/// 서명 동일 → +1 · 서명 변화 → 리셋 · **metadata 실패(None) → 진행하지
/// 않고 리셋**(리뷰: 실패 40회 누적으로 완료 오판하던 경로 차단).
pub(super) fn advance_stability(
    prev: (Option<FileSig>, u32),
    sig: Option<FileSig>,
) -> (Option<FileSig>, u32) {
    match (prev.0, sig) {
        (Some(a), Some(b)) if a == b => (Some(a), prev.1 + 1),
        (_, Some(b)) => (Some(b), 0),
        (_, None) => (prev.0, 0),
    }
}

/// 한 서브에이전트의 조립된 프레임 — items는 **빌려온다**(clone 없음).
/// `done`은 이 프레임이 완료 보존(sub_done) 출처라는 뜻 = payload에서 본문을
/// 빼고 메타만 싣는 대상.
pub(super) struct Frame<'a> {
    pub(super) aid: String,
    pub(super) turn: u64,
    pub(super) items: &'a [TimelineItem],
    pub(super) done: bool,
    /// 본문 캐시 무효화용 파일 서명(AA2). 완료 프레임 = 완료 시점 서명, 활성
    /// 프레임 = 이번 틱의 서명(전이 시 완료 서명과 일치 — 안정 구간이라 고정),
    /// 서명 조회 실패 = `None`.
    pub(super) sig: Option<FileSig>,
}

/// 활성 + 완료 프레임을 **발견 순서**로 조립 — 순수 (P0 B2, 리뷰 재수정:
/// active-뒤-done 병합은 순회 순서를 바꿔 미확정 부모의 first-match 후보
/// 순위를 흔든다. 발견 순서는 결정적이며 기존 HashMap 비결정 순회의 유효한
/// 정밀화 — spec §2 B2 순서 명세는 log에 기록).
/// 보존 계약: 완료 에이전트의 (aid, turn, items)가 계속 포함되고, 재활성
/// 재파싱이 끝나 active items가 비어 있지 않으면 active가 우선한다.
///
/// 메모리 1단계(2026-08-10): 반환을 소유(Vec<TimelineItem>)에서 차용(&[..])으로
/// 바꿨다 — 이 함수가 매 emit마다 `sub_done`의 items를 통째로 clone하던 것이
/// Rust 쪽 13MB/emit 처닝의 정체였다. 순서·우선순위 판정은 그대로다(`active`를
/// 소비하며 `remove`하던 것이 `get`으로 바뀌었지만 `order`에 중복 aid가 없어
/// — 호출부가 `contains` 검사로 push한다 — 결과 동일).
pub(super) fn ordered_frames<'a>(
    order: &[String],
    active: &HashMap<String, (u64, &'a [TimelineItem])>,
    active_sig: &HashMap<String, FileSig>,
    done: &'a HashMap<String, DoneSub>,
) -> Vec<Frame<'a>> {
    let mut out = Vec::new();
    for aid in order {
        if let Some((turn, items)) = active.get(aid) {
            if !items.is_empty() {
                out.push(Frame {
                    aid: aid.clone(),
                    turn: *turn,
                    items,
                    done: false,
                    sig: active_sig.get(aid).copied(),
                });
                continue;
            }
            // 활성이지만 아직 빈 tail(재활성 재파싱 전 등) — done 폴백 시도.
        }
        if let Some(d) = done.get(aid) {
            out.push(Frame {
                aid: aid.clone(),
                turn: d.turn,
                items: &d.items,
                done: true,
                sig: Some(d.sig),
            });
        }
    }
    out
}

/// 프레임 → payload 항목 — 순수 (메모리 1단계 B).
///
/// 완료(보존) 프레임은 **본문을 싣지 않는다** — clone도 직렬화도 하지 않고
/// 메타(진행도·상태·rev)만 보낸다. 활성 프레임만 items를 복사·절단해 인라인한다
/// (진행 중 에이전트는 아직 작고, 실시간 표시가 조회 왕복을 견디지 못한다).
/// 메타는 **절단 전 원본 items**에서 세므로 본문 유무와 무관하게 같은 값이다.
fn payload_frames(sub_raw: &[Frame<'_>], parents: Vec<Option<String>>) -> Vec<SubagentFrame> {
    sub_raw
        .iter()
        .zip(parents)
        .map(|(f, parent)| SubagentFrame {
            id: f.aid.clone(),
            parent,
            turn: f.turn,
            total: f.items.len(),
            completed: f
                .items
                .iter()
                .filter(|i| i.agent_status == core_lib::AgentStatus::Completed)
                .count(),
            last_status: f.items.last().map(|i| i.agent_status),
            sig: f.sig.map(sig_string),
            items: (!f.done).then(|| {
                let mut its = f.items.to_vec();
                cap_content(&mut its);
                its
            }),
        })
        .collect()
}

/// emit 최소 간격 게이트 — 순수 (메모리 1단계 C). 폴 주기(150ms)는 그대로 두고
/// **전송만** 디바운스한다. 반환 = (이번 틱에 emit할까, 다음 틱으로 넘길 pending).
///
/// **trailing edge 보장**: 변화가 있었다는 사실(`pending`)은 실제로 보낼 때까지
/// 지워지지 않는다. 스트리밍이 멎어 더 이상 변화가 없어도 폴은 계속 돌므로,
/// 마지막 상태는 간격이 지난 첫 틱(≤150ms 뒤)에 반드시 착지한다 — 화면이 낡은
/// 채 남지 않는다. payload는 emit 시점의 tail에서 새로 조립되므로 언제나 최신이다
/// (합쳐진 중간 상태를 보내지 않는다).
pub(super) fn emit_gate(
    changed: bool,
    pending: bool,
    since_last_emit: Duration,
    min_interval: Duration,
) -> (bool, bool) {
    let pending = pending || changed;
    if pending && since_last_emit >= min_interval {
        (true, false)
    } else {
        (false, pending)
    }
}

/// payload 조립 + `claude-timeline` emit — 폴 루프의 정상 틱과 종료 flush(AA1)가
/// **같은 경로**를 쓰도록 추출. items·turns·answers 등을 t에서 새로 복사하고,
/// 서브에이전트 프레임을 발견 순서로 조립해(활성=본문 인라인, 완료=메타만) 보낸다.
#[allow(clippy::too_many_arguments)]
fn assemble_and_emit(
    app: &AppHandle,
    id: u64,
    t: &core_lib::jsonl::SessionTail,
    subagents: &HashMap<String, core_lib::jsonl::SessionTail>,
    subagent_turn: &HashMap<String, u64>,
    active_sig: &HashMap<String, FileSig>,
    sub_order: &[String],
    sub_done: &HashMap<String, DoneSub>,
    mention_memo: &mut HashMap<(String, String, String), (u32, bool)>,
) {
    let items = t.timeline().items();
    let items_v = items.to_vec();
    let turns_v: Vec<(u64, String)> = t.turns().iter().map(|(k, v)| (*k, v.clone())).collect();
    let answers_v: Vec<(u64, String)> = t.answers().iter().map(|(k, v)| (*k, v.clone())).collect();
    let dates_v: Vec<(u64, String)> = t.dates().iter().map(|(k, v)| (*k, v.clone())).collect();
    let tokens_v: Vec<(u64, TokenUsage)> = t.tokens().iter().map(|(k, v)| (*k, *v)).collect();
    let model_v: Option<String> = t.model().map(str::to_string);
    let last_usage_v: Option<TokenUsage> = t.last_usage();
    // P0 B2: 발견 순서로 활성+완료 프레임 조립(특성테스트 ordered_frames_*)
    // — 완료 프레임 보존 + active(재파싱 완료) 우선 + 결정적 순서.
    let active_map: HashMap<String, (u64, &[TimelineItem])> = subagents
        .iter()
        .map(|(aid, st)| (aid.clone(), (*subagent_turn.get(aid).unwrap_or(&0), st.timeline().items())))
        .collect();
    let sub_raw = ordered_frames(sub_order, &active_map, active_sig, sub_done);
    // 부모 추론은 **절단 전** 원문으로(멘션이 CAP 밖에 있을 수 있다 — P1 절단은
    // 그 뒤 표시용 클론에만 적용). first-match를 매 변경 틱 재계산하되 아이템별
    // contains 판정만 revision 키로 메모(naive와 완전 동치, 비용만 국한).
    let parents: Vec<Option<String>> = sub_raw
        .iter()
        .map(|f| subagent_parent_memo(&f.aid, &items_v, &sub_raw, mention_memo))
        .collect();
    let mut items_p = items_v;
    cap_content(&mut items_p);
    let subagents_v = payload_frames(&sub_raw, parents);
    let _ = app.emit(
        "claude-timeline",
        ClaudeTimelinePayload {
            id,
            items: items_p,
            turns: turns_v,
            answers: answers_v,
            dates: dates_v,
            tokens: tokens_v,
            model: model_v,
            last_usage: last_usage_v,
            subagents: subagents_v,
        },
    );
}

#[cfg_attr(not(test), allow(dead_code))] // 특성테스트의 naive 기준 구현(메모판과 동치 검증용)
pub(super) fn subagent_parent(
    aid: &str,
    main_items: &[TimelineItem],
    sub_raw: &[Frame<'_>],
) -> Option<String> {
    main_items
        .iter()
        .chain(
            sub_raw
                .iter()
                .filter(|f| f.aid != aid)
                .flat_map(|f| f.items.iter()),
        )
        .find(|it| it.content_text.as_deref().is_some_and(|ct| ct.contains(aid)))
        .map(|it| it.tool_call_id.clone())
}

/// P0 B1(리뷰 재수정 — Some-동결 캐시는 "늦게 채워진 상위 후보로의 부모
/// 교체"라는 원본 동작을 잃는다): first-match를 **매 변경 틱 그대로 재계산**
/// 하되, 아이템별 `contains(aid)` 판정만 `(revision)` 키로 메모한다.
/// contains는 content_text에만 의존하고 content_text 변경은 revision bump를
/// 동반하므로(TimelineItem.revision: "Bumped on every merged update"),
/// 결과는 naive 스캔과 **완전 동일**하고 비용만 변경된 아이템으로 국한된다
/// (특성테스트: memo vs naive 동치·revision bump 반영).
pub(super) fn subagent_parent_memo(
    aid: &str,
    main_items: &[TimelineItem],
    sub_raw: &[Frame<'_>],
    memo: &mut HashMap<(String, String, String), (u32, bool)>,
) -> Option<String> {
    // 키 = (aid, **session_id**, tool_call_id) — tool_call_id만으로는 다른
    // 세션(다른 서브에이전트 transcript)의 동일 id와 충돌해 앞 아이템의
    // 판정이 뒤 아이템에 재사용된다(재점검 N1-1). revision 계약은 같은
    // Timeline 안에서만 유효하므로 재파싱 재구축 시 호출부가 해당 소스의
    // 메모를 무효화한다(N1-2 — purge_mention_memo_for_source).
    fn mentions(
        aid: &str,
        it: &TimelineItem,
        memo: &mut HashMap<(String, String, String), (u32, bool)>,
    ) -> bool {
        let key = (aid.to_string(), it.session_id.clone(), it.tool_call_id.clone());
        if let Some((rev, m)) = memo.get(&key) {
            if *rev == it.revision {
                return *m;
            }
        }
        let m = it.content_text.as_deref().is_some_and(|ct| ct.contains(aid));
        memo.insert(key, (it.revision, m));
        m
    }
    for it in main_items {
        if mentions(aid, it, memo) {
            return Some(it.tool_call_id.clone());
        }
    }
    for f in sub_raw {
        if f.aid == aid {
            continue;
        }
        for it in f.items {
            if mentions(aid, it, memo) {
                return Some(it.tool_call_id.clone());
            }
        }
    }
    None
}

/// The polling loop for one Claude session (its own thread). Waits for the
/// session JSONL to appear (the CLI creates it after init), then polls a
/// `SessionTail` every ~150ms, emitting and persisting newly-touched items.
/// Ends when the stop flag is set (`claude_close`).
///
/// `project` keys everything this loop persists (the snapshot and its name
/// override) and doubles as the timeline's root for project labels. It used to
/// be the PTY's cwd, which was the same string until external-session adoption
/// let the two differ: an adopted session's PTY runs in the transcript's own
/// directory, but its snapshot must be filed under the app's project like every
/// other session (see `spawn::spawn_claude`).
pub(super) fn run_timeline_poll(
    app: AppHandle,
    id: u64,
    project: String,
    uuid: String,
    initial_name: String,
    stop: Arc<AtomicBool>,
) {
    let Some(root) = core_lib::jsonl::claude_projects_root() else {
        return;
    };
    let mut tail: Option<core_lib::jsonl::SessionTail> = None;
    // `<uuid>/subagents/` dir + a tail per subagent transcript (Task agents), and
    // the main turn each agent was first seen in (so it nests under that turn).
    let mut sub_dir: Option<PathBuf> = None;
    let mut subagents: HashMap<String, core_lib::jsonl::SessionTail> = HashMap::new();
    let mut subagent_turn: HashMap<String, u64> = HashMap::new();
    // P0 B1: 아이템별 contains(aid) 메모 — (aid, session_id, tool_call_id) →
    // (revision, 결과). first-match는 매 변경 틱 재계산(동결 없음).
    let mut mention_memo: HashMap<(String, String, String), (u32, bool)> = HashMap::new();
    // P0 B2/N2: 재활성(Timeline 재구축) 세대 — revision이 리셋되어 내용이
    // 달라도 fp가 같아질 수 있으므로 fp에 합산해 emit 누락을 막는다.
    let mut sub_gen: u64 = 0;
    // P0 B2: 완료 서브에이전트(파일 서명 DONE_STREAK 연속 안정) — tail 드롭,
    // items 보존. 서명 변화 시 같은 틱에 재파싱까지 마쳐 원자 교체.
    let mut sub_done: HashMap<String, DoneSub> = HashMap::new();
    let mut sub_stable: HashMap<String, (Option<FileSig>, u32)> = HashMap::new();
    let mut sub_path: HashMap<String, PathBuf> = HashMap::new();
    // 서브에이전트 최초 발견 순서 — 프레임 조립·부모 탐색 순서의 결정적 기준
    // (기존 HashMap 비결정 순회의 정밀화, 리뷰 재수정).
    let mut sub_order: Vec<String> = Vec::new();
    // 60초(150ms×400) 연속 무변화 = 완료로 간주 — 리뷰: 6초는 긴 툴 실행
    // 대기(cargo test 등)마다 완료↔재활성 churn + 전체 재파싱을 유발한다.
    const DONE_STREAK: u32 = 400;
    // P1: 스냅샷 저장 debounce 상태.
    const SAVE_DEBOUNCE: Duration = Duration::from_secs(2);
    let mut snap_dirty = false;
    let mut last_save = std::time::Instant::now()
        .checked_sub(SAVE_DEBOUNCE)
        .unwrap_or_else(std::time::Instant::now);
    // 메모리 1단계 C: emit 최소 간격. 폴은 150ms 그대로 두고 전송만 디바운스한다
    // — 답변 스트리밍 중에는 fingerprint가 매 틱 바뀌어 최대 6.7 emit/s가 나갔다
    // (실측 payload 24.8MB × 6.7/s ≈ 166MB/s의 직렬화·IPC·JS 파싱). 400ms면
    // 전송이 ≤2.5/s로 떨어지면서(−63%) 체감 지연은 반 초 미만이다. 스냅샷
    // debounce(:292)와 같은 패턴이되, 저장(2s)보다 훨씬 짧게 잡아 화면 최신성을
    // 지킨다. 마지막 상태는 trailing edge로 반드시 착지한다(emit_gate).
    const EMIT_MIN_INTERVAL: Duration = Duration::from_millis(400);
    let mut emit_pending = false;
    let mut last_emit = std::time::Instant::now()
        .checked_sub(EMIT_MIN_INTERVAL)
        .unwrap_or_else(std::time::Instant::now);
    // Cheap fingerprint of the last emitted state (incl. subagent item count). A
    // prompt- or answer-only record advances turns/answers without touching any
    // tool item, so we can't key off `poll`'s touched indices alone.
    let mut last_fp: (usize, u32, usize, usize, usize, usize, u64, u64, u64, u64) =
        (0, 0, 0, 0, 0, 0, 0, 0, 0, 0);

    while !stop.load(Ordering::Relaxed) {
        thread::sleep(Duration::from_millis(150));
        // Re-check after the sleep so a `claude_close` during the sleep stops us
        // before another poll/save (so a delete-after-close isn't recreated —
        // codex session-UX F4).
        if stop.load(Ordering::Relaxed) {
            break;
        }

        // Resolve the file once it appears, then keep tailing it.
        if tail.is_none() {
            if let Ok(Some(path)) = core_lib::jsonl::find_session_jsonl(&root, &uuid) {
                sub_dir = Some(path.with_extension("").join("subagents"));
                tail = Some(core_lib::jsonl::SessionTail::new(
                    project.clone(),
                    uuid.clone(),
                    path,
                ));
            } else {
                continue;
            }
        }
        let Some(t) = tail.as_mut() else { continue };

        // P1(듀얼 리뷰 #1·#2, 감사 B1): 스냅샷 debounce 플러시 — emit의 fp
        // 게이트와 poll의 `continue`보다 **앞**, 매 틱 검사한다. 변화가 멎어도
        // (또는 일시 read 오류 틱에도) 마지막 변화 후 ~SAVE_DEBOUNCE에 트레일링
        // 엣지가 반드시 착지한다(게이트 뒤에 두면 무변화 틱이 건너뛰어 마지막
        // 턴이 영구 미저장 — 정상 종료마다 재현). stop을 조건에서 재검사해
        // close 직후 delete가 스냅샷 재생성으로 덮이지 않게 한다(F4 — 구현 전과
        // 동일한 보장 지점). 무변화 틱 비용은 Instant 비교 1회.
        if snap_dirty && !stop.load(Ordering::Relaxed) && last_save.elapsed() >= SAVE_DEBOUNCE {
            // last_save는 성공/실패 무관 갱신(실패 핫루프 방지 — 2s 간격 재시도),
            // dirty는 본문 save() 성공 시에만 해제 — 일시 디스크 오류 1회가 그
            // 시점까지의 변화를 저장 대상에서 영구히 빼지 않는다(#2).
            last_save = std::time::Instant::now();
            if let Ok(base) = app.path().app_data_dir() {
                // Read the rename override (decoupled file) rather than the
                // body's own name, so a concurrent rename isn't clobbered (F1).
                let name = core_lib::snapshot::read_name(&base, &project, &uuid)
                    .unwrap_or_else(|| initial_name.clone());
                let date = chrono::Local::now().format("%Y-%m-%d").to_string();
                // 스냅샷 본문은 **전문**(절단 없음 — 듀얼 리뷰 #3). 절단은 IPC
                // 반환 경계(emit payload·claude_session_snapshot)에서만 —
                // 절단본을 디스크 정본 캐시로 남기면 CLI가 원본 JSONL을
                // 로테이트한 뒤 복구 불능이 된다. 디스크 쓰기 크기는 병목이
                // 아니다(병목 = 직렬화 CPU·IPC·DOM).
                let snap = core_lib::snapshot::SessionSnapshot {
                    uuid: uuid.clone(),
                    name,
                    date,
                    items: t.timeline().items().to_vec(),
                    turns: t.turns().iter().map(|(k, v)| (*k, v.clone())).collect(),
                    answers: t.answers().iter().map(|(k, v)| (*k, v.clone())).collect(),
                    dates: t.dates().iter().map(|(k, v)| (*k, v.clone())).collect(),
                    tokens: t.tokens().iter().map(|(k, v)| (*k, *v)).collect(),
                    model: t.model().map(str::to_string),
                    last_usage: t.last_usage(),
                    // Task-chain meta lives in the decoupled `.task` sidecar (set
                    // at handoff), not the body — `load` sources them from there.
                    prev_uuid: None,
                    summary_path: None,
                    // Title/summary likewise sidecar-sourced on `load`.
                    title: None,
                    summary: None,
                };
                // save 직전 stop 재검사 — close→delete와의 경합 창을 syscall
                // 하나로 좁힌다(구 구현과 동급 이하). 완전 봉쇄는 delete와의
                // 락 공유가 필요해 P6(session 락 정리) 후보로 기록(고유 잔존).
                if !stop.load(Ordering::Relaxed)
                    && core_lib::snapshot::save(&base, &project, &snap).is_ok()
                {
                    snap_dirty = false;
                }
            }
        }
        if t.poll().is_err() {
            continue; // transient read error — retry next tick (플러시는 이미 수행)
        }

        // Tail each subagent transcript (parallel Task agents write their own
        // `<uuid>/subagents/agent-<id>.jsonl`). New files appear as agents spawn.
        if let Some(sd) = &sub_dir {
            if let Ok(entries) = std::fs::read_dir(sd) {
                for entry in entries.flatten() {
                    let f = entry.path();
                    if f.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                        continue;
                    }
                    let Some(aid) = f
                        .file_stem()
                        .and_then(|s| s.to_str())
                        .map(|s| s.trim_start_matches("agent-").to_string())
                    else {
                        continue;
                    };
                    // P0 B2: 완료 처리된 에이전트(활성 tail 없음)는 파일 서명이
                    // 달라질 때만 tail을 재생성한다. **같은 틱에 전체 재파싱
                    // (poll)까지 마치고**, items가 생겼을 때에만 done을 지운다
                    // — 전이 틱 프레임 공백 없음. 이미 재활성된(활성 tail 존재)
                    // 에이전트는 이 분기를 타지 않는다 — 빈 재파싱이 틱마다
                    // 재생성·재-emit 루프를 돌던 경로 차단(재점검 2차 P1).
                    if !subagents.contains_key(&aid) {
                        if let Some(d) = sub_done.get(&aid) {
                            if let Some(sig) = file_sig(&f) {
                                if sig != d.sig {
                                    // N1-2(재수정): 재구축은 revision을 리셋한다
                                    // — 옛 items의 (session_id, tool_call_id)
                                    // 메모 키를 정확히 무효화(레코드 sessionId가
                                    // 생성자 id보다 우선하므로 sid==aid 가정
                                    // 불가 — 실코드 확인 map.rs L79-81).
                                    let stale: std::collections::HashSet<(&str, &str)> = d
                                        .items
                                        .iter()
                                        .map(|it| (it.session_id.as_str(), it.tool_call_id.as_str()))
                                        .collect();
                                    mention_memo.retain(|(_, sid, tcid), _| {
                                        !stale.contains(&(sid.as_str(), tcid.as_str()))
                                    });
                                    let mut st = core_lib::jsonl::SessionTail::new(
                                        project.clone(),
                                        aid.clone(),
                                        f.clone(),
                                    );
                                    let _ = st.poll();
                                    if !st.timeline().items().is_empty() {
                                        sub_done.remove(&aid);
                                        // N2: done 실제 제거(교체 확정) 시점에만
                                        // 세대 증가 — 빈 재파싱은 증가 없음.
                                        sub_gen += 1;
                                    }
                                    sub_stable.remove(&aid);
                                    sub_path.insert(aid.clone(), f);
                                    subagents.insert(aid, st);
                                }
                            }
                            continue;
                        }
                    }
                    // (재활성 후 아직 빈 tail인 done 병존 에이전트는 아래 정상
                    // poll 경로가 증분을 잇는다 — 재생성 없음.)
                    if !subagents.contains_key(&aid) {
                        subagent_turn.insert(aid.clone(), t.current_turn());
                        if !sub_order.contains(&aid) {
                            sub_order.push(aid.clone());
                        }
                    }
                    sub_path.insert(aid.clone(), f.clone());
                    let st = subagents.entry(aid.clone()).or_insert_with(|| {
                        core_lib::jsonl::SessionTail::new(project.clone(), aid.clone(), f)
                    });
                    let _ = st.poll();
                }
            }
        }
        // P0 B2: 완료 전이 스윕 — 파일 서명이 DONE_STREAK 연속 무변화면
        // tail을 드롭하고 items만 보존한다(빈 tail·metadata 실패는 완료
        // 후보 아님). 재활성 재파싱이 items를 만든 에이전트의 잔여 done은
        // 정리(active 우선).
        let done_before = sub_done.len();
        sub_done.retain(|aid, _| {
            !subagents
                .get(aid)
                .map(|st| !st.timeline().items().is_empty())
                .unwrap_or(false)
        });
        if sub_done.len() != done_before {
            sub_gen += 1; // 지연 교체 확정(빈 tail → 증분으로 items 도달) — N2
        }
        let mut newly_done: Vec<(String, FileSig)> = Vec::new();
        // AA2: 활성 에이전트의 이번 틱 파일 서명 — payload 프레임의 캐시 키.
        // 완료 전이 안정 구간엔 값이 고정이라 done 서명(DoneSub.sig)과 일치한다.
        let mut active_sig: HashMap<String, FileSig> = HashMap::new();
        for (aid, st) in subagents.iter() {
            let Some(p) = sub_path.get(aid) else { continue };
            let sig = file_sig(p);
            if let Some(s) = sig {
                active_sig.insert(aid.clone(), s);
            }
            let prev = sub_stable.get(aid).copied().unwrap_or((None, 0));
            let next = advance_stability(prev, sig);
            sub_stable.insert(aid.clone(), next);
            if next.1 >= DONE_STREAK && !st.timeline().items().is_empty() {
                if let Some(s) = next.0 {
                    newly_done.push((aid.clone(), s));
                }
            }
        }
        for (aid, sig) in newly_done {
            if let Some(st) = subagents.remove(&aid) {
                let items = st.timeline().items().to_vec();
                let rev: u32 = items.iter().map(|i| i.revision).sum();
                sub_stable.remove(&aid);
                let turn = *subagent_turn.get(&aid).unwrap_or(&0);
                sub_done.insert(aid, DoneSub { turn, sig, items, rev });
            }
        }

        // fingerprint·카운트는 활성+완료 합산 — 완료 전이가 payload 내용을
        // 바꾸지 않으므로 fp도 불변이어야 한다(전이 자체로 재-emit 없음).
        let done_rev: u32 = sub_done.values().map(|d| d.rev).sum();
        let done_count: usize = sub_done.values().map(|d| d.items.len()).sum();
        let sub_rev: u32 = subagents
            .values()
            .flat_map(|st| st.timeline().items().iter().map(|i| i.revision))
            .sum::<u32>()
            + done_rev;
        let sub_count: usize =
            subagents.values().map(|st| st.timeline().items().len()).sum::<usize>() + done_count;

        let items = t.timeline().items();
        // Token/model/usage changes can land without any item/answer change (a
        // usage-only assistant record), so fold them into the fingerprint — else the
        // gauge and persisted snapshot would skip those ticks (codex).
        let token_fp: u64 = t
            .tokens()
            .values()
            .map(|u| u.input + u.output + u.cache_read + u.cache_creation)
            .sum();
        let ctx_fp: u64 = t
            .last_usage()
            .map(|u| u.input + u.cache_read + u.cache_creation)
            .unwrap_or(0);
        let model_fp: u64 = t.model().map(|m| m.bytes().map(u64::from).sum()).unwrap_or(0);
        let fp = (
            items.len(),
            items.iter().map(|i| i.revision).sum::<u32>() + sub_rev,
            t.turns().len(),
            t.answers().values().map(|s| s.len()).sum(),
            t.dates().len(),
            sub_count,
            token_fp,
            ctx_fp,
            model_fp,
            sub_gen, // N2: 재활성 세대 — 재구축으로 rev 합이 같아도 emit 보장
        );
        // 변화 감지와 전송을 분리한다(메모리 1단계 C). 변화는 매 틱 그대로
        // 판정해 스냅샷 dirty를 즉시 세우고(저장 debounce는 자기 주기를 유지),
        // emit만 최소 간격 게이트를 통과할 때 나간다. pending은 실제 전송
        // 전까지 유지되므로 마지막 상태가 반드시 전달된다(trailing edge).
        let changed = fp != last_fp;
        if changed {
            last_fp = fp;
            // 저장은 emit 게이트와 무관하게 마킹 — 디바운스된 전송이 스냅샷
            // 저장까지 늦추면 안 된다. Persisting keeps the session
            // listable/reopenable across restarts (D-1).
            snap_dirty = true;
        }
        let (do_emit, pending) = emit_gate(changed, emit_pending, last_emit.elapsed(), EMIT_MIN_INTERVAL);
        emit_pending = pending;
        if !do_emit {
            continue;
        }
        last_emit = std::time::Instant::now();

        assemble_and_emit(
            &app,
            id,
            t,
            &subagents,
            &subagent_turn,
            &active_sig,
            &sub_order,
            &sub_done,
            &mut mention_memo,
        );
        // 저장 자체는 위(틱 진입부) debounce 플러시가 수행하고, dirty 마킹은
        // 변화 감지 시점(emit 게이트 앞)에서 이미 끝났다.

        if stop.load(Ordering::Relaxed) {
            break; // closed during poll/emit — don't persist after close (F4)
        }
    }

    // The PTY died on its own (claude exited) — drop the runtime entry so a later
    // id collision can't see stale live/driver state (review R7-3 cleanup).
    let mut existed = false;
    if let Some(state) = app.try_state::<super::runtime::ClaudeState>() {
        if let Ok(mut rt) = state.rt.lock() {
            existed = rt.remove_session(id).is_some(); // T7 (전이표 순수 메서드)
        }
    }
    // AA1/BB1(듀얼 리뷰 codex): **자연 종료(existed=true)면 emit_pending과 무관하게**
    // 마지막 poll 1회 후 최종 상태를 emit한다 — 직전 emit 후 400ms 창 안의 미발화
    // 변화든, 종료 직전 아직 poll하지 못한 바이트든 모두 최종 화면에 반영된다
    // (게이트가 도입한 라이브 회귀를 근본에서 닫는 단순 규칙: "자연 종료 = 최종
    // poll+emit"). 정상 순서로는 이 timeline이 아래 `claude-session-closed`보다
    // 먼저 도착하지만, **순서가 뒤집혀도 프론트가 종결 우선(idempotent)이라**
    // 이미 닫힌 세션이 다시 열리지 않는다(BB2 — useClaudeTimeline). 즉 순서 안전은
    // 프론트가 흡수하고 여기선 "최종 상태를 반드시 한 번 보낸다"만 책임진다.
    // 재emit은 idempotent replace라 무변화여도 무해. active_sig는 빈 맵 — 남은
    // 활성 프레임은 본문 인라인, 완료 프레임은 DoneSub.sig를 쓴다.
    if existed {
        if let Some(t) = tail.as_mut() {
            let _ = t.poll();
            assemble_and_emit(
                &app,
                id,
                t,
                &subagents,
                &subagent_turn,
                &HashMap::new(),
                &sub_order,
                &sub_done,
                &mut mention_memo,
            );
        }
        // Notify any mirror windows that the session ended (review P6-impl #2).
        let _ = app.emit("claude-session-closed", id);
    }
}


#[cfg(test)]
mod tests {
    use super::*;

    /// serde로 최소 필드 TimelineItem 픽스처 생성 (shell()은 pub(crate) of core).
    fn item(tool_call_id: &str, content_text: Option<&str>) -> TimelineItem {
        serde_json::from_value(serde_json::json!({
            "session_id": "s",
            "tool_call_id": tool_call_id,
            "turn": 1,
            "seq": 1,
            "kind": "execute",
            "title": "t",
            "locations": [],
            "project_label": null,
            "diffs": [],
            "content_text": content_text,
            "raw_input": null,
            "agent_status": "completed",
            "write_status": "none",
            "revision": 1
        }))
        .expect("fixture")
    }

    /// 차용 프레임(메모리 1단계 — ordered_frames가 clone하지 않는다). items의
    /// 소유권은 호출부(테스트 지역 변수)에 남는다.
    fn agent<'a>(aid: &str, items: &'a [TimelineItem]) -> Frame<'a> {
        Frame { aid: aid.to_string(), turn: 1, items, done: false, sig: None }
    }

    // P1 특성테스트 — 절단은 UTF-8 경계 보존 + 플래그, 상한 이하는 불변.
    #[test]
    fn cap_content_truncates_on_char_boundary_and_flags() {
        let long = "가".repeat(CONTENT_CAP); // 3바이트 문자 — 경계가 CAP에 안 떨어짐
        let mut items = vec![item("big", Some(&long)), item("small", Some("짧음")), item("none", None)];
        cap_content(&mut items);
        let big = &items[0];
        assert!(big.content_truncated);
        let ct = big.content_text.as_deref().unwrap();
        assert!(ct.len() <= CONTENT_CAP);
        assert!(ct.chars().all(|c| c == '가'), "경계 절단이 문자를 깨면 안 된다");
        assert!(!items[1].content_truncated);
        assert_eq!(items[1].content_text.as_deref(), Some("짧음"));
        assert!(!items[2].content_truncated);
    }

    // P0 B2 특성테스트 — 기대값 손계산.
    const SIG_A: FileSig = (100, 1);
    const SIG_B: FileSig = (150, 2);

    #[test]
    fn stability_streak_advances_resets_and_skips_metadata_failure() {
        assert_eq!(advance_stability((Some(SIG_A), 0), Some(SIG_A)), (Some(SIG_A), 1));
        assert_eq!(advance_stability((Some(SIG_A), 5), Some(SIG_A)), (Some(SIG_A), 6));
        assert_eq!(advance_stability((Some(SIG_A), 5), Some(SIG_B)), (Some(SIG_B), 0)); // 변화 → 리셋
        // 같은 len·다른 mtime = 재작성 감지 (len 단독 판정 회귀 방지)
        assert_eq!(advance_stability((Some((100, 1)), 5), Some((100, 9))), (Some((100, 9)), 0));
        // metadata 실패 → 스트릭 진행 금지(리셋), 마지막 서명 유지
        assert_eq!(advance_stability((Some(SIG_A), 39), None), (Some(SIG_A), 0));
        assert_eq!(advance_stability((None, 0), None), (None, 0));
    }

    fn done(turn: u64, items: Vec<TimelineItem>) -> DoneSub {
        let rev = items.iter().map(|i| i.revision).sum();
        DoneSub { turn, sig: SIG_A, items, rev }
    }

    #[test]
    fn ordered_frames_keeps_done_in_discovery_order_and_prefers_reparsed_active() {
        let order = vec!["a1".to_string(), "a2".to_string(), "a3".to_string()];
        let (live1, empty3) = (vec![item("l-1", None)], Vec::new());
        let mut active: HashMap<String, (u64, &[TimelineItem])> = HashMap::new();
        active.insert("a1".into(), (1, &live1)); // 활성
        active.insert("a3".into(), (3, &empty3)); // 재활성 재파싱 전(빈 tail)
        let mut d: HashMap<String, DoneSub> = HashMap::new();
        d.insert("a2".into(), done(7, vec![item("d-2", None)])); // 완료
        d.insert("a3".into(), done(9, vec![item("d-3", None)])); // 전이 중 — done 폴백
        // AA2: 활성 프레임의 파일 서명이 캐시 키로 실린다(완료 프레임은 DoneSub.sig).
        let mut asig: HashMap<String, FileSig> = HashMap::new();
        asig.insert("a1".into(), SIG_B);
        let out = ordered_frames(&order, &active, &asig, &d);
        // 발견 순서 유지 + 완료 프레임 보존 + 빈 active는 done 폴백(공백 없음).
        assert_eq!(
            out.iter()
                .map(|f| (f.aid.as_str(), f.turn, f.items[0].tool_call_id.as_str(), f.done))
                .collect::<Vec<_>>(),
            vec![("a1", 1, "l-1", false), ("a2", 7, "d-2", true), ("a3", 9, "d-3", true)]
        );
        // 서명: 활성=active_sig, 완료=DoneSub.sig(SIG_A).
        assert_eq!(out[0].sig, Some(SIG_B));
        assert_eq!(out[1].sig, Some(SIG_A));
        assert_eq!(out[2].sig, Some(SIG_A));
    }

    #[test]
    fn ordered_frames_active_wins_over_stale_done_after_reparse() {
        let order = vec!["a1".to_string()];
        let live = vec![item("new-1", None)];
        let mut active: HashMap<String, (u64, &[TimelineItem])> = HashMap::new();
        active.insert("a1".into(), (1, &live));
        let mut d: HashMap<String, DoneSub> = HashMap::new();
        d.insert("a1".into(), done(1, vec![item("old-1", None)]));
        let out = ordered_frames(&order, &active, &HashMap::new(), &d);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].items[0].tool_call_id, "new-1"); // 재파싱된 active 우선
        assert!(!out[0].done, "활성 프레임은 payload에 본문을 싣는다");
    }

    // 메모리 1단계 B — payload 분할: 완료 프레임은 메타만, 활성 프레임만 본문.
    #[test]
    fn payload_frames_drops_done_bodies_but_keeps_their_meta() {
        let mut done_items = vec![item("d-1", None), item("d-2", None)];
        done_items[1].agent_status = core_lib::AgentStatus::InProgress; // 마지막 아이템
        done_items[1].revision = 4;
        let live_items = vec![item("l-1", Some("x"))];
        let frames = vec![
            Frame { aid: "done".into(), turn: 2, items: &done_items, done: true, sig: Some((42, 7)) },
            Frame { aid: "live".into(), turn: 3, items: &live_items, done: false, sig: None },
        ];
        let out = payload_frames(&frames, vec![Some("call-1".into()), None]);
        // 완료: 본문 없음(= 프론트가 펼칠 때 조회) + 메타는 원본 items 기준.
        assert!(out[0].items.is_none(), "완료 프레임의 본문이 payload에 실리면 절감이 사라진다");
        assert_eq!((out[0].total, out[0].completed), (2, 1));
        assert_eq!(out[0].last_status, Some(core_lib::AgentStatus::InProgress));
        assert_eq!(out[0].sig.as_deref(), Some("42-7")); // AA2: 파일 서명 문자열
        assert_eq!(out[0].parent.as_deref(), Some("call-1"));
        assert_eq!(out[0].turn, 2);
        // 활성: 본문 인라인(절단 적용) + 서명 없음(인라인이라 불필요).
        assert_eq!(out[1].items.as_ref().map(Vec::len), Some(1));
        assert_eq!((out[1].total, out[1].completed), (1, 1));
        assert!(out[1].sig.is_none());
    }

    /// 절단(CONTENT_CAP)은 payload 본문에만 걸리고 **메타는 원본 기준**이어야
    /// 한다 — 진행도 카운트가 절단 때문에 달라지면 안 된다.
    #[test]
    fn payload_frames_caps_live_bodies_without_touching_meta() {
        let long = "가".repeat(CONTENT_CAP);
        let live_items = vec![item("l-1", Some(&long))];
        let frames =
            vec![Frame { aid: "live".into(), turn: 1, items: &live_items, done: false, sig: None }];
        let out = payload_frames(&frames, vec![None]);
        let its = out[0].items.as_ref().unwrap();
        assert!(its[0].content_truncated);
        assert!(its[0].content_text.as_deref().unwrap().len() <= CONTENT_CAP);
        assert_eq!(live_items[0].content_text.as_deref().unwrap().len(), long.len(), "원본 불변");
        assert_eq!(out[0].total, 1);
    }

    // 메모리 1단계 C — emit 최소 간격 게이트. 핵심 계약은 **trailing edge**:
    // 변화 후 더 이상 변화가 없어도 마지막 상태가 반드시 나간다.
    #[test]
    fn emit_gate_throttles_but_always_lands_the_last_state() {
        const MIN: Duration = Duration::from_millis(400);
        let ms = Duration::from_millis;
        // 변화 없음 + pending 없음 → 아무것도 안 보낸다(간격이 지났어도).
        assert_eq!(emit_gate(false, false, ms(10_000), MIN), (false, false));
        // 변화 직후 간격 미달 → 보류(pending 유지 — 여기서 잃으면 화면이 낡는다).
        assert_eq!(emit_gate(true, false, ms(0), MIN), (false, true));
        assert_eq!(emit_gate(true, true, ms(399), MIN), (false, true));
        // **변화가 멎어도** 간격이 지난 첫 틱에 보류분이 나간다(trailing edge).
        assert_eq!(emit_gate(false, true, ms(400), MIN), (true, false));
        // 간격이 지난 뒤의 변화는 그 틱에 바로 나간다(디바운스 = 지연이 아니라 상한).
        assert_eq!(emit_gate(true, false, ms(1_000), MIN), (true, false));
    }

    /// 게이트를 150ms 폴 루프에 태운 시뮬레이션 — 스트리밍 중 전송이 줄고,
    /// 스트리밍이 끝난 뒤 **마지막 변화가 빠짐없이** 전달되는지 고정한다.
    #[test]
    fn emit_gate_over_a_poll_loop_drops_rate_and_keeps_final_tick() {
        const MIN: Duration = Duration::from_millis(400);
        const TICK: u64 = 150;
        let mut pending = false;
        let mut since = MIN; // 첫 틱은 자격 있음
        let mut emits = 0;
        let mut last_emitted_tick = None;
        // 0..20틱(3초) 중 앞 10틱만 매 틱 변화(스트리밍), 이후 무변화.
        for tick in 0..20u64 {
            let changed = tick < 10;
            let (go, p) = emit_gate(changed, pending, since, MIN);
            pending = p;
            if go {
                emits += 1;
                last_emitted_tick = Some(tick);
                since = Duration::ZERO;
            } else {
                since += Duration::from_millis(TICK);
            }
        }
        // 게이트 없으면 10회(변화 틱마다). 게이트로 4회.
        assert_eq!(emits, 4, "스트리밍 10틱이 4회 전송으로 합쳐진다");
        // 마지막 변화(틱 9) 이후의 전송이 존재 = 최종 상태 착지.
        assert!(last_emitted_tick.unwrap() >= 9, "마지막 변화 뒤 전송이 없으면 화면이 낡는다");
        assert!(!pending, "보류가 남은 채 끝나면 안 된다");
    }

    // P0 B1(재수정) — 메모 스캔이 naive와 완전 동치인지 + revision bump 반영.
    #[test]
    fn parent_memo_matches_naive_and_tracks_revision_updates() {
        let mut memo: HashMap<(String, String, String), (u32, bool)> = HashMap::new();
        let mut main = vec![item("call-1", Some("nothing")), item("call-2", Some("spawn agent-A"))];
        let none: Vec<TimelineItem> = Vec::new();
        let subs = vec![agent("agent-A", &none)];
        assert_eq!(
            subagent_parent_memo("agent-A", &main, &subs, &mut memo),
            subagent_parent("agent-A", &main, &subs)
        );
        // 더 이른 아이템(call-1)의 content_text가 나중에 갱신되어(revision bump)
        // aid를 언급하면 — naive처럼 부모가 call-1로 "승격"되어야 한다(동결 금지).
        main[0] = {
            let mut it = item("call-1", Some("late mention of agent-A"));
            it.revision = 2;
            it
        };
        assert_eq!(
            subagent_parent_memo("agent-A", &main, &subs, &mut memo),
            Some("call-1".to_string())
        );
        assert_eq!(
            subagent_parent_memo("agent-A", &main, &subs, &mut memo),
            subagent_parent("agent-A", &main, &subs)
        );
    }

    /// 재점검 N1-1: 다른 세션(다른 transcript)의 동일 tool_call_id·동일
    /// revision이 있어도 메모가 충돌하지 않아야 한다 — 키에 session_id 포함.
    #[test]
    fn parent_memo_does_not_collide_across_sessions() {
        fn item_in(sid: &str, tcid: &str, ct: Option<&str>) -> TimelineItem {
            let mut it = item(tcid, ct);
            it.session_id = sid.to_string();
            it
        }
        let mut memo: HashMap<(String, String, String), (u32, bool)> = HashMap::new();
        // main의 "dup"(미언급)이 먼저 스캔되고, agent-B transcript의 "dup"
        // (언급, 같은 revision)이 뒤에 온다 — naive는 b쪽 dup을 부모로 찾는다.
        let main = vec![item_in("main", "dup", Some("nothing"))];
        let (none, b_items) =
            (Vec::new(), vec![item_in("agent-B", "dup", Some("spawn agent-A"))]);
        let subs = vec![agent("agent-A", &none), agent("agent-B", &b_items)];
        assert_eq!(
            subagent_parent_memo("agent-A", &main, &subs, &mut memo),
            subagent_parent("agent-A", &main, &subs)
        );
        assert_eq!(subagent_parent_memo("agent-A", &main, &subs, &mut memo), Some("dup".into()));
    }

    // P0 B1 특성테스트 — 기대값 손계산 (자기참조 금지).
    #[test]
    fn subagent_parent_prefers_main_timeline_first_match() {
        let main = vec![
            item("call-1", Some("no mention")),
            item("call-2", Some("spawned agent-A here")),
            item("call-3", Some("agent-A again later")),
        ];
        let none: Vec<TimelineItem> = Vec::new();
        let subs = vec![agent("agent-A", &none)];
        // 첫 매치(call-2)가 이긴다 — call-3이 아니라.
        assert_eq!(subagent_parent("agent-A", &main, &subs), Some("call-2".into()));
    }

    #[test]
    fn subagent_parent_excludes_own_transcript_but_scans_others() {
        // 자기 transcript가 자기 id를 에코해도 self-parent가 되면 안 된다.
        let main = vec![item("m-1", Some("nothing"))];
        let (a_items, b_items) = (
            vec![item("a-1", Some("I am agent-A"))],
            vec![item("b-1", Some("delegating to agent-A"))],
        );
        let subs = vec![agent("agent-A", &a_items), agent("agent-B", &b_items)];
        // main 무매치 → 다른 에이전트(B)의 아이템이 부모.
        assert_eq!(subagent_parent("agent-A", &main, &subs), Some("b-1".into()));
        // B 자신은 어디에도 언급이 없으니 None.
        assert_eq!(subagent_parent("agent-B", &main, &subs), None);
    }

    #[test]
    fn subagent_parent_none_when_unmentioned_or_no_content() {
        let main = vec![item("m-1", None)];
        assert_eq!(subagent_parent("agent-X", &main, &[]), None);
    }
}

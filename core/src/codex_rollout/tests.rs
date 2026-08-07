//! codex rollout 파서·매칭 테스트.
//!
//! 매칭 테스트가 이 파일의 무게중심이다 — **오매칭이 유일한 심각 실패 모드**이고
//! (남의 대화가 내 탭에 뜬다) 그건 화면에서 조용히 지나간다. "동시 스폰이면
//! 아무에게도 주지 않는다"는 규칙은 여기서만 고정된다.

use super::*;
use crate::timeline::ItemKind;

// ---------------------------------------------------------------------------
// 시각 파싱
// ---------------------------------------------------------------------------

#[test]
fn rfc3339_utc_with_millis() {
    // 실측 전사의 형태 그대로.
    let ms = parse_rfc3339_ms("2026-08-07T11:52:03.502Z").unwrap();
    assert_eq!(ms, 1_786_103_523_502);
}

#[test]
fn rfc3339_without_fraction_and_epoch() {
    assert_eq!(parse_rfc3339_ms("1970-01-01T00:00:00Z").unwrap(), 0);
    assert_eq!(parse_rfc3339_ms("1970-01-01T00:00:01Z").unwrap(), 1_000);
}

#[test]
fn rfc3339_offsets_normalize_to_utc() {
    let z = parse_rfc3339_ms("2026-08-07T11:52:03Z").unwrap();
    // 같은 순간의 KST 표기 — 콜론형·무콜론형 둘 다 같은 값이어야 한다.
    assert_eq!(parse_rfc3339_ms("2026-08-07T20:52:03+09:00").unwrap(), z);
    assert_eq!(parse_rfc3339_ms("2026-08-07T20:52:03+0900").unwrap(), z);
    assert_eq!(parse_rfc3339_ms("2026-08-07T02:52:03-09:00").unwrap(), z);
}

#[test]
fn rfc3339_rejects_garbage() {
    // 형식이 어긋나면 None — 추측한 시각으로 매칭을 태우지 않는다.
    for bad in ["", "not-a-time", "2026-08-07", "2026/08/07T11:52:03Z", "2026-13-07T11:52:03Z"] {
        assert!(parse_rfc3339_ms(bad).is_none(), "{bad} 는 거부돼야 한다");
    }
}

// ---------------------------------------------------------------------------
// session_meta
// ---------------------------------------------------------------------------

const META: &str = r#"{"timestamp":"2026-08-07T11:52:09.324Z","type":"session_meta","payload":{"session_id":"019fdc10-e8ad-7923-80c4-169adc7e9521","id":"019fdc10-e8ad-7923-80c4-169adc7e9521","timestamp":"2026-08-07T11:52:03.502Z","cwd":"/proj","originator":"codex-tui","cli_version":"0.144.1","source":"cli"}}"#;

/// **매칭이 기대는 사실**: `payload.timestamp`는 파일이 만들어진 시각(줄의
/// `timestamp`)이 아니라 **세션이 열린 시각**이다. 실측에서 둘은 6초 차이였고
/// (파일은 첫 메시지 전송 때 생긴다), 스폰 시각과 맞춰야 하는 건 앞엣것이다.
#[test]
fn meta_started_ms_is_session_open_not_file_write() {
    let m = parse_meta_line(META).unwrap();
    assert_eq!(m.cwd.as_deref(), Some("/proj"));
    assert_eq!(m.session_id.as_deref(), Some("019fdc10-e8ad-7923-80c4-169adc7e9521"));
    assert_eq!(m.started_ms, parse_rfc3339_ms("2026-08-07T11:52:03.502Z"));
    assert_ne!(m.started_ms, parse_rfc3339_ms("2026-08-07T11:52:09.324Z"));
}

#[test]
fn meta_line_of_another_type_is_not_meta() {
    assert!(parse_meta_line(r#"{"type":"event_msg","payload":{}}"#).is_none());
    assert!(parse_meta_line("{ broken").is_none());
}

// ---------------------------------------------------------------------------
// 후보 자격 — 앱이 띄운 TUI 전사만 후보다
// ---------------------------------------------------------------------------

/// 실전사에서 그대로 가져온 첫 줄들. 211개 중 **189개가 exec·5개가 서브에이전트**라,
/// 거르지 않으면 후보 대부분이 앱과 무관한 전사다(리뷰 #2).
const META_EXEC: &str = r#"{"timestamp":"2026-08-05T09:19:27.802Z","type":"session_meta","payload":{"session_id":"019fd138-7af4-72b2-8496-097b4880addf","id":"019fd138-7af4-72b2-8496-097b4880addf","timestamp":"2026-08-05T09:19:27.476Z","cwd":"/proj","originator":"codex_exec","cli_version":"0.144.1","source":"exec"}}"#;
const META_SUBAGENT: &str = r#"{"timestamp":"2026-06-01T09:19:27.802Z","type":"session_meta","payload":{"session_id":"019e8030-1111-7000-8000-000000000001","id":"019e8030-1111-7000-8000-000000000001","timestamp":"2026-06-01T09:19:27.476Z","cwd":"/proj","originator":"codex-tui","cli_version":"0.137.0","source":{"subagent":{"thread_spawn":{"parent_thread_id":"019e8030-afda-7713-99bf-63f6fdb17e33","depth":1,"agent_nickname":"Fermat"}}}}}"#;

#[test]
fn only_the_interactive_tui_transcript_can_be_ours() {
    // 앱이 띄우는 것 = 대화형 TUI. 이것만 후보다.
    assert!(app_spawnable(&parse_meta_line(META).unwrap()));
    // `codex exec` 원샷(리뷰 워커 등) — 앱 탭이 아니다.
    assert!(!app_spawnable(&parse_meta_line(META_EXEC).unwrap()));
    // 서브에이전트 스레드 — `source`가 문자열이 아니라 객체다.
    let sub = parse_meta_line(META_SUBAGENT).unwrap();
    assert!(sub.subagent, "객체형 source는 서브에이전트로 읽혀야 한다");
    assert!(!app_spawnable(&sub));
}

/// 허용 목록이 아니라 **거부 목록**이다 — codex가 originator를 늘려도 타임라인이
/// 통째로 죽지 않는다(최악 후보가 하나 더 남을 뿐).
#[test]
fn an_unknown_originator_is_still_a_candidate() {
    let m = RolloutMeta {
        session_id: Some("x".into()),
        cwd: Some("/proj".into()),
        started_ms: Some(1),
        originator: Some("codex-tui-next".into()),
        cli_version: None,
        source: Some("cli".into()),
        subagent: false,
    };
    assert!(app_spawnable(&m));
}

// ---------------------------------------------------------------------------
// 매칭
// ---------------------------------------------------------------------------

fn spawn(id: u64, at: i64) -> SpawnRef {
    SpawnRef { id, cwd: Some("/proj".into()), spawned_ms: at }
}
fn cand(name: &str, at: i64) -> RolloutCandidate {
    RolloutCandidate {
        path: PathBuf::from(format!("/r/{name}.jsonl")),
        cwd: Some("/proj".into()),
        started_ms: Some(at),
        originator: Some(APP_ORIGINATOR.into()),
    }
}
/// 앱이 띄우지 않은 대화형 TUI — 사용자가 터미널에서 직접 `codex`를 친 경우.
fn foreign(name: &str, at: i64) -> RolloutCandidate {
    RolloutCandidate { originator: Some("codex-tui".into()), ..cand(name, at) }
}

#[test]
fn single_candidate_in_window_matches() {
    let a = spawn(1, 1_000_000);
    let c = cand("a", 1_000_900); // 실측 지연 ~0.9초
    assert_eq!(
        match_rollout(&a, &[a.clone()], &[c.clone()], &[]),
        MatchOutcome::Matched(c.path)
    );
}

#[test]
fn nothing_yet_when_the_session_has_not_written_a_file() {
    let a = spawn(1, 1_000_000);
    assert_eq!(match_rollout(&a, &[a.clone()], &[], &[]), MatchOutcome::NoCandidate);
}

/// 창 밖 = 남의 세션. 늦게 뜬 탭의 전사를 먼저 뜬 탭이 가로채면 **다른 사람의
/// 대화가 화면에 뜬다** — 이 테스트가 그 경계를 고정한다.
#[test]
fn a_file_outside_the_window_is_never_taken() {
    let a = spawn(1, 1_000_000);
    for at in [
        1_000_000 - MATCH_SKEW_MS - 1,  // 스폰보다 너무 이르다(이전 세션)
        1_000_000 + MATCH_WINDOW_MS + 1, // 스폰보다 너무 늦다(다음 세션)
    ] {
        assert_eq!(
            match_rollout(&a, &[a.clone()], &[cand("x", at)], &[]),
            MatchOutcome::NoCandidate,
            "at={at}"
        );
    }
}

#[test]
fn a_file_from_another_directory_is_never_taken() {
    let a = spawn(1, 1_000_000);
    let other = RolloutCandidate {
        cwd: Some("/somewhere-else".into()),
        ..cand("x", 1_000_900)
    };
    assert_eq!(match_rollout(&a, &[a.clone()], &[other], &[]), MatchOutcome::NoCandidate);
}

/// **동시 스폰** — 같은 프로젝트에서 두 탭을 연달아 열면 두 탭의 창이 같은 파일을
/// 덮는다. 그때는 아무에게도 주지 않는다(둘 중 하나를 찍으면 50% 확률로 오매칭).
#[test]
fn concurrent_spawns_give_the_file_to_nobody() {
    let a = spawn(1, 1_000_000);
    let b = spawn(2, 1_002_000);
    let live = [a.clone(), b.clone()];
    let cs = [cand("one", 1_002_500)];
    assert_eq!(match_rollout(&a, &live, &cs, &[]), MatchOutcome::Contested);
    assert_eq!(match_rollout(&b, &live, &cs, &[]), MatchOutcome::Contested);
}

/// 반대로 **창이 겹치지 않을 만큼 떨어져 열린** 두 탭은 각자 자기 것을 갖는다.
#[test]
fn sequential_spawns_each_take_their_own() {
    let a = spawn(1, 1_000_000);
    let b = spawn(2, 1_000_000 + MATCH_WINDOW_MS + 5_000);
    let live = [a.clone(), b.clone()];
    let ca = cand("a", 1_000_900);
    let cb = cand("b", 1_000_000 + MATCH_WINDOW_MS + 5_900);
    let cs = [ca.clone(), cb.clone()];
    assert_eq!(match_rollout(&a, &live, &cs, &[]), MatchOutcome::Matched(ca.path));
    assert_eq!(match_rollout(&b, &live, &cs, &[]), MatchOutcome::Matched(cb.path));
}

/// 이미 다른 탭이 잡은 파일은 후보에서 빠진다 — 한 전사가 두 탭에 뜨지 않는다.
#[test]
fn a_claimed_file_is_off_the_table() {
    let a = spawn(1, 1_000_000);
    let taken = cand("a", 1_000_900);
    assert_eq!(
        match_rollout(&a, &[a.clone()], &[taken.clone()], &[taken.path.clone()]),
        MatchOutcome::NoCandidate
    );
}

/// 한 탭의 창 안에 파일이 둘 — 외부 codex(터미널에서 직접 띄운 것)가 끼어든 경우.
#[test]
fn two_files_in_one_window_are_ambiguous() {
    let a = spawn(1, 1_000_000);
    let cs = [cand("a", 1_000_900), cand("b", 1_001_500)];
    assert_eq!(match_rollout(&a, &[a.clone()], &cs, &[]), MatchOutcome::Multiple);
}

/// cwd나 시각을 못 읽은 후보(첫 줄이 잘렸거나 형식이 바뀐 전사)는 매칭에 끼지
/// 않는다 — 모르면 안 붙인다.
#[test]
fn a_candidate_without_identity_is_ignored() {
    let a = spawn(1, 1_000_000);
    let blind = RolloutCandidate {
        path: "/r/x.jsonl".into(),
        cwd: None,
        started_ms: None,
        originator: Some(APP_ORIGINATOR.into()),
    };
    assert_eq!(match_rollout(&a, &[a.clone()], &[blind], &[]), MatchOutcome::NoCandidate);
}

// ---------------------------------------------------------------------------
// 결정적 표식 (T1) — 앱이 띄운 세션만 후보로 남긴다
// ---------------------------------------------------------------------------

/// **리뷰 재현(T1)**: 사용자가 터미널에서 직접 띄운 codex TUI가 같은 폴더·같은
/// 10초 안에 있으면, cwd+시각만으로는 우리 것과 구별할 방법이 없다 — 후보가 둘이
/// 되어 타임라인이 죽거나(`Multiple`) 최악 남의 전사가 붙는다.
///
/// 표식(`CODEX_INTERNAL_ORIGINATOR_OVERRIDE`)이 그 경우를 구조적으로 없앤다.
#[test]
fn a_foreign_tui_in_the_same_window_is_structurally_excluded() {
    let a = spawn(1, 1_000_000);
    let mine = cand("mine", 1_000_900);
    let theirs = foreign("theirs", 1_001_200);
    let all = [mine.clone(), theirs.clone()];

    // 표식 없이 보면 구별이 안 된다 — 이게 T1이 지적한 상태다.
    assert_eq!(match_rollout(&a, &[a.clone()], &all, &[]), MatchOutcome::Multiple);

    // 표식으로 좁히면 우리 것 하나만 남는다.
    let narrowed = narrow_to_marked(&all);
    assert_eq!(narrowed, vec![mine.clone()]);
    assert_eq!(match_rollout(&a, &[a.clone()], &narrowed, &[]), MatchOutcome::Matched(mine.path));
}

/// **U1 재현 — 폴백을 두면 안 되는 이유.**
///
/// 앱 탭이 뜬 직후, 사용자가 아직 첫 메시지를 안 보낸 구간에는 **우리 전사가 없다**.
/// 그 구간에 같은 폴더의 외부 codex TUI 전사가 하나 있으면, "표식 후보가 없으면 옛
/// 규칙으로 물러난다"는 폴백은 그것을 집어 sticky claim으로 굳힌다 — 남의 대화가
/// 영구히 내 탭에 뜬다. 창을 좁혀도 못 막는다(양쪽 다 정상 범위 안이다).
///
/// 그래서 표식 없는 후보는 **한 번도 매칭 대상이 되지 않는다**.
#[test]
fn an_unmarked_transcript_is_never_matched_even_when_it_is_the_only_one() {
    let a = spawn(1, 1_000_000);
    let theirs = foreign("theirs", 1_000_500);

    // ① 우리 전사가 생기기 전 — 외부 전사만 있다. 폴백이 있었다면 여기서
    //    Matched(theirs)가 나왔다(= U1이 지적한 오매칭).
    let narrowed = narrow_to_marked(&[theirs.clone()]);
    assert!(narrowed.is_empty(), "표식 없는 후보는 목록에 남지 않는다");
    assert_eq!(
        match_rollout(&a, &[a.clone()], &narrowed, &[]),
        MatchOutcome::NoCandidate,
        "표식이 없으면 아무것도 매칭하지 않는다"
    );

    // ② 첫 메시지 뒤 우리 전사가 생기면 그때 확정된다 — 기다린 값이 있다.
    let mine = cand("mine", 1_000_900);
    let narrowed = narrow_to_marked(&[theirs, mine.clone()]);
    assert_eq!(
        match_rollout(&a, &[a.clone()], &narrowed, &[]),
        MatchOutcome::Matched(mine.path)
    );
}

/// 표식 없는 후보는 몇 개가 있든 전부 빠진다.
#[test]
fn unmarked_transcripts_never_survive_narrowing() {
    let all = [foreign("x", 1), cand("mine", 2), foreign("y", 3)];
    let narrowed = narrow_to_marked(&all);
    assert_eq!(narrowed.len(), 1);
    assert_eq!(narrowed[0].originator.as_deref(), Some(APP_ORIGINATOR));
    assert!(narrow_to_marked(&[foreign("x", 1), foreign("y", 2)]).is_empty());
}

// ---------------------------------------------------------------------------
// 매핑
// ---------------------------------------------------------------------------

fn map(lines: &[&str]) -> RolloutParse {
    let mut m = RolloutMapper::new("/proj");
    for l in lines {
        m.apply_line(l);
    }
    m.finish()
}

const USER: &str = r#"{"timestamp":"2026-08-07T11:52:10.000Z","type":"event_msg","payload":{"type":"user_message","message":"파일 읽어줘","images":[],"local_images":[],"text_elements":[]}}"#;

#[test]
fn user_message_opens_a_turn_and_agent_message_answers_it() {
    let out = map(&[
        META,
        USER,
        r#"{"timestamp":"2026-08-07T11:52:20.000Z","type":"event_msg","payload":{"type":"agent_message","message":"먼저 찾아볼게요","phase":"commentary"}}"#,
        r#"{"timestamp":"2026-08-07T11:52:30.000Z","type":"event_msg","payload":{"type":"agent_message","message":"다 됐습니다","phase":"final_answer"}}"#,
    ]);
    assert_eq!(out.turns, vec![(1, "파일 읽어줘".to_string())]);
    // commentary + final_answer 둘 다 TUI에 보이므로 둘 다 잇는다.
    assert_eq!(out.answers, vec![(1, "먼저 찾아볼게요\n\n다 됐습니다".to_string())]);
    assert_eq!(out.dates, vec![(1, "2026-08-07".to_string())]);
    assert_eq!(out.session_id, "019fdc10-e8ad-7923-80c4-169adc7e9521");
}

/// 시스템 주입(`response_item`의 developer/user)은 대화에 끼지 않는다 — 이걸
/// 놓치면 매 턴 앞에 `<environment_context>` 덩어리가 사용자 발화로 뜬다.
#[test]
fn injected_context_is_not_a_user_turn() {
    let out = map(&[
        META,
        r#"{"timestamp":"2026-08-07T11:52:05.000Z","type":"response_item","payload":{"type":"message","role":"developer","content":[{"type":"input_text","text":"<permissions instructions>…"}]}}"#,
        r#"{"timestamp":"2026-08-07T11:52:05.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<recommended_plugins>…"}]}}"#,
        USER,
    ]);
    assert_eq!(out.turns.len(), 1);
    assert_eq!(out.turns[0].0, 1);
    assert!(out.skipped.is_empty(), "message는 아는 레코드다: {:?}", out.skipped);
}

#[test]
fn exec_command_becomes_a_run_item_with_its_output() {
    let out = map(&[
        META,
        USER,
        r#"{"timestamp":"2026-08-07T11:52:11.000Z","type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"{\"cmd\":\"cat a.txt\",\"workdir\":\"/proj\"}","call_id":"call_1"}}"#,
        r#"{"timestamp":"2026-08-07T11:52:12.000Z","type":"response_item","payload":{"type":"function_call_output","call_id":"call_1","output":"hello"}}"#,
    ]);
    assert_eq!(out.items.len(), 1);
    let it = &out.items[0];
    assert_eq!(it.kind, ItemKind::Execute);
    assert_eq!(it.title, "cat a.txt");
    assert_eq!(it.turn, 1);
    assert_eq!(it.content_text.as_deref(), Some("hello"));
    assert_eq!(it.agent_status, AgentStatus::Completed);
    assert_eq!(it.cwd.as_deref(), Some("/proj"));
    // 뷰어(ItemDetail)가 `raw_input.command`를 "명령" 블록으로 띄운다.
    assert_eq!(it.raw_input.as_ref().unwrap()["command"], "cat a.txt");
}

/// `exec_command_end`만이 codex의 명령 해석(`parsed_cmd`)을 들고 온다 — 종류를
/// READ/FIND로 좁히고 상대 경로를 절대 경로로 만드는 유일한 지점.
#[test]
fn exec_command_end_refines_kind_and_paths() {
    let out = map(&[
        META,
        USER,
        r#"{"timestamp":"2026-08-07T11:52:11.000Z","type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"{\"cmd\":\"sed -n '1,20p' src/a.rs\"}","call_id":"c1"}}"#,
        r#"{"timestamp":"2026-08-07T11:52:12.000Z","type":"event_msg","payload":{"type":"exec_command_end","call_id":"c1","cwd":"/proj","parsed_cmd":[{"type":"read","name":"a.rs","path":"src/a.rs"}],"aggregated_output":"fn main() {}","exit_code":0,"status":"completed"}}"#,
    ]);
    let it = &out.items[0];
    assert_eq!(it.kind, ItemKind::Read);
    assert_eq!(it.locations, vec![PathBuf::from("/proj/src/a.rs")]);
    assert_eq!(it.content_text.as_deref(), Some("fn main() {}"));
}

#[test]
fn a_nonzero_exit_marks_the_item_failed() {
    let out = map(&[
        META,
        USER,
        r#"{"timestamp":"2026-08-07T11:52:11.000Z","type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"{\"cmd\":\"false\"}","call_id":"c1"}}"#,
        r#"{"timestamp":"2026-08-07T11:52:12.000Z","type":"event_msg","payload":{"type":"exec_command_end","call_id":"c1","cwd":"/proj","parsed_cmd":[],"aggregated_output":"boom","exit_code":1,"status":"completed"}}"#,
    ]);
    assert_eq!(out.items[0].agent_status, AgentStatus::Failed);
}

#[test]
fn apply_patch_carries_the_three_change_shapes() {
    let out = map(&[
        META,
        USER,
        r#"{"timestamp":"2026-08-07T11:52:11.000Z","type":"response_item","payload":{"type":"custom_tool_call","status":"completed","call_id":"c1","name":"apply_patch","input":"*** Begin Patch\n…"}}"#,
        r#"{"timestamp":"2026-08-07T11:52:12.000Z","type":"event_msg","payload":{"type":"patch_apply_end","call_id":"c1","stdout":"Success.","stderr":"","success":true,"changes":{"/proj/new.md":{"type":"add","content":"NEW"},"/proj/old.md":{"type":"delete","content":"OLD"},"/proj/mid.md":{"type":"update","unified_diff":"@@ -1 +1 @@\n-a\n+b\n","move_path":null}},"status":"completed"}}"#,
    ]);
    let it = &out.items[0];
    assert_eq!(it.kind, ItemKind::Edit);
    assert_eq!(it.diffs.len(), 3);
    let find = |n: &str| it.diffs.iter().find(|d| d.path.ends_with(n)).unwrap();
    // 새 파일 = 이전 없음 + 전문.
    assert_eq!(find("new.md").old_text, None);
    assert_eq!(find("new.md").new_text, "NEW");
    // 삭제 = 사라진 전문을 "이전"으로.
    assert_eq!(find("old.md").old_text.as_deref(), Some("OLD"));
    assert_eq!(find("old.md").new_text, "");
    // 수정 = codex가 unified diff만 준다. 전/후 전문을 지어내지 않는다.
    assert_eq!(find("mid.md").old_text, None);
    assert!(find("mid.md").new_text.contains("@@ -1 +1 @@"));
    assert!(it.title.starts_with("패치 "), "제목이 변경 파일을 담아야 한다: {}", it.title);
}

#[test]
fn update_plan_renders_as_a_checklist_for_the_plan_viewer() {
    let out = map(&[
        META,
        USER,
        r#"{"timestamp":"2026-08-07T11:52:11.000Z","type":"response_item","payload":{"type":"function_call","name":"update_plan","arguments":"{\"plan\":[{\"step\":\"조사\",\"status\":\"completed\"},{\"step\":\"구현\",\"status\":\"in_progress\"},{\"step\":\"검증\",\"status\":\"pending\"}]}","call_id":"c1"}}"#,
    ]);
    let it = &out.items[0];
    assert_eq!(it.kind, ItemKind::Plan);
    let plan = it.raw_input.as_ref().unwrap()["plan"].as_str().unwrap();
    assert_eq!(plan, "- [x] 조사\n- [~] 구현\n- [ ] 검증");
}

#[test]
fn a_web_search_shows_its_query() {
    let out = map(&[
        META,
        USER,
        r#"{"timestamp":"2026-08-07T11:52:11.000Z","type":"event_msg","payload":{"type":"web_search_end","call_id":"ws1","query":"rust pty","action":{"type":"search","query":"rust pty"}}}"#,
    ]);
    assert_eq!(out.items[0].kind, ItemKind::Fetch);
    assert_eq!(out.items[0].title, "rust pty");
    assert_eq!(out.items[0].agent_status, AgentStatus::Completed);
}

#[test]
fn tokens_split_cached_input_and_track_the_last_reading() {
    let out = map(&[
        META,
        USER,
        r#"{"timestamp":"2026-08-07T11:52:12.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":21091,"cached_input_tokens":11648,"output_tokens":277,"reasoning_output_tokens":0,"total_tokens":21368},"last_token_usage":{"input_tokens":21091,"cached_input_tokens":11648,"output_tokens":277,"reasoning_output_tokens":0,"total_tokens":21368},"model_context_window":258400},"rate_limits":null}}"#,
        // rate-limit만 실린 틱은 info가 null이다(실전사 97건) — 무시하고 지나가야 한다.
        r#"{"timestamp":"2026-08-07T11:52:13.000Z","type":"event_msg","payload":{"type":"token_count","info":null,"rate_limits":{"limit_id":"codex"}}}"#,
    ]);
    let u = out.last_usage.unwrap();
    // codex의 input_tokens는 캐시분 포함 총량 — 게이지 분자(input+cache_read)가
    // 원래의 input_tokens와 같아야 한다.
    assert_eq!(u.input + u.cache_read, 21_091);
    assert_eq!(u.cache_read, 11_648);
    assert_eq!(u.output, 277);
    assert_eq!(out.context_window, Some(258_400));
    assert_eq!(out.tokens.len(), 1);
}

#[test]
fn turn_context_supplies_the_model_and_effort() {
    let out = map(&[
        META,
        r#"{"timestamp":"2026-08-07T11:52:09.000Z","type":"turn_context","payload":{"turn_id":"t1","cwd":"/proj","model":"gpt-5.6-sol","effort":"xhigh","summary":"auto"}}"#,
    ]);
    assert_eq!(out.model.as_deref(), Some("gpt-5.6-sol"));
    assert_eq!(out.effort.as_deref(), Some("xhigh"));
}

/// 중단된 턴 — 아직 열려 있던 도구 호출이 "진행 중"으로 영원히 남지 않는다.
#[test]
fn an_aborted_turn_closes_open_calls() {
    let out = map(&[
        META,
        USER,
        r#"{"timestamp":"2026-08-07T11:52:11.000Z","type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"{\"cmd\":\"sleep 100\"}","call_id":"c1"}}"#,
        r#"{"timestamp":"2026-08-07T11:52:20.000Z","type":"event_msg","payload":{"type":"turn_aborted","turn_id":"t1","reason":"interrupted"}}"#,
    ]);
    assert_eq!(out.items[0].agent_status, AgentStatus::Canceled);
}

// ---------------------------------------------------------------------------
// 관대함 (codex 버전업 내성)
// ---------------------------------------------------------------------------

#[test]
fn unknown_records_are_counted_not_fatal() {
    let out = map(&[
        META,
        USER,
        r#"{"timestamp":"2026-08-07T11:52:11.000Z","type":"brand_new_kind","payload":{"whatever":1}}"#,
        r#"{"timestamp":"2026-08-07T11:52:11.000Z","type":"event_msg","payload":{"type":"future_event","x":1}}"#,
        r#"{"timestamp":"2026-08-07T11:52:11.000Z","type":"response_item","payload":{"type":"future_item","x":1}}"#,
    ]);
    assert_eq!(
        out.skipped,
        vec![
            ("brand_new_kind".to_string(), 1),
            ("event_msg/future_event".to_string(), 1),
            ("response_item/future_item".to_string(), 1),
        ]
    );
    // 미지 레코드가 있어도 아는 부분은 그대로 산다.
    assert_eq!(out.turns.len(), 1);
}

#[test]
fn malformed_lines_are_counted_not_fatal() {
    let out = map(&[
        META,
        "{ this is not json",
        "",
        r#"{"timestamp":"x","payload":{}}"#, // type 없음
        USER,
    ]);
    assert_eq!(out.bad_lines, 2);
    assert_eq!(out.turns.len(), 1);
    // 빈 줄은 세지 않는다(전사 끝의 개행).
    assert_eq!(out.lines, 4);
}

/// 여는 레코드를 못 본 결과(전사 앞이 잘렸거나 순서가 뒤집힌 경우)도 버리지
/// 않는다 — 결과가 통째로 사라지는 편이 더 나쁘다.
#[test]
fn an_output_without_its_call_still_lands() {
    let out = map(&[
        META,
        USER,
        r#"{"timestamp":"2026-08-07T11:52:12.000Z","type":"response_item","payload":{"type":"function_call_output","call_id":"orphan","output":"결과만 있다"}}"#,
    ]);
    assert_eq!(out.items.len(), 1);
    assert_eq!(out.items[0].content_text.as_deref(), Some("결과만 있다"));
}

/// 도구 결과가 **배열**로 오는 형태(실전사 29건 — `exec` 커스텀 도구가 헤더와
/// 본문을 두 조각으로 준다). 문자열로만 읽으면 항목은 남고 내용만 비는 조용한 유실.
#[test]
fn array_shaped_tool_output_is_joined() {
    let out = map(&[
        META,
        USER,
        r#"{"timestamp":"2026-08-07T11:52:11.000Z","type":"response_item","payload":{"type":"custom_tool_call","status":"completed","call_id":"c1","name":"exec","input":"tools.exec_command(…)"}}"#,
        r#"{"timestamp":"2026-08-07T11:52:12.000Z","type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"c1","output":[{"type":"input_text","text":"Script completed\nOutput:\n"},{"type":"input_text","text":"hooks/git-guard.sh\n"}]}}"#,
    ]);
    assert_eq!(
        out.items[0].content_text.as_deref(),
        Some("Script completed\nOutput:\nhooks/git-guard.sh\n"),
    );
}

#[test]
fn an_unknown_output_shape_is_shown_rather_than_dropped() {
    let out = map(&[
        META,
        USER,
        r#"{"timestamp":"2026-08-07T11:52:12.000Z","type":"response_item","payload":{"type":"function_call_output","call_id":"c1","output":{"future":"shape"}}}"#,
    ]);
    assert_eq!(out.items[0].content_text.as_deref(), Some(r#"{"future":"shape"}"#));
}

/// 읽을 수조차 없는 줄(무효 UTF-8)도 세어서 화면에 드러낸다 — 말없이 건너뛰면
/// 타임라인이 이유 없이 얇아진다(리뷰 #6).
#[test]
fn unreadable_bytes_are_counted_as_bad_lines() {
    let mut p = std::env::temp_dir();
    p.push(format!("cw-codex-rollout-{}.jsonl", std::process::id()));
    let mut bytes = META.as_bytes().to_vec();
    bytes.push(b'\n');
    bytes.extend_from_slice(&[0xff, 0xfe, 0xff, b'\n']); // 무효 UTF-8 한 줄
    bytes.extend_from_slice(USER.as_bytes());
    bytes.push(b'\n');
    std::fs::write(&p, &bytes).unwrap();
    let out = parse_rollout(&p).unwrap();
    std::fs::remove_file(&p).ok();
    assert_eq!(out.bad_lines, 1);
    assert_eq!(out.turns.len(), 1, "읽을 수 있는 줄은 그대로 살아야 한다");
}

#[test]
fn arguments_that_are_not_json_still_show_up() {
    let out = map(&[
        META,
        USER,
        r#"{"timestamp":"2026-08-07T11:52:11.000Z","type":"response_item","payload":{"type":"function_call","name":"mystery","arguments":"not json at all","call_id":"c1"}}"#,
    ]);
    assert_eq!(out.items.len(), 1);
    assert!(out.items[0].title.starts_with("mystery"));
}

// ---------------------------------------------------------------------------
// 실전사 코퍼스 (이 머신에 있을 때만 — 다른 머신에서는 조용히 통과)
// ---------------------------------------------------------------------------

/// **가정①의 상시 검증**: 이 머신의 `~/.codex/sessions` 전 파일을 파싱해 crash 0을
/// 확인한다. 코퍼스가 없는 머신(CI·타 개발기)에서는 아무것도 하지 않는다 —
/// 사용자 데이터에 의존하는 단언은 넣지 않고, "터지지 않는다"만 본다.
#[test]
fn the_real_corpus_parses_without_crashing() {
    let Some(root) = codex_sessions_root().filter(|r| r.is_dir()) else { return };
    let mut files = Vec::new();
    collect_jsonl(&root, &mut files);
    let (mut lines, mut bad, mut items) = (0u64, 0u64, 0usize);
    let mut skipped: BTreeMap<String, u64> = BTreeMap::new();
    for f in &files {
        let Ok(p) = parse_rollout(f) else { continue };
        lines += p.lines;
        bad += p.bad_lines;
        items += p.items.len();
        for (k, v) in p.skipped {
            *skipped.entry(k).or_insert(0) += v;
        }
    }
    eprintln!(
        "[codex 코퍼스] 파일 {} · 줄 {lines} · 미파싱 {bad} · 아이템 {items} · 미지 {skipped:?}",
        files.len()
    );
    if lines > 0 {
        // 전사는 append 중일 수 있어 마지막 줄이 잘릴 수 있다 — 0을 요구하지 않되
        // 스키마가 통째로 바뀌면(대량 미파싱) 걸리게 한다.
        assert!(bad * 100 < lines, "미파싱 줄이 1%를 넘는다: {bad}/{lines}");
    }
}

fn collect_jsonl(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            collect_jsonl(&p, out);
        } else if p.extension().and_then(|x| x.to_str()) == Some("jsonl") {
            out.push(p);
        }
    }
}

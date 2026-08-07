//! codex **rollout 전사** → 타임라인 (작업③ H).
//!
//! claude 매퍼([`crate::jsonl`])와 **완전히 분리된 신규 모듈**이다(spec ②). 두
//! 전사는 이름만 같은 JSONL일 뿐 공유할 것이 없다:
//!
//! | | claude | codex |
//! |---|---|---|
//! | 경로 | `~/.claude/projects/<slug>/<uuid>.jsonl` | `~/.codex/sessions/Y/M/D/rollout-<ts>-<uuid>.jsonl` |
//! | uuid | **앱이 선채번**(`--session-id`) | codex가 정하고 첫 줄에 쓴다 |
//! | 레코드 | `{type, message{role, content[]}}` | `{timestamp, type, payload{type,…}}` |
//! | 도구 | `tool_use`/`tool_result` 블록 | `function_call`/`custom_tool_call` + `event_msg` 종료 이벤트 |
//!
//! 공유하는 것은 **누적기**([`Timeline`])와 표시 모델([`TimelineItem`])뿐 —
//! ACP·JSONL 매퍼가 이미 그렇게 서 있다.
//!
//! # 실전사 인벤토리 (2026-08-07 · 211파일 10,046줄 · 파싱 실패 0줄)
//!
//! 모든 줄이 `{timestamp, type, payload}` 3키. `type`은 6종:
//! `response_item`(6222) `event_msg`(3294) `turn_context`(309) `session_meta`(211)
//! `world_state`(9) `compacted`(1).
//!
//! **`event_msg`와 `response_item`은 같은 대화의 두 층이다.** `response_item`은
//! API에 실제로 오가는 원본이라 시스템 주입(`developer` 251·컨텍스트 `user` 232)이
//! 섞이고, `event_msg`는 TUI가 보여주는 층이다. 그래서 **대화는 `event_msg`에서,
//! 도구는 `response_item`에서** 가져온다 — `agent_message`(820)는
//! `response_item/message role=assistant`(820)와 1:1이고, `user_message`(322)만
//! 사용자가 실제로 친 것이다(같은 role의 response_item 554 중 232는 주입).
//!
//! 파싱은 **미지 레코드에 관대**하다(spec ②): 모르는 `type`·`payload.type`은
//! 건너뛰고 [`RolloutParse::skipped`]에 종류별로 센다. codex가 필드를 늘려도
//! 화면이 조용히 비지 않고 "N개 미지원 레코드"로 드러난다.

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::timeline::{AgentStatus, FileDiff, ItemKind, Timeline, TimelineItem, TokenUsage};

// ---------------------------------------------------------------------------
// 경로
// ---------------------------------------------------------------------------

/// `~/.codex/sessions` (또는 `CODEX_HOME/sessions`). codex가 rollout 전사를
/// `<root>/YYYY/MM/DD/rollout-<로컬시각>-<uuid>.jsonl`로 쓴다.
pub fn codex_sessions_root() -> Option<PathBuf> {
    if let Ok(home) = std::env::var("CODEX_HOME") {
        if !home.is_empty() {
            return Some(PathBuf::from(home).join("sessions"));
        }
    }
    let home = std::env::var("HOME").ok().filter(|h| !h.is_empty())?;
    Some(PathBuf::from(home).join(".codex").join("sessions"))
}

// ---------------------------------------------------------------------------
// 시각 파싱 (chrono 없이 — core는 chrono 의존이 없다)
// ---------------------------------------------------------------------------

/// RFC3339 → epoch millis. `2026-08-07T11:52:03.502Z` / `…+09:00` / `…+0900` 형태만
/// 받는다(전사가 쓰는 형태). 형식이 어긋나면 `None` — 그 후보는 매칭에서 빠진다
/// (추측해서 남의 세션에 붙는 것보다 안 붙는 쪽이 정답, spec ②).
pub fn parse_rfc3339_ms(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 19 {
        return None;
    }
    let num = |from: usize, to: usize| -> Option<i64> { s.get(from..to)?.parse::<i64>().ok() };
    if b[4] != b'-' || b[7] != b'-' || !(b[10] == b'T' || b[10] == b't' || b[10] == b' ') {
        return None;
    }
    if b[13] != b':' || b[16] != b':' {
        return None;
    }
    let (y, mo, d) = (num(0, 4)?, num(5, 7)?, num(8, 10)?);
    let (h, mi, se) = (num(11, 13)?, num(14, 16)?, num(17, 19)?);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || se > 60 {
        return None;
    }

    let mut rest = &s[19..];
    let mut millis = 0i64;
    if let Some(frac) = rest.strip_prefix('.') {
        let digits: String = frac.chars().take_while(|c| c.is_ascii_digit()).collect();
        if digits.is_empty() {
            return None;
        }
        let mut ms = String::from("000");
        ms.replace_range(..digits.len().min(3), &digits[..digits.len().min(3)]);
        millis = ms.parse().ok()?;
        rest = &rest[1 + digits.len()..];
    }

    // 오프셋: Z | ±HH:MM | ±HHMM | ±HH
    let offset_min = match rest.as_bytes().first() {
        None => 0, // 오프셋 생략 = UTC로 취급(전사에는 없는 형태지만 관대하게)
        Some(b'Z') | Some(b'z') => 0,
        Some(sign @ (b'+' | b'-')) => {
            let sign = if *sign == b'-' { -1 } else { 1 };
            let t = &rest[1..];
            let (hh, mm) = if t.len() >= 5 && t.as_bytes()[2] == b':' {
                (t.get(0..2)?, t.get(3..5)?)
            } else if t.len() >= 4 {
                (t.get(0..2)?, t.get(2..4)?)
            } else if t.len() >= 2 {
                (t.get(0..2)?, "00")
            } else {
                return None;
            };
            sign * (hh.parse::<i64>().ok()? * 60 + mm.parse::<i64>().ok()?)
        }
        Some(_) => return None,
    };

    let days = days_from_civil(y, mo, d);
    Some(((days * 86_400 + h * 3_600 + mi * 60 + se - offset_min * 60) * 1_000) + millis)
}

/// 1970-01-01 기준 일수 (Howard Hinnant, `days_from_civil`).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

// ---------------------------------------------------------------------------
// session_meta (첫 줄) — 매칭의 입력
// ---------------------------------------------------------------------------

/// 전사 첫 줄(`session_meta`)에서 뽑는 신원. **`started_ms`가 매칭의 핵심**이다:
/// 파일 자체는 사용자가 첫 메시지를 보낼 때에야 생기지만(실측 — TUI 기동 25초
/// 동안 파일 없음), 이 필드는 **TUI가 뜬 시각**을 담는다(실측: 스폰 +0.9초).
#[derive(Debug, Clone, PartialEq)]
pub struct RolloutMeta {
    pub session_id: Option<String>,
    pub cwd: Option<String>,
    pub started_ms: Option<i64>,
    pub originator: Option<String>,
    pub cli_version: Option<String>,
}

fn str_field(v: &Value, k: &str) -> Option<String> {
    v.get(k)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// `session_meta` 한 줄을 파싱한다. 다른 타입이거나 형태가 어긋나면 `None`.
pub fn parse_meta_line(line: &str) -> Option<RolloutMeta> {
    let v: Value = serde_json::from_str(line.trim()).ok()?;
    if v.get("type").and_then(Value::as_str)? != "session_meta" {
        return None;
    }
    let p = v.get("payload")?;
    Some(RolloutMeta {
        session_id: str_field(p, "session_id").or_else(|| str_field(p, "id")),
        cwd: str_field(p, "cwd"),
        started_ms: str_field(p, "timestamp").as_deref().and_then(parse_rfc3339_ms),
        originator: str_field(p, "originator"),
        cli_version: str_field(p, "cli_version"),
    })
}

/// 파일의 **첫 줄만** 읽어 신원을 뽑는다(후보 스캔이 전문을 읽지 않게).
pub fn read_meta(path: &Path) -> Option<RolloutMeta> {
    let f = std::fs::File::open(path).ok()?;
    let mut first = String::new();
    BufReader::new(f).read_line(&mut first).ok()?;
    parse_meta_line(&first)
}

// ---------------------------------------------------------------------------
// 스폰 ↔ 전사 매칭
// ---------------------------------------------------------------------------

/// 시계 오차 여유 — 전사 시각이 스폰 시각보다 **앞설** 수 있는 한계.
pub const MATCH_SKEW_MS: i64 = 2_000;
/// 스폰 후 전사 세션이 열리기까지 허용하는 창. 실측 0.9초라 30초는 넉넉하면서도,
/// **다음 탭이 이 창 안에 들어오지 않을 만큼** 짧아야 한다(창이 넓을수록 남의
/// 세션을 덮을 위험이 커진다).
pub const MATCH_WINDOW_MS: i64 = 30_000;

/// 살아 있는 codex 탭 하나 — 매칭의 주체이자, 다른 탭의 후보를 **가로막는** 존재.
#[derive(Debug, Clone, PartialEq)]
pub struct SpawnRef {
    pub id: u64,
    /// 스폰 cwd(절대 경로). `None`이면 어떤 후보와도 cwd가 맞지 않는 것으로 본다.
    pub cwd: Option<String>,
    pub spawned_ms: i64,
}

/// 아직 임자가 정해지지 않은 전사 파일 하나.
#[derive(Debug, Clone, PartialEq)]
pub struct RolloutCandidate {
    pub path: PathBuf,
    pub cwd: Option<String>,
    pub started_ms: Option<i64>,
}

/// 매칭 결과. **`Matched` 외에는 전부 "전사를 찾지 못함"**이고, 이유가 다를 뿐이다
/// (무음 금지 — 뷰가 이유를 그대로 보여준다).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MatchOutcome {
    Matched(PathBuf),
    /// 창 안에 맞는 파일이 아직 없다(= 첫 메시지 전이거나 창을 벗어났다).
    NoCandidate,
    /// 후보는 있으나 **다른 살아 있는 탭도 같은 후보를 가리킨다** — 동시 스폰.
    Contested,
    /// 이 탭의 창 안에 후보가 둘 이상이다.
    Multiple,
}

/// 스폰 하나가 전사 하나를 덮는가 — cwd 일치 + 시각 창.
fn covers(spawn: &SpawnRef, cand: &RolloutCandidate) -> bool {
    let (Some(scwd), Some(ccwd)) = (spawn.cwd.as_deref(), cand.cwd.as_deref()) else {
        return false;
    };
    if scwd != ccwd {
        return false;
    }
    let Some(started) = cand.started_ms else {
        return false;
    };
    started >= spawn.spawned_ms - MATCH_SKEW_MS && started <= spawn.spawned_ms + MATCH_WINDOW_MS
}

/// `target` 탭의 전사를 고른다.
///
/// **오매칭이 이 기능의 유일한 심각 실패 모드**다(남의 대화가 내 탭에 뜬다). 그래서
/// 규칙은 전부 "확신 없으면 안 붙인다" 쪽으로 기운다:
///
/// 1. 이미 다른 탭이 claim한 파일(`claimed`)은 후보에서 제외한다.
/// 2. 후보는 **cwd가 같고** 시각이 `[스폰-2s, 스폰+30s]`인 것만.
/// 3. 후보 하나를 **다른 미해결 탭도** 덮으면(동시 스폰) 아무에게도 주지 않는다
///    → [`MatchOutcome::Contested`].
/// 4. 남은 후보가 정확히 하나일 때만 매칭. 둘 이상이면 [`MatchOutcome::Multiple`].
///
/// `live`에는 target 자신이 들어 있어도 되고 없어도 된다(id로 걸러낸다).
pub fn match_rollout(
    target: &SpawnRef,
    live: &[SpawnRef],
    candidates: &[RolloutCandidate],
    claimed: &[PathBuf],
) -> MatchOutcome {
    let mine: Vec<&RolloutCandidate> = candidates
        .iter()
        .filter(|c| !claimed.contains(&c.path) && covers(target, c))
        .collect();
    if mine.is_empty() {
        return MatchOutcome::NoCandidate;
    }
    let uncontested: Vec<&&RolloutCandidate> = mine
        .iter()
        .filter(|c| !live.iter().any(|s| s.id != target.id && covers(s, c)))
        .collect();
    match uncontested.len() {
        1 => MatchOutcome::Matched(uncontested[0].path.clone()),
        0 => MatchOutcome::Contested,
        _ => MatchOutcome::Multiple,
    }
}

// ---------------------------------------------------------------------------
// 전사 → 타임라인 매핑
// ---------------------------------------------------------------------------

/// 한 전사 파일을 끝까지 읽은 결과 — 그대로 UI 페이로드가 된다.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RolloutParse {
    pub session_id: String,
    pub cwd: Option<String>,
    pub items: Vec<TimelineItem>,
    pub turns: Vec<(u64, String)>,
    pub answers: Vec<(u64, String)>,
    pub dates: Vec<(u64, String)>,
    pub tokens: Vec<(u64, TokenUsage)>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub context_window: Option<u64>,
    pub last_usage: Option<TokenUsage>,
    /// 총 읽은 줄 수(빈 줄 제외).
    pub lines: u64,
    /// JSON으로 못 읽은 줄 수(전사가 append 중이라 마지막 줄이 잘렸을 때 등).
    pub bad_lines: u64,
    /// 인식하지 못해 건너뛴 레코드 — `"type/payload.type"` → 개수.
    pub skipped: Vec<(String, u64)>,
}

/// 전사를 줄 단위로 먹여 타임라인을 쌓는 매퍼. 파일 하나 = 세션 하나.
pub struct RolloutMapper {
    timeline: Timeline,
    session_id: String,
    cwd: Option<String>,
    current_turn: u64,
    turns: BTreeMap<u64, String>,
    answers: BTreeMap<u64, String>,
    dates: BTreeMap<u64, String>,
    tokens: BTreeMap<u64, TokenUsage>,
    model: Option<String>,
    effort: Option<String>,
    context_window: Option<u64>,
    last_usage: Option<TokenUsage>,
    skipped: BTreeMap<String, u64>,
    lines: u64,
    bad_lines: u64,
    reasoning_n: u64,
}

impl RolloutMapper {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        let root = root.into();
        Self {
            timeline: Timeline::new(root),
            session_id: String::new(),
            cwd: None,
            current_turn: 0,
            turns: BTreeMap::new(),
            answers: BTreeMap::new(),
            dates: BTreeMap::new(),
            tokens: BTreeMap::new(),
            model: None,
            effort: None,
            context_window: None,
            last_usage: None,
            skipped: BTreeMap::new(),
            lines: 0,
            bad_lines: 0,
            reasoning_n: 0,
        }
    }

    pub fn finish(self) -> RolloutParse {
        RolloutParse {
            session_id: self.session_id,
            cwd: self.cwd,
            items: self.timeline.items().to_vec(),
            turns: self.turns.into_iter().collect(),
            answers: self.answers.into_iter().collect(),
            dates: self.dates.into_iter().collect(),
            tokens: self.tokens.into_iter().collect(),
            model: self.model,
            effort: self.effort,
            context_window: self.context_window,
            last_usage: self.last_usage,
            lines: self.lines,
            bad_lines: self.bad_lines,
            skipped: self.skipped.into_iter().collect(),
        }
    }

    fn skip(&mut self, key: String) {
        *self.skipped.entry(key).or_insert(0) += 1;
    }

    /// 한 줄을 적용한다. 어떤 입력에도 panic하지 않는다 — 못 읽으면 세고 넘어간다.
    pub fn apply_line(&mut self, line: &str) {
        let line = line.trim();
        if line.is_empty() {
            return;
        }
        self.lines += 1;
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            self.bad_lines += 1;
            return;
        };
        let ts = v.get("timestamp").and_then(Value::as_str).map(str::to_string);
        let Some(rtype) = v.get("type").and_then(Value::as_str) else {
            self.bad_lines += 1;
            return;
        };
        let payload = v.get("payload").cloned().unwrap_or(Value::Null);
        match rtype {
            "session_meta" => self.apply_meta(&payload),
            "turn_context" => self.apply_turn_context(&payload),
            "event_msg" => self.apply_event(&payload, ts.as_deref()),
            "response_item" => self.apply_response_item(&payload),
            // 알고 있으나 타임라인에 담을 것이 없는 레코드. `world_state`는 codex가
            // 모델에 주는 환경 스냅샷, `compacted`는 컨텍스트 압축 후의 치환 이력.
            "world_state" | "compacted" => {}
            other => self.skip(other.to_string()),
        }
    }

    fn apply_meta(&mut self, p: &Value) {
        if let Some(id) = str_field(p, "session_id").or_else(|| str_field(p, "id")) {
            self.session_id = id;
        }
        if let Some(cwd) = str_field(p, "cwd") {
            self.cwd = Some(cwd);
        }
    }

    fn apply_turn_context(&mut self, p: &Value) {
        if let Some(m) = str_field(p, "model") {
            self.model = Some(m);
        }
        if let Some(e) = str_field(p, "effort") {
            self.effort = Some(e);
        }
        if self.cwd.is_none() {
            self.cwd = str_field(p, "cwd");
        }
    }

    // -- event_msg (TUI 층: 대화·도구 종료 이벤트) ---------------------------

    fn apply_event(&mut self, p: &Value, ts: Option<&str>) {
        let Some(kind) = p.get("type").and_then(Value::as_str) else {
            self.skip("event_msg/<none>".into());
            return;
        };
        match kind {
            // 사용자가 실제로 친 것 = 새 턴. (response_item의 user 레코드에는
            // `<environment_context>` 같은 주입이 섞여 있어 쓰지 않는다.)
            "user_message" => {
                self.current_turn += 1;
                let turn = self.current_turn;
                let msg = str_field(p, "message").unwrap_or_default();
                self.turns.insert(turn, msg);
                if let Some(d) = ts.and_then(|t| t.get(..10)) {
                    self.dates.insert(turn, d.to_string());
                }
            }
            // 어시스턴트 출력. `phase`는 commentary(중간 코멘트) / final_answer —
            // TUI에는 둘 다 보이므로 둘 다 답변에 잇는다.
            "agent_message" => {
                let Some(msg) = str_field(p, "message") else { return };
                let turn = self.current_turn;
                let slot = self.answers.entry(turn).or_default();
                if !slot.is_empty() {
                    slot.push_str("\n\n");
                }
                slot.push_str(&msg);
            }
            "token_count" => self.apply_tokens(p),
            "task_started" => {
                if let Some(w) = p.get("model_context_window").and_then(Value::as_u64) {
                    self.context_window = Some(w);
                }
            }
            // 중단된 턴 — 아직 열려 있는 도구 호출을 취소로 닫는다.
            "turn_aborted" => self.timeline.cancel_open(),
            "exec_command_end" => self.apply_exec_end(p),
            "patch_apply_end" => self.apply_patch_end(p),
            "web_search_end" => self.apply_web_search(p),
            "mcp_tool_call_end" => self.apply_mcp_end(p),
            // 알지만 표시할 것이 없는 것들.
            "task_complete" | "context_compacted" | "thread_rolled_back" => {}
            other => self.skip(format!("event_msg/{other}")),
        }
    }

    fn apply_tokens(&mut self, p: &Value) {
        // `info`는 rate-limit만 실린 틱에서 null이다(실전사 97건).
        let Some(info) = p.get("info").filter(|i| i.is_object()) else { return };
        if let Some(w) = info.get("model_context_window").and_then(Value::as_u64) {
            self.context_window = Some(w);
        }
        let Some(last) = info.get("last_token_usage") else { return };
        let usage = usage_from(last);
        self.last_usage = Some(usage);
        self.tokens.entry(self.current_turn).or_default().add(&usage);
    }

    // -- response_item (API 층: 도구 호출) -----------------------------------

    fn apply_response_item(&mut self, p: &Value) {
        let Some(kind) = p.get("type").and_then(Value::as_str) else {
            self.skip("response_item/<none>".into());
            return;
        };
        match kind {
            // 대화는 event_msg 층에서 이미 받았다(1:1 대응 — 모듈 주석 표 참조).
            "message" => {}
            "reasoning" => self.apply_reasoning(p),
            "function_call" => self.apply_function_call(p),
            "function_call_output" => {
                let Some(cid) = str_field(p, "call_id") else { return };
                let out = p.get("output").and_then(Value::as_str).map(str::to_string);
                self.complete(&cid, out, None);
            }
            "custom_tool_call" => self.apply_custom_call(p),
            "custom_tool_call_output" => {
                let Some(cid) = str_field(p, "call_id") else { return };
                // apply_patch는 `patch_apply_end`가 더 읽기 좋은 본문을 이미 넣는다
                // — 여기 output은 JSON 봉투라 덮어쓰지 않는다(complete가 기존 본문
                // 을 보존한다).
                let out = p.get("output").and_then(Value::as_str).map(str::to_string);
                self.complete(&cid, out, None);
            }
            // call_id가 없어 붙일 데가 없다 — 같은 호출을 event_msg/web_search_end가
            // call_id·query와 함께 들고 온다(그쪽이 아이템의 주인).
            "web_search_call" => {}
            "tool_search_call" => {
                let Some(cid) = str_field(p, "call_id") else { return };
                let q = p
                    .get("arguments")
                    .and_then(|a| a.get("query"))
                    .and_then(Value::as_str)
                    .unwrap_or("도구 검색");
                let raw = p.get("arguments").cloned();
                self.open(&cid, ItemKind::Search, q.to_string(), raw, Vec::new());
            }
            "tool_search_output" => {
                let Some(cid) = str_field(p, "call_id") else { return };
                let n = p.get("tools").and_then(Value::as_array).map(|a| a.len());
                self.complete(&cid, n.map(|n| format!("도구 {n}개")), None);
            }
            other => self.skip(format!("response_item/{other}")),
        }
    }

    /// 추론 요약. **실전사 1041건 전부 `summary: []`·`content: null`**이고 본문은
    /// `encrypted_content`라 읽을 수 없다 — 그래서 보통은 아무 아이템도 만들지
    /// 않는다. codex가 요약을 평문으로 주기 시작하면 그때 THINK 항목이 생긴다.
    fn apply_reasoning(&mut self, p: &Value) {
        let mut text = String::new();
        for arr in [p.get("summary"), p.get("content")].into_iter().flatten() {
            for it in arr.as_array().into_iter().flatten() {
                if let Some(t) = it.get("text").and_then(Value::as_str).filter(|t| !t.is_empty()) {
                    if !text.is_empty() {
                        text.push_str("\n\n");
                    }
                    text.push_str(t);
                }
            }
        }
        if text.is_empty() {
            return;
        }
        self.reasoning_n += 1;
        let id = format!("reasoning-{}", self.reasoning_n);
        let title = first_line(&text, 80);
        self.open(&id, ItemKind::Think, title, None, Vec::new());
        self.complete(&id, Some(text), Some(AgentStatus::Completed));
    }

    fn apply_function_call(&mut self, p: &Value) {
        let Some(cid) = str_field(p, "call_id") else { return };
        let name = str_field(p, "name").unwrap_or_else(|| "tool".into());
        // `arguments`는 **JSON 문자열**이다(중첩 객체가 아니라). 못 읽으면 원문을
        // 그대로 raw_input에 넣는다 — 화면에서 사라지지 않게.
        let args: Value = p
            .get("arguments")
            .and_then(Value::as_str)
            .and_then(|s| serde_json::from_str(s).ok())
            .unwrap_or_else(|| p.get("arguments").cloned().unwrap_or(Value::Null));

        match name.as_str() {
            "exec_command" => {
                let cmd = args.get("cmd").and_then(Value::as_str).unwrap_or("").to_string();
                let workdir = args.get("workdir").and_then(Value::as_str).map(str::to_string);
                let raw = serde_json::json!({ "command": cmd, "workdir": workdir });
                let title = first_line(&cmd, 120);
                let idx = self.open(&cid, ItemKind::Execute, title, Some(raw), Vec::new());
                if let (Some(i), Some(w)) = (idx, workdir) {
                    self.timeline.item_mut(i).cwd = Some(w);
                }
            }
            "update_plan" => {
                let steps = args.get("plan").and_then(Value::as_array).cloned().unwrap_or_default();
                let text = format_plan(&steps);
                let raw = serde_json::json!({ "plan": text });
                let title = format!("계획 {}단계", steps.len());
                self.open(&cid, ItemKind::Plan, title, Some(raw), Vec::new());
            }
            _ => {
                let title = format!("{name}{}", brief_args(&args));
                self.open(&cid, ItemKind::Other, title, Some(args), Vec::new());
            }
        }
    }

    fn apply_custom_call(&mut self, p: &Value) {
        let Some(cid) = str_field(p, "call_id") else { return };
        let name = str_field(p, "name").unwrap_or_else(|| "tool".into());
        let input = p.get("input").and_then(Value::as_str).unwrap_or("").to_string();
        let (kind, title) = match name.as_str() {
            // 실제 변경 파일 목록은 `patch_apply_end`가 알려 주므로 여기선 임시 제목.
            "apply_patch" => (ItemKind::Edit, "패치 적용".to_string()),
            "exec" => (ItemKind::Execute, first_line(&input, 120)),
            _ => (ItemKind::Other, name.clone()),
        };
        let raw = if kind == ItemKind::Execute {
            serde_json::json!({ "command": input })
        } else {
            serde_json::json!({ "input": input })
        };
        self.open(&cid, kind, title, Some(raw), Vec::new());
    }

    // -- 도구 종료 이벤트 (event_msg 층이 더 풍부한 정보를 준다) --------------

    fn apply_exec_end(&mut self, p: &Value) {
        let Some(cid) = str_field(p, "call_id") else { return };
        let cwd = str_field(p, "cwd");
        // `parsed_cmd`는 codex가 명령을 해석한 결과 — 여기서만 종류·경로를 얻는다.
        let mut kind = None;
        let mut paths: Vec<PathBuf> = Vec::new();
        for c in p.get("parsed_cmd").and_then(Value::as_array).into_iter().flatten() {
            match c.get("type").and_then(Value::as_str) {
                Some("read") => kind = kind.or(Some(ItemKind::Read)),
                Some("search") | Some("list_files") => kind = kind.or(Some(ItemKind::Search)),
                _ => {}
            }
            if let Some(path) = c.get("path").and_then(Value::as_str).filter(|p| !p.is_empty()) {
                paths.push(abs_path(path, cwd.as_deref()));
            }
        }
        let failed = p.get("exit_code").and_then(Value::as_i64).is_some_and(|c| c != 0)
            || p.get("status").and_then(Value::as_str) == Some("failed");
        let body = str_field(p, "aggregated_output")
            .or_else(|| str_field(p, "stdout"))
            .or_else(|| str_field(p, "stderr"));
        let status = Some(if failed { AgentStatus::Failed } else { AgentStatus::Completed });
        let Some(idx) = self.complete(&cid, body, status) else { return };
        let label = self.timeline.label_for(&paths);
        let item = self.timeline.item_mut(idx);
        if let Some(k) = kind {
            item.kind = k;
        }
        if !paths.is_empty() {
            item.locations = paths;
            item.project_label = label;
        }
        if item.cwd.is_none() {
            item.cwd = cwd;
        }
    }

    fn apply_patch_end(&mut self, p: &Value) {
        let Some(cid) = str_field(p, "call_id") else { return };
        let ok = p.get("success").and_then(Value::as_bool).unwrap_or(true);
        let mut diffs = Vec::new();
        let mut paths = Vec::new();
        for (path, change) in p.get("changes").and_then(Value::as_object).into_iter().flatten() {
            paths.push(PathBuf::from(path));
            let ctype = change.get("type").and_then(Value::as_str).unwrap_or("");
            let (old_text, new_text) = match ctype {
                // 새 파일: 이전이 없고 전문이 새 내용.
                "add" => (None, str_field(change, "content").unwrap_or_default()),
                // 삭제: 사라진 전문을 "이전"으로 보여 준다.
                "delete" => (str_field(change, "content"), String::new()),
                // 수정: codex가 **unified diff만** 준다(전/후 전문 없음). 그대로
                // 보여 주는 것이 정직하다 — 없는 전문을 지어내지 않는다.
                _ => (None, str_field(change, "unified_diff").unwrap_or_default()),
            };
            diffs.push(FileDiff { path: PathBuf::from(path), old_text, new_text });
        }
        let body = str_field(p, "stdout").or_else(|| str_field(p, "stderr"));
        let status = Some(if ok { AgentStatus::Completed } else { AgentStatus::Failed });
        let Some(idx) = self.complete(&cid, body, status) else { return };
        let label = self.timeline.label_for(&paths);
        let item = self.timeline.item_mut(idx);
        item.kind = ItemKind::Edit;
        if !paths.is_empty() {
            item.title = format!("패치 {}", join_names(&paths, 3));
            item.locations = paths;
            item.project_label = label;
        }
        item.diffs = diffs;
    }

    fn apply_web_search(&mut self, p: &Value) {
        let Some(cid) = str_field(p, "call_id") else { return };
        let query = str_field(p, "query")
            .or_else(|| p.get("action").and_then(|a| str_field(a, "query")))
            .unwrap_or_else(|| "웹 검색".into());
        let raw = p.get("action").cloned();
        self.open(&cid, ItemKind::Fetch, first_line(&query, 120), raw, Vec::new());
        self.complete(&cid, None, Some(AgentStatus::Completed));
    }

    fn apply_mcp_end(&mut self, p: &Value) {
        let Some(cid) = str_field(p, "call_id") else { return };
        let inv = p.get("invocation");
        let server = inv.and_then(|i| str_field(i, "server")).unwrap_or_else(|| "mcp".into());
        let tool = inv.and_then(|i| str_field(i, "tool")).unwrap_or_else(|| "tool".into());
        let raw = inv.and_then(|i| i.get("arguments")).cloned();
        self.open(&cid, ItemKind::Other, format!("{server}.{tool}"), raw, Vec::new());
        let result = p.get("result");
        let failed = result.is_some_and(|r| r.get("Err").is_some())
            || result
                .and_then(|r| r.get("Ok"))
                .and_then(|o| o.get("isError"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
        let body = result.map(|r| serde_json::to_string_pretty(r).unwrap_or_default());
        self.complete(
            &cid,
            body,
            Some(if failed { AgentStatus::Failed } else { AgentStatus::Completed }),
        );
    }

    // -- 누적기 프리미티브 ---------------------------------------------------

    /// 도구 호출을 연다(첫 목격이면 새 아이템). 이미 있으면 비어 있는 칸만 채운다
    /// — 종료 이벤트가 먼저 온 전사(순서 역전)에도 견딘다.
    fn open(
        &mut self,
        call_id: &str,
        kind: ItemKind,
        title: String,
        raw_input: Option<Value>,
        locations: Vec<PathBuf>,
    ) -> Option<usize> {
        let sid = self.session_id.clone();
        let turn = self.current_turn;
        let label = self.timeline.label_for(&locations);
        let (idx, is_new) = self.timeline.entry(&sid, call_id);
        let item = self.timeline.item_mut(idx);
        if is_new {
            item.turn = turn;
            item.agent_status = AgentStatus::InProgress;
        } else {
            item.revision += 1;
        }
        if item.title.is_empty() {
            item.title = title;
        }
        if item.kind == ItemKind::Other {
            item.kind = kind;
        }
        if item.raw_input.is_none() {
            item.raw_input = raw_input;
        }
        if item.locations.is_empty() && !locations.is_empty() {
            item.locations = locations;
            item.project_label = label;
        }
        Some(idx)
    }

    /// 도구 호출을 닫는다. 여는 레코드를 못 본 call_id면 껍데기를 만들어서라도
    /// 결과를 남긴다(관대 — 전사 앞부분이 잘렸을 때 결과가 통째로 사라지지 않게).
    fn complete(
        &mut self,
        call_id: &str,
        body: Option<String>,
        status: Option<AgentStatus>,
    ) -> Option<usize> {
        let sid = self.session_id.clone();
        let turn = self.current_turn;
        let (idx, is_new) = self.timeline.entry(&sid, call_id);
        let item = self.timeline.item_mut(idx);
        if is_new {
            item.turn = turn;
        }
        item.revision += 1;
        if let Some(b) = body.filter(|b| !b.is_empty()) {
            // 먼저 들어온 본문(더 읽기 좋은 종료 이벤트)을 덮지 않는다.
            if item.content_text.is_none() {
                item.content_text = Some(b);
            }
        }
        item.agent_status = status.unwrap_or(AgentStatus::Completed);
        Some(idx)
    }
}

// ---------------------------------------------------------------------------
// 파일 단위 진입점
// ---------------------------------------------------------------------------

/// 전사 파일 하나를 통째로 파싱한다. 읽기 실패만 `Err`이고, **내용이 어떻든
/// panic하지 않는다** — 못 읽은 줄은 `bad_lines`, 모르는 레코드는 `skipped`.
pub fn parse_rollout(path: &Path) -> std::io::Result<RolloutParse> {
    let f = std::fs::File::open(path)?;
    // 루트 = 세션 cwd를 모르는 시점이라 파일이 있는 디렉토리로 시작하고, meta를
    // 읽은 뒤 project_label 계산이 필요한 아이템부터 실제 cwd 기준이 되게 한다.
    // (label_for는 root 안쪽만 훑으므로 잘못 잡아도 라벨이 비는 정도다.)
    let mut mapper = RolloutMapper::new(path.parent().unwrap_or(Path::new("/")));
    let mut first = true;
    for line in BufReader::new(f).lines() {
        let Ok(line) = line else { continue };
        if first {
            first = false;
            if let Some(meta) = parse_meta_line(&line) {
                if let Some(cwd) = meta.cwd.as_deref() {
                    mapper.timeline = Timeline::new(cwd);
                }
            }
        }
        mapper.apply_line(&line);
    }
    Ok(mapper.finish())
}

// ---------------------------------------------------------------------------
// 작은 순수 도우미
// ---------------------------------------------------------------------------

fn usage_from(v: &Value) -> TokenUsage {
    let n = |k: &str| v.get(k).and_then(Value::as_u64).unwrap_or(0);
    let input = n("input_tokens");
    let cached = n("cached_input_tokens").min(input);
    TokenUsage {
        // codex의 `input_tokens`는 캐시분을 **포함한** 총량이라 빼서 나눈다
        // (claude의 input/cache_read 의미에 맞춘다 — 게이지 분자는 둘의 합).
        input: input - cached,
        output: n("output_tokens"),
        cache_read: cached,
        cache_creation: 0,
    }
}

/// 첫 줄만, `max`자까지. 제목 칸은 한 줄이라 개행이 들어가면 레이아웃이 깨진다.
fn first_line(s: &str, max: usize) -> String {
    let line = s.lines().next().unwrap_or("").trim();
    if line.chars().count() <= max {
        return line.to_string();
    }
    let cut: String = line.chars().take(max).collect();
    format!("{cut}…")
}

/// 인자 요약 — 모르는 도구의 제목에 붙일 한 줄(`{"target":"…"}` 정도).
fn brief_args(args: &Value) -> String {
    match args {
        Value::Null => String::new(),
        v => {
            let s = v.to_string();
            if s == "{}" {
                String::new()
            } else {
                format!(" {}", first_line(&s, 60))
            }
        }
    }
}

fn join_names(paths: &[PathBuf], max: usize) -> String {
    let names: Vec<String> = paths
        .iter()
        .take(max)
        .map(|p| {
            p.file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| p.to_string_lossy().to_string())
        })
        .collect();
    if paths.len() > max {
        format!("{} 외 {}", names.join(", "), paths.len() - max)
    } else {
        names.join(", ")
    }
}

fn abs_path(path: &str, cwd: Option<&str>) -> PathBuf {
    let p = Path::new(path);
    match cwd {
        Some(c) if p.is_relative() => Path::new(c).join(p),
        _ => p.to_path_buf(),
    }
}

/// `update_plan`의 단계 배열 → 마크다운 체크리스트(뷰어의 PlanDetail이 읽는 형태).
fn format_plan(steps: &[Value]) -> String {
    steps
        .iter()
        .map(|s| {
            let text = s.get("step").and_then(Value::as_str).unwrap_or("");
            let mark = match s.get("status").and_then(Value::as_str) {
                Some("completed") => "x",
                Some("in_progress") => "~",
                _ => " ",
            };
            format!("- [{mark}] {text}")
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests;

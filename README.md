# Claude Workbench

여러 **Claude Code CLI 세션**을 타임라인으로 보고 **아카이브(책·요약·지식 베이스)**로 기록하며, 터미널·Git·에디터·스터디(2폴더 비교)를 한 화면에서 다루는 **Claude 중심 IDE 셸**.

> Tauri 2 (Rust) + React + TypeScript. 데스크톱(Linux/WebKitGTK 검증) 앱.
> 패키지/바이너리 `claude-workbench`. 번들 식별자만 `com.multiterminal.dev` 유지(앱 저장 상태 경로 보존).

---

## 핵심 기능

- **멀티 프로젝트 워크스페이스** — 폴더를 탭으로 열고, 패널 배치·트리 상태를 영속(재시작 복원).
- **멀티 윈도우 (탭 드래그 → 창 분리·도킹)** — 패널 탭을 끌어 별도 OS 창으로 떼어내고, 다시 끌어 원래 창으로 도킹. 양방향 전송, 드롭 위치 인디케이터, 멀티모니터 좌표(z-order·물리좌표 hit-test), 팝아웃 창 재시작 영속.
- **멀티 터미널** — xterm.js + PTY. 테마/폰트 크기/색 커스텀.
- **Claude Code 세션 (아키텍처 A)** — 진짜 `claude` CLI를 PTY로 띄우고, 세션 JSONL(`~/.claude/projects/<slug>/<uuid>.jsonl`)을 tail 해 **타임라인**으로 렌더.
  - 멀티 세션, 세션 관리(생성/재오픈/닫기/삭제/rename), 토큰 사용량·서브에이전트 트리.
  - **세션 아카이브 (라이브 체크포인트)** — 버튼 한 번으로 JSONL 원본 복사 + 정규화 JSON + **자기완결 `book.html`**(대화를 처음부터 단계별로 넘겨보는 책, 외부 의존 0) + 헤드리스 `claude -p` 추출로 **요약·지식 베이스**(issue/method/domain frontmatter + INDEX.md) 생성. 멱등 재아카이브, 세션은 계속 사용 가능.
  - **아카이브 브라우저** — 사이드바 탭에서 프로젝트별 `날짜-요약-uuid` 트리로 열람(책=시스템 브라우저, 요약/지식=peek 뷰어). 저장 위치는 중앙 기본 + 설정 변경.
  - **재시작 세션 재개** — 안정 UUID로 `--resume`/`--session-id`(대화 없어도 동일 세션 유지). 새 태스크 = 순수 새 세션(체인 없음 — 맥락은 아카이브가 담당).
- **에디터 / 뷰어** — CodeMirror 6. 트리 키보드 네비 + peek 뷰어(Enter/↑↓/Esc, Ctrl+E 에디터), dockview 패널 편집·저장(Ctrl+S, 원자적 write). 디스크 리로드(폴링 + ↻).
- **Git 패널 (사이드바 빌트인)** — 상태/스테이지/커밋, 로컬·원격 브랜치 전환·생성·삭제, merge·fetch·pull·push·stash·tag, **머지 충돌 해결**(내것/상대/인라인 편집), **멀티레인 커밋 그래프**(정렬), diff 뷰어, **worktree**.
- **의존성 그래프 (사이드바 graph 탭)** — 프로젝트의 의존성 그래프를 `claude`(opus) 1회 호출로 생성 → `<archive_root>/<project>/graph/{json,html}`에 저장 → **자기완결 HTML**(순수 인라인 SVG·외부 의존 0·XSS-safe) 뷰어를 시스템 브라우저로. 생성은 `--add-dir`로 프로젝트를 탐색하되 cwd는 `/tmp` 스크래치(아카이브와 동일 — 백필 루프 차단), UI 논블로킹. **git_roots 계층**(하위 저장소를 품은 상위=하위 서브그래프 통합, sub-project별 group 색상). **`.claude` 마커 폴더**만 대상으로 하는 폴더별 on-demand 생성(필요한 곳에서만).
- **스터디 모드** — 두 폴더를 좌우로 동시 탐색/비교: `[좌SB][좌뷰어][우뷰어][우SB]` + 하단 단일 Claude 세션(질문·고민 기록).
  - 측별 뷰어/에디터 모드, 멀티탭(+▾오버플로), 마우스 없는 동선(Ctrl=칼럼/Alt=탭/트리 키보드), 마크다운·이미지·PDF(pdf.js) 렌더, 영속.
- **테마** — 라이트/다크(CSS 변수 단일화 + xterm/CodeMirror/dockview 연동), 코드 폰트 크기, 터미널 팔레트 프리셋·#코드 커스텀.
- **툴바 / 모드 스위처** — 화면 모드 3택 세그먼트([스터디|통합|개발]), 세션/실행 버튼 상단 통합, **외관 팝오버**(테마·글자크기 스테퍼/직접입력·터미널색), attention 모션 배지(reduced-motion 폴백), **인텔리제이식 좌측 액티비티 바**(사이드바 5탭 세로 스트립 + 트리 접기).
- **세션 드래그 배치** — 아카이브·+Claude 목록의 세션 행을 dock 위로 드래그해 원하는 위치에 열기(**중앙=탭 추가, 가장자리 20%=그 방향 스플릿**, 하이라이트 프리뷰) + 아카이브 "이어서" 원클릭 resume. 이미 열린 세션은 해당 탭 활성화.
- **hook 기반 세션 상태** — 워크벤치가 띄우는 claude 세션에만 `--settings`로 hook(Stop/Notification/UserPromptSubmit) 세션 한정 주입 → 로컬 수신기(127.0.0.1, 세션별 토큰)로 배지가 **hook 정본·화면 스캔 폴백** 동작. 사용자 `~/.claude` 설정 무수정.
- **프로젝트 2-surface 분할** — 프로젝트 탭 우클릭 → "우측 분할로 열기": 두 프로젝트의 dock을 나란히(우측=수동 '보조' dock, 리사이즈·재시작 복원, 같은 프로젝트 전환 시 자동 닫힘).

---

## 프로젝트 레이아웃

```
multi-terminal/
├── core/                    # 순수 Rust 로직 (tauri 무의존 — headless 단위 테스트)
│   ├── src/
│   │   ├── jsonl/           #   세션 JSONL 파서·타임라인 매퍼·tail·locate
│   │   ├── archive.rs       #   아카이브 파이프라인 (정규화·book.html·멱등 교체)
│   │   ├── knowledge.rs     #   지식 베이스 (추출 파싱·issue/method/domain·INDEX)
│   │   ├── mcp.rs           #   지식 조회 MCP 서버 로직 + .mcp.json 병합 등록
│   │   ├── claude_cli.rs    #   일회성 claude -p 호출 (--model/--effort)
│   │   ├── git/ git.rs      #   git CLI 래핑 (그래프·rewrite·worktree)
│   │   ├── graph.rs         #   의존성 그래프 생성(claude -p·--add-dir)·git_roots 계층·자기완결 HTML·저장
│   │   ├── session.rs       #   PTY 세션 매니저
│   │   ├── snapshot.rs      #   세션 타임라인 스냅샷 영속
│   │   ├── persist.rs       #   워크스페이스 상태 (workspace.json)
│   │   └── bin/
│   │       ├── knowledge_mcp.rs      # MCP stdio 서버 바이너리
│   │       └── archive_backfill.rs   # 과거 세션 일괄 아카이브 CLI
├── src-tauri/               # Tauri 셸 — 얇은 command 래퍼
│   └── src/commands/        #   claude·archive·git·graph·files·ssh·terminal
├── src/                     # React 프론트
│   ├── components/          #   ClaudeTermPanel(터미널+타임라인)·ArchivePanel·
│   │                        #   GitPanel·GraphPanel·DevView·StudyView·MainArea(dockview)…
│   └── state/               #   zustand store·claudeStatus(배지)·layerRouting
└── scripts/css-audit.mjs    # CSS 가드 (z토큰·flex·네임스페이스)
```

## 아키텍처 구조

```
┌──────────────────────────── React 프론트 (WebView) ────────────────────────────┐
│  ProjectTabs · 사이드바(파일/Git/워크트리/아카이브) · MainArea(dockview)         │
│  ClaudeTermPanel = [xterm 터미널 | 상세뷰어 | 타임라인] · DevView · StudyView    │
└──────────────┬────────────────────────────────────────────────────────────────┘
               │ Tauri IPC (invoke / event)
┌──────────────▼──────────────── src-tauri commands ─────────────────────────────┐
│  claude_* (PTY·타임라인 폴링)   archive_* (아카이브·목록·설정)   git_* · ssh_* │
└──────┬───────────────┬──────────────────┬─────────────────────────────────────┘
       │               │                  │
┌──────▼─────┐  ┌──────▼───────┐  ┌───────▼────────┐
│ core::     │  │ core::       │  │ core::git      │
│ session    │  │ jsonl→       │  │ (system git)   │
│ (PTY 스폰) │  │ timeline     │  └────────────────┘
└──────┬─────┘  └──────▲───────┘
       │               │ tail (150ms)
       ▼               │
  claude CLI ──▶ ~/.claude/projects/<slug>/<uuid>.jsonl   ← 단일 출처 (앱은 읽기만)
                       │
                       ▼ 아카이브(수동 버튼 / backfill CLI)
   <archive_root>/<project>/{sessions/…, knowledge/…}
                       ▲
                       │ 조회 (읽기 전용)
   knowledge-mcp (stdio) ◀── .mcp.json ◀── 아카이브·세션 시작 시 자동 등록
```

## 동작 프로세스

**세션 → 타임라인 (라이브)**

```
[+ Claude] ─▶ claude_open_or_attach
   ├─ (지식 있으면) .mcp.json 등록 보장 ─▶ 새 claude가 지식 서버를 갖고 시작
   ├─ PTY 스폰: claude --session-id <uuid>
   └─ 폴링 스레드: JSONL tail ─▶ JsonlMapper ─▶ claude-timeline 이벤트
                                          └─▶ 스냅샷 영속 (재시작 복원)
프론트: xterm에 PTY 출력 · 타임라인에 턴/도구/서브에이전트 · 배지(blocked/done)
```

**아카이브 → 지식 → 재사용 (기록 사이클)**

```
[아카이브 버튼]  (라이브 체크포인트 — 세션은 계속, 재실행 = 멱등 갱신)
   ▼
① core 산출물 선착지: session.jsonl 복사 + normalized.json + book.html + meta.json
   ▼                                (원본 무변경 · 이후 실패해도 이건 남음)
② claude -p 추출 (기본 opus + effort xhigh, /tmp 스크래치 cwd에서 실행)
   │   ===SUMMARY=== 제목·요약 / ===ENTRY=== issue|method|domain
   ├─ 실패 ─▶ 부분 성공 (이전 요약 last-good 유지, 재아카이브가 재시도)
   ▼
③ summary.md + knowledge/{issues,methods,domain}/*.md + INDEX.md 재생성
   ▼
④ .mcp.json 병합 등록 (타 서버 보존 · 동명 타 서버 거부 · 손상 시 미변경)
```

**MCP 조회 사이클 (자동화의 목적지)**

```
그 프로젝트에서 claude 시작 (앱 안이든 밖이든)
   │  Claude Code가 .mcp.json 읽음
   ▼
knowledge-mcp 자식 프로세스 스폰 (stdio · 상시 데몬 아님 · 읽기 전용)
   │  initialize(버전 협상) → tools/list
   ▼
이슈 발생: "search_knowledge로 <에러코드> 검색"
   │  이슈 본문에 에러 원문이 보존돼 있어 문자열 그대로 매칭
   ▼
과거의 원인·해결·실패한 시도 → read_knowledge로 전문 → 같은 삽질 반복 없음
```

과거 세션은 `archive-backfill` CLI로 일괄 지식화한다 (`--days`·`--limit`·`--exclude`, 프로젝트 병렬·완료 판정 = summary 존재 → 중단·실패분은 재실행이 자동 회수).

**의존성 그래프 (on-demand)**

```
[graph 탭 / .claude 마커 폴더]  프로젝트 열 때는 캐시만 확인 (graph_list — Opus 미실행)
   ▼ [생성]
git_roots 로 하위 저장소 파악 ─▶ 각 root 를 --add-dir 로 허용
   ▼
claude -p (opus, cwd=/tmp 스크래치 = 아카이브와 동일 · 백필 루프 차단) ─▶ 의존성 그래프 JSON
   ▼
<archive_root>/<project>/graph/{graph.json, graph.html}   (self-contained HTML · 외부 의존 0)
   ▼ [열기]
graph_open_path ─▶ 시스템 브라우저 (archive_root containment 검사)
```

---

## 기술 스택

| 영역 | 사용 |
|------|------|
| 셸/런타임 | Tauri 2 (Rust) |
| 프론트 | React + TypeScript + Vite |
| 터미널 | @xterm/xterm + PTY |
| 에디터/뷰어 | CodeMirror 6 |
| 패널 | dockview-react |
| 레이아웃 | react-resizable-panels |
| 문서 렌더 | marked + DOMPurify, pdfjs-dist |
| 상태 | zustand |
| Git | 시스템 `git` CLI 래핑(`--literal-pathspecs`·porcelain `-z`·ref 가드) |

코어 로직(세션 스냅샷·JSONL 매퍼·git·영속)은 Rust `core` 크레이트에 단위 테스트와 함께.

---

## 요구 사항

- **Node.js** + **Rust** (빌드)
- **`claude` CLI** (Claude Code 세션) · **`git`** (Git 패널/worktree)
- Linux: WebKitGTK (Tauri 의존). 코드 폰트는 **JetBrains Mono** 권장.

---

## 실행 / 빌드

```bash
npm install

# 개발 (핫리로드)
npm run tauri dev

# 릴리스 바이너리 (번들 없이 빠르게)
npm run tauri build -- --no-bundle
#   → target/release/claude-workbench
```

### 바탕화면 런처(Linux)
릴리스 바이너리를 안정 위치로 복사하고 `.desktop`을 만들면 더블클릭으로 실행됩니다.
GUI 런처는 PATH가 빈약하므로 `bash -lc`로 감싸 `claude`/`git`을 인식시킵니다:

```ini
[Desktop Entry]
Type=Application
Name=Claude Workbench
Exec=bash -lc "exec '$HOME/.local/share/claude-workbench/claude-workbench'"
Icon=$HOME/.local/share/claude-workbench/icon.png
Terminal=false
Categories=Development;Utility;
```

---

## 키보드 (스터디 모드)

- `Ctrl + ←/→` — 네 칼럼(좌SB↔좌뷰어↔우뷰어↔우SB) 이동
- 트리 — `↑↓` 커서 · `→/←` 펼침/접기 · `Enter` 열기 (뷰어 모드는 커서 따라 자동 열림)
- `Alt + ←/→` — 뷰어 탭 사이클 · `Alt + ↓` — ▾목록(↑↓ + Enter 선택)
- 우클릭 — 경로 복사 / 새 파일 / 삭제

---

## 아키텍처 노트 (A)

앱이 UUID를 생성해 `claude --session-id <uuid>`로 세션을 시작(또는 `--resume <uuid>`로 이어붙임)하고, claude가 쓰는 **네이티브 세션 JSONL**을 tail 한다. 즉 앱이 이벤트를 따로 저장하지 않고 **claude의 파일을 단일 출처로** 읽어 타임라인을 구성한다. (구버전 B = ACP 커스텀 프로토콜은 제거됨.)

**아카이브**도 같은 원칙의 파생물이다: 원본 JSONL은 절대 수정하지 않고(복사만), 정규화 JSON·book.html·지식 파일은 전부 원본에서 재생성 가능하다. 과거의 task 핸드오프 체인(요약 시드 재기동 + `prev_uuid` stitching)은 이 아카이브 모델로 대체·제거됐다.

---

## 크레딧 / 참고

타임라인의 일부 UI는 **[tessera](https://github.com/horang-labs/tessera)** (Apache-2.0)를 참고했습니다 — CSS 색 토큰 규율과 타임라인 "보는 경험" 패턴(턴 접기·KIND 라벨·thinking 디엠퍼시스·서브에이전트 레일·컨텍스트 게이지)의 *아이디어*만 차용했고, 코드를 복사하거나 Tailwind를 도입하지는 않았습니다(기존 순수 CSS 위에 자체 구현).

세션 attention 배지·알림은 **[herdr](https://github.com/ogulcancelik/herdr)** (AGPL-3.0)의 *개념*을 참고했습니다 — "누가 나를 부르나" 상태 롤업(blocked/working/done), **done = 완료됐는데 아직 안 봄(seen)** 의미론, 화면 기반 입력 대기 감지라는 발상만 차용했고, AGPL 코드·감지 룰은 일절 복사하지 않았습니다(감지 규칙·상태 머신·알림 전부 자체 설계·구현).

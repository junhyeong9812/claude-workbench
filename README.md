# Claude Workbench

여러 **Claude Code CLI 세션**을 타임라인·핸드오프로 오케스트레이션하고, 터미널·Git·에디터·스터디(2폴더 비교)를 한 화면에서 다루는 **Claude 중심 IDE 셸**.

> Tauri 2 (Rust) + React + TypeScript. 데스크톱(Linux/WebKitGTK 검증) 앱.
> 패키지/바이너리 `claude-workbench`. 번들 식별자만 `com.multiterminal.dev` 유지(앱 저장 상태 경로 보존).

---

## 핵심 기능

- **멀티 프로젝트 워크스페이스** — 폴더를 탭으로 열고, 패널 배치·트리 상태를 영속(재시작 복원).
- **멀티 윈도우 (탭 드래그 → 창 분리·도킹)** — 패널 탭을 끌어 별도 OS 창으로 떼어내고, 다시 끌어 원래 창으로 도킹. 양방향 전송, 드롭 위치 인디케이터, 멀티모니터 좌표(z-order·물리좌표 hit-test), 팝아웃 창 재시작 영속.
- **멀티 터미널** — xterm.js + PTY. 테마/폰트 크기/색 커스텀.
- **Claude Code 세션 (아키텍처 A)** — 진짜 `claude` CLI를 PTY로 띄우고, 세션 JSONL(`~/.claude/projects/<slug>/<uuid>.jsonl`)을 tail 해 **타임라인**으로 렌더.
  - 멀티 세션, 세션 관리(생성/재오픈/닫기/삭제/rename), 토큰 사용량·서브에이전트 트리.
  - **task 핸드오프** — 이전 task를 헤드리스 요약 → 새 세션으로 재기동 + 요약 시드 주입, `prev_uuid` 체인으로 타임라인 stitching.
  - **재시작 세션 재개** — 안정 UUID로 `--resume`/`--session-id`(대화 없어도 동일 세션 유지).
- **에디터 / 뷰어** — CodeMirror 6. 트리 키보드 네비 + peek 뷰어(Enter/↑↓/Esc, Ctrl+E 에디터), dockview 패널 편집·저장(Ctrl+S, 원자적 write). 디스크 리로드(폴링 + ↻).
- **Git 패널 (사이드바 빌트인)** — 상태/스테이지/커밋, 로컬·원격 브랜치 전환·생성·삭제, merge·fetch·pull·push·stash·tag, **머지 충돌 해결**(내것/상대/인라인 편집), **멀티레인 커밋 그래프**(정렬), diff 뷰어, **worktree**.
- **스터디 모드** — 두 폴더를 좌우로 동시 탐색/비교: `[좌SB][좌뷰어][우뷰어][우SB]` + 하단 단일 Claude 세션(질문·고민 기록).
  - 측별 뷰어/에디터 모드, 멀티탭(+▾오버플로), 마우스 없는 동선(Ctrl=칼럼/Alt=탭/트리 키보드), 마크다운·이미지·PDF(pdf.js) 렌더, 영속.
- **테마** — 라이트/다크(CSS 변수 단일화 + xterm/CodeMirror/dockview 연동), 코드 폰트 크기, 터미널 팔레트 프리셋·#코드 커스텀.

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

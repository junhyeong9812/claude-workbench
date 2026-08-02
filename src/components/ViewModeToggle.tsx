/**
 * 뷰모드 ↔ 원본 토글 버튼 (P5 F-e1 — FilePeekViewer ↔ ClaudeTermPanel의
 * 문자단위 동일 버튼 단일 출처. FilePeekViewer가 `claudeterm-viewmode-btn`
 * 클래스를 빌려 쓰던 암묵 결합을 명시 공유로). 표시 조건(Peek=md일 때만,
 * ClaudeTerm=항상)과 단축키 `v` 처리는 호출부 소유.
 */
export function ViewModeToggle({
  markdown,
  onToggle,
}: {
  markdown: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      className="claudeterm-viewmode-btn"
      title="뷰모드 ↔ 원본 (단축키 v)"
      onClick={onToggle}
    >
      {markdown ? "원본 보기" : "뷰모드 보기"}
    </button>
  );
}

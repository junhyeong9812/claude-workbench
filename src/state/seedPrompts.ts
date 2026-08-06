/**
 * 시드 문안 — 앱이 Claude 세션에 **처음 보내는 요청**들의 단일 출처.
 *
 * 세 곳이 이 문안을 만든다: 리뷰 모드(커밋 사이드바 🤖), 개발 모드 ✓확인
 * (DevView와 EditorPanel 둘 다 — 같은 문장이다), 테스트 생성 🧪. 예전에는
 * 각자 인라인 템플릿 리터럴로 들고 있었고, 두 곳의 검토 문안은 글자까지
 * 같은데도 따로 적혀 있었다.
 *
 * 여기로 모은 이유는 중복 제거보다 **테스트가 진짜를 보게 하기 위해서**다.
 * 시드가 제출되는지는 문안의 모양(단일행이냐 멀티라인이냐)이 가르는데
 * (`promptRefine.submitBytes`), 테스트가 문안 *사본*을 검증하면 실제 문안이
 * 멀티라인으로 바뀌어도 테스트는 태연히 통과한다 — 회귀를 못 잡는 테스트가
 * 된다. 소비처와 테스트가 같은 함수를 부르면 그 구멍이 닫힌다.
 *
 * **줄바꿈은 의미다.** 여기서 `\n`을 넣고 빼는 것은 문구 다듬기가 아니라 전송
 * 방식을 바꾸는 일이다(단일행 = CR 한 조각, 멀티라인 = 붙여넣기+CR 두 조각).
 */

/** 커밋 리뷰 시드 (리뷰 모드 🤖) — 변경 파일 목록 때문에 **멀티라인**이다. */
export function commitReviewSeed(commit: string, fileLines: readonly string[]): string {
  return (
    `이 커밋을 함께 코드리뷰하자. 커밋: ${commit}\n` +
    `변경 파일 ${fileLines.length}개:\n${fileLines.join("\n")}\n\n` +
    `먼저 \`git show ${commit}\` 로 변경을 확인하고, 버그·경계조건·설계 관점에서 리뷰해줘. ` +
    `내가 특정 파일/라인을 물으면 그 부분을 깊이 보자. (파일은 수정하지 말고 리뷰·설명만)`
  );
}

/** 파일 검토 시드 (개발 모드 ✓확인 — DevView·EditorPanel 공용). 단일행. */
export function fileReviewSeed(path: string): string {
  return (
    `방금 \`${path}\` 를 편집·저장했어. 그 파일을 읽고 검토해줘 — ` +
    `오타·빠진 import·들여쓰기/포맷·맥락 적합성 위주로. ` +
    `직접 수정하지 말고 무엇을 어떻게 고치면 되는지 지적·설명만 해줘.`
  );
}

/** 테스트 생성 시드 (🧪). `testPath`가 없으면 위치를 Claude에게 맡긴다. 단일행. */
export function testGenSeed(path: string, testPath: string | null): string {
  const where = testPath ? `\`${testPath}\` 에` : "프로젝트 컨벤션에 맞는 위치에";
  return (
    `\`${path}\` 의 단위 테스트를 ${where} 생성해줘. ` +
    `프로젝트의 기존 테스트 컨벤션·프레임워크를 따르고, 파일을 실제로 만들어줘(필요하면 디렉토리도). ` +
    `핵심 동작·경계조건 위주로.`
  );
}

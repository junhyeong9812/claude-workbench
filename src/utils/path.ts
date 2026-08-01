/**
 * 경로 표시 유틸 (P4 공통화 — 문자단위 동일 3벌 통합: StudyViewer·StudySidebar·
 * store.ts).
 *
 * 계약(관용 버전): 구분자 `/`·`\` 모두 지원, 후행 구분자 흡수(filter(Boolean)),
 * 세그먼트가 없으면(루트 "/"·빈 문자열) 입력 원문 폴백. 다른 정책의 구현
 * (treeDnd.parentDir — 루트="/" 계약+테스트 보유, DevView 등 엄격 split 인라인)
 * 은 의도적으로 유지한다 — 조사 결과 trailing-slash·백슬래시 3축이 갈려 있어
 * 단일 함수 강제 통일은 회귀를 만든다(P4 ledger).
 */
export const basename = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

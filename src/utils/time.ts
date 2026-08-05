/** Unix seconds → 짧은 로컬 시각. 아카이브 시점·버전 라벨의 단일 표기 —
 * 화면마다 포맷이 갈리면 같은 시각이 다르게 보인다 (리뷰 F6/O3). */
export const fmtUnix = (t?: number | null): string =>
  t
    ? new Date(t * 1000).toLocaleString("ko-KR", {
        year: "2-digit",
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";

/** Unix seconds → "3분 전" 류의 상대 표기. 외부 세션 목록처럼 "언제 마지막으로
 * 만졌나"가 절대 시각보다 중요한 자리에서 쓴다. `now`는 테스트용 주입점.
 * 미래 시각(시계 어긋남)은 "방금"으로 접는다 — "-3분 전"은 의미가 없다. */
export const fmtAgo = (t?: number | null, now: number = Date.now()): string => {
  if (!t) return "";
  const sec = Math.floor(now / 1000) - t;
  if (sec < 60) return "방금";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}분 전`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}시간 전`;
  const day = Math.floor(hour / 24);
  if (day < 30) return `${day}일 전`;
  // 한 달을 넘기면 상대 표기가 오히려 흐려진다 — 날짜로 넘긴다.
  return new Date(t * 1000).toLocaleDateString("ko-KR", {
    year: "2-digit",
    month: "numeric",
    day: "numeric",
  });
};

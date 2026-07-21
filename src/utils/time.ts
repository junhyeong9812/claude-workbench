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

/**
 * 자동 회수 원시(primitive) — "원격에서 한 번 당겨 온다"가 이 앱에서 일어나는
 * **유일한 자리**.
 *
 * ## 왜 하나로 모았나
 *
 * 같은 결함이 세 번 재발했다. ①loop1 R1(세션 본문 자동 회수가 빈 성공 응답에
 * 무한 재발화 — 실측 5초에 1,400회, 회차마다 새 SSH 연결) → ②원격 데이터 조회를
 * 만들다가 같은 것을 다시 만들었다(“Maximum update depth exceeded”) → ③서브에이전트
 * 회수에서 또(L2-2).
 *
 * 매번 처방은 옳았다 — "판정의 축을 *내용*이 아니라 *시도*로". 그런데도 재발한
 * 이유는 자동 회수 기계가 **세 벌로 병렬 존재**했고 각자 자기 잠금 키를 만들었기
 * 때문이다. 그리고 세 번째 재발이 그 구조의 진짜 함정을 보여 줬다:
 *
 * > **잠금 키가 가변 데이터에서 파생되면, 순수 판정 함수가 옳게 동작하면서도
 * > 루프가 선다.**
 *
 * L2-2 가 정확히 그것이다. 키가 `${session}/${agent}#${sig}` 였고 `sig` 는 파일
 * 서명(`<len>-<mtime_ns>`)이다. **돌고 있는** 에이전트는 전사가 자라 델타마다
 * 서명이 바뀐다 → 키가 바뀌어 `attempted` 가 초기화된다 → 자동 회수 재발화 →
 * 델타당 SSH 왕복 1회 + 전사 1벌 추가 상주(옛 벌은 어떤 경로로도 지워지지 않는다).
 * `shouldAutoLoadSubagent` 는 그동안 내내 옳은 답을 돌려주고 있었다.
 *
 * ## 계약 (이 파일이 지키는 것 전부)
 *
 * 1. **잠금 키 = 정체성(주소)뿐이다.** `host`·`session`·`agent`·`root`·`path` 처럼
 *    "무엇을 가리키나"만 들어간다. 서명·내용·커서·개수 같은 **가변 값은 키에
 *    넣지 않는다**. 키가 안 흔들리면 `attempted` 도 안 흔들린다.
 * 2. **가변 서명은 신선도 표시로만.** 값과 함께 들고 있다가 프레임의 서명과
 *    다르면 "바뀌었습니다"를 **보여 준다**({@link isStale}). 자동으로 다시 받지
 *    않는다 — 다시 받는 것은 사용자가 누르는 버튼이다.
 * 3. **캐시는 정체성당 한 벌.** 새 서명으로 받으면 옛 벌을 **교체**한다(누적 금지).
 * 4. **in-flight 가드가 조용히 삼키지 않는다.** 같은 주소에 같은 인자면 합치고
 *    (동시 N 클릭 → invoke 1회), **인자가 다르면 세대를 올려 교체**한다 — 늦게
 *    온 옛 답은 버려지고, 새 요청은 반드시 나간다(L2-3).
 * 5. **버린 칸은 되살아나지 않는다.** {@link AutoFetch.forget} 은 세대를 올리므로,
 *    버리는 시점에 나가 있던 회수의 늦은 답도 자리를 다시 차지하지 못한다(L2-9).
 */
import { useCallback, useMemo, useRef, useState } from "react";
import { errText } from "../utils/error";

/** 이어 붙이기의 결과 — 붙일 수 없는 페이지는 **사유를 들고** 거절된다. */
export type Merge<T> = { ok: true; value: T } | { ok: false; error: string };

/** 한 주소가 들고 있는 것 전부 — 값·서명·오류·진행·**시도 여부**·성공 시각. */
export interface Fetched<T> {
  value: T | null;
  /**
   * 이 값을 받을 때의 신선도 표시(파일 서명 등). **키가 아니다** — 키에 넣으면
   * 그 순간 자동 회수 루프가 선다(L2-2). 여기 있는 이유는 하나뿐이다: 지금
   * 프레임의 서명과 달라졌을 때 화면이 그 사실을 말하기 위해서.
   */
  sig: string | null;
  error: string | null;
  loading: boolean;
  /**
   * 이 주소를 **읽으려 시도한 적이 있나**(성공·빈 응답·실패 전부 포함).
   *
   * 자동 회수의 잠금이다. *내용*으로 판정하면 — `!value` — 화면에 채울 것이 없는
   * 정상 응답(빈 폴더·아무 일도 안 하고 끝난 세션)이 오는 순간 판정이 true 로
   * 돌아와 effect 가 재발화하고, 그 한 바퀴가 `Registry::call` → **새 SSH 연결
   * 1회**다(백오프도 지연도 없다).
   */
  attempted: boolean;
  /** 마지막 **성공** 시각(ms). 오류가 떠도 값이 남아 있을 때 "언제 것인지". */
  at: number | null;
}

export const idleFetch = <T,>(): Fetched<T> => ({
  value: null,
  sig: null,
  error: null,
  loading: false,
  attempted: false,
  at: null,
});

/**
 * 지금 **자동으로** 한 번 걸어도 되나 — 축은 시도다.
 *
 * 신선도는 여기 들어오지 않는다. "서명이 달라졌으니 자동으로 다시 받자"가 정확히
 * L2-2 이고, 그 판단이 이 함수 밖(사용자 버튼)에 있는 것이 재슬라이스의 요지다.
 */
export function shouldAutoFetch(e: Fetched<unknown>): boolean {
  return !e.attempted;
}

/**
 * 들고 있는 값이 지금 서명에 대해 **낡았나**.
 *
 * 서명이 한쪽이라도 없으면 낡았다고 본다: 무효화할 수단이 없는 캐시를 신선하다고
 * 부르면 바뀐 전사를 옛 본문으로 조용히 덮어 보이게 된다. 낡음의 처방은 재회수가
 * 아니라 **한 줄과 버튼**이다.
 */
export function isStale(e: Fetched<unknown>, sig: string | null): boolean {
  if (e.value == null) return false; // 들고 있는 게 없으면 낡음도 없다
  if (e.sig === null || sig === null) return true;
  return e.sig !== sig;
}

/** 회수 한 번의 주문서. */
export interface FetchRequest<T> {
  /** **정체성**(주소)만. 가변 값은 절대 넣지 않는다 — 이 파일의 계약 1. */
  key: string;
  /**
   * 이 요청의 인자(페이지 `from`·커서 등) — **in-flight 판정에만** 쓴다.
   *
   * 같으면 합치고(동시 N 회 → invoke 1회), 다르면 세대를 올려 교체한다. 잠금에도
   * 캐시 키에도 들어가지 않으므로 여기에 가변 값이 와도 루프가 서지 않는다.
   */
  args?: string;
  /** 받아 올 값의 신선도 표시. 값과 함께 보관된다(키가 아니다). */
  sig?: string | null;
  /** 실패했을 때 화면에 나갈 기본 문장. */
  fallback?: string;
  call: () => Promise<T>;
  /** 페이지 이어 붙이기 — 없으면 **교체**(정체성당 한 벌). */
  merge?: (prev: T | null, got: T) => Merge<T>;
}

export interface AutoFetch<T> {
  get: (key: string) => Fetched<T>;
  entries: ReadonlyMap<string, Fetched<T>>;
  run: (req: FetchRequest<T>) => void;
  /** 이 주소들을 버린다 — 나가 있는 회수의 늦은 답도 함께 무효가 된다. */
  forget: (keys: Iterable<string>) => void;
  /** 이 조건에 맞는 주소만 남긴다(나머지는 {@link AutoFetch.forget}). */
  retain: (keep: (key: string) => boolean) => void;
}

export function useAutoFetch<T>(): AutoFetch<T> {
  const [entries, setEntries] = useState<Map<string, Fetched<T>>>(new Map());
  /**
   * 렌더 중에 맞춰 두는 거울 — **돌려주는 객체의 정체성을 고정하기 위해서**다.
   *
   * 값이 바뀔 때마다 새 객체를 돌려주면, 그 객체에 매달린 `useCallback`·`useEffect`
   * 의존성이 전부 매 응답마다 새로 만들어진다. "마운트하면 한 번 읽는다"는
   * effect 가 **응답이 올 때마다 다시 도는** 무한 회수가 되는데, 그 한 바퀴가
   * 새 SSH 연결 1회다 — 이 파일이 없애려는 바로 그 사고를, 이 파일이 만든다.
   * 그래서 API 는 고정이고 값은 이 거울로 읽는다(리렌더는 `entries` 상태가 낸다).
   */
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  /**
   * 주소별 세대. **여기에만** 늦은 응답의 운명이 걸린다 — 더 새 요청이 있거나
   * 그 사이 칸이 버려졌으면 옛 응답은 아무것도 건드리지 못한다.
   */
  const genRef = useRef<Map<string, number>>(new Map());
  /**
   * 지금 나가 있는 요청의 인자 — **상태가 아니라 ref 다**.
   *
   * 상태로 걸던 가드는 상태에만 걸리고 호출에는 안 걸렸다(`invoke` 가 그 바깥의
   * 형제 문장이었다): 같은 tick 안의 두 번째 호출은 첫 번째의 `loading:true` 를
   * 아직 보지 못해 SSH 회수가 병렬로 나갔다(R17).
   */
  const inFlightRef = useRef<Map<string, string>>(new Map());

  const bump = useCallback((key: string) => {
    const n = (genRef.current.get(key) ?? 0) + 1;
    genRef.current.set(key, n);
    return n;
  }, []);

  const run = useCallback(
    (req: FetchRequest<T>) => {
      const { key } = req;
      const args = req.args ?? "";
      // 같은 주소에 **같은 요청**이 이미 나가 있다 — 합친다(R17).
      if (inFlightRef.current.get(key) === args) return;
      // 다른 인자면 조용히 삼키지 않고 **교체**한다(L2-3): 세대를 올려 옛 답을
      // 무효로 만들고, 새 요청은 반드시 나간다.
      const mine = bump(key);
      inFlightRef.current.set(key, args);
      setEntries((prev) => {
        const next = new Map(prev);
        next.set(key, { ...(prev.get(key) ?? idleFetch<T>()), loading: true, attempted: true });
        return next;
      });

      const settle = (fn: (prev: Fetched<T>) => Fetched<T>) => {
        // 더 새 요청이 떠 있거나(교체) 칸이 버려졌으면(정리) 이 답은 정본이 아니다.
        if (genRef.current.get(key) !== mine) return;
        inFlightRef.current.delete(key);
        setEntries((prev) => {
          const next = new Map(prev);
          next.set(key, fn(prev.get(key) ?? idleFetch<T>()));
          return next;
        });
      };

      void req.call().then(
        (got) =>
          settle((p) => {
            const m = req.merge ? req.merge(p.value, got) : { ok: true as const, value: got };
            // 이어 붙일 수 없는 페이지는 **값을 남기고 사유를 얹는다** — 구멍을
            // 조용히 이어 붙이는 것이 이 경로의 무음 유실이다.
            return m.ok
              ? {
                  value: m.value,
                  sig: req.sig ?? null,
                  error: null,
                  loading: false,
                  attempted: true,
                  at: Date.now(),
                }
              : { ...p, error: m.error, loading: false, attempted: true };
          }),
        (e) =>
          // 실패를 빈 값으로 축소하지 않는다: 값은 남기고 사유를 얹는다. 빈
          // 배열로 줄이면 화면은 "없음"을 정직한 답으로 보이고 아무도 계약이
          // 깨진 줄 모른다.
          settle((p) => ({
            ...p,
            error: errText(e, req.fallback ?? "원격에서 읽지 못했습니다."),
            loading: false,
            attempted: true,
          })),
      );
    },
    [bump],
  );

  const forget = useCallback(
    (keys: Iterable<string>) => {
      const gone = [...keys];
      if (gone.length === 0) return;
      for (const k of gone) {
        // 세대를 올려야 **버리는 시점에 나가 있던** 회수가 뒤늦게 자리를 다시
        // 차지하지 못한다(L2-9 — 그 자리는 두 번 다시 정리 대상이 안 됐다).
        bump(k);
        inFlightRef.current.delete(k);
      }
      setEntries((prev) => {
        if (!gone.some((k) => prev.has(k))) return prev;
        const next = new Map(prev);
        for (const k of gone) next.delete(k);
        return next;
      });
    },
    [bump],
  );

  const retain = useCallback(
    (keep: (key: string) => boolean) => {
      forget([...genRef.current.keys(), ...inFlightRef.current.keys()].filter((k) => !keep(k)));
    },
    [forget],
  );

  const get = useCallback(
    (key: string): Fetched<T> => entriesRef.current.get(key) ?? idleFetch<T>(),
    [],
  );

  return useMemo(
    () => ({
      get,
      get entries() {
        return entriesRef.current;
      },
      run,
      forget,
      retain,
    }),
    [get, run, forget, retain],
  );
}

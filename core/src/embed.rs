//! JSON → HTML `<script>` 임베드 이스케이프 (P4 공통화 — archive/graph 공용).
//!
//! 보안 경계: 임베드되는 JSON의 모든 `<`를 JSON/JS 겸용 이스케이프 `\u003c`로
//! 바꿔 어떤 내용도 `<script>`를 닫거나 태그를 열 수 없게 한다. U+2028/U+2029는
//! JSON에선 합법이지만 구형 JS 엔진의 라인 종결자라 함께 이스케이프한다.
//! (전신: archive::render_book_html / graph::render_graph_html의 문자단위 동일
//! 4줄 체인 — 양쪽 테스트를 이 모듈로 합류.)

use serde::Serialize;

/// `v`를 `<script>` 슬롯에 안전하게 넣을 수 있는 JSON 문자열로 직렬화한다.
/// 직렬화 실패는 `"null"`(렌더러가 빈 문서로 처리 — 기존 계약 유지).
pub fn embed_json<T: Serialize>(v: &T) -> String {
    serde_json::to_string(v)
        .unwrap_or_else(|_| "null".to_string())
        .replace('<', "\\u003c")
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `<`가 남지 않는다 — script 탈출·태그 열기 불가(양쪽 테스트의 공통 핵).
    #[test]
    fn escapes_every_angle_bracket() {
        let s = embed_json(&"</script><img onerror=x>");
        assert!(!s.contains('<'), "임베드 문자열에 '<'가 남으면 안 된다: {s}");
        assert!(s.contains("\\u003c/script"), "JSON/JS 겸용 이스케이프 형태");
        // 이스케이프는 왕복 가능해야 한다(값 보존) — serde가 다시 읽으면 원문.
        let back: String = serde_json::from_str(&s).unwrap();
        assert_eq!(back, "</script><img onerror=x>");
    }

    /// U+2028/2029 라인 종결자 이스케이프 (archive 쪽 테스트 이관).
    #[test]
    fn escapes_js_line_separators() {
        let s = embed_json(&"a\u{2028}b\u{2029}c");
        assert!(!s.contains('\u{2028}') && !s.contains('\u{2029}'));
        assert!(s.contains("\\u2028") && s.contains("\\u2029"));
        let back: String = serde_json::from_str(&s).unwrap();
        assert_eq!(back, "a\u{2028}b\u{2029}c");
    }

    /// 직렬화 불가 값은 "null" (기존 unwrap_or_else 계약).
    #[test]
    fn unserializable_falls_back_to_null() {
        use serde::ser::Error as _;
        struct Bad;
        impl Serialize for Bad {
            fn serialize<S: serde::Serializer>(&self, _s: S) -> Result<S::Ok, S::Error> {
                Err(S::Error::custom("no"))
            }
        }
        assert_eq!(embed_json(&Bad), "null");
    }
}

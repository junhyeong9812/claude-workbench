//! Project-type detection from filesystem marker files.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

/// Marker files that identify a directory as a project root. Mirrors the
/// ecosystem probes in [`detect_project_types`] (kept as a flat list so the
/// timeline label helper can ask "is *any* project rooted here?" — see
/// `crate::label::nearest_project_marker`).
pub const PROJECT_MARKERS: &[&str] = &[
    "Cargo.toml",
    "package.json",
    "pyproject.toml",
    "requirements.txt",
    "setup.py",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "settings.gradle.kts",
];

/// Whether `dir` directly contains any [`PROJECT_MARKERS`] file.
pub fn has_project_marker(dir: &Path) -> bool {
    PROJECT_MARKERS.iter().any(|m| dir.join(m).exists())
}

/// The detected build/ecosystem type of a project folder.
///
/// Serializes as a plain string (`"Rust"`, `"Java"`, ...) so the webview can
/// use it directly as a badge label.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum ProjectType {
    Rust,
    Java,
    Kotlin,
    Python,
    React,
    JavaScript,
    Vue,
    #[default]
    Unknown,
}

/// Fixed display order for detected types. A directory may match several
/// ecosystems at once; results are always sorted into this order so the UI
/// renders badges predictably regardless of probe order.
const DISPLAY_ORDER: [ProjectType; 7] = [
    ProjectType::Rust,
    ProjectType::Python,
    ProjectType::React,
    ProjectType::Vue,
    ProjectType::JavaScript,
    ProjectType::Kotlin,
    ProjectType::Java,
];

/// Detect **all** [`ProjectType`]s present in `path` by probing for well-known
/// marker files directly inside the directory. There is no precedence: every
/// matching ecosystem is collected.
///
/// Markers:
/// - `Cargo.toml` -> Rust
/// - `build.gradle.kts` | `settings.gradle.kts` -> Kotlin
/// - `pom.xml` | `build.gradle` -> Java
/// - `pyproject.toml` | `requirements.txt` | `setup.py` -> Python
/// - `package.json` -> parse deps + devDeps: `vue` -> Vue, `react` -> React,
///   neither (or any read/parse failure) -> JavaScript
///
/// Results are sorted by [`DISPLAY_ORDER`]. An empty/marker-less directory
/// yields an empty `Vec`. This function never panics.
pub fn detect_project_types<P: AsRef<Path>>(path: P) -> Vec<ProjectType> {
    detect_project_types_uncached(path.as_ref())
}

/// P2: (dir mtime, package.json mtime) 키 캐시 — 트리 폴링이 4초마다 펼친
/// 디렉토리의 모든 하위 dir에 마커 stat ~10회씩을 반복하던 것을 재사용한다.
/// 무효화: 마커 파일 추가/삭제 = dir mtime 변경, JS flavor(React/Vue/JS)는
/// package.json **내용** 의존 = 그 파일 mtime 변경. 알려진 잔존 구멍(리뷰
/// ledger 기록·수용): ①dir 밖을 가리키는 심링크 마커의 타깃만 생기고/사라지는
/// 경우(dir mtime 불변) ②mtime 해상도가 초 단위인 FS(exFAT·SMB)에서 같은 tick
/// 내 마커 변경 — 둘 다 배지 표시에 한정되고 로컬 dev FS(ns 해상도)에선 발생
/// 하지 않는다. 키 조회 실패(mtime 불가)는 캐시 미사용(항상 재계산).
const TYPE_CACHE_MAX: usize = 4096;
type TypeCacheKey = (PathBuf, SystemTime, Option<SystemTime>);
static TYPE_CACHE: Mutex<Option<HashMap<PathBuf, (TypeCacheKey, Vec<ProjectType>)>>> =
    Mutex::new(None);

/// [`detect_project_types`]와 결과 동일(캐시 히트 시 재계산 생략). 트리 폴링
/// 경로([`crate::list_dir`])가 사용한다.
pub fn detect_project_types_cached(dir: &Path) -> Vec<ProjectType> {
    let Ok(dir_mtime) = std::fs::metadata(dir).and_then(|m| m.modified()) else {
        return detect_project_types(dir); // 키 불가 — 캐시 우회
    };
    let pkg_mtime = std::fs::metadata(dir.join("package.json"))
        .and_then(|m| m.modified())
        .ok();
    let key: TypeCacheKey = (dir.to_path_buf(), dir_mtime, pkg_mtime);
    if let Ok(mut guard) = TYPE_CACHE.lock() {
        let cache = guard.get_or_insert_with(HashMap::new);
        if let Some((k, v)) = cache.get(&key.0) {
            if *k == key {
                return v.clone();
            }
        }
    }
    let types = detect_project_types(dir);
    if let Ok(mut guard) = TYPE_CACHE.lock() {
        let cache = guard.get_or_insert_with(HashMap::new);
        if cache.len() >= TYPE_CACHE_MAX {
            // 절반만 축출(임의 순서) — 전체 clear는 상한 근처 워크로드에서 매
            // 폴링 재구축 thrash가 된다(리뷰 P3). 정확성 무관(키 재검증).
            let doomed: Vec<PathBuf> =
                cache.keys().take(TYPE_CACHE_MAX / 2).cloned().collect();
            for k in doomed {
                cache.remove(&k);
            }
        }
        cache.insert(key.0.clone(), (key, types.clone()));
    }
    types
}

fn detect_project_types_uncached(dir: &Path) -> Vec<ProjectType> {
    let has = |marker: &str| dir.join(marker).exists();

    let mut types: Vec<ProjectType> = Vec::new();

    if has("Cargo.toml") {
        types.push(ProjectType::Rust);
    }
    if has("build.gradle.kts") || has("settings.gradle.kts") {
        types.push(ProjectType::Kotlin);
    }
    if has("pom.xml") || has("build.gradle") {
        types.push(ProjectType::Java);
    }
    if has("pyproject.toml") || has("requirements.txt") || has("setup.py") {
        types.push(ProjectType::Python);
    }
    if has("package.json") {
        types.push(detect_js_flavor(&dir.join("package.json")));
    }

    types.sort_by_key(|t| {
        DISPLAY_ORDER
            .iter()
            .position(|d| d == t)
            .unwrap_or(usize::MAX)
    });
    types
}

/// Classify a `package.json` into Vue / React / plain JavaScript by scanning its
/// `dependencies` and `devDependencies`. Any read or parse failure falls back to
/// plain JavaScript (the file's mere presence already proves a JS project).
fn detect_js_flavor(package_json: &Path) -> ProjectType {
    let contents = match std::fs::read_to_string(package_json) {
        Ok(c) => c,
        Err(_) => return ProjectType::JavaScript,
    };
    let value: serde_json::Value = match serde_json::from_str(&contents) {
        Ok(v) => v,
        Err(_) => return ProjectType::JavaScript,
    };

    let has_dep = |name: &str| {
        ["dependencies", "devDependencies"].iter().any(|section| {
            value
                .get(section)
                .and_then(|s| s.as_object())
                .map(|obj| obj.contains_key(name))
                .unwrap_or(false)
        })
    };

    if has_dep("vue") {
        ProjectType::Vue
    } else if has_dep("react") {
        ProjectType::React
    } else {
        ProjectType::JavaScript
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static COUNTER: AtomicUsize = AtomicUsize::new(0);

    /// Create a fresh, unique temp directory for a test case.
    fn temp_dir(tag: &str) -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let mut p = std::env::temp_dir();
        p.push(format!("mt_pt_{tag}_{nanos}_{n}"));
        fs::create_dir_all(&p).unwrap();
        p
    }

    fn touch(dir: &Path, file: &str) {
        fs::write(dir.join(file), b"").unwrap();
    }

    fn write_pkg(dir: &Path, body: &str) {
        fs::write(dir.join("package.json"), body).unwrap();
    }

    // --- single-marker regression ---

    #[test]
    fn cargo_toml_is_rust() {
        let d = temp_dir("rust");
        touch(&d, "Cargo.toml");
        assert_eq!(detect_project_types(&d), vec![ProjectType::Rust]);
    }

    #[test]
    fn pom_xml_is_java() {
        let d = temp_dir("java_pom");
        touch(&d, "pom.xml");
        assert_eq!(detect_project_types(&d), vec![ProjectType::Java]);
    }

    #[test]
    fn build_gradle_is_java() {
        let d = temp_dir("java_gradle");
        touch(&d, "build.gradle");
        assert_eq!(detect_project_types(&d), vec![ProjectType::Java]);
    }

    #[test]
    fn build_gradle_kts_is_kotlin() {
        let d = temp_dir("kotlin");
        touch(&d, "build.gradle.kts");
        assert_eq!(detect_project_types(&d), vec![ProjectType::Kotlin]);
    }

    #[test]
    fn settings_gradle_kts_is_kotlin() {
        let d = temp_dir("kotlin_settings");
        touch(&d, "settings.gradle.kts");
        assert_eq!(detect_project_types(&d), vec![ProjectType::Kotlin]);
    }

    #[test]
    fn pyproject_is_python() {
        let d = temp_dir("py_pyproject");
        touch(&d, "pyproject.toml");
        assert_eq!(detect_project_types(&d), vec![ProjectType::Python]);
    }

    #[test]
    fn requirements_txt_is_python() {
        let d = temp_dir("py_req");
        touch(&d, "requirements.txt");
        assert_eq!(detect_project_types(&d), vec![ProjectType::Python]);
    }

    #[test]
    fn setup_py_is_python() {
        let d = temp_dir("py_setup");
        touch(&d, "setup.py");
        assert_eq!(detect_project_types(&d), vec![ProjectType::Python]);
    }

    #[test]
    fn empty_dir_is_empty_vec() {
        let d = temp_dir("empty");
        assert_eq!(detect_project_types(&d), Vec::<ProjectType>::new());
    }

    // --- multi-collect + ordering ---

    #[test]
    fn cargo_plus_react_collects_both_in_order() {
        let d = temp_dir("rust_react");
        touch(&d, "Cargo.toml");
        write_pkg(&d, r#"{ "dependencies": { "react": "^18.0.0" } }"#);
        assert_eq!(
            detect_project_types(&d),
            vec![ProjectType::Rust, ProjectType::React]
        );
    }

    #[test]
    fn pom_plus_react_sorts_react_before_java() {
        let d = temp_dir("java_react");
        touch(&d, "pom.xml");
        write_pkg(&d, r#"{ "dependencies": { "react": "^18.0.0" } }"#);
        assert_eq!(
            detect_project_types(&d),
            vec![ProjectType::React, ProjectType::Java]
        );
    }

    // --- JS flavor discrimination ---

    #[test]
    fn package_json_vue_is_vue() {
        let d = temp_dir("vue");
        write_pkg(&d, r#"{ "dependencies": { "vue": "^3.0.0" } }"#);
        assert_eq!(detect_project_types(&d), vec![ProjectType::Vue]);
    }

    #[test]
    fn package_json_react_is_react() {
        let d = temp_dir("react");
        write_pkg(&d, r#"{ "devDependencies": { "react": "^18.0.0" } }"#);
        assert_eq!(detect_project_types(&d), vec![ProjectType::React]);
    }

    #[test]
    fn package_json_lodash_only_is_javascript() {
        let d = temp_dir("js");
        write_pkg(&d, r#"{ "dependencies": { "lodash": "^4.0.0" } }"#);
        assert_eq!(detect_project_types(&d), vec![ProjectType::JavaScript]);
    }

    #[test]
    fn package_json_malformed_is_javascript() {
        let d = temp_dir("js_bad");
        write_pkg(&d, r#"{ this is not valid json ]]]"#);
        assert_eq!(detect_project_types(&d), vec![ProjectType::JavaScript]);
    }

    #[test]
    fn package_json_vue_wins_over_react() {
        // Both present -> Vue takes the single JS slot (checked first).
        let d = temp_dir("vue_react");
        write_pkg(
            &d,
            r#"{ "dependencies": { "vue": "^3.0.0", "react": "^18.0.0" } }"#,
        );
        assert_eq!(detect_project_types(&d), vec![ProjectType::Vue]);
    }

    #[test]
    fn nonexistent_path_is_empty_not_panic() {
        let p = PathBuf::from("/this/path/should/not/exist/claude-workbench-xyz");
        assert_eq!(detect_project_types(&p), Vec::<ProjectType>::new());
    }

    // ---- P2 캐시 특성테스트: cached ≡ uncached + 무효화 반증 ----

    /// mtime 해상도(코스 FS)보다 확실히 지나가도록 잠깐 대기.
    fn tick() {
        std::thread::sleep(std::time::Duration::from_millis(15));
    }

    #[test]
    fn cached_equals_uncached_and_hits_do_not_stale() {
        let d = temp_dir("eq");
        std::fs::write(d.join("Cargo.toml"), "[package]").unwrap();
        assert_eq!(detect_project_types_cached(&d), detect_project_types(&d));
        // 2회째(히트)도 동일 — 캐시가 결과를 바꾸지 않는다.
        assert_eq!(detect_project_types_cached(&d), vec![ProjectType::Rust]);
        let _ = std::fs::remove_dir_all(&d);
    }

    /// 반증①: 마커 추가/삭제(dir mtime 변경)가 즉시 반영되나 — 캐시 동결 금지.
    #[test]
    fn marker_change_invalidates_cache() {
        let d = temp_dir("marker");
        std::fs::write(d.join("Cargo.toml"), "[package]").unwrap();
        assert_eq!(detect_project_types_cached(&d), vec![ProjectType::Rust]);
        tick();
        std::fs::write(d.join("pyproject.toml"), "").unwrap(); // dir mtime 변경
        assert_eq!(
            detect_project_types_cached(&d),
            vec![ProjectType::Rust, ProjectType::Python]
        );
        tick();
        std::fs::remove_file(d.join("Cargo.toml")).unwrap();
        assert_eq!(detect_project_types_cached(&d), vec![ProjectType::Python]);
        let _ = std::fs::remove_dir_all(&d);
    }

    /// 반증②: package.json **내용**만 바뀌어도(JS flavor — dir mtime 불변)
    /// package.json mtime 키가 무효화한다.
    #[test]
    fn package_json_content_change_invalidates_cache() {
        let d = temp_dir("flavor");
        std::fs::write(d.join("package.json"), r#"{"dependencies":{}}"#).unwrap();
        assert_eq!(detect_project_types_cached(&d), vec![ProjectType::JavaScript]);
        tick();
        std::fs::write(d.join("package.json"), r#"{"dependencies":{"react":"18"}}"#).unwrap();
        assert_eq!(detect_project_types_cached(&d), vec![ProjectType::React]);
        let _ = std::fs::remove_dir_all(&d);
    }
}

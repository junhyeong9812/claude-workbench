//! Project-type detection from filesystem marker files.

use serde::{Deserialize, Serialize};
use std::path::Path;

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
    let dir = path.as_ref();
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
        let p = PathBuf::from("/this/path/should/not/exist/multi-terminal-xyz");
        assert_eq!(detect_project_types(&p), Vec::<ProjectType>::new());
    }
}

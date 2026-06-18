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
    #[default]
    Unknown,
}

/// Detect the [`ProjectType`] of `path` by probing for well-known marker files
/// directly inside the directory.
///
/// Precedence (first match wins):
/// 1. `Cargo.toml` -> [`ProjectType::Rust`]
/// 2. `build.gradle.kts` | `settings.gradle.kts` -> [`ProjectType::Kotlin`]
///    (checked **before** Java so a mixed Gradle project reports Kotlin)
/// 3. `pom.xml` | `build.gradle` -> [`ProjectType::Java`]
/// 4. `pyproject.toml` | `requirements.txt` | `setup.py` -> [`ProjectType::Python`]
/// 5. otherwise -> [`ProjectType::Unknown`]
pub fn detect_project_type<P: AsRef<Path>>(path: P) -> ProjectType {
    let dir = path.as_ref();
    let has = |marker: &str| dir.join(marker).exists();

    if has("Cargo.toml") {
        ProjectType::Rust
    } else if has("build.gradle.kts") || has("settings.gradle.kts") {
        ProjectType::Kotlin
    } else if has("pom.xml") || has("build.gradle") {
        ProjectType::Java
    } else if has("pyproject.toml") || has("requirements.txt") || has("setup.py") {
        ProjectType::Python
    } else {
        ProjectType::Unknown
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

    #[test]
    fn cargo_toml_is_rust() {
        let d = temp_dir("rust");
        touch(&d, "Cargo.toml");
        assert_eq!(detect_project_type(&d), ProjectType::Rust);
    }

    #[test]
    fn pom_xml_is_java() {
        let d = temp_dir("java_pom");
        touch(&d, "pom.xml");
        assert_eq!(detect_project_type(&d), ProjectType::Java);
    }

    #[test]
    fn build_gradle_is_java() {
        let d = temp_dir("java_gradle");
        touch(&d, "build.gradle");
        assert_eq!(detect_project_type(&d), ProjectType::Java);
    }

    #[test]
    fn build_gradle_kts_is_kotlin() {
        let d = temp_dir("kotlin");
        touch(&d, "build.gradle.kts");
        assert_eq!(detect_project_type(&d), ProjectType::Kotlin);
    }

    #[test]
    fn settings_gradle_kts_is_kotlin() {
        let d = temp_dir("kotlin_settings");
        touch(&d, "settings.gradle.kts");
        assert_eq!(detect_project_type(&d), ProjectType::Kotlin);
    }

    #[test]
    fn kotlin_wins_over_java_when_both_gradle_variants_present() {
        let d = temp_dir("mixed_gradle");
        touch(&d, "build.gradle");
        touch(&d, "build.gradle.kts");
        assert_eq!(detect_project_type(&d), ProjectType::Kotlin);
    }

    #[test]
    fn pyproject_is_python() {
        let d = temp_dir("py_pyproject");
        touch(&d, "pyproject.toml");
        assert_eq!(detect_project_type(&d), ProjectType::Python);
    }

    #[test]
    fn requirements_txt_is_python() {
        let d = temp_dir("py_req");
        touch(&d, "requirements.txt");
        assert_eq!(detect_project_type(&d), ProjectType::Python);
    }

    #[test]
    fn setup_py_is_python() {
        let d = temp_dir("py_setup");
        touch(&d, "setup.py");
        assert_eq!(detect_project_type(&d), ProjectType::Python);
    }

    #[test]
    fn empty_dir_is_unknown() {
        let d = temp_dir("unknown");
        assert_eq!(detect_project_type(&d), ProjectType::Unknown);
    }

    #[test]
    fn cargo_wins_over_other_markers() {
        let d = temp_dir("rust_priority");
        touch(&d, "Cargo.toml");
        touch(&d, "pom.xml");
        touch(&d, "requirements.txt");
        assert_eq!(detect_project_type(&d), ProjectType::Rust);
    }

    #[test]
    fn nonexistent_path_is_unknown_not_panic() {
        let p = PathBuf::from("/this/path/should/not/exist/multi-terminal-xyz");
        assert_eq!(detect_project_type(&p), ProjectType::Unknown);
    }
}

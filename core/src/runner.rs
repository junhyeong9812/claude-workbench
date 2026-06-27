//! Detect per-language build/test commands from project marker files, so the UI
//! can offer "빌드"/"테스트" actions that run the right tool. Reuses the same
//! marker files as [`crate::project_type`]. A polyglot repo (e.g. a Tauri app
//! with both `Cargo.toml` and `package.json`) returns one target per tool — the
//! UI shows a button per target rather than guessing a single "primary".

use serde::{Deserialize, Serialize};
use std::path::Path;

/// One runnable toolchain detected in a project directory.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunTarget {
    /// Tool id, for the button label ("cargo", "npm", "gradle", "maven",
    /// "python", "go").
    pub kind: String,
    /// Build/compile command, or `None` if the tool has no meaningful build step.
    pub build: Option<String>,
    /// Test command, or `None`.
    pub test: Option<String>,
}

/// Detect every build/test toolchain present directly in `dir` (no recursion).
pub fn detect_run_targets(dir: impl AsRef<Path>) -> Vec<RunTarget> {
    let dir = dir.as_ref();
    let has = |m: &str| dir.join(m).exists();
    let mut targets = Vec::new();

    if has("Cargo.toml") {
        targets.push(RunTarget {
            kind: "cargo".into(),
            build: Some("cargo build".into()),
            test: Some("cargo test".into()),
        });
    }
    // Gradle drives both Java and Kotlin projects. Prefer the wrapper if present
    // (matches the version the repo pins); else fall back to a system `gradle`.
    if has("build.gradle") || has("build.gradle.kts") || has("settings.gradle") || has("settings.gradle.kts") {
        let g = if has("gradlew") { "./gradlew" } else { "gradle" };
        targets.push(RunTarget {
            kind: "gradle".into(),
            build: Some(format!("{g} build")),
            test: Some(format!("{g} test")),
        });
    }
    if has("pom.xml") {
        targets.push(RunTarget {
            kind: "maven".into(),
            build: Some("mvn -q compile".into()),
            test: Some("mvn -q test".into()),
        });
    }
    if has("package.json") {
        let (build, test) = npm_scripts(&dir.join("package.json"));
        targets.push(RunTarget {
            kind: "npm".into(),
            build,
            test,
        });
    }
    if has("pyproject.toml") || has("setup.py") || has("requirements.txt") {
        targets.push(RunTarget {
            kind: "python".into(),
            build: None, // most Python projects have no separate build step
            test: Some("pytest".into()),
        });
    }
    if has("go.mod") {
        targets.push(RunTarget {
            kind: "go".into(),
            build: Some("go build ./...".into()),
            test: Some("go test ./...".into()),
        });
    }

    targets
}

/// `npm run build` / `npm test` only if the corresponding script exists in
/// `package.json` (a missing/unparseable file falls back to `npm test`, which
/// npm itself errors cleanly if absent).
fn npm_scripts(pkg: &Path) -> (Option<String>, Option<String>) {
    let content = match std::fs::read_to_string(pkg) {
        Ok(c) => c,
        Err(_) => return (None, Some("npm test".into())),
    };
    let v: serde_json::Value = match serde_json::from_str(&content) {
        Ok(v) => v,
        Err(_) => return (None, Some("npm test".into())),
    };
    let scripts = v.get("scripts");
    let has_script = |name: &str| scripts.and_then(|s| s.get(name)).is_some();
    let build = if has_script("build") {
        Some("npm run build".into())
    } else {
        None
    };
    let test = if has_script("test") {
        Some("npm test".into())
    } else {
        None
    };
    (build, test)
}

/// The conventional test-file path that *mirrors* a source file, by language.
/// Returns `None` for unsupported extensions. This computes the path only — the
/// UI asks Claude to actually generate the test content there.
///
/// Conventions:
/// - TS/JS → sibling `foo.test.ts` (Jest/Vitest)
/// - Python → sibling `test_foo.py` (pytest-discoverable)
/// - Go → sibling `foo_test.go`
/// - Rust → crate `tests/foo.rs` (swap a `src/` segment), else sibling `foo_test.rs`
/// - Java → `src/test/java/.../FooTest.java` (swap `main/java`→`test/java`)
/// - Kotlin → `src/test/kotlin/.../FooTest.kt` (swap `main/kotlin`→`test/kotlin`)
pub fn mirror_test_path(src: &str) -> Option<String> {
    let p = Path::new(src);
    let ext = p.extension()?.to_str()?.to_lowercase();
    let stem = p.file_stem()?.to_str()?.to_string();
    let dir = p.parent()?.to_string_lossy().to_string();
    match ext.as_str() {
        "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" => Some(format!("{dir}/{stem}.test.{ext}")),
        "py" => Some(format!("{dir}/test_{stem}.py")),
        "go" => Some(format!("{dir}/{stem}_test.go")),
        "rs" => Some(
            swap_path_seg(src, "src", "tests").unwrap_or_else(|| format!("{dir}/{stem}_test.rs")),
        ),
        "java" => {
            let test_dir = swap_path_seg(&dir, "main/java", "test/java")
                .or_else(|| swap_path_seg(&dir, "main", "test"))
                .unwrap_or(dir);
            Some(format!("{test_dir}/{stem}Test.java"))
        }
        "kt" | "kts" => {
            let test_dir = swap_path_seg(&dir, "main/kotlin", "test/kotlin")
                .or_else(|| swap_path_seg(&dir, "main", "test"))
                .unwrap_or(dir);
            Some(format!("{test_dir}/{stem}Test.kt"))
        }
        _ => None,
    }
}

/// Replace the first `<from>` path segment with `<to>` — matching it mid-path
/// (`/src/`) *or* as the leading segment (`src/...`, e.g. a relative path).
/// `None` if the segment isn't present.
fn swap_path_seg(path: &str, from: &str, to: &str) -> Option<String> {
    let mid = format!("/{from}/");
    if let Some(idx) = path.find(&mid) {
        return Some(format!("{}/{}/{}", &path[..idx], to, &path[idx + mid.len()..]));
    }
    let lead = format!("{from}/");
    if let Some(rest) = path.strip_prefix(&lead) {
        return Some(format!("{to}/{rest}"));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static COUNTER: AtomicUsize = AtomicUsize::new(0);

    fn temp_dir() -> std::path::PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let mut p = std::env::temp_dir();
        p.push(format!("mt_runner_{nanos}_{n}"));
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn cargo_target() {
        let d = temp_dir();
        fs::write(d.join("Cargo.toml"), b"[package]").unwrap();
        let t = detect_run_targets(&d);
        assert_eq!(t.len(), 1);
        assert_eq!(t[0].kind, "cargo");
        assert_eq!(t[0].test.as_deref(), Some("cargo test"));
    }

    #[test]
    fn npm_scripts_gate_build_and_test() {
        let d = temp_dir();
        fs::write(
            d.join("package.json"),
            br#"{"scripts":{"build":"vite build","test":"vitest"}}"#,
        )
        .unwrap();
        let t = detect_run_targets(&d);
        assert_eq!(t[0].kind, "npm");
        assert_eq!(t[0].build.as_deref(), Some("npm run build"));
        assert_eq!(t[0].test.as_deref(), Some("npm test"));

        // No scripts → no build, no test.
        let d2 = temp_dir();
        fs::write(d2.join("package.json"), br#"{"name":"x"}"#).unwrap();
        let t2 = detect_run_targets(&d2);
        assert_eq!(t2[0].build, None);
        assert_eq!(t2[0].test, None);
    }

    #[test]
    fn gradle_prefers_wrapper() {
        let d = temp_dir();
        fs::write(d.join("build.gradle.kts"), b"").unwrap();
        assert_eq!(
            detect_run_targets(&d)[0].build.as_deref(),
            Some("gradle build")
        );
        fs::write(d.join("gradlew"), b"#!/bin/sh").unwrap();
        assert_eq!(
            detect_run_targets(&d)[0].build.as_deref(),
            Some("./gradlew build")
        );
    }

    #[test]
    fn polyglot_returns_multiple() {
        let d = temp_dir();
        fs::write(d.join("Cargo.toml"), b"[package]").unwrap();
        fs::write(d.join("package.json"), br#"{"scripts":{"test":"vitest"}}"#).unwrap();
        let kinds: Vec<String> = detect_run_targets(&d).into_iter().map(|t| t.kind).collect();
        assert!(kinds.contains(&"cargo".to_string()));
        assert!(kinds.contains(&"npm".to_string()));
    }

    #[test]
    fn empty_dir_no_targets() {
        assert!(detect_run_targets(&temp_dir()).is_empty());
    }

    #[test]
    fn mirror_paths_by_language() {
        assert_eq!(
            mirror_test_path("/p/src/components/Foo.ts").as_deref(),
            Some("/p/src/components/Foo.test.ts")
        );
        assert_eq!(
            mirror_test_path("/p/pkg/foo.py").as_deref(),
            Some("/p/pkg/test_foo.py")
        );
        assert_eq!(
            mirror_test_path("/p/foo.go").as_deref(),
            Some("/p/foo_test.go")
        );
        assert_eq!(
            mirror_test_path("/p/src/foo.rs").as_deref(),
            Some("/p/tests/foo.rs")
        );
        // Relative path with a *leading* src/ segment (codex finding).
        assert_eq!(
            mirror_test_path("src/foo.rs").as_deref(),
            Some("tests/foo.rs")
        );
        assert_eq!(
            mirror_test_path("/p/src/main/java/com/x/Foo.java").as_deref(),
            Some("/p/src/test/java/com/x/FooTest.java")
        );
        assert_eq!(
            mirror_test_path("/p/src/main/kotlin/com/x/Foo.kt").as_deref(),
            Some("/p/src/test/kotlin/com/x/FooTest.kt")
        );
        assert_eq!(mirror_test_path("/p/README.md"), None);
    }
}

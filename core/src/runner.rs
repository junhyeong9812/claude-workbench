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
}

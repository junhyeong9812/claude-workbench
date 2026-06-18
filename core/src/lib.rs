//! Pure logic for the multi-terminal IDE shell.
//!
//! This crate intentionally has **no** dependency on `tauri` (and therefore no
//! transitive link against `webkit2gtk`). That keeps it fully headless so
//! `cargo test -p core` runs without any system GUI libraries installed.

pub mod fs;
pub mod persist;
pub mod project_type;
pub mod session;

pub use fs::{list_dir, DirEntry};
pub use persist::{load_state, save_state, Project, TreeState, WorkspaceState};
pub use project_type::{detect_project_types, ProjectType};
pub use session::{OutputChunk, SessionId, SessionManager};

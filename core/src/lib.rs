//! Pure logic for the multi-terminal IDE shell.
//!
//! This crate intentionally has **no** dependency on `tauri` (and therefore no
//! transitive link against `webkit2gtk`) and **no** async runtime (no `tokio`).
//! That keeps it fully headless so `cargo test -p core` runs without any system
//! GUI libraries installed, and confines the ACP async island to `core-acp`.
//! The ACP *schema* types (pure serde) are used here for the timeline mapping.

pub mod acp_map;
pub mod fs;
pub mod label;
pub mod persist;
pub mod project_type;
pub mod session;

pub use acp_map::{AgentStatus, FileDiff, ItemKind, TimelineItem, Timeline, WriteStatus};
pub use fs::{list_dir, DirEntry};
pub use label::nearest_project_marker;
pub use persist::{load_state, save_state, Project, TreeState, WorkspaceState};
pub use project_type::{detect_project_types, ProjectType};
pub use session::{OutputChunk, SessionId, SessionManager};

//! Pure logic for the multi-terminal IDE shell.
//!
//! This crate intentionally has **no** dependency on `tauri` (and therefore no
//! transitive link against `webkit2gtk`), so `cargo test -p core` runs without
//! any system GUI libraries installed. The SSH transport ([`ssh`]) does pull in
//! `tokio`, but the runtime is encapsulated on a per-session thread and the
//! public [`session::SessionManager`] API stays synchronous — the crate remains
//! headless and tauri-free (host-key prompts are surfaced over a channel, not a
//! Tauri event).

pub mod fs;
pub mod git;
pub mod history;
pub mod jsonl;
pub mod label;
pub mod persist;
pub mod project_type;
pub mod runner;
pub mod scrollback_store;
pub mod search;
pub mod session;
pub mod snapshot;
pub mod ssh;
pub mod timeline;

pub use timeline::{
    AgentStatus, FileDiff, ItemKind, Timeline, TimelineItem, TokenUsage, WriteStatus,
};
pub use fs::{list_dir, DirEntry};
pub use label::nearest_project_marker;
pub use persist::{load_state, save_state, Project, SshConnection, TreeState, WorkspaceState};
pub use project_type::{detect_project_types, ProjectType};
pub use runner::{detect_run_targets, RunTarget};
pub use search::{search_content, search_files, ContentHit, FileHit};
pub use session::{OutputChunk, SessionId, SessionManager};

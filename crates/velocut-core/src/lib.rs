//! velocut-core — the canonical editing engine.
//!
//! Layering (no upward dependencies):
//!   model  → pure data structures, the serialized form IS the protocol
//!   command→ EditCommand application + validation (single write path)
//!   eval   → Document × time → FrameGraph (shared by preview & export)
//!   engine → state + history + JSON ABI (consumed by wasm binding / server)

pub mod command;
pub mod engine;
pub mod eval;
pub mod model;

pub use command::{apply, CmdError, EditCommand, Event, TrimEdge};
pub use engine::Engine;
pub use eval::{evaluate, FrameGraph};
pub use model::*;

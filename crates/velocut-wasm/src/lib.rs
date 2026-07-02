//! WASM ABI — a thin string-in/string-out shell over velocut_core::Engine.
//!
//! Strings (JSON) cross the boundary instead of structured objects on
//! purpose: the ABI stays identical to the server-side JSON API, is trivially
//! versionable, and avoids wasm-bindgen object lifetime pitfalls. Hot-path
//! evaluate() results are small (one frame's layer list), so serialization
//! cost is negligible next to decode/render work.
//!
//! Build locally (sandbox lacks the wasm32 std; one-time setup):
//!   rustup target add wasm32-unknown-unknown
//!   cargo install wasm-pack   # or: npm i -g wasm-pack
//!   wasm-pack build crates/velocut-wasm --target web --release \
//!     --out-dir ../../web/apps/editor/public/wasm

use velocut_core::Engine;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct WasmEngine {
    inner: Engine,
}

#[wasm_bindgen]
impl WasmEngine {
    #[wasm_bindgen(constructor)]
    pub fn new(name: &str, width: u32, height: u32, fps_num: u32, fps_den: u32) -> WasmEngine {
        WasmEngine { inner: Engine::new(name, width, height, fps_num, fps_den) }
    }

    /// Apply one EditCommand (JSON). Returns the response envelope (JSON).
    pub fn apply(&mut self, cmd_json: &str) -> String {
        self.inner.apply_json(cmd_json)
    }

    pub fn undo(&mut self) -> String {
        self.inner.undo_json()
    }

    pub fn redo(&mut self) -> String {
        self.inner.redo_json()
    }

    pub fn can_undo(&self) -> bool {
        self.inner.can_undo()
    }

    pub fn can_redo(&self) -> bool {
        self.inner.can_redo()
    }

    /// Full document (JSON) — the project file format.
    pub fn document(&self) -> String {
        self.inner.document_json()
    }

    pub fn load(&mut self, doc_json: &str) -> String {
        self.inner.load_json(doc_json)
    }

    /// FrameGraph (JSON) for one timeline instant.
    pub fn evaluate(&self, time_us: f64) -> String {
        self.inner.evaluate_json(time_us as i64)
    }

    pub fn revision(&self) -> f64 {
        self.inner.revision() as f64
    }

    pub fn duration_us(&self) -> f64 {
        self.inner.document().duration_us() as f64
    }
}

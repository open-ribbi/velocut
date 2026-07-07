//! The stateful engine: document + history + the JSON envelope API.
//!
//! `apply_json` / response envelope is the stable ABI shared by the WASM
//! binding, server-side usage and agents:
//!
//! request:  any `EditCommand` JSON
//! response: {"ok":true,"revision":12,"events":[...]}
//!        or {"ok":false,"error":{"code":"overlap","message":"..."}}

use crate::command::{apply, CmdError, EditCommand, Event};
use crate::eval::{evaluate, FrameGraph};
use crate::model::{Document, TimeUs};
use serde::Serialize;

const MAX_HISTORY: usize = 200;

pub struct Engine {
    doc: Document,
    /// Snapshot-based history. Documents are small (KBs); snapshots keep undo
    /// trivially correct. Migration path: inverse-command patches → CRDT ops
    /// when collaborative editing lands. The protocol does not change.
    undo: Vec<Document>,
    redo: Vec<Document>,
    revision: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase", untagged)]
pub enum Envelope {
    #[serde(rename_all = "camelCase")]
    Ok {
        ok: bool,
        revision: u64,
        events: Vec<Event>,
    },
    #[serde(rename_all = "camelCase")]
    Err { ok: bool, error: CmdError },
}

impl Envelope {
    fn ok(revision: u64, events: Vec<Event>) -> String {
        serde_json::to_string(&Envelope::Ok {
            ok: true,
            revision,
            events,
        })
        .unwrap()
    }
    fn err(error: CmdError) -> String {
        serde_json::to_string(&Envelope::Err { ok: false, error }).unwrap()
    }
}

impl Engine {
    pub fn new(name: &str, width: u32, height: u32, fps_num: u32, fps_den: u32) -> Self {
        Engine {
            doc: Document::new(name, width, height, fps_num, fps_den),
            undo: Vec::new(),
            redo: Vec::new(),
            revision: 0,
        }
    }

    pub fn document(&self) -> &Document {
        &self.doc
    }
    pub fn revision(&self) -> u64 {
        self.revision
    }

    pub fn apply(&mut self, cmd: &EditCommand) -> Result<Vec<Event>, CmdError> {
        let snapshot = self.doc.clone();
        match apply(&mut self.doc, cmd) {
            Ok(events) => {
                self.undo.push(snapshot);
                if self.undo.len() > MAX_HISTORY {
                    self.undo.remove(0);
                }
                self.redo.clear();
                self.revision += 1;
                Ok(events)
            }
            Err(e) => {
                // A failed command must have zero side effects — including
                // id-counter advances made before validation failed.
                self.doc = snapshot;
                Err(e)
            }
        }
    }

    pub fn undo(&mut self) -> Option<Vec<Event>> {
        let prev = self.undo.pop()?;
        self.redo.push(std::mem::replace(&mut self.doc, prev));
        self.revision += 1;
        Some(vec![Event::DocumentReplaced])
    }

    pub fn redo(&mut self) -> Option<Vec<Event>> {
        let next = self.redo.pop()?;
        self.undo.push(std::mem::replace(&mut self.doc, next));
        self.revision += 1;
        Some(vec![Event::DocumentReplaced])
    }

    pub fn can_undo(&self) -> bool {
        !self.undo.is_empty()
    }
    pub fn can_redo(&self) -> bool {
        !self.redo.is_empty()
    }

    pub fn evaluate(&self, time_us: TimeUs) -> FrameGraph {
        evaluate(&self.doc, time_us)
    }

    // ---- JSON ABI -------------------------------------------------------

    pub fn apply_json(&mut self, cmd_json: &str) -> String {
        let cmd: EditCommand = match serde_json::from_str(cmd_json) {
            Ok(c) => c,
            Err(e) => return Envelope::err(CmdError::new("parse", e.to_string())),
        };
        match self.apply(&cmd) {
            Ok(events) => Envelope::ok(self.revision, events),
            Err(e) => Envelope::err(e),
        }
    }

    pub fn undo_json(&mut self) -> String {
        match self.undo() {
            Some(events) => Envelope::ok(self.revision, events),
            None => Envelope::err(CmdError::new("invalidArg", "nothing to undo")),
        }
    }

    pub fn redo_json(&mut self) -> String {
        match self.redo() {
            Some(events) => Envelope::ok(self.revision, events),
            None => Envelope::err(CmdError::new("invalidArg", "nothing to redo")),
        }
    }

    pub fn document_json(&self) -> String {
        serde_json::to_string(&self.doc).unwrap()
    }

    pub fn evaluate_json(&self, time_us: TimeUs) -> String {
        serde_json::to_string(&self.evaluate(time_us)).unwrap()
    }

    pub fn load_json(&mut self, doc_json: &str) -> String {
        // Normalize before deserializing: legacy documents may omit
        // asset.hasAudio — fill it with the same kind-aware default the
        // addAsset command applies, so both engines resolve identical values.
        let mut value: serde_json::Value = match serde_json::from_str(doc_json) {
            Ok(v) => v,
            Err(e) => return Envelope::err(CmdError::new("parse", e.to_string())),
        };
        if let Some(assets) = value.get_mut("assets").and_then(|a| a.as_array_mut()) {
            for asset in assets {
                if asset.get("hasAudio").is_none_or(|v| v.is_null()) {
                    let is_image = asset.get("kind").and_then(|k| k.as_str()) == Some("image");
                    asset["hasAudio"] = serde_json::Value::Bool(!is_image);
                }
            }
        }
        match serde_json::from_value::<Document>(value) {
            Ok(doc) => {
                self.doc = doc;
                self.undo.clear();
                self.redo.clear();
                self.revision += 1;
                Envelope::ok(self.revision, vec![Event::DocumentReplaced])
            }
            Err(e) => Envelope::err(CmdError::new("parse", e.to_string())),
        }
    }
}

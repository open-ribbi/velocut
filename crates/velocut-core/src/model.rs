//! Timeline data model.
//!
//! Design notes:
//! - All times are integer **microseconds** (`TimeUs`). Floats never touch the
//!   timeline domain — this keeps edits deterministic and CRDT-friendly later.
//! - Every struct serializes to stable, human/LLM-readable JSON (camelCase).
//!   The JSON form *is* the interchange protocol: UI, server agents and LLMs
//!   all read and write the same shapes.
//! - IDs are opaque strings minted by the engine (`clip_7`, `track_2`, ...).

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub type TimeUs = i64;

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Document {
    pub id: String,
    pub name: String,
    /// Output canvas size in pixels.
    pub width: u32,
    pub height: u32,
    /// Frames per second as a rational to avoid 29.97 float drift.
    pub fps_num: u32,
    pub fps_den: u32,
    pub assets: Vec<Asset>,
    /// Render order: tracks[0] is the bottom layer.
    pub tracks: Vec<Track>,
    /// Monotonic counter for ID minting; never reused.
    #[serde(default)]
    pub next_id: u64,
}

impl Document {
    pub fn new(name: &str, width: u32, height: u32, fps_num: u32, fps_den: u32) -> Self {
        Document {
            id: "doc_1".into(),
            name: name.into(),
            width,
            height,
            fps_num,
            fps_den,
            assets: Vec::new(),
            tracks: Vec::new(),
            next_id: 1,
        }
    }

    pub fn mint_id(&mut self, prefix: &str) -> String {
        let id = format!("{}_{}", prefix, self.next_id);
        self.next_id += 1;
        id
    }

    /// Timeline end = max clip end across all tracks.
    pub fn duration_us(&self) -> TimeUs {
        self.tracks
            .iter()
            .flat_map(|t| t.clips.iter())
            .map(|c| c.end_us())
            .max()
            .unwrap_or(0)
    }

    pub fn find_track(&self, id: &str) -> Option<&Track> {
        self.tracks.iter().find(|t| t.id == id)
    }
    pub fn find_track_mut(&mut self, id: &str) -> Option<&mut Track> {
        self.tracks.iter_mut().find(|t| t.id == id)
    }
    pub fn find_asset(&self, id: &str) -> Option<&Asset> {
        self.assets.iter().find(|a| a.id == id)
    }
    /// Returns (track_index, clip_index) for a clip id.
    pub fn locate_clip(&self, clip_id: &str) -> Option<(usize, usize)> {
        for (ti, t) in self.tracks.iter().enumerate() {
            if let Some(ci) = t.clips.iter().position(|c| c.id == clip_id) {
                return Some((ti, ci));
            }
        }
        None
    }
    pub fn find_clip(&self, clip_id: &str) -> Option<&Clip> {
        self.locate_clip(clip_id)
            .map(|(ti, ci)| &self.tracks[ti].clips[ci])
    }
    pub fn find_clip_mut(&mut self, clip_id: &str) -> Option<&mut Clip> {
        let (ti, ci) = self.locate_clip(clip_id)?;
        Some(&mut self.tracks[ti].clips[ci])
    }
}

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AssetKind {
    Video,
    Audio,
    Image,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Asset {
    pub id: String,
    pub kind: AssetKind,
    /// Opaque locator resolved by the media layer (blob URL, file path, CDN URL).
    pub src: String,
    pub name: String,
    #[serde(default)]
    pub duration_us: TimeUs,
    #[serde(default)]
    pub width: u32,
    #[serde(default)]
    pub height: u32,
    /// Always explicit in persisted documents. Loaders fill a missing value as
    /// `kind != image` (see Engine::load_json) — the same default the addAsset
    /// command applies — so both engines resolve identical values. Keeping the
    /// field required makes any other deserialization path loud instead of
    /// silently diverging.
    pub has_audio: bool,
}

// ---------------------------------------------------------------------------
// Tracks
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TrackKind {
    Video,
    Audio,
    Text,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub id: String,
    pub kind: TrackKind,
    pub name: String,
    #[serde(default)]
    pub muted: bool,
    #[serde(default)]
    pub locked: bool,
    /// Kept sorted by `start_us`; engine enforces no overlap within a track.
    pub clips: Vec<Clip>,
}

impl Track {
    /// True if [start, start+duration) overlaps any clip except `ignore`.
    pub fn overlaps(&self, start: TimeUs, duration: TimeUs, ignore: Option<&str>) -> bool {
        let end = start + duration;
        self.clips
            .iter()
            .any(|c| Some(c.id.as_str()) != ignore && start < c.end_us() && c.start_us < end)
    }
    pub fn sort_clips(&mut self) {
        self.clips.sort_by_key(|c| c.start_us);
    }
}

// ---------------------------------------------------------------------------
// Clips
// ---------------------------------------------------------------------------

/// Static (non-animated) visual transform. Units: px offsets from canvas
/// center; scale 1.0 = fit source pixel size; rotation in degrees CW.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Transform {
    pub x: f64,
    pub y: f64,
    pub scale_x: f64,
    pub scale_y: f64,
    pub rotation: f64,
    pub opacity: f64,
}

impl Default for Transform {
    fn default() -> Self {
        Transform {
            x: 0.0,
            y: 0.0,
            scale_x: 1.0,
            scale_y: 1.0,
            rotation: 0.0,
            opacity: 1.0,
        }
    }
}

/// Animatable property ids. Keyframes on a property override its static value.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[serde(rename_all = "camelCase")]
pub enum Property {
    X,
    Y,
    ScaleX,
    ScaleY,
    Rotation,
    Opacity,
    Volume,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Easing {
    Linear,
    Hold,
    /// CSS-style cubic bezier with control points (x1,y1,x2,y2), x in [0,1].
    Bezier {
        x1: f64,
        y1: f64,
        x2: f64,
        y2: f64,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Keyframe {
    /// Relative to clip start (timeline domain, not source domain).
    pub time_us: TimeUs,
    pub value: f64,
    /// Easing of the segment leaving this keyframe.
    pub easing: Easing,
}

/// A GPU effect attached to a clip. `params` is schema-driven: the renderer's
/// effect registry owns the schema; the core treats it as opaque JSON so new
/// effects need zero core changes.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EffectInstance {
    pub id: String,
    pub effect: String,
    #[serde(default)]
    pub params: serde_json::Value,
    #[serde(default)]
    pub enabled: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TextPayload {
    pub content: String,
    #[serde(default)]
    pub font_family: Option<String>,
    #[serde(default)]
    pub font_size: Option<f64>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub align: Option<String>,
    // Styling. skip_serializing_if keeps an unstyled payload byte-identical to
    // the pre-styling shape (golden vectors stay stable); the renderer reads
    // whichever of these are present.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bold: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub italic: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stroke_color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stroke_width: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shadow_color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shadow_blur: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shadow_x: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shadow_y: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background_color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background_opacity: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background_full_width: Option<bool>,
}

/// A transition at a clip's START — blends in from the previous adjacent clip
/// on the same track (or from black for the first clip). Visual-only in v1.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Transition {
    /// "dissolve" | "fadeBlack" | "wipeLeft" | … | custom. Renderer maps kind→shader.
    pub kind: String,
    pub duration_us: TimeUs,
    /// Optional AI-authored WGSL transition body; overrides the built-in kind.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wgsl: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Clip {
    pub id: String,
    /// None for text/solid clips.
    pub asset_id: Option<String>,
    /// Timeline position and length (post-speed).
    pub start_us: TimeUs,
    pub duration_us: TimeUs,
    /// In-point within the source asset.
    #[serde(default)]
    pub source_in_us: TimeUs,
    /// Playback rate: source consumed per timeline second. 2.0 = 2x faster.
    #[serde(default = "default_speed")]
    pub speed: f64,
    #[serde(default)]
    pub transform: Transform,
    /// Animated properties. BTreeMap for deterministic serialization order.
    #[serde(default)]
    pub keyframes: BTreeMap<Property, Vec<Keyframe>>,
    #[serde(default)]
    pub effects: Vec<EffectInstance>,
    #[serde(default)]
    pub text: Option<TextPayload>,
    /// Mix volume 0..1 for clips with audio.
    #[serde(default = "default_volume")]
    pub volume: f64,
    /// Transition into this clip from the previous one. skip_serializing_if
    /// keeps transition-less clips byte-identical to the pre-transition shape.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transition: Option<Transition>,
}

fn default_speed() -> f64 {
    1.0
}
fn default_volume() -> f64 {
    1.0
}

impl Clip {
    pub fn end_us(&self) -> TimeUs {
        self.start_us + self.duration_us
    }
    /// Map a timeline instant inside this clip to source time.
    pub fn source_time_at(&self, timeline_us: TimeUs) -> TimeUs {
        let local = (timeline_us - self.start_us).max(0);
        self.source_in_us + ((local as f64) * self.speed).round() as TimeUs
    }
    /// Source span consumed by this clip.
    pub fn source_out_us(&self) -> TimeUs {
        self.source_in_us + ((self.duration_us as f64) * self.speed).round() as TimeUs
    }
}

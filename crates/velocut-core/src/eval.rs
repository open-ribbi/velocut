//! Frame evaluation: Document × time → FrameGraph.
//!
//! The FrameGraph is a pure, serializable description of one frame: which
//! layers are visible, their resolved (keyframe-evaluated) transforms, which
//! source frame each needs, and the audio mix state. Both the realtime
//! preview renderer and the offline export pipeline consume this — they are
//! guaranteed to agree because they share this single evaluator.

use crate::model::*;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FrameGraph {
    pub time_us: TimeUs,
    pub width: u32,
    pub height: u32,
    /// Bottom-to-top render order.
    pub layers: Vec<Layer>,
    pub audio: Vec<AudioSlice>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Layer {
    pub clip_id: String,
    pub asset_id: Option<String>,
    /// Which source instant this layer shows (after speed mapping).
    pub source_time_us: TimeUs,
    pub transform: ResolvedTransform,
    pub effects: Vec<EffectInstance>,
    pub text: Option<TextPayload>,
    /// Cross-clip transition: set on the incoming layer during the window;
    /// `from` is the outgoing layer the renderer mixes with. Boxed to break the
    /// recursive type; skipped in JSON when absent (keeps non-transition eval
    /// output byte-identical).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transition: Option<Box<LayerTransition>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LayerTransition {
    pub kind: String,
    pub progress: f64,
    pub from: Layer,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wgsl: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedTransform {
    pub x: f64,
    pub y: f64,
    pub scale_x: f64,
    pub scale_y: f64,
    pub rotation: f64,
    pub opacity: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AudioSlice {
    pub clip_id: String,
    pub asset_id: String,
    pub source_time_us: TimeUs,
    pub speed: f64,
    /// Final gain after clip volume × keyframes (track mute already applied
    /// by omission).
    pub gain: f64,
}

// ---------------------------------------------------------------------------
// Keyframe interpolation
// ---------------------------------------------------------------------------

/// Solve CSS cubic-bezier easing: given progress x in [0,1], return y.
fn bezier_ease(x1: f64, y1: f64, x2: f64, y2: f64, x: f64) -> f64 {
    if x <= 0.0 {
        return 0.0;
    }
    if x >= 1.0 {
        return 1.0;
    }
    // Cubic bezier with P0=(0,0), P3=(1,1):
    let sample = |c1: f64, c2: f64, t: f64| {
        let omt = 1.0 - t;
        3.0 * omt * omt * t * c1 + 3.0 * omt * t * t * c2 + t * t * t
    };
    // Binary search t such that sample_x(t) = x (monotonic for valid x1,x2 in [0,1]).
    let (mut lo, mut hi) = (0.0_f64, 1.0_f64);
    let mut t = x;
    for _ in 0..24 {
        let xs = sample(x1, x2, t);
        if (xs - x).abs() < 1e-6 {
            break;
        }
        if xs < x {
            lo = t;
        } else {
            hi = t;
        }
        t = 0.5 * (lo + hi);
    }
    sample(y1, y2, t)
}

/// Evaluate a sorted keyframe list at clip-local time. Outside the keyframed
/// range the boundary value holds.
pub fn eval_keyframes(kfs: &[Keyframe], local_us: TimeUs) -> Option<f64> {
    if kfs.is_empty() {
        return None;
    }
    if local_us <= kfs[0].time_us {
        return Some(kfs[0].value);
    }
    let last = kfs.last().unwrap();
    if local_us >= last.time_us {
        return Some(last.value);
    }
    let i = kfs.partition_point(|k| k.time_us <= local_us) - 1;
    let (a, b) = (&kfs[i], &kfs[i + 1]);
    let span = (b.time_us - a.time_us) as f64;
    let p = ((local_us - a.time_us) as f64 / span).clamp(0.0, 1.0);
    let eased = match a.easing {
        Easing::Hold => 0.0,
        Easing::Linear => p,
        Easing::Bezier { x1, y1, x2, y2 } => bezier_ease(x1, y1, x2, y2, p),
    };
    Some(a.value + (b.value - a.value) * eased)
}

fn resolve_transform(clip: &Clip, local_us: TimeUs) -> ResolvedTransform {
    let get = |p: Property, base: f64| {
        clip.keyframes
            .get(&p)
            .and_then(|kfs| eval_keyframes(kfs, local_us))
            .unwrap_or(base)
    };
    let t = &clip.transform;
    ResolvedTransform {
        x: get(Property::X, t.x),
        y: get(Property::Y, t.y),
        scale_x: get(Property::ScaleX, t.scale_x),
        scale_y: get(Property::ScaleY, t.scale_y),
        rotation: get(Property::Rotation, t.rotation),
        opacity: get(Property::Opacity, t.opacity).clamp(0.0, 1.0),
    }
}

// ---------------------------------------------------------------------------
// Frame evaluation
// ---------------------------------------------------------------------------

/// Build a render layer for a clip at an absolute time, scaling its resolved
/// opacity by `opacity_mul`. `source_time_at` continues past the clip's
/// out-point (used for the transition "from" frame), freezing at source end.
fn build_layer(clip: &Clip, time_us: TimeUs, opacity_mul: f64) -> Layer {
    let local = (time_us - clip.start_us).max(0);
    let mut transform = resolve_transform(clip, local);
    transform.opacity = (transform.opacity * opacity_mul).clamp(0.0, 1.0);
    Layer {
        clip_id: clip.id.clone(),
        asset_id: clip.asset_id.clone(),
        source_time_us: clip.source_time_at(time_us),
        transform,
        effects: clip
            .effects
            .iter()
            .filter(|e| e.enabled.unwrap_or(true))
            .cloned()
            .collect(),
        text: clip.text.clone(),
        transition: None,
    }
}

pub fn evaluate(doc: &Document, time_us: TimeUs) -> FrameGraph {
    let mut layers = Vec::new();
    let mut audio = Vec::new();

    for track in &doc.tracks {
        // Active clip on this track (clips don't overlap, so at most one).
        let Some(clip) = track
            .clips
            .iter()
            .find(|c| time_us >= c.start_us && time_us < c.end_us())
        else {
            continue;
        };
        let local = time_us - clip.start_us;
        let source_time = clip.source_time_at(time_us);

        let is_visual = matches!(track.kind, TrackKind::Video | TrackKind::Text);
        if is_visual && !track.muted {
            // A transition is BETWEEN this clip and its predecessor: during the
            // window we hand the renderer this (incoming) layer plus the `from`
            // (outgoing) layer + progress, and the renderer mixes their pixels by
            // kind (dissolve/wipe/…). With no predecessor there is no transition
            // (a clip can't transition from nothing — that would be a fade-in).
            let mut layer = build_layer(clip, time_us, 1.0);
            if let Some(tr) = &clip.transition {
                if let Some(p) = track
                    .clips
                    .iter()
                    .find(|c| c.id != clip.id && c.end_us() == clip.start_us)
                {
                    let d = tr
                        .duration_us
                        .min(clip.duration_us)
                        .min(p.duration_us)
                        .max(1);
                    if local < d {
                        let progress = (local as f64 / d as f64).clamp(0.0, 1.0);
                        layer.transition = Some(Box::new(LayerTransition {
                            kind: tr.kind.clone(),
                            progress,
                            from: build_layer(p, time_us, 1.0),
                            wgsl: tr.wgsl.clone(),
                        }));
                    }
                }
            }
            layers.push(layer);
        }

        if !track.muted {
            if let Some(aid) = &clip.asset_id {
                if let Some(asset) = doc.find_asset(aid) {
                    if asset.has_audio && matches!(asset.kind, AssetKind::Video | AssetKind::Audio) {
                        let gain_kf = clip
                            .keyframes
                            .get(&Property::Volume)
                            .and_then(|kfs| eval_keyframes(kfs, local))
                            .unwrap_or(clip.volume);
                        audio.push(AudioSlice {
                            clip_id: clip.id.clone(),
                            asset_id: aid.clone(),
                            source_time_us: source_time,
                            speed: clip.speed,
                            gain: gain_kf.max(0.0),
                        });
                    }
                }
            }
        }
    }

    FrameGraph { time_us, width: doc.width, height: doc.height, layers, audio }
}

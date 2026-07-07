//! The edit command protocol — the single write path into a document.
//!
//! Both the human UI and any LLM/agent produce these commands as JSON; the
//! engine validates and applies them identically. Errors carry stable,
//! machine-readable codes so an agent can react programmatically.
//!
//! Example wire format:
//! ```json
//! {"type":"splitClip","clipId":"clip_3","atUs":1500000}
//! {"type":"moveClip","clipId":"clip_3","trackId":"track_1","startUs":0}
//! {"type":"batch","commands":[ ... ]}   // atomic: all-or-nothing
//! ```

use crate::model::*;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum EditCommand {
    // --- project / assets ---
    #[serde(rename_all = "camelCase")]
    AddAsset {
        kind: AssetKind,
        src: String,
        name: String,
        #[serde(default)]
        duration_us: TimeUs,
        #[serde(default)]
        width: u32,
        #[serde(default)]
        height: u32,
        #[serde(default)]
        has_audio: Option<bool>,
        /// Optional caller-chosen id (must be unique); else engine mints one.
        #[serde(default)]
        id: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    AddTrack {
        kind: TrackKind,
        #[serde(default)]
        name: Option<String>,
        /// Insert position in render order; default = top.
        #[serde(default)]
        index: Option<usize>,
    },
    #[serde(rename_all = "camelCase")]
    RemoveTrack { track_id: String },
    #[serde(rename_all = "camelCase")]
    MoveTrack { track_id: String, to_index: usize },

    // --- clip lifecycle ---
    #[serde(rename_all = "camelCase")]
    AddClip {
        track_id: String,
        asset_id: String,
        start_us: TimeUs,
        #[serde(default)]
        duration_us: Option<TimeUs>,
        #[serde(default)]
        source_in_us: TimeUs,
    },
    #[serde(rename_all = "camelCase")]
    AddTextClip {
        track_id: String,
        start_us: TimeUs,
        duration_us: TimeUs,
        text: TextPayload,
    },
    #[serde(rename_all = "camelCase")]
    RemoveClip { clip_id: String },
    /// Move within or across tracks. Rejected with `overlap` if it collides.
    #[serde(rename_all = "camelCase")]
    MoveClip {
        clip_id: String,
        #[serde(default)]
        track_id: Option<String>,
        start_us: TimeUs,
    },
    /// Adjust an edge. `edge` = "in" trims the head (changes startUs and
    /// sourceInUs together), "out" trims the tail.
    #[serde(rename_all = "camelCase")]
    TrimClip {
        clip_id: String,
        edge: TrimEdge,
        /// New absolute timeline position of that edge.
        to_us: TimeUs,
    },
    #[serde(rename_all = "camelCase")]
    SplitClip { clip_id: String, at_us: TimeUs },
    /// Change playback rate, preserving the source span (timeline duration
    /// rescales). Rejected if the rescaled clip would overlap a neighbour.
    #[serde(rename_all = "camelCase")]
    SetClipSpeed { clip_id: String, speed: f64 },

    // --- properties / animation ---
    #[serde(rename_all = "camelCase")]
    SetTransform { clip_id: String, transform: Transform },
    #[serde(rename_all = "camelCase")]
    SetClipVolume { clip_id: String, volume: f64 },
    #[serde(rename_all = "camelCase")]
    SetText { clip_id: String, text: TextPayload },
    /// Set or clear (transition: null) the transition into a clip.
    #[serde(rename_all = "camelCase")]
    SetTransition {
        clip_id: String,
        #[serde(default)]
        transition: Option<Transition>,
    },
    /// Upsert one keyframe (matched by property + timeUs).
    #[serde(rename_all = "camelCase")]
    SetKeyframe {
        clip_id: String,
        property: Property,
        keyframe: Keyframe,
    },
    #[serde(rename_all = "camelCase")]
    RemoveKeyframe {
        clip_id: String,
        property: Property,
        time_us: TimeUs,
    },

    // --- effects ---
    #[serde(rename_all = "camelCase")]
    AddEffect {
        clip_id: String,
        effect: String,
        #[serde(default)]
        params: serde_json::Value,
    },
    #[serde(rename_all = "camelCase")]
    RemoveEffect { clip_id: String, effect_id: String },
    #[serde(rename_all = "camelCase")]
    SetEffectParams {
        clip_id: String,
        effect_id: String,
        params: serde_json::Value,
    },

    // --- track props ---
    #[serde(rename_all = "camelCase")]
    SetTrackMuted { track_id: String, muted: bool },
    #[serde(rename_all = "camelCase")]
    SetTrackLocked { track_id: String, locked: bool },

    /// Atomic composite: applied all-or-nothing, single undo step.
    #[serde(rename_all = "camelCase")]
    Batch { commands: Vec<EditCommand> },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TrimEdge {
    In,
    Out,
}

// ---------------------------------------------------------------------------
// Results & events
// ---------------------------------------------------------------------------

/// Change notifications for the UI layer (and for agents observing edits).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Event {
    #[serde(rename_all = "camelCase")]
    AssetAdded { asset_id: String },
    #[serde(rename_all = "camelCase")]
    TrackAdded { track_id: String },
    #[serde(rename_all = "camelCase")]
    TrackRemoved { track_id: String },
    #[serde(rename_all = "camelCase")]
    TrackUpdated { track_id: String },
    #[serde(rename_all = "camelCase")]
    ClipAdded { clip_id: String, track_id: String },
    #[serde(rename_all = "camelCase")]
    ClipRemoved { clip_id: String },
    #[serde(rename_all = "camelCase")]
    ClipUpdated { clip_id: String },
    DocumentReplaced,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CmdError {
    /// Stable machine-readable code: notFound | overlap | invalidArg |
    /// locked | parse | outOfRange
    pub code: String,
    pub message: String,
}

impl CmdError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        CmdError { code: code.into(), message: message.into() }
    }
    pub fn not_found(what: &str, id: &str) -> Self {
        Self::new("notFound", format!("{} '{}' not found", what, id))
    }
    pub fn overlap(msg: impl Into<String>) -> Self {
        Self::new("overlap", msg)
    }
    pub fn invalid(msg: impl Into<String>) -> Self {
        Self::new("invalidArg", msg)
    }
    pub fn locked(track_id: &str) -> Self {
        Self::new("locked", format!("track '{}' is locked", track_id))
    }
}

pub type CmdResult = Result<Vec<Event>, CmdError>;

// ---------------------------------------------------------------------------
// Application logic
// ---------------------------------------------------------------------------

pub fn apply(doc: &mut Document, cmd: &EditCommand) -> CmdResult {
    use EditCommand::*;
    match cmd {
        AddAsset { kind, src, name, duration_us, width, height, has_audio, id } => {
            let asset_id = match id {
                Some(explicit) => {
                    if doc.find_asset(explicit).is_some() {
                        return Err(CmdError::invalid(format!("asset id '{}' already exists", explicit)));
                    }
                    explicit.clone()
                }
                None => doc.mint_id("asset"),
            };
            doc.assets.push(Asset {
                id: asset_id.clone(),
                kind: *kind,
                src: src.clone(),
                name: name.clone(),
                duration_us: *duration_us,
                width: *width,
                height: *height,
                has_audio: has_audio.unwrap_or(*kind != AssetKind::Image),
            });
            Ok(vec![Event::AssetAdded { asset_id }])
        }

        AddTrack { kind, name, index } => {
            let track_id = doc.mint_id("track");
            let n = doc.tracks.len();
            let track = Track {
                id: track_id.clone(),
                kind: *kind,
                name: name.clone().unwrap_or_else(|| format!("Track {}", n + 1)),
                muted: false,
                locked: false,
                clips: Vec::new(),
            };
            let at = index.unwrap_or(n).min(n);
            doc.tracks.insert(at, track);
            Ok(vec![Event::TrackAdded { track_id }])
        }

        RemoveTrack { track_id } => {
            let i = doc
                .tracks
                .iter()
                .position(|t| t.id == *track_id)
                .ok_or_else(|| CmdError::not_found("track", track_id))?;
            doc.tracks.remove(i);
            Ok(vec![Event::TrackRemoved { track_id: track_id.clone() }])
        }

        MoveTrack { track_id, to_index } => {
            let i = doc
                .tracks
                .iter()
                .position(|t| t.id == *track_id)
                .ok_or_else(|| CmdError::not_found("track", track_id))?;
            let to = (*to_index).min(doc.tracks.len() - 1);
            let t = doc.tracks.remove(i);
            doc.tracks.insert(to, t);
            Ok(vec![Event::TrackUpdated { track_id: track_id.clone() }])
        }

        AddClip { track_id, asset_id, start_us, duration_us, source_in_us } => {
            let asset = doc
                .find_asset(asset_id)
                .ok_or_else(|| CmdError::not_found("asset", asset_id))?
                .clone();
            let dur = duration_us.unwrap_or(asset.duration_us.max(1));
            if dur <= 0 || *start_us < 0 {
                return Err(CmdError::invalid("duration must be > 0 and start >= 0"));
            }
            let clip_id = doc.mint_id("clip");
            let track = doc
                .find_track_mut(track_id)
                .ok_or_else(|| CmdError::not_found("track", track_id))?;
            if track.locked {
                return Err(CmdError::locked(track_id));
            }
            if track.overlaps(*start_us, dur, None) {
                return Err(CmdError::overlap("clip would overlap an existing clip on this track"));
            }
            track.clips.push(Clip {
                id: clip_id.clone(),
                asset_id: Some(asset_id.clone()),
                start_us: *start_us,
                duration_us: dur,
                source_in_us: *source_in_us,
                speed: 1.0,
                transform: Transform::default(),
                keyframes: Default::default(),
                effects: Vec::new(),
                text: None,
                volume: 1.0,
                transition: None,
            });
            track.sort_clips();
            Ok(vec![Event::ClipAdded { clip_id, track_id: track_id.clone() }])
        }

        AddTextClip { track_id, start_us, duration_us, text } => {
            if *duration_us <= 0 || *start_us < 0 {
                return Err(CmdError::invalid("duration must be > 0 and start >= 0"));
            }
            let clip_id = doc.mint_id("clip");
            let track = doc
                .find_track_mut(track_id)
                .ok_or_else(|| CmdError::not_found("track", track_id))?;
            if track.locked {
                return Err(CmdError::locked(track_id));
            }
            if track.overlaps(*start_us, *duration_us, None) {
                return Err(CmdError::overlap("clip would overlap an existing clip on this track"));
            }
            track.clips.push(Clip {
                id: clip_id.clone(),
                asset_id: None,
                start_us: *start_us,
                duration_us: *duration_us,
                source_in_us: 0,
                speed: 1.0,
                transform: Transform::default(),
                keyframes: Default::default(),
                effects: Vec::new(),
                text: Some(text.clone()),
                volume: 1.0,
                transition: None,
            });
            track.sort_clips();
            Ok(vec![Event::ClipAdded { clip_id, track_id: track_id.clone() }])
        }

        RemoveClip { clip_id } => {
            let (ti, ci) = doc
                .locate_clip(clip_id)
                .ok_or_else(|| CmdError::not_found("clip", clip_id))?;
            if doc.tracks[ti].locked {
                return Err(CmdError::locked(&doc.tracks[ti].id.clone()));
            }
            doc.tracks[ti].clips.remove(ci);
            Ok(vec![Event::ClipRemoved { clip_id: clip_id.clone() }])
        }

        MoveClip { clip_id, track_id, start_us } => {
            if *start_us < 0 {
                return Err(CmdError::invalid("start must be >= 0"));
            }
            let (ti, ci) = doc
                .locate_clip(clip_id)
                .ok_or_else(|| CmdError::not_found("clip", clip_id))?;
            let dest_ti = match track_id {
                Some(tid) => doc
                    .tracks
                    .iter()
                    .position(|t| t.id == *tid)
                    .ok_or_else(|| CmdError::not_found("track", tid))?,
                None => ti,
            };
            if dest_ti != ti && doc.tracks[dest_ti].kind != doc.tracks[ti].kind {
                return Err(CmdError::invalid("cannot move a clip across track kinds"));
            }
            if doc.tracks[ti].locked || doc.tracks[dest_ti].locked {
                return Err(CmdError::locked(&doc.tracks[dest_ti].id.clone()));
            }
            let dur = doc.tracks[ti].clips[ci].duration_us;
            let ignore = if dest_ti == ti { Some(clip_id.as_str()) } else { None };
            if doc.tracks[dest_ti].overlaps(*start_us, dur, ignore) {
                return Err(CmdError::overlap("destination range overlaps an existing clip"));
            }
            let mut clip = doc.tracks[ti].clips.remove(ci);
            clip.start_us = *start_us;
            doc.tracks[dest_ti].clips.push(clip);
            doc.tracks[dest_ti].sort_clips();
            Ok(vec![Event::ClipUpdated { clip_id: clip_id.clone() }])
        }

        TrimClip { clip_id, edge, to_us } => {
            let (ti, ci) = doc
                .locate_clip(clip_id)
                .ok_or_else(|| CmdError::not_found("clip", clip_id))?;
            if doc.tracks[ti].locked {
                return Err(CmdError::locked(&doc.tracks[ti].id.clone()));
            }
            let clip = doc.tracks[ti].clips[ci].clone();
            let (new_start, new_dur, new_src_in) = match edge {
                TrimEdge::In => {
                    if *to_us >= clip.end_us() {
                        return Err(CmdError::invalid("in-edge must stay before clip end"));
                    }
                    let to = (*to_us).max(0);
                    let delta = to - clip.start_us; // may be negative (extend head)
                    let src_in = clip.source_in_us + ((delta as f64) * clip.speed).round() as TimeUs;
                    if src_in < 0 {
                        return Err(CmdError::new("outOfRange", "cannot extend before source start"));
                    }
                    (to, clip.end_us() - to, src_in)
                }
                TrimEdge::Out => {
                    if *to_us <= clip.start_us {
                        return Err(CmdError::invalid("out-edge must stay after clip start"));
                    }
                    (clip.start_us, *to_us - clip.start_us, clip.source_in_us)
                }
            };
            // Source bound check for assets with known duration.
            if let Some(aid) = &clip.asset_id {
                if let Some(asset) = doc.find_asset(aid) {
                    if asset.kind != AssetKind::Image && asset.duration_us > 0 {
                        let src_out = new_src_in + ((new_dur as f64) * clip.speed).round() as TimeUs;
                        if src_out > asset.duration_us {
                            return Err(CmdError::new("outOfRange", "trim exceeds source media duration"));
                        }
                    }
                }
            }
            if doc.tracks[ti].overlaps(new_start, new_dur, Some(clip_id)) {
                return Err(CmdError::overlap("trim would overlap a neighbouring clip"));
            }
            let c = &mut doc.tracks[ti].clips[ci];
            c.start_us = new_start;
            c.duration_us = new_dur;
            c.source_in_us = new_src_in;
            doc.tracks[ti].sort_clips();
            Ok(vec![Event::ClipUpdated { clip_id: clip_id.clone() }])
        }

        SplitClip { clip_id, at_us } => {
            let (ti, ci) = doc
                .locate_clip(clip_id)
                .ok_or_else(|| CmdError::not_found("clip", clip_id))?;
            if doc.tracks[ti].locked {
                return Err(CmdError::locked(&doc.tracks[ti].id.clone()));
            }
            let clip = doc.tracks[ti].clips[ci].clone();
            if *at_us <= clip.start_us || *at_us >= clip.end_us() {
                return Err(CmdError::invalid("split point must be strictly inside the clip"));
            }
            let right_id = doc.mint_id("clip");
            let split_local = *at_us - clip.start_us;
            let track = &mut doc.tracks[ti];
            let left = &mut track.clips[ci];
            left.duration_us = split_local;
            let mut right = clip.clone();
            right.id = right_id.clone();
            right.start_us = *at_us;
            right.duration_us = clip.end_us() - *at_us;
            right.source_in_us = clip.source_time_at(*at_us);
            // The transition lives at the original clip's START → stays on the
            // left half; the new cut between halves is hard.
            right.transition = None;
            // Keyframes are clip-relative: re-base and partition.
            right.keyframes = clip
                .keyframes
                .iter()
                .map(|(p, kfs)| {
                    let shifted: Vec<Keyframe> = kfs
                        .iter()
                        .filter(|k| k.time_us >= split_local)
                        .map(|k| Keyframe { time_us: k.time_us - split_local, ..*k })
                        .collect();
                    (*p, shifted)
                })
                .filter(|(_, v)| !v.is_empty())
                .collect();
            track.clips[ci]
                .keyframes
                .iter_mut()
                .for_each(|(_, kfs)| kfs.retain(|k| k.time_us <= split_local));
            track.clips[ci].keyframes.retain(|_, v| !v.is_empty());
            let track_id = track.id.clone();
            track.clips.push(right);
            track.sort_clips();
            Ok(vec![
                Event::ClipUpdated { clip_id: clip_id.clone() },
                Event::ClipAdded { clip_id: right_id, track_id },
            ])
        }

        SetClipSpeed { clip_id, speed } => {
            if !(*speed > 0.0) || !speed.is_finite() {
                return Err(CmdError::invalid("speed must be a finite number > 0"));
            }
            let (ti, ci) = doc
                .locate_clip(clip_id)
                .ok_or_else(|| CmdError::not_found("clip", clip_id))?;
            if doc.tracks[ti].locked {
                return Err(CmdError::locked(&doc.tracks[ti].id.clone()));
            }
            let clip = doc.tracks[ti].clips[ci].clone();
            // Preserve the source span; timeline duration rescales.
            let source_span = (clip.duration_us as f64) * clip.speed;
            let new_dur = (source_span / speed).round() as TimeUs;
            if new_dur <= 0 {
                return Err(CmdError::invalid("resulting duration would be zero"));
            }
            if doc.tracks[ti].overlaps(clip.start_us, new_dur, Some(clip_id)) {
                return Err(CmdError::overlap("speed change would overlap the next clip; move or trim it first"));
            }
            let c = &mut doc.tracks[ti].clips[ci];
            c.speed = *speed;
            c.duration_us = new_dur;
            Ok(vec![Event::ClipUpdated { clip_id: clip_id.clone() }])
        }

        SetTransform { clip_id, transform } => {
            let c = doc
                .find_clip_mut(clip_id)
                .ok_or_else(|| CmdError::not_found("clip", clip_id))?;
            c.transform = *transform;
            Ok(vec![Event::ClipUpdated { clip_id: clip_id.clone() }])
        }

        SetClipVolume { clip_id, volume } => {
            if !(0.0..=4.0).contains(volume) {
                return Err(CmdError::invalid("volume must be within 0..=4"));
            }
            let c = doc
                .find_clip_mut(clip_id)
                .ok_or_else(|| CmdError::not_found("clip", clip_id))?;
            c.volume = *volume;
            Ok(vec![Event::ClipUpdated { clip_id: clip_id.clone() }])
        }

        SetText { clip_id, text } => {
            let c = doc
                .find_clip_mut(clip_id)
                .ok_or_else(|| CmdError::not_found("clip", clip_id))?;
            if c.text.is_none() {
                return Err(CmdError::invalid("clip is not a text clip"));
            }
            c.text = Some(text.clone());
            Ok(vec![Event::ClipUpdated { clip_id: clip_id.clone() }])
        }

        SetTransition { clip_id, transition } => {
            if let Some(tr) = transition {
                if tr.duration_us <= 0 {
                    return Err(CmdError::invalid("transition duration must be > 0"));
                }
            }
            let c = doc
                .find_clip_mut(clip_id)
                .ok_or_else(|| CmdError::not_found("clip", clip_id))?;
            c.transition = transition.clone();
            Ok(vec![Event::ClipUpdated { clip_id: clip_id.clone() }])
        }

        SetKeyframe { clip_id, property, keyframe } => {
            let c = doc
                .find_clip_mut(clip_id)
                .ok_or_else(|| CmdError::not_found("clip", clip_id))?;
            if keyframe.time_us < 0 || keyframe.time_us > c.duration_us {
                return Err(CmdError::new("outOfRange", "keyframe time outside clip"));
            }
            let kfs = c.keyframes.entry(*property).or_default();
            match kfs.iter_mut().find(|k| k.time_us == keyframe.time_us) {
                Some(existing) => *existing = *keyframe,
                None => {
                    kfs.push(*keyframe);
                    kfs.sort_by_key(|k| k.time_us);
                }
            }
            Ok(vec![Event::ClipUpdated { clip_id: clip_id.clone() }])
        }

        RemoveKeyframe { clip_id, property, time_us } => {
            let c = doc
                .find_clip_mut(clip_id)
                .ok_or_else(|| CmdError::not_found("clip", clip_id))?;
            let kfs = c
                .keyframes
                .get_mut(property)
                .ok_or_else(|| CmdError::new("notFound", "no keyframes on property"))?;
            let before = kfs.len();
            kfs.retain(|k| k.time_us != *time_us);
            if kfs.len() == before {
                return Err(CmdError::new("notFound", "keyframe not found at that time"));
            }
            if kfs.is_empty() {
                c.keyframes.remove(property);
            }
            Ok(vec![Event::ClipUpdated { clip_id: clip_id.clone() }])
        }

        AddEffect { clip_id, effect, params } => {
            let effect_id = doc.mint_id("fx");
            let c = doc
                .find_clip_mut(clip_id)
                .ok_or_else(|| CmdError::not_found("clip", clip_id))?;
            c.effects.push(EffectInstance {
                id: effect_id,
                effect: effect.clone(),
                params: params.clone(),
                enabled: Some(true),
            });
            Ok(vec![Event::ClipUpdated { clip_id: clip_id.clone() }])
        }

        RemoveEffect { clip_id, effect_id } => {
            let c = doc
                .find_clip_mut(clip_id)
                .ok_or_else(|| CmdError::not_found("clip", clip_id))?;
            let before = c.effects.len();
            c.effects.retain(|e| e.id != *effect_id);
            if c.effects.len() == before {
                return Err(CmdError::not_found("effect", effect_id));
            }
            Ok(vec![Event::ClipUpdated { clip_id: clip_id.clone() }])
        }

        SetEffectParams { clip_id, effect_id, params } => {
            let c = doc
                .find_clip_mut(clip_id)
                .ok_or_else(|| CmdError::not_found("clip", clip_id))?;
            let fx = c
                .effects
                .iter_mut()
                .find(|e| e.id == *effect_id)
                .ok_or_else(|| CmdError::not_found("effect", effect_id))?;
            fx.params = params.clone();
            Ok(vec![Event::ClipUpdated { clip_id: clip_id.clone() }])
        }

        SetTrackMuted { track_id, muted } => {
            let t = doc
                .find_track_mut(track_id)
                .ok_or_else(|| CmdError::not_found("track", track_id))?;
            t.muted = *muted;
            Ok(vec![Event::TrackUpdated { track_id: track_id.clone() }])
        }

        SetTrackLocked { track_id, locked } => {
            let t = doc
                .find_track_mut(track_id)
                .ok_or_else(|| CmdError::not_found("track", track_id))?;
            t.locked = *locked;
            Ok(vec![Event::TrackUpdated { track_id: track_id.clone() }])
        }

        Batch { commands } => {
            // All-or-nothing: work on a scratch copy, commit only on success.
            let mut scratch = doc.clone();
            let mut events = Vec::new();
            for c in commands {
                events.extend(apply(&mut scratch, c)?);
            }
            *doc = scratch;
            Ok(events)
        }
    }
}

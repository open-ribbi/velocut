use crate::command::{apply_inner, CmdError, CmdResult, EditCommand, Event};
use crate::model::*;

fn request_ok(r: &GenerationRequest) -> bool {
    [&r.first_frame_reference_id, &r.last_frame_reference_id]
        .iter()
        .all(|v| v.as_ref().map(|s| !s.is_empty()).unwrap_or(true))
        && [
            &r.reference_image_ids,
            &r.reference_video_ids,
            &r.reference_audio_ids,
        ]
        .iter()
        .all(|v| {
            v.as_ref()
                .map(|ids| ids.iter().all(|s| !s.is_empty()))
                .unwrap_or(true)
        })
        && r.parameters
            .as_ref()
            .map(|values| {
                values
                    .values()
                    .all(|v| v.is_string() || v.is_boolean() || v.is_number())
            })
            .unwrap_or(true)
}
fn request_equal(a: &GenerationRequest, b: &GenerationRequest) -> bool {
    let normalize = |r: &GenerationRequest| {
        let mut v = r.clone();
        v.parameters.get_or_insert_with(Default::default);
        v.reference_image_ids.get_or_insert_with(Vec::new);
        v.reference_video_ids.get_or_insert_with(Vec::new);
        v.reference_audio_ids.get_or_insert_with(Vec::new);
        v
    };
    normalize(a) == normalize(b)
}
fn overlap(t: &Track, start: TimeUs, duration: TimeUs, ignore: Option<&str>) -> bool {
    t.clips.iter().any(|c| {
        Some(c.id.as_str()) != ignore && start < c.end_us() && c.start_us < start + duration
    })
}
pub fn sync_slots(doc: &mut Document) {
    let tracks = &doc.tracks;
    doc.generation_slots.retain(|s| {
        tracks.iter().any(|t| t.id == s.track_id)
            && s.clip_id
                .as_ref()
                .map(|id| tracks.iter().any(|t| t.clips.iter().any(|c| &c.id == id)))
                .unwrap_or(true)
    });
    for s in &mut doc.generation_slots {
        if let Some(id) = &s.clip_id {
            if let Some((t, c)) = tracks
                .iter()
                .find_map(|t| t.clips.iter().find(|c| &c.id == id).map(|c| (t, c)))
            {
                if s.duration_us != c.duration_us {
                    s.intent_version += 1;
                }
                s.track_id = t.id.clone();
                s.start_us = c.start_us;
                s.duration_us = c.duration_us;
            }
        }
    }
}
pub fn apply_generation(doc: &mut Document, cmd: &EditCommand) -> Option<CmdResult> {
    use EditCommand::*;
    if !matches!(
        cmd,
        AddGenerationSlot { .. }
            | UpdateGenerationSlot { .. }
            | RemoveGenerationSlot { .. }
            | ResolveGenerationSlot { .. }
            | ReplaceClipSource { .. }
    ) {
        return None;
    }
    Some(run(doc, cmd))
}
fn run(doc: &mut Document, cmd: &EditCommand) -> CmdResult {
    use EditCommand::*;
    match cmd {
        AddGenerationSlot {
            track_id,
            start_us,
            duration_us,
            request,
            name,
        } => {
            let t = doc
                .find_track(track_id)
                .ok_or_else(|| CmdError::not_found("track", track_id))?;
            if t.locked {
                return Err(CmdError::locked(track_id));
            }
            if t.kind != TrackKind::Video
                || *start_us < 0
                || *duration_us <= 0
                || !request_ok(request)
            {
                return Err(CmdError::invalid(
                    "generation slot requires a video track, positive duration and a valid request",
                ));
            }
            if overlap(t, *start_us, *duration_us, None)
                || doc.generation_slots.iter().any(|s| {
                    s.clip_id.is_none()
                        && s.track_id == *track_id
                        && *start_us < s.start_us + s.duration_us
                        && s.start_us < start_us + duration_us
                })
            {
                return Err(CmdError::overlap(
                    "generation slot overlaps an existing clip or slot",
                ));
            }
            let id = doc.mint_id("slot");
            doc.generation_slots.push(GenerationSlot {
                id: id.clone(),
                track_id: track_id.clone(),
                start_us: *start_us,
                duration_us: *duration_us,
                name: name.clone().unwrap_or("Generated shot".into()),
                intent_version: 1,
                request: request.clone(),
                clip_id: None,
                selected_job_id: None,
            });
            Ok(vec![Event::GenerationSlotAdded { slot_id: id }])
        }
        UpdateGenerationSlot {
            slot_id,
            track_id,
            start_us,
            duration_us,
            request,
            name,
        } => {
            let si = doc
                .generation_slots
                .iter()
                .position(|s| &s.id == slot_id)
                .ok_or_else(|| CmdError::not_found("generation slot", slot_id))?;
            let mut s = doc.generation_slots[si].clone();
            let target = track_id.as_ref().unwrap_or(&s.track_id).clone();
            let ti = doc
                .tracks
                .iter()
                .position(|t| t.id == target)
                .ok_or_else(|| CmdError::not_found("track", &target))?;
            if doc.tracks[ti].locked || doc.find_track(&s.track_id).unwrap().locked {
                return Err(CmdError::new("locked", "generation slot track is locked"));
            }
            let start = start_us.unwrap_or(s.start_us);
            let duration = duration_us.unwrap_or(s.duration_us);
            if doc.tracks[ti].kind != TrackKind::Video
                || start < 0
                || duration <= 0
                || request.as_ref().map(|r| !request_ok(r)).unwrap_or(false)
            {
                return Err(CmdError::invalid("invalid generation slot edit"));
            }
            if overlap(&doc.tracks[ti], start, duration, s.clip_id.as_deref())
                || doc.generation_slots.iter().any(|o| {
                    o.id != s.id
                        && o.clip_id.is_none()
                        && o.track_id == target
                        && start < o.start_us + o.duration_us
                        && o.start_us < start + duration
                })
            {
                return Err(CmdError::overlap(
                    "generation slot overlaps an existing clip or slot",
                ));
            }
            if let Some(id) = &s.clip_id {
                let (from, ci) = doc.locate_clip(id).unwrap();
                if duration != doc.tracks[from].clips[ci].duration_us {
                    return Err(CmdError::invalid(
                        "trim an adopted clip to change its duration",
                    ));
                }
                let mut c = doc.tracks[from].clips.remove(ci);
                c.start_us = start;
                doc.tracks[ti].clips.push(c);
                doc.tracks[ti].clips.sort_by_key(|c| c.start_us);
            }
            if duration != s.duration_us
                || request
                    .as_ref()
                    .map(|r| !request_equal(r, &s.request))
                    .unwrap_or(false)
            {
                s.intent_version += 1;
            }
            s.track_id = target;
            s.start_us = start;
            s.duration_us = duration;
            if let Some(r) = request {
                s.request = r.clone();
            }
            if let Some(n) = name {
                s.name = n.clone();
            }
            doc.generation_slots[si] = s;
            Ok(vec![Event::GenerationSlotUpdated {
                slot_id: slot_id.clone(),
            }])
        }
        RemoveGenerationSlot { slot_id } => {
            let s = doc
                .generation_slots
                .iter()
                .find(|s| &s.id == slot_id)
                .ok_or_else(|| CmdError::not_found("generation slot", slot_id))?;
            if doc
                .find_track(&s.track_id)
                .map(|t| t.locked)
                .unwrap_or(false)
            {
                return Err(CmdError::new("locked", "generation slot track is locked"));
            }
            doc.generation_slots.retain(|s| &s.id != slot_id);
            Ok(vec![Event::GenerationSlotRemoved {
                slot_id: slot_id.clone(),
            }])
        }
        ReplaceClipSource {
            clip_id,
            asset_id,
            source_in_us,
            duration_us,
        } => {
            let (ti, ci) = doc
                .locate_clip(clip_id)
                .ok_or_else(|| CmdError::not_found("clip", clip_id))?;
            let a = doc
                .find_asset(asset_id)
                .ok_or_else(|| CmdError::not_found("asset", asset_id))?;
            let t = &doc.tracks[ti];
            let c = &t.clips[ci];
            if t.locked {
                return Err(CmdError::locked(&t.id));
            }
            let duration = duration_us.unwrap_or(c.duration_us);
            let source = source_in_us.unwrap_or(0);
            if c.text.is_some()
                || t.kind == TrackKind::Text
                || t.kind == TrackKind::Video && a.kind == AssetKind::Audio
                || t.kind == TrackKind::Audio && a.kind != AssetKind::Audio
            {
                return Err(CmdError::invalid(
                    "source kind does not match the clip track",
                ));
            }
            if duration <= 0
                || source < 0
                || a.kind != AssetKind::Image
                    && source + (duration as f64 * c.speed).round() as i64 > a.duration_us
            {
                return Err(CmdError::new(
                    "outOfRange",
                    "replacement source is shorter than the requested clip window",
                ));
            }
            if overlap(t, c.start_us, duration, Some(clip_id)) {
                return Err(CmdError::overlap(
                    "replacement would overlap an existing clip",
                ));
            }
            let c = &mut doc.tracks[ti].clips[ci];
            c.asset_id = Some(asset_id.clone());
            c.source_in_us = source;
            c.duration_us = duration;
            Ok(vec![Event::ClipUpdated {
                clip_id: clip_id.clone(),
            }])
        }
        ResolveGenerationSlot {
            slot_id,
            intent_version,
            asset_id,
            source_in_us,
            duration_us,
            job_id,
        } => {
            let si = doc
                .generation_slots
                .iter()
                .position(|s| &s.id == slot_id)
                .ok_or_else(|| CmdError::not_found("generation slot", slot_id))?;
            let s = doc.generation_slots[si].clone();
            if s.intent_version != *intent_version {
                return Err(CmdError::new("conflict", "generation intent changed"));
            }
            let a = doc
                .find_asset(asset_id)
                .ok_or_else(|| CmdError::invalid("generation result must be a video asset"))?;
            if a.kind != AssetKind::Video {
                return Err(CmdError::invalid("generation result must be a video asset"));
            }
            let duration = duration_us.unwrap_or(s.duration_us);
            let source = source_in_us.unwrap_or(0);
            let (mut events, id) = if let Some(id) = s.clip_id.clone() {
                (
                    apply_inner(
                        doc,
                        &ReplaceClipSource {
                            clip_id: id.clone(),
                            asset_id: asset_id.clone(),
                            source_in_us: Some(source),
                            duration_us: Some(duration),
                        },
                    )?,
                    id,
                )
            } else {
                if source < 0 || duration <= 0 || source + duration > a.duration_us {
                    return Err(CmdError::new(
                        "outOfRange",
                        "generation result is shorter than the requested slot",
                    ));
                }
                let events = apply_inner(
                    doc,
                    &AddClip {
                        track_id: s.track_id,
                        asset_id: asset_id.clone(),
                        start_us: s.start_us,
                        duration_us: Some(duration),
                        source_in_us: source,
                    },
                )?;
                let id = events
                    .iter()
                    .find_map(|e| {
                        if let Event::ClipAdded { clip_id, .. } = e {
                            Some(clip_id.clone())
                        } else {
                            None
                        }
                    })
                    .unwrap();
                (events, id)
            };
            let s = &mut doc.generation_slots[si];
            s.clip_id = Some(id.clone());
            if s.duration_us != duration {
                s.intent_version += 1;
            }
            s.duration_us = duration;
            if job_id.is_some() {
                s.selected_job_id = job_id.clone();
            }
            events.push(Event::GenerationSlotUpdated {
                slot_id: slot_id.clone(),
            });
            events.push(Event::ClipUpdated { clip_id: id });
            Ok(events)
        }
        _ => unreachable!(),
    }
}

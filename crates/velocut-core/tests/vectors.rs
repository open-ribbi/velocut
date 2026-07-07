//! Golden vector harness. The same vectors are executed by the TS reference
//! engine (web/packages/core-ts) — any behavioural divergence between the two
//! implementations fails CI on both sides.

use serde_json::Value;
use std::fs;
use std::path::PathBuf;
use velocut_core::Engine;

fn vectors_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../protocol/vectors")
}

fn approx(a: f64, b: f64) -> bool {
    (a - b).abs() < 1e-3
}

fn run_vector(path: &PathBuf) {
    let raw = fs::read_to_string(path).unwrap();
    let v: Value = serde_json::from_str(&raw).unwrap();
    let name = v["name"].as_str().unwrap_or("unnamed");
    let mut engine = Engine::new("test", 1920, 1080, 30, 1);

    for (i, step) in v["steps"].as_array().unwrap().iter().enumerate() {
        if let Some(cmd) = step.get("apply") {
            let resp: Value = serde_json::from_str(&engine.apply_json(&cmd.to_string())).unwrap();
            assert!(
                resp["ok"].as_bool() == Some(true),
                "[{}] step {}: expected ok, got {}",
                name,
                i,
                resp
            );
        } else if let Some(e) = step.get("applyErr") {
            let resp: Value =
                serde_json::from_str(&engine.apply_json(&e["cmd"].to_string())).unwrap();
            assert!(
                resp["ok"].as_bool() == Some(false),
                "[{}] step {}: expected error, got ok",
                name,
                i
            );
            assert_eq!(
                resp["error"]["code"].as_str(),
                e["code"].as_str(),
                "[{}] step {}: wrong error code: {}",
                name,
                i,
                resp
            );
        } else if let Some(doc) = step.get("load") {
            let resp: Value = serde_json::from_str(&engine.load_json(&doc.to_string())).unwrap();
            assert!(
                resp["ok"].as_bool() == Some(true),
                "[{}] step {}: load failed: {}",
                name,
                i,
                resp
            );
        } else if step.get("undo").is_some() {
            engine.undo().expect("nothing to undo");
        } else if step.get("redo").is_some() {
            engine.redo().expect("nothing to redo");
        } else {
            panic!("[{}] step {}: unknown step {:?}", name, i, step);
        }
    }

    let doc: Value = serde_json::from_str(&engine.document_json()).unwrap();
    let expect = &v["expect"];

    if let Some(assets) = expect.get("assets").and_then(|a| a.as_array()) {
        for want in assets {
            let id = want["id"].as_str().unwrap();
            let asset = doc["assets"]
                .as_array()
                .unwrap()
                .iter()
                .find(|a| a["id"].as_str() == Some(id))
                .unwrap_or_else(|| panic!("[{}] asset {} not found", name, id));
            if let Some(w) = want.get("hasAudio") {
                assert_eq!(&asset["hasAudio"], w, "[{}] {} hasAudio", name, id);
            }
        }
    }

    if let Some(clips) = expect.get("clips").and_then(|c| c.as_array()) {
        for want in clips {
            let id = want["id"].as_str().unwrap();
            let mut found = None;
            for track in doc["tracks"].as_array().unwrap() {
                for clip in track["clips"].as_array().unwrap() {
                    if clip["id"] == want["id"] {
                        found = Some((track["id"].as_str().unwrap().to_string(), clip.clone()));
                    }
                }
            }
            let (track_id, clip) =
                found.unwrap_or_else(|| panic!("[{}] clip {} not found", name, id));
            if let Some(t) = want.get("trackId") {
                assert_eq!(t.as_str().unwrap(), track_id, "[{}] {} track", name, id);
            }
            for field in ["startUs", "durationUs", "sourceInUs"] {
                if let Some(w) = want.get(field) {
                    assert_eq!(&clip[field], w, "[{}] {} {}", name, id, field);
                }
            }
            if let Some(w) = want.get("speed") {
                assert!(
                    approx(clip["speed"].as_f64().unwrap(), w.as_f64().unwrap()),
                    "[{}] {} speed",
                    name,
                    id
                );
            }
        }
    }

    if let Some(counts) = expect.get("clipCounts").and_then(|c| c.as_object()) {
        for (track_id, want) in counts {
            let n = doc["tracks"]
                .as_array()
                .unwrap()
                .iter()
                .find(|t| t["id"].as_str() == Some(track_id))
                .map(|t| t["clips"].as_array().unwrap().len())
                .unwrap_or(usize::MAX);
            assert_eq!(
                n as u64,
                want.as_u64().unwrap(),
                "[{}] clip count on {}",
                name,
                track_id
            );
        }
    }

    if let Some(evals) = expect.get("eval").and_then(|e| e.as_array()) {
        for case in evals {
            let t = case["timeUs"].as_i64().unwrap();
            let fg: Value = serde_json::from_str(&engine.evaluate_json(t)).unwrap();
            if let Some(want_audio) = case.get("audio").and_then(|a| a.as_array()) {
                let got_audio = fg["audio"].as_array().unwrap();
                for want in want_audio {
                    let cid = want["clipId"].as_str().unwrap();
                    let slice = got_audio
                        .iter()
                        .find(|s| s["clipId"].as_str() == Some(cid))
                        .unwrap_or_else(|| {
                            panic!("[{}] eval t={} missing audio slice {}", name, t, cid)
                        });
                    if let Some(w) = want.get("gain") {
                        assert!(
                            approx(slice["gain"].as_f64().unwrap(), w.as_f64().unwrap()),
                            "[{}] t={} {} gain: got {}",
                            name,
                            t,
                            cid,
                            slice["gain"]
                        );
                    }
                    if let Some(w) = want.get("sourceTimeUs") {
                        assert_eq!(
                            &slice["sourceTimeUs"], w,
                            "[{}] t={} {} audio sourceTime",
                            name, t, cid
                        );
                    }
                }
                assert_eq!(
                    got_audio.len(),
                    want_audio.len(),
                    "[{}] eval t={} audio slice count: got {}",
                    name,
                    t,
                    fg
                );
            }
            let Some(want_layers) = case.get("layers").and_then(|l| l.as_array()) else {
                continue;
            };
            let got_layers = fg["layers"].as_array().unwrap();
            assert_eq!(
                got_layers.len(),
                want_layers.len(),
                "[{}] eval t={} layer count: got {}",
                name,
                t,
                fg
            );
            for want in want_layers {
                let cid = want["clipId"].as_str().unwrap();
                let layer = got_layers
                    .iter()
                    .find(|l| l["clipId"].as_str() == Some(cid))
                    .unwrap_or_else(|| panic!("[{}] eval t={} missing layer {}", name, t, cid));
                if let Some(w) = want.get("sourceTimeUs") {
                    assert_eq!(
                        &layer["sourceTimeUs"], w,
                        "[{}] t={} {} sourceTime",
                        name, t, cid
                    );
                }
                if let Some(w) = want.get("opacity") {
                    assert!(
                        approx(
                            layer["transform"]["opacity"].as_f64().unwrap(),
                            w.as_f64().unwrap()
                        ),
                        "[{}] t={} {} opacity: got {}",
                        name,
                        t,
                        cid,
                        layer["transform"]["opacity"]
                    );
                }
                if let Some(w) = want.get("x") {
                    assert!(
                        approx(
                            layer["transform"]["x"].as_f64().unwrap(),
                            w.as_f64().unwrap()
                        ),
                        "[{}] t={} {} x: got {}",
                        name,
                        t,
                        cid,
                        layer["transform"]["x"]
                    );
                }
            }
        }
    }
}

#[test]
fn golden_vectors() {
    let mut paths: Vec<PathBuf> = fs::read_dir(vectors_dir())
        .expect("vectors dir")
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().map(|e| e == "json").unwrap_or(false))
        .collect();
    paths.sort();
    assert!(!paths.is_empty(), "no vectors found");
    for p in &paths {
        run_vector(p);
    }
    println!("{} vectors passed", paths.len());
}

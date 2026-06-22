//! Voice embedding loading, formula parsing, weighted combination, and per-length
//! style slicing. Ported from tauri/sidecar/tts-worker.ts.
use anyhow::{anyhow, Result};
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

const BLOCK: usize = 256;

/// Cache of raw voice float buffers, keyed by voice id.
pub type VoiceCache = Mutex<HashMap<String, Arc<Vec<f32>>>>;

fn load_raw(models_dir: &Path, id: &str, cache: &VoiceCache) -> Result<Arc<Vec<f32>>> {
    if let Some(v) = cache.lock().unwrap().get(id) {
        return Ok(v.clone());
    }
    let path = models_dir.join(format!("{id}.bin"));
    let bytes = std::fs::read(&path).map_err(|e| anyhow!("voice {id}: {e}"))?;
    if bytes.len() % 4 != 0 {
        return Err(anyhow!("voice {id}: byte length not f32-aligned"));
    }
    let floats: Vec<f32> = bytes
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        .collect();
    let arc = Arc::new(floats);
    cache.lock().unwrap().insert(id.to_string(), arc.clone());
    Ok(arc)
}

#[derive(Debug)]
struct VoiceWeight {
    id: String,
    weight: f32,
}

fn parse_formula(formula: &str) -> Result<Vec<VoiceWeight>> {
    let formula: String = formula.chars().filter(|c| !c.is_whitespace()).collect();
    if formula.is_empty() {
        return Err(anyhow!("Voice or voice formula cannot be empty"));
    }
    if !formula
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || "-_.*+".contains(c))
    {
        return Err(anyhow!("Invalid formula characters"));
    }
    let terms: Vec<&str> = formula.split('+').filter(|t| !t.is_empty()).collect();
    if terms.len() == 1 && !terms[0].contains('*') {
        return Ok(vec![VoiceWeight {
            id: terms[0].to_string(),
            weight: 1.0,
        }]);
    }
    let mut voices = Vec::new();
    for term in &terms {
        if !term.contains('*') {
            return Err(anyhow!("Term \"{term}\" must contain asterisk"));
        }
        let parts: Vec<&str> = term.split('*').collect();
        if parts.len() != 2 || parts[0].is_empty() || parts[1].is_empty() {
            return Err(anyhow!("Term \"{term}\" format incorrect"));
        }
        let mut weight: f32 = parts[1]
            .parse()
            .map_err(|_| anyhow!("Invalid weight for voice \"{}\"", parts[0]))?;
        if !(0.0..=1.0).contains(&weight) {
            return Err(anyhow!("Invalid weight for voice \"{}\"", parts[0]));
        }
        weight = (weight * 10.0).round() / 10.0;
        voices.push(VoiceWeight {
            id: parts[0].to_string(),
            weight,
        });
    }
    let total: f32 = voices.iter().map(|v| v.weight).sum();
    if ((total * 10.0).round() / 10.0 - 1.0).abs() > 1e-6 {
        return Err(anyhow!("Weights must sum to 1, got {total}"));
    }
    Ok(voices)
}

/// Weighted element-wise combination of one or more voices → flat f32 buffer.
pub fn combine(models_dir: &Path, formula: &str, cache: &VoiceCache) -> Result<Vec<f32>> {
    let voices = parse_formula(formula)?;
    let first = load_raw(models_dir, &voices[0].id, cache)?;
    let mut combined = vec![0f32; first.len()];
    for v in &voices {
        let raw = load_raw(models_dir, &v.id, cache)?;
        if raw.len() != combined.len() {
            return Err(anyhow!("voice {} size mismatch", v.id));
        }
        for (c, &x) in combined.iter_mut().zip(raw.iter()) {
            *c += v.weight * x;
        }
    }
    Ok(combined)
}

/// Style slice for an unpadded token length: block `len-1` (256 floats).
pub fn style_slice(combined: &[f32], unpadded_len: usize) -> Result<&[f32]> {
    if unpadded_len == 0 {
        return Err(anyhow!("empty token sequence"));
    }
    let start = (unpadded_len - 1) * BLOCK;
    combined
        .get(start..start + BLOCK)
        .ok_or_else(|| anyhow!("token length {unpadded_len} exceeds voice blocks"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn single_voice() {
        let v = parse_formula("af_heart").unwrap();
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].weight, 1.0);
    }

    #[test]
    fn weighted_blend_must_sum_to_one() {
        assert!(parse_formula("af_heart*0.6+am_michael*0.4").is_ok());
        assert!(parse_formula("af_heart*0.5+am_michael*0.4").is_err());
        assert!(parse_formula("bad chars!").is_err());
    }
}

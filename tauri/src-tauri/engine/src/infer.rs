//! ONNX inference: tokens + style + speed → waveform. Tensors match the Kokoro
//! model I/O confirmed from model_q8f16.onnx.
use anyhow::Result;
use ort::session::Session;
use ort::value::Tensor;

/// Run one inference. `tokens` is the unpadded token sequence; padding zeros are
/// added here. `speed` is passed through to the model (the Node engine hardcoded 1).
pub fn infer(session: &Session, tokens: &[i64], style: &[f32], speed: f32) -> Result<Vec<f32>> {
    let mut ids = Vec::with_capacity(tokens.len() + 2);
    ids.push(0i64);
    ids.extend_from_slice(tokens);
    ids.push(0i64);

    let input_ids = Tensor::<i64>::from_array(([1usize, ids.len()], ids))?;
    let style_t = Tensor::<f32>::from_array(([1usize, style.len()], style.to_vec()))?;
    let speed_t = Tensor::<f32>::from_array(([1usize], vec![speed]))?;

    let outputs = session.run(ort::inputs![
        "input_ids" => input_ids,
        "style" => style_t,
        "speed" => speed_t,
    ]?)?;

    let (_shape, data) = outputs["waveform"].try_extract_raw_tensor::<f32>()?;
    Ok(data.to_vec())
}

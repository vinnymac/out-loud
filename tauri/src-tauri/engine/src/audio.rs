//! Audio post-processing: silence trimming and WAV encoding. Ported from
//! tauri/sidecar/{tts-worker,shared-audio}.ts.
use crate::text::SAMPLE_RATE;
use anyhow::Result;

/// Trim leading/trailing near-silence (5% of max windowed amplitude, 256-sample
/// window + 256-sample buffer). Faithful port of trimWaveform.
pub fn trim(w: &[f32]) -> &[f32] {
    if w.is_empty() {
        return w;
    }
    let (window, buffer) = (256usize, 256usize);
    let num_windows = w.len().div_ceil(window);
    let mut amps = vec![0f32; num_windows];
    let mut max_amp = 0f32;
    for i in 0..num_windows {
        let (s, e) = (i * window, ((i + 1) * window).min(w.len()));
        let sum: f32 = w[s..e].iter().map(|x| x.abs()).sum();
        let avg = sum / (e - s) as f32;
        amps[i] = avg;
        if avg > max_amp {
            max_amp = avg;
        }
    }
    let threshold = max_amp * 0.05;

    let mut start_sample = 0usize;
    for i in 0..num_windows {
        if amps[i] > threshold {
            let (ws, we) = (i * window, ((i + 1) * window).min(w.len()));
            for j in ws..we {
                if w[j].abs() > threshold {
                    start_sample = j;
                    break;
                }
            }
            break;
        }
    }
    let mut end_sample = w.len();
    for i in (0..num_windows).rev() {
        if amps[i] > threshold {
            let (ws, we) = (i * window, ((i + 1) * window).min(w.len()));
            for j in (ws..we).rev() {
                if w[j].abs() > threshold {
                    end_sample = j + 1;
                    break;
                }
            }
            break;
        }
    }
    start_sample = start_sample.saturating_sub(buffer);
    end_sample = (end_sample + buffer).min(w.len());
    &w[start_sample..end_sample]
}

/// Encode f32 PCM samples as a 32-bit-float mono 24 kHz WAV (in memory).
pub fn to_wav(samples: &[f32]) -> Result<Vec<u8>> {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: SAMPLE_RATE,
        bits_per_sample: 32,
        sample_format: hound::SampleFormat::Float,
    };
    let mut cursor = std::io::Cursor::new(Vec::<u8>::new());
    {
        let mut w = hound::WavWriter::new(&mut cursor, spec)?;
        for &s in samples {
            w.write_sample(s)?;
        }
        w.finalize()?;
    }
    Ok(cursor.into_inner())
}

/// Encode mono f32 PCM (24 kHz) to MP3 bytes (extension API `response_format: mp3`).
pub fn to_mp3(samples: &[f32]) -> Result<Vec<u8>> {
    use mp3lame_encoder::{Bitrate, Builder, FlushNoGap, MonoPcm, Quality};

    let mut builder = Builder::new().ok_or_else(|| anyhow::anyhow!("lame builder"))?;
    builder.set_num_channels(1).map_err(|e| anyhow::anyhow!("lame channels: {e:?}"))?;
    builder.set_sample_rate(SAMPLE_RATE).map_err(|e| anyhow::anyhow!("lame rate: {e:?}"))?;
    builder.set_brate(Bitrate::Kbps128).map_err(|e| anyhow::anyhow!("lame brate: {e:?}"))?;
    builder.set_quality(Quality::Best).map_err(|e| anyhow::anyhow!("lame quality: {e:?}"))?;
    let mut enc = builder.build().map_err(|e| anyhow::anyhow!("lame build: {e:?}"))?;

    let mut out: Vec<u8> = Vec::with_capacity(mp3lame_encoder::max_required_buffer_size(samples.len()));
    let n = enc
        .encode(MonoPcm(samples), out.spare_capacity_mut())
        .map_err(|e| anyhow::anyhow!("lame encode: {e:?}"))?;
    unsafe { out.set_len(out.len() + n) };
    let n = enc
        .flush::<FlushNoGap>(out.spare_capacity_mut())
        .map_err(|e| anyhow::anyhow!("lame flush: {e:?}"))?;
    unsafe { out.set_len(out.len() + n) };
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trim_removes_silence() {
        let mut w = vec![0f32; 2000];
        for s in w.iter_mut().take(1200).skip(1000) {
            *s = 0.5;
        }
        let t = trim(&w);
        assert!(t.len() < w.len());
        assert!(t.len() >= 200); // signal + buffer retained
    }

    #[test]
    fn wav_roundtrips_header() {
        let bytes = to_wav(&[0.0, 0.1, -0.1]).unwrap();
        assert_eq!(&bytes[0..4], b"RIFF");
        assert_eq!(&bytes[8..12], b"WAVE");
    }
}

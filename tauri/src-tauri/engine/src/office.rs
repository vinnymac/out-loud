//! Legacy `.doc` / modern `.docx` text extraction via the `office_oxide` crate
//! (replaces the Node-only `word-extractor`).
use anyhow::{anyhow, Result};
use std::sync::atomic::{AtomicU64, Ordering};

static SEQ: AtomicU64 = AtomicU64::new(0);

/// Extract plain text from in-memory Word document bytes. `office_oxide` opens by
/// path (extension-driven format detection), so we round-trip through a uniquely
/// named temp file and clean it up.
pub fn extract_text(bytes: &[u8]) -> Result<String> {
    let n = SEQ.fetch_add(1, Ordering::Relaxed);
    let path = std::env::temp_dir().join(format!("outloud-doc-{}-{n}.doc", std::process::id()));
    std::fs::write(&path, bytes)?;
    let result = (|| -> Result<String> {
        let doc = office_oxide::Document::open(&path).map_err(|e| anyhow!("open doc: {e:?}"))?;
        Ok(doc.plain_text())
    })();
    let _ = std::fs::remove_file(&path);
    result
}

// Sidebar recents (mirrors electron/reader-recents.ts). Two kinds: opened files
// (path + format, text never stored) and text "sessions" (full text stored
// LOCALLY ONLY, never sent anywhere). Deduped, capped at 24, newest first.
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

const MAX_RECENTS: usize = 24;

#[derive(Serialize, Deserialize, Clone)]
#[serde(tag = "kind")]
pub enum RecentEntry {
    #[serde(rename = "file")]
    File {
        path: String,
        name: String,
        title: String,
        format: String,
        #[serde(rename = "addedAt")]
        added_at: f64,
    },
    #[serde(rename = "text")]
    Text {
        id: String,
        preview: String,
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        voice: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        language: Option<String>,
        #[serde(rename = "addedAt")]
        added_at: f64,
    },
}

impl RecentEntry {
    fn key(&self) -> String {
        match self {
            RecentEntry::File { path, .. } => format!("file:{path}"),
            RecentEntry::Text { id, .. } => format!("text:{id}"),
        }
    }
    fn text_value(&self) -> Option<&str> {
        match self {
            RecentEntry::Text { text, .. } => Some(text),
            _ => None,
        }
    }
}

fn recents_path(data_dir: &Path) -> PathBuf {
    data_dir.join("reader-recents.json")
}

pub fn get_recents(data_dir: &Path) -> Vec<RecentEntry> {
    match fs::read_to_string(recents_path(data_dir)) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

fn write(data_dir: &Path, mut list: Vec<RecentEntry>) -> Vec<RecentEntry> {
    list.truncate(MAX_RECENTS);
    let _ = fs::create_dir_all(data_dir);
    if let Ok(s) = serde_json::to_string_pretty(&list) {
        let _ = fs::write(recents_path(data_dir), s);
    }
    list
}

pub fn put_recent(data_dir: &Path, entry: RecentEntry) -> Vec<RecentEntry> {
    let key = entry.key();
    let entry_text = entry.text_value().map(|s| s.to_string());
    let mut list: Vec<RecentEntry> = get_recents(data_dir)
        .into_iter()
        .filter(|r| {
            if r.key() == key {
                return false;
            }
            // Collapse identical text sessions so replaying the same text
            // doesn't pile up duplicates.
            if let (Some(a), Some(b)) = (entry_text.as_deref(), r.text_value()) {
                if a == b {
                    return false;
                }
            }
            true
        })
        .collect();
    list.insert(0, entry);
    write(data_dir, list)
}

pub fn remove_recent(data_dir: &Path, key: &str) -> Vec<RecentEntry> {
    let list = get_recents(data_dir)
        .into_iter()
        .filter(|r| r.key() != key)
        .collect();
    write(data_dir, list)
}

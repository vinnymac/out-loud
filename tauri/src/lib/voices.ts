// The Kokoro voice catalogue, grouped by language. Mirrors the bundled voice
// .bin files and the original VoiceSelect data.
export interface Voice {
  id: string;
  name: string;
}

export const VOICES: Record<string, Voice[]> = {
  "en-us": [
    { id: "af_heart", name: "Heart" },
    { id: "af_bella", name: "Bella" },
    { id: "af_nicole", name: "Nicole" },
    { id: "af_aoede", name: "Aoede" },
    { id: "af_kore", name: "Kore" },
    { id: "af_sarah", name: "Sarah" },
    { id: "af_nova", name: "Nova" },
    { id: "af_sky", name: "Sky" },
    { id: "af_alloy", name: "Alloy" },
    { id: "af_jessica", name: "Jessica" },
    { id: "af_river", name: "River" },
    { id: "am_michael", name: "Michael" },
    { id: "am_fenrir", name: "Fenrir" },
    { id: "am_puck", name: "Puck" },
    { id: "am_echo", name: "Echo" },
    { id: "am_eric", name: "Eric" },
    { id: "am_liam", name: "Liam" },
    { id: "am_onyx", name: "Onyx" },
    { id: "am_santa", name: "Santa" },
    { id: "am_adam", name: "Adam" },
  ],
  "en-gb": [
    { id: "bf_emma", name: "Emma" },
    { id: "bf_isabella", name: "Isabella" },
    { id: "bf_alice", name: "Alice" },
    { id: "bf_lily", name: "Lily" },
    { id: "bm_george", name: "George" },
    { id: "bm_lewis", name: "Lewis" },
    { id: "bm_daniel", name: "Daniel" },
    { id: "bm_fable", name: "Fable" },
  ],
  "es-419": [
    { id: "ef_dora", name: "Dora" },
    { id: "em_alex", name: "Alex" },
    { id: "em_santa", name: "Santa" },
  ],
  "pt-br": [
    { id: "pf_dora", name: "Dora" },
    { id: "pm_alex", name: "Alex" },
    { id: "pm_santa", name: "Santa" },
  ],
  it: [
    { id: "if_sara", name: "Sara" },
    { id: "im_nicola", name: "Nicola" },
  ],
  hi: [
    { id: "hf_alpha", name: "Alpha" },
    { id: "hf_beta", name: "Beta" },
    { id: "hm_omega", name: "Omega" },
    { id: "hm_psi", name: "Psi" },
  ],
  ja: [
    { id: "jf_alpha", name: "Alpha" },
    { id: "jf_gongitsune", name: "Gongitsune" },
    { id: "jf_nezumi", name: "Nezumi" },
    { id: "jf_tebukuro", name: "Tebukuro" },
    { id: "jm_kumo", name: "Kumo" },
  ],
  cmn: [
    { id: "zf_xiaobei", name: "Xiaobei" },
    { id: "zf_xiaoni", name: "Xiaoni" },
    { id: "zf_xiaoxiao", name: "Xiaoxiao" },
    { id: "zf_xiaoyi", name: "Xiaoyi" },
    { id: "zm_yunjian", name: "Yunjian" },
    { id: "zm_yunxi", name: "Yunxi" },
    { id: "zm_yunxia", name: "Yunxia" },
    { id: "zm_yunyang", name: "Yunyang" },
  ],
};

// Language option list (value + i18n key suffix for the label).
export const LANGUAGES: { value: string; key: string }[] = [
  { value: "en-us", key: "enUs" },
  { value: "en-gb", key: "enGb" },
  { value: "es-419", key: "es" },
  { value: "pt-br", key: "ptBr" },
  { value: "it", key: "it" },
  { value: "hi", key: "hi" },
  { value: "ja", key: "ja" },
  { value: "cmn", key: "cmn" },
];

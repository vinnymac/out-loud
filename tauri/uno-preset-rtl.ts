import type { Preset } from "unocss";

// Lightweight RTL helpers (inspired by npmx.dev). presetWind4 already ships the
// logical-property utilities the app uses (ps/pe, ms/me, start/end, text-start,
// rounded-s/e, border-s/e), so this preset only adds the directional icon flip
// used for chevrons/arrows that must mirror under `dir="rtl"`.
export function presetRtl(): Preset {
  return {
    name: "rtl-preset",
    rules: [["rtl-flip", { transform: "scaleX(1)" }]],
    variants: [
      // `rtl-flip` flips horizontally only when an ancestor is dir="rtl".
      (matcher) => {
        if (!matcher.startsWith("rtl-flip")) return matcher;
        return {
          matcher,
          selector: (s) => `[dir="rtl"] ${s}`,
        };
      },
    ],
    preflights: [
      {
        getCSS: () => `[dir="rtl"] .rtl-flip{transform:scaleX(-1)}`,
      },
    ],
  };
}

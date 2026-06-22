import type { Theme } from "@unocss/preset-wind4/theme";

// Design tokens for Out Loud. Semantic colors are CSS custom properties (set in
// src/styles/main.css) so the palette lives in one place and the same token
// names work everywhere — mirrors the npmx.dev approach. The standard wind4
// palette (indigo/emerald/amber/rose/sky/gray) stays available on top of these.
export const theme = {
  font: {
    sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Inter", system-ui, sans-serif',
    mono: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
  },
  // Small, named sizes so the a11y preset can steer arbitrary px sizes here.
  text: {
    "2xs": { fontSize: "0.6875rem" }, // 11px
    "3xs": { fontSize: "0.625rem" }, // 10px
    "4xs": { fontSize: "0.5625rem" }, // 9px
    "5xs": { fontSize: "0.5rem" }, // 8px
  },
  colors: {
    bg: {
      DEFAULT: "var(--bg)",
      subtle: "var(--bg-subtle)",
      muted: "var(--bg-muted)",
      elevated: "var(--bg-elevated)",
    },
    fg: {
      DEFAULT: "var(--fg)",
      muted: "var(--fg-muted)",
      subtle: "var(--fg-subtle)",
    },
    border: {
      DEFAULT: "var(--border)",
      subtle: "var(--border-subtle)",
      hover: "var(--border-hover)",
    },
    accent: {
      DEFAULT: "var(--accent)",
      hover: "var(--accent-hover)",
      active: "var(--accent-active)",
    },
  },
  animation: {
    keyframes: {
      "fade-in": "{from { opacity: 0 } to { opacity: 1 }}",
      "scale-in":
        "{from { opacity: 0; transform: scale(0.97) } to { opacity: 1; transform: scale(1) }}",
    },
    durations: {
      "fade-in": "0.18s",
      "scale-in": "0.16s",
    },
    timingFns: {
      "fade-in": "ease-out",
      "scale-in": "cubic-bezier(0.22, 1, 0.36, 1)",
    },
  },
} satisfies Theme;

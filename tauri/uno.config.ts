import {
  defineConfig,
  presetIcons,
  presetWind4,
  transformerDirectives,
  transformerVariantGroup,
} from "unocss";
import { presetA11y } from "./uno-preset-a11y";
import { presetRtl } from "./uno-preset-rtl";
import { theme } from "./uno.theme";

export default defineConfig({
  presets: [
    presetWind4(),
    presetIcons({
      scale: 1.2,
      extraProperties: {
        display: "inline-block",
        "vertical-align": "middle",
      },
    }),
    presetRtl(),
    presetA11y(),
  ],
  transformers: [transformerDirectives(), transformerVariantGroup()],
  theme,
  shortcuts: [
    // Consistent, accessible focus ring (npmx convention).
    [
      "focus-ring",
      "outline-none focus-visible:(ring-2 ring-accent/50 ring-offset-2 ring-offset-bg)",
    ],
    // Neutral secondary button used for footer actions (?, Quit) and the like.
    [
      "btn-ghost",
      "cursor-pointer rounded-md border border-border bg-bg-elevated text-fg-muted transition-all duration-200 hover:(border-border-hover bg-bg-muted text-fg) focus-ring",
    ],
    // Primary action button (Play).
    [
      "btn-primary",
      "cursor-pointer rounded-md border-none bg-accent text-white font-medium shadow-lg shadow-accent/25 transition-all duration-200 hover:(bg-accent-hover shadow-accent/40) active:(bg-accent-active shadow-none) focus-ring",
    ],
    // Dark form field surface shared by the textarea and selects.
    [
      "field",
      "rounded-md border border-border bg-bg-subtle text-fg transition-all duration-200 hover:(border-border-hover bg-bg-muted) focus:outline-none disabled:(cursor-not-allowed opacity-50)",
    ],
  ],
});

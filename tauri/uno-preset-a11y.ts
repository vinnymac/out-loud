import type { Preset } from "unocss";

// Accessibility preset (ported from npmx.dev). Warns when a component reaches
// for an arbitrary font size like `text-[11px]` and points it at the named
// token (`text-2xs`) so small text stays consistent and legible. The class
// still resolves — this nudges, it doesn't break the build.
const warnedClasses = new Set<string>();

function warnOnce(message: string, key: string) {
  if (!warnedClasses.has(key)) {
    warnedClasses.add(key);
    console.warn(message);
  }
}

const textPxToClass: Record<number, string> = {
  11: "text-2xs",
  10: "text-3xs",
  9: "text-4xs",
  8: "text-5xs",
};

export function presetA11y(): Preset {
  return {
    name: "a11y-preset",
    rules: [
      [
        /^text-\[(\d+(\.\d+)?)(px)?\]$/,
        ([match, numStr], context) => {
          const num = Number(numStr);
          const fullClass = context.rawSelector || match;
          const suggested = textPxToClass[num];
          warnOnce(
            suggested
              ? `[a11y] Avoid '${fullClass}', use '${suggested}' instead.`
              : `[a11y] Avoid '${fullClass}', use a named text-<size> token or rem value instead.`,
            fullClass
          );
          return [["font-size", `${num}px`]];
        },
        { autocomplete: "text-[<num>]" },
      ],
    ],
  };
}

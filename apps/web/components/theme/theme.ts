/**
 * Finsol Enterprises is light only, day and night, whatever the operating
 * system prefers: app/layout.tsx renders data-theme="light" and nothing
 * switches it. Kept as a module so theme-aware code (the WebGL route field)
 * has one place to ask.
 */
export type Theme = "light";

export const THEME: Theme = "light";

/** The page background colour, for browser chrome and canvases. */
export const THEME_CHROME: Record<Theme, string> = { light: "#F3F6FA" };

/** Always "light". */
export function useTheme(): Theme {
  return THEME;
}

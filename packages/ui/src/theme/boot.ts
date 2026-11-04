/** The localStorage key the boot script reads and the theme controller writes. */
export const THEME_STORAGE_KEY = "kantel.theme";
/**
 * The key before the rename. It is read only when the new key isn't there, and the controller then writes the new key.
 */
export const LEGACY_THEME_STORAGE_KEY = "harbour.theme"; // before the rename

/** What a person sees until they choose: the device's light or dark (Tom, 3 Nov 2026). */
export const DEFAULT_THEME_PREFERENCE = "system" as const;

/**
 * The script a host puts inline in its page's <head>, before any stylesheet or bundle, so the page's first paint is
 * already in the person's theme: it reads what this browser remembers (controller.ts, `ThemeCache`), works out light
 * or dark (System follows `prefers-color-scheme`) and sets `data-kt-theme` on <html>. Both themes' colours are in the
 * page's stylesheet (dark.css, light.css), so that is all it does. Nothing remembered, or anything unexpected, and the
 * page follows the device, the default (`DEFAULT_THEME_PREFERENCE`). A few hundred bytes, no network.
 *
 * A choice remembered before Kantel had only light and dark (version 1, a theme's ID with its CSS) paints as the kind
 * of theme it was, by the `color-scheme` in that CSS; the controller then migrates it for good (`themePreference`).
 *
 * The console adds it with a Vite plugin (apps/console/vite.config.ts). Another host can do the same, or write
 * `<script>${themeBootScript}</script>` into its HTML.
 */
export const themeBootScript = `(function(){var p=${JSON.stringify(DEFAULT_THEME_PREFERENCE)};try{var r=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});if(r===null)r=localStorage.getItem(${JSON.stringify(LEGACY_THEME_STORAGE_KEY)});var c=JSON.parse(r||"null");if(c&&c.v===2&&(c.preference==="light"||c.preference==="dark"||c.preference==="system"))p=c.preference;else if(c&&c.v===1&&typeof c.preference==="string"){if(c.preference==="system")p="system";else{var css=c.css&&c.css[c.preference];if(typeof css==="string")p=/color-scheme:\\s*light/.test(css)?"light":"dark"}}}catch(e){}try{if(p==="system")p=matchMedia("(prefers-color-scheme: light)").matches?"light":"dark";document.documentElement.setAttribute("data-kt-theme",p)}catch(e){}})();`;

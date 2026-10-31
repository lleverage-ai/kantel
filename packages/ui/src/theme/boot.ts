/** The localStorage key the boot script reads and the theme controller writes. */
export const THEME_STORAGE_KEY = "kantel.theme";
/**
 * The key before the rename (TASK-4231). Its CSS sets `--hb-*` tokens on `[data-hb-theme]`, which nothing reads now:
 * it is read only when the new key isn't there, through `legacyThemeCss`, and the controller then writes the new key.
 */
export const LEGACY_THEME_STORAGE_KEY = "harbour.theme";

/**
 * A theme rule written before the rename, in today's names: `--hb-*` tokens become `--kt-*`, and the selectors on
 * `data-hb-theme` and `.hb-theme` (before the rename) `data-kt-theme` and `.kt-theme`. The boot script does the same.
 */
export const legacyThemeCss = (css: string): string =>
	css
		.replace(/--hb-/g, "--kt-")
		.replace(/data-hb-theme/g, "data-kt-theme")
		.replace(/\.hb-theme\b/g, ".kt-theme");

/** What the boot script adds: a copy of the remembered theme's rule, until the controller's stylesheet replaces it. */
export const BOOT_STYLE_ID = "kt-theme-boot";

/**
 * The script a host puts inline in its page's <head>, before any stylesheet or bundle, so the page's first paint is
 * already in the person's theme: it reads what this browser remembers (controller.ts, `ThemeCache`), adds the theme's
 * CSS rule and sets `data-kt-theme` on <html>. Nothing remembered, or anything unexpected, and it does nothing: the
 * page paints in Kantel, tokens.css's own values. A few hundred bytes, no network.
 *
 * The console adds it with a Vite plugin (apps/console/vite.config.ts). Another host can do the same, or write
 * `<script>${themeBootScript}</script>` into its HTML.
 */
export const themeBootScript = `(function(){try{var r=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)}),o=r===null;if(o)r=localStorage.getItem(${JSON.stringify(LEGACY_THEME_STORAGE_KEY)});var c=JSON.parse(r||"null");if(!c||c.v!==1)return;var id=c.preference==="system"?(matchMedia("(prefers-color-scheme: light)").matches?c.light:c.dark):c.preference;var css=c.css&&c.css[id];if(typeof css!=="string")return;if(o)css=css.replace(/--hb-/g,"--kt-").replace(/data-hb-theme/g,"data-kt-theme").replace(/\\.hb-theme\\b/g,".kt-theme");var s=document.createElement("style");s.id=${JSON.stringify(BOOT_STYLE_ID)};s.textContent=css;document.head.appendChild(s);document.documentElement.setAttribute("data-kt-theme",id)}catch(e){}})();`;

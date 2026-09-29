export const THEME_STORAGE_KEY = "genex-theme";

/** Runs before first paint (inlined in <head>) so the page never flashes
 * the wrong theme. Falls back to the operating system preference. */
export const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem("${THEME_STORAGE_KEY}");if(t!=="light"&&t!=="dark"){t=window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"}document.documentElement.dataset.theme=t}catch(e){document.documentElement.dataset.theme="light"}})();`;

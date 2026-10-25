// Applies the dark token set (.dark in index.css) before first paint. The stored choice
// (localStorage "rt-theme": light | dark, absent = system) wins; otherwise the OS preference
// decides. Loaded as a blocking external script so it runs under the server CSP
// (default-src 'self', no inline scripts). Keep the key in sync with src/lib/theme.ts.
try {
  var stored = null;
  try {
    stored = localStorage.getItem("rt-theme");
  } catch (e) {
    // storage blocked: fall through to the OS preference.
  }
  var dark =
    stored === "dark" ||
    (stored !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  if (dark) document.documentElement.classList.add("dark");
} catch (e) {
  // matchMedia unavailable: stay light.
}

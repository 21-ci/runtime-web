// Applies the dark token set (.dark in index.css) before first paint when the
// OS prefers dark. Loaded as a blocking external script so it runs under
// the server CSP (default-src 'self', no inline scripts).
try {
  if (window.matchMedia("(prefers-color-scheme: dark)").matches) {
    document.documentElement.classList.add("dark");
  }
} catch (e) {
  // matchMedia unavailable: stay light.
}

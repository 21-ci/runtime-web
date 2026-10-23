import { useRuntimeStatus } from "@/lib/runtime-status";

// RuntimeStatusBanner explains that the runtime is busy or unreachable. It is not an error of
// the user's app, so it does not name any app. It stays out of layout when there is no problem.
function RuntimeStatusBanner() {
  const status = useRuntimeStatus();
  if (!status) return null;
  const text =
    status === "busy"
      ? "The runtime is busy. Retry in a moment."
      : "The runtime is unreachable. Changes are not applied until it recovers.";
  return (
    <div role="status" className="border-b border-line bg-panel-2 px-4 py-2 text-center text-sm text-text">
      {text}
    </div>
  );
}

export { RuntimeStatusBanner };

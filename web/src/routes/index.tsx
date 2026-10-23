import { createFileRoute } from "@tanstack/react-router";

// Placeholder home until the org and app pages land (Tasks 14-15).
function HomePage() {
  return (
    <main className="flex min-h-dvh items-center justify-center p-6">
      <h1 className="text-lg font-semibold">Runtime Console</h1>
    </main>
  );
}

export const Route = createFileRoute("/")({
  component: HomePage,
});

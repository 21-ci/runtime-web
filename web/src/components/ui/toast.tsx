import { Toaster as SonnerToaster, type ToasterProps } from "sonner";

// Toaster is mounted once in main.tsx. Import `toast` from "sonner" where it is called.
function Toaster(props: ToasterProps) {
  return (
    <SonnerToaster
      theme="system"
      position="bottom-right"
      closeButton
      toastOptions={{
        classNames: {
          toast: "rounded-2xl border border-line bg-surface text-text shadow-menu",
          description: "text-muted",
          actionButton: "rounded-full bg-accent text-on-primary",
          cancelButton: "rounded-full bg-secondary text-text",
        },
      }}
      {...props}
    />
  );
}

export { Toaster };

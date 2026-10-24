import { Toaster as SonnerToaster, type ToasterProps } from "sonner";

// Toaster is mounted once in the root route. Import `toast` from "sonner" where it is called.
function Toaster(props: ToasterProps) {
  return (
    <SonnerToaster
      theme="system"
      position="bottom-right"
      closeButton
      toastOptions={{
        classNames: {
          toast: "rounded-lg border border-line bg-surface-2 text-text shadow-menu",
          description: "text-muted",
          actionButton: "rounded-md bg-accent text-on-primary",
          cancelButton: "rounded-md bg-secondary text-text",
        },
      }}
      {...props}
    />
  );
}

export { Toaster };

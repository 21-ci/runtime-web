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
          toast: "border border-line bg-surface text-text shadow-lg",
          description: "text-muted",
          actionButton: "bg-blue text-white",
          cancelButton: "bg-panel-2 text-text",
        },
      }}
      {...props}
    />
  );
}

export { Toaster };

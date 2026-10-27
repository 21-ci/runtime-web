# Editor

The editor changes an app's code in the browser. Saving it stores a new version of the code. Deploying is a separate
step.

## Files

The file tree lists the app's source files. Create, rename and delete files from the tree. Opening a file opens it in
the editor.

## Save

- **Save**, or `Ctrl`/`Cmd` + `S`, stores and builds a new version of the code. Saving does not deploy it: the toolbar
  shows **Saved vN (not live)**.
- **Deploy vN** makes the saved version live. It appears when the newest saved version built and is not live yet.
- The editor opens the newest saved version, even when an older one is live.
- The editor sends the app version it loaded. If someone changed the app in the meantime, the save is refused with a
  conflict. Reload to get their changes, then reapply yours.
- A save that fails the build is refused, and the console shows the build error. The live version is unchanged.
- The preview pane always shows the live version. Deploy to see saved changes there.

## Type checking

TypeScript files are checked against the runtime's guest API as you edit. Type errors are reported in the editor. The
type checker loads only when you open the editor.

## Read-only access

Viewers can read the code but cannot save.

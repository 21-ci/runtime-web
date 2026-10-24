# Editor

The editor changes an app's code in the browser. Saving it stores a new version of the code. Deploying is a separate
step.

## Files

The file tree lists the app's source files. Create, rename and delete files from the tree. Opening a file opens it in
the editor.

## Save

- **Save**, or `Ctrl`/`Cmd` + `S`, stores a new version of the code. Saving does not deploy it.
- The editor sends the version it loaded. If someone saved a newer version in the meantime, the save is refused with a
  conflict. Reload to get their changes, then reapply yours.
- A save that fails the build is refused, and the console shows the build error.

## Type checking

TypeScript files are checked against the runtime's guest API as you edit. Type errors are reported in the editor. The
type checker loads only when you open the editor.

## Read-only access

Viewers can read the code but cannot save.

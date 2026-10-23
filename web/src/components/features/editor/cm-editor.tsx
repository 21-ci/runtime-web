// Lazily loaded: the only module (with its cm-* siblings) that imports CodeMirror.
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import { bracketMatching, defaultHighlightStyle, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { linter, lintGutter, lintKeymap, setDiagnostics, type Diagnostic as CmDiagnostic } from "@codemirror/lint";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { EditorState } from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { useEffect, useRef } from "react";

import type { Diagnostic } from "./hooks";
import { tsDiagnostics } from "./ts-client";

export type CodeEditorProps = {
  path: string;
  value: string;
  readOnly: boolean;
  onChange: (text: string) => void;
  onSave: () => void;
  // Server (build) diagnostics for this file.
  diagnostics: Diagnostic[];
  // All current files, for cross-file type checks.
  getFiles: () => Record<string, string>;
};

const theme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "var(--color-panel)", color: "var(--color-text)", fontSize: "13px" },
  "&.cm-focused": { outline: "2px solid var(--color-focus)" },
  ".cm-gutters": { backgroundColor: "var(--color-panel-2)", color: "var(--color-muted)", border: "none" },
  ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "var(--color-blue-pale)" },
  ".cm-content": { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", caretColor: "var(--color-text)" },
});

function toCm(state: EditorState, diags: Diagnostic[]): CmDiagnostic[] {
  return diags.map((d) => {
    const line = state.doc.line(Math.min(Math.max(d.line ?? 1, 1), state.doc.lines));
    const from = Math.min(line.from + Math.max((d.column ?? 1) - 1, 0), line.to);
    return {
      from,
      to: Math.max(from, line.to),
      severity: d.severity === "warning" ? "warning" : "error",
      message: d.message,
      source: "build",
    };
  });
}

export default function CodeEditor(props: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const latest = useRef(props);
  useEffect(() => {
    latest.current = props;
  });

  const { path, readOnly } = props;
  useEffect(() => {
    if (!host.current) return;
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: latest.current.value,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          drawSelection(),
          history(),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          autocompletion(),
          highlightSelectionMatches(),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          javascript({ typescript: /\.tsx?$/.test(path), jsx: /x$/.test(path) }),
          keymap.of([
            {
              key: "Mod-s",
              preventDefault: true,
              run: () => {
                latest.current.onSave();
                return true;
              },
            },
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...searchKeymap,
            ...historyKeymap,
            ...completionKeymap,
            ...lintKeymap,
          ]),
          lintGutter(),
          linter(
            async (ed) => {
              const files = { ...latest.current.getFiles(), [path]: ed.state.doc.toString() };
              const ts = await tsDiagnostics(path, files);
              const len = ed.state.doc.length;
              return ts.map((d) => ({ ...d, from: Math.min(d.from, len), to: Math.min(d.to, len), source: "ts" }));
            },
            { delay: 500 },
          ),
          EditorState.readOnly.of(readOnly),
          EditorView.editable.of(!readOnly),
          EditorView.contentAttributes.of({
            "aria-label": `Code editor: ${path}`,
            role: "textbox",
            "aria-multiline": "true",
            "aria-readonly": String(readOnly),
          }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) latest.current.onChange(u.state.doc.toString());
          }),
          theme,
        ],
      }),
    });
    view.current = v;
    return () => {
      v.destroy();
      view.current = null;
    };
  }, [path, readOnly]);

  // External replacement (reload after a stale save).
  const { value, diagnostics } = props;
  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== value) {
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
    }
  }, [value]);

  useEffect(() => {
    const v = view.current;
    if (v) v.dispatch(setDiagnostics(v.state, toCm(v.state, diagnostics)));
  }, [diagnostics, path, readOnly]);

  return <div ref={host} className="h-full min-h-[320px] overflow-auto rounded-md border border-line" />;
}

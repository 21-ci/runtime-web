// Lazily loaded: the only module (with its cm-* siblings) that imports CodeMirror.
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import { bracketMatching, HighlightStyle, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { linter, lintGutter, lintKeymap, setDiagnostics, type Diagnostic as CmDiagnostic } from "@codemirror/lint";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState } from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

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

// The editor reads every colour from the design tokens, so it follows the light and dark themes.
const theme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "var(--color-bg)", color: "var(--color-text)", fontSize: "13px" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { lineHeight: "1.65" },
  ".cm-gutters": { backgroundColor: "var(--color-bg)", color: "var(--color-muted)", border: "none", paddingLeft: "6px" },
  ".cm-activeLine": { backgroundColor: "var(--color-hover)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--color-text)" },
  ".cm-content": { fontFamily: "var(--font-mono)", caretColor: "var(--color-text)", padding: "8px 0" },
  ".cm-line": { padding: "0 12px" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": { backgroundColor: "var(--color-accent-soft) !important" },
  ".cm-selectionMatch": { backgroundColor: "var(--color-active)" },
  ".cm-matchingBracket": { backgroundColor: "var(--color-active)", outline: "1px solid var(--color-line-strong)" },
  ".cm-tooltip": { backgroundColor: "var(--color-surface-2)", border: "1px solid var(--color-line)", borderRadius: "6px", boxShadow: "var(--shadow-menu)", color: "var(--color-text)" },
  ".cm-tooltip-autocomplete ul li[aria-selected]": { backgroundColor: "var(--color-hover)", color: "var(--color-text)" },
  ".cm-lintRange-error": { backgroundImage: "none", textDecoration: "underline wavy var(--color-danger)" },
  ".cm-lintRange-warning": { backgroundImage: "none", textDecoration: "underline wavy var(--color-tag-yellow-solid)" },
});

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.controlKeyword, t.operatorKeyword, t.definitionKeyword], color: "var(--color-tag-purple-text)" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "var(--color-tag-green-text)" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "var(--color-tag-orange-text)" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "var(--color-muted)", fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "var(--color-tag-blue-text)" },
  { tag: [t.propertyName, t.attributeName], color: "var(--color-tag-teal-text)" },
  { tag: [t.typeName, t.className, t.namespace], color: "var(--color-tag-yellow-text)" },
  { tag: [t.variableName, t.definition(t.variableName)], color: "var(--color-text)" },
  { tag: [t.operator, t.punctuation, t.bracket], color: "var(--color-muted)" },
  { tag: t.invalid, color: "var(--color-danger-text)" },
]);

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
  const { t } = useTranslation("editor");
  // The label lives in a compartment so a language change relabels the editor without
  // recreating it (which would drop undo history and the cursor).
  const labels = useRef(new Compartment());
  const label = t("editor.label", { path });
  const latestLabel = useRef(label);
  latestLabel.current = label;
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
          syntaxHighlighting(highlight),
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
          labels.current.of(EditorView.contentAttributes.of({ "aria-label": latestLabel.current })),
          EditorView.contentAttributes.of({
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

  useEffect(() => {
    view.current?.dispatch({
      effects: labels.current.reconfigure(EditorView.contentAttributes.of({ "aria-label": label })),
    });
  }, [label]);

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

  return <div ref={host} className="h-full min-h-[320px] overflow-auto" />;
}

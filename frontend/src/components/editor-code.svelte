<script lang="ts">
  /*
   * bulk of the code is initialization and a handful of helper classes for inline
   * widgets and decorations.
   */
  import { onMount, createEventDispatcher } from "svelte";
  import {
    EditorView,
    Decoration,
    WidgetType,
    keymap,
    lineNumbers,
    type DecorationSet,
  } from "@codemirror/view";
  import {
    EditorState,
    StateField,
    StateEffect,
    RangeSetBuilder,
    type Extension,
  } from "@codemirror/state";
  import {
    history,
    undo,
    redo,
    historyKeymap,
    standardKeymap,
  } from "@codemirror/commands";
  import {
    apiUploadFile,
    editorAPI,
    isStorageLimitError,
    type UploadedFile,
  } from "../lib/core";
  import ContextMenu from "./context-menu.svelte";

  export let roomId: string = "";
  export let files: UploadedFile[] = [];
  export let now: number = Date.now();

  const dispatch = createEventDispatcher<{
    change: {
      changes: Array<{
        range: {
          startLineNumber: number;
          startColumn: number;
          endLineNumber: number;
          endColumn: number;
        };
        text: string;
      }>;
      fullContent: string;
    };
    filePasted: {
      filename: string;
      url: string;
      sizeBytes: number;
      deleteAt: number;
    };
    fileSizeError: void;
    fileLimitError: void;
    onClearNote: void;
  }>();

  let container: HTMLDivElement;
  let viewRef: EditorView | null = null;
  // flag to suppress change events when we apply edits coming from the server
  let isRemoteUpdate = false;

  let contextMenuVisible = false;
  let contextMenuX = 0;
  let contextMenuY = 0;

  // Line Widgets (Download, Expiry Timer, Drag Hint)
  // simple inline badge used for timers and status markers
  class BadgeWidget extends WidgetType {
    constructor(
      readonly label: string,
      readonly cls: string,
    ) {
      super();
    }
    eq(other: BadgeWidget) {
      return other.label === this.label && other.cls === this.cls;
    }
    toDOM() {
      const span = document.createElement("span");
      span.className = this.cls;
      span.textContent = this.label;
      return span;
    }
    // don't let the widget steal click events
    ignoreEvent() {
      return true;
    }
  }

  // widget showing a clickable download badge for file URLs
  class DownloadBadgeWidget extends WidgetType {
    constructor(readonly url: string) {
      super();
    }
    eq(other: DownloadBadgeWidget) {
      return other.url === this.url;
    }
    toDOM() {
      const span = document.createElement("span");
      span.className = "file-badge-download";
      span.textContent = "↓ dl";
      span.addEventListener("click", () => {
        // create temporary anchor to trigger download
        const a = document.createElement("a");
        a.href = this.url;
        a.download = "";
        a.style.display = "none";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      });
      return span;
    }
    ignoreEvent() {
      return true;
    }
  }

  // inline prompt shown while dragging a file over the editor
  class DragHintWidget extends WidgetType {
    constructor(readonly lineNum: number) {
      super();
    }
    eq(other: DragHintWidget) {
      return other.lineNum === this.lineNum;
    }
    toDOM() {
      const span = document.createElement("span");
      span.className = "drop-hint-inline";
      span.textContent = `Drop file on line ${this.lineNum}`;
      return span;
    }
    ignoreEvent() {
      return true;
    }
  }

  const setDragPosEffect = StateEffect.define<{
    pos: number;
    lineNum: number;
  } | null>();

  // state field tracking the current drag hint decoration
  const dragHintField = StateField.define<DecorationSet>({
    create() {
      return Decoration.none;
    },
    update(decos, tr) {
      for (const e of tr.effects) {
        if (e.is(setDragPosEffect)) {
          if (e.value === null) return Decoration.none;
          return Decoration.set([
            Decoration.widget({
              widget: new DragHintWidget(e.value.lineNum),
              side: -1,
            }).range(e.value.pos),
          ]);
        }
      }
      return decos.map(tr.changes);
    },
    provide: (f) => EditorView.decorations.from(f),
  });

  interface FileDecoState {
    files: UploadedFile[];
    now: number;
  }

  const setFilesEffect = StateEffect.define<FileDecoState>();

  // decorations representing file links and timers in the document
  const fileDecoField = StateField.define<{
    data: FileDecoState;
    decos: DecorationSet;
  }>({
    create() {
      return { data: { files: [], now: Date.now() }, decos: Decoration.none };
    },
    update(value, tr) {
      let data = value.data;
      for (const e of tr.effects) {
        if (e.is(setFilesEffect)) data = e.value;
      }
      if (!tr.docChanged && data === value.data) return value;
      return { data, decos: buildDecos(tr.state, data) };
    },
    provide: (f) => EditorView.decorations.from(f, (v) => v.decos),
  });

  function buildDecos(
    state: EditorState,
    { files: currentFiles, now: currentNow }: FileDecoState,
  ) {
    const builder = new RangeSetBuilder<Decoration>();
    for (let i = 1; i <= state.doc.lines; i++) {
      const line = state.doc.line(i);
      const text = line.text;
      if (!text.includes("/api/files/")) continue;
      const matchingFile = currentFiles.find((f) => text.includes(f.url));
      if (!matchingFile) continue;

      const ms = Math.max(0, matchingFile.deleteAt - currentNow);
      const expired = ms === 0;

      // Line background + left border gutter via CSS class on the <div.cm-line>
      builder.add(
        line.from,
        line.from,
        Decoration.line({
          class: expired ? "file-line-expired" : "file-line-active",
        }),
      );

      // constrained to the URL characters only
      const urlMatch = text.match(/(https?:\/\/[^\s]+\/api\/files\/[^\s]+)/);
      if (urlMatch && urlMatch.index !== undefined) {
        const urlFrom = line.from + urlMatch.index;
        const urlTo = urlFrom + urlMatch[0].length;
        builder.add(
          urlFrom,
          urlTo,
          Decoration.mark({ class: "file-link-text" }),
        );

        if (!expired) {
          builder.add(
            urlTo,
            urlTo,
            Decoration.widget({
              widget: new DownloadBadgeWidget(urlMatch[0]),
              side: 1,
            }),
          );
        }

        if (expired) {
          builder.add(
            urlTo,
            urlTo,
            Decoration.widget({
              widget: new BadgeWidget(" expired ", "file-badge-expired"),
              side: 1,
            }),
          );
        } else {
          const mins = Math.floor(ms / 60000);
          const secs = String(Math.floor((ms % 60000) / 1000)).padStart(2, "0");
          const badgeCls =
            ms < 60000 ? "file-badge-warning" : "file-badge-active";
          builder.add(
            urlTo,
            urlTo,
            Decoration.widget({
              widget: new BadgeWidget(` ${mins}:${secs} `, badgeCls),
              side: 1,
            }),
          );
        }
      }
    }
    return builder.finish();
  }

  // emit an effect to refresh file-related decorations; invoked reactively
  function updateFileDecorations(
    currentFiles: UploadedFile[],
    currentNow: number,
  ) {
    if (!viewRef) return;
    viewRef.dispatch({
      effects: setFilesEffect.of({ files: currentFiles, now: currentNow }),
    });
  }

  // whenever `files` or `now` change, recalc decorations
  $: if (viewRef) updateFileDecorations(files, now);

  // Offset helpers
  // helpers for converting between line/column and document offsets
  function posToOffset(
    state: EditorState,
    lineNumber: number,
    column: number,
  ): number {
    const line = state.doc.line(Math.min(lineNumber, state.doc.lines));
    return Math.min(line.from + column - 1, line.to);
  }

  function offsetToLineCol(state: EditorState, offset: number) {
    const line = state.doc.lineAt(offset);
    return { lineNumber: line.number, column: offset - line.from + 1 };
  }

  onMount(() => {
    // accumulate edits locally so we can batch them in a single `change`
    // event; reset after 500 ms of inactivity.
    let saveTimer: number | null = null;
    let pendingChanges: Array<{
      range: {
        startLineNumber: number;
        startColumn: number;
        endLineNumber: number;
        endColumn: number;
      };
      text: string;
    }> = [];

    const darkTheme = EditorView.theme(
      {
        "&": {
          background: "#0a0a0a",
          color: "#f5f5f5",
          height: "100%",
          fontFamily: '"JetBrains Mono", "Fira Mono", Menlo, monospace',
          fontSize: "14px",
        },
        ".cm-content": {
          padding: "16px 0",
          caretColor: "#f5f5f5",
          lineHeight: "22px",
        },
        ".cm-line": {
          padding: "0 16px 0 0",
          lineHeight: "22px",
          minHeight: "22px",
        },
        ".cm-gutters": {
          background: "#0a0a0a",
          border: "none",
          color: "#303030",
          paddingRight: "4px",
          minWidth: "40px",
        },
        ".cm-lineNumbers .cm-gutterElement": {
          padding: "0 8px",
          minWidth: "32px",
          textAlign: "right",
        },
        ".cm-cursor": {
          borderLeftColor: "#f5f5f5",
        },
        "& .cm-content ::selection": {
          background: "rgba(38, 79, 120, 0.7)",
          color: "inherit",
        },
        ".cm-activeLine": {
          background: "transparent",
        },
        ".cm-activeLineGutter": {
          background: "transparent",
          color: "#606060",
        },
        ".cm-scroller": {
          overflow: "auto",
          fontFamily: '"JetBrains Mono", "Fira Mono", Menlo, monospace',
        },
      },
      { dark: true },
    );

    // listener that watches document changes and queues them for the
    // parent via the `change` event.  `isRemoteUpdate` prevents echoing edits
    // we ourselves programmatically apply.
    const updateListener = EditorView.updateListener.of((update) => {
      if (!update.docChanged || isRemoteUpdate) return;
      update.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
        const startLC = offsetToLineCol(update.startState, fromA);
        const endLC = offsetToLineCol(update.startState, toA);
        pendingChanges.push({
          range: {
            startLineNumber: startLC.lineNumber,
            startColumn: startLC.column,
            endLineNumber: endLC.lineNumber,
            endColumn: endLC.column,
          },
          text: inserted.toString(),
        });
      });
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = window.setTimeout(() => {
        const changes = pendingChanges;
        pendingChanges = [];
        dispatch("change", {
          changes,
          fullContent: update.view.state.doc.toString(),
        });
      }, 500);
    });

    const domHandlers = EditorView.domEventHandlers({
      copy(_e, view) {
        const sel = view.state.selection.main;
        if (!sel.empty) {
          const text = view.state.sliceDoc(sel.from, sel.to);
          if (text)
            window.dispatchEvent(
              new CustomEvent("synclippy:copy", { detail: text }),
            );
        }
        return false; // allow default behavior as well
      },
      cut(_e, view) {
        const sel = view.state.selection.main;
        if (!sel.empty) {
          const text = view.state.sliceDoc(sel.from, sel.to);
          if (text)
            window.dispatchEvent(
              new CustomEvent("synclippy:copy", { detail: text }),
            );
        }
        return false;
      },
      contextmenu(e) {
        e.preventDefault();
        contextMenuX = e.clientX;
        contextMenuY = e.clientY;
        contextMenuVisible = true;
        return true;
      },
      mousedown(e, view) {
        const isMeta = e.ctrlKey || e.metaKey;
        if (!isMeta) return false;
        const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
        if (pos === null) return false;
        const line = view.state.doc.lineAt(pos);
        const urlMatch = line.text.match(
          /(https?:\/\/[^\s]+\/api\/files\/[^\s]+)/,
        );
        if (urlMatch) {
          e.preventDefault();
          window.open(urlMatch[1], "_blank", "noopener");
          return true;
        }
        return false;
      },
      mousemove(e, view) {
        const isMeta = e.ctrlKey || e.metaKey;
        if (!isMeta) {
          (view.dom as HTMLElement).style.cursor = "";
          return false;
        }
        const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
        if (pos === null) {
          (view.dom as HTMLElement).style.cursor = "";
          return false;
        }
        const line = view.state.doc.lineAt(pos);
        (view.dom as HTMLElement).style.cursor = line.text.includes(
          "/api/files/",
        )
          ? "pointer"
          : "";
        return false;
      },
    });

    // intercept paste events to upload files rather than inserting binary data
    function handlePaste(e: ClipboardEvent) {
      if (!viewRef?.hasFocus) return;
      if (!e.clipboardData) return;
      const items = Array.from(e.clipboardData.items);
      const mediaItem = items.find((i) => i.kind === "file");
      if (!mediaItem) return;
      e.preventDefault();
      e.stopPropagation();
      const file = mediaItem.getAsFile();
      if (!file) return;
      if (file.size > 50 * 1024 * 1024) {
        dispatch("fileSizeError");
        return;
      }
      apiUploadFile(roomId, file)
        .then((result) => {
          if (!viewRef) return;
          const fullUrl = window.location.origin + result.url;
          const sel = viewRef.state.selection.main;
          viewRef.dispatch({
            changes: { from: sel.from, to: sel.to, insert: fullUrl + "\n" },
            selection: { anchor: sel.from + fullUrl.length + 1 },
          });
          dispatch("filePasted", result);
        })
        .catch((err: any) => {
          if (isStorageLimitError(err)) {
            dispatch("fileLimitError");
          } else {
            console.error("Upload failed", err);
          }
        });
    }
    document.addEventListener("paste", handlePaste, true);

    const extraKeymap = keymap.of([
      {
        key: "F1",
        run() {
          window.dispatchEvent(new CustomEvent("synclippy:openpalette"));
          return true;
        },
      },
    ]);

    // assemble CM extensions and create the view
    const extensions: Extension[] = [
      darkTheme,
      history(),
      lineNumbers(),
      EditorView.lineWrapping,
      keymap.of([...standardKeymap, ...historyKeymap]),
      extraKeymap,
      fileDecoField,
      dragHintField,
      updateListener,
      domHandlers,
    ];

    const view = new EditorView({
      state: EditorState.create({ doc: "", extensions }),
      parent: container,
    });
    viewRef = view;

    // native listeners on view.dom (more reliable than domEventHandlers)
    function onDragOver(e: DragEvent) {
      e.preventDefault();
      const raw = view.posAtCoords({ x: e.clientX, y: e.clientY }) ?? 0;
      const line = view.state.doc.lineAt(raw);
      view.dispatch({
        effects: setDragPosEffect.of({ pos: line.from, lineNum: line.number }),
      });
    }
    function onDragLeave() {
      view.dispatch({ effects: setDragPosEffect.of(null) });
    }
    function onDrop() {
      view.dispatch({ effects: setDragPosEffect.of(null) });
    }
    view.dom.addEventListener("dragover", onDragOver);
    view.dom.addEventListener("dragleave", onDragLeave);
    view.dom.addEventListener("drop", onDrop);

    function applyRemoteEdits(
      edits: Array<{
        range: {
          startLineNumber: number;
          startColumn: number;
          endLineNumber: number;
          endColumn: number;
        };
        text: string;
      }>,
    ) {
      if (!viewRef) return;
      isRemoteUpdate = true;
      try {
        const changes = edits.map((op) => ({
          from: posToOffset(
            viewRef!.state,
            op.range.startLineNumber,
            op.range.startColumn,
          ),
          to: posToOffset(
            viewRef!.state,
            op.range.endLineNumber,
            op.range.endColumn,
          ),
          insert: op.text,
        }));
        viewRef.dispatch({ changes });
      } finally {
        isRemoteUpdate = false;
      }
    }

    // replace entire document with minimal diff to avoid cursor jumps
    function setValueRemote(newContent: string) {
      if (!viewRef) return;
      const current = viewRef.state.doc.toString();
      if (current === newContent) return;
      isRemoteUpdate = true;
      try {
        const minLen = Math.min(current.length, newContent.length);
        let prefixLen = 0;
        while (
          prefixLen < minLen &&
          current[prefixLen] === newContent[prefixLen]
        )
          prefixLen++;
        let suffixLen = 0;
        while (
          suffixLen < minLen - prefixLen &&
          current[current.length - 1 - suffixLen] ===
            newContent[newContent.length - 1 - suffixLen]
        )
          suffixLen++;
        viewRef.dispatch({
          changes: {
            from: prefixLen,
            to: current.length - suffixLen,
            insert: newContent.slice(prefixLen, newContent.length - suffixLen),
          },
        });
      } finally {
        isRemoteUpdate = false;
      }
    }

    // editorAPI store
    editorAPI.set({
      getValue: () => view.state.doc.toString(),
      setValue: (v: string) => setValueRemote(v),
      setValueForce: (v: string) => {
        isRemoteUpdate = true;
        try {
          view.dispatch({
            changes: { from: 0, to: view.state.doc.length, insert: v },
          });
        } finally {
          isRemoteUpdate = false;
        }
      },
      applyRemoteEdits,
      focus: () => view.focus(),
      insertText: (text: string) => {
        const sel = view.state.selection.main;
        view.dispatch({
          changes: { from: sel.from, to: sel.to, insert: text },
          selection: { anchor: sel.from + text.length },
        });
        view.focus();
      },
      appendText: (text: string) => {
        const doc = view.state.doc;
        const end = doc.length;
        const current = doc.toString();
        const prefix =
          current.length > 0 && !current.endsWith("\n") ? "\n" : "";
        const insert = prefix + text;
        view.dispatch({
          changes: { from: end, to: end, insert },
          selection: { anchor: end + insert.length },
        });
        view.focus();
      },
      undo: () => {
        undo(view);
      },
      redo: () => {
        redo(view);
      },
      getSelectedText: () => {
        const sel = view.state.selection.main;
        if (sel.empty) return "";
        return view.state.sliceDoc(sel.from, sel.to);
      },
      selectAll: () => {
        view.dispatch({
          selection: { anchor: 0, head: view.state.doc.length },
        });
        view.focus();
      },
      scrollToBottom: () => {
        const end = view.state.doc.length;
        view.dispatch({ selection: { anchor: end } });
        view.requestMeasure();
      },
    });

    return () => {
      document.removeEventListener("paste", handlePaste, true);
      view.dom.removeEventListener("dragover", onDragOver);
      view.dom.removeEventListener("dragleave", onDragLeave);
      view.dom.removeEventListener("drop", onDrop);
      if (saveTimer) clearTimeout(saveTimer);
      view.destroy();
      viewRef = null;
      editorAPI.set(null);
    };
  });
</script>

<div bind:this={container} class="absolute inset-0 overflow-hidden"></div>

{#if contextMenuVisible}
  <ContextMenu
    x={contextMenuX}
    y={contextMenuY}
    onClose={() => {
      contextMenuVisible = false;
      viewRef?.focus();
    }}
    onClearNote={() => dispatch("onClearNote")}
  />
{/if}

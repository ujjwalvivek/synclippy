<script lang="ts">
  /*
   * Root application component.  Responsible for:
   *  - creating/entering a collaboration room
   *  - wiring the websocket client to editor and storage logic
   *  - handling file uploads, warnings, and the UI chrome
   */
  import { onMount, onDestroy } from "svelte";
  import Editor from "./components/editor-code.svelte";
  import Toolbar from "./components/top-bar.svelte";
  import StatusBar from "./components/status-bar.svelte";
  import RoomExpired from "./components/room-expire.svelte";
  import {
    apiCreateRoom,
    apiLoadNote,
    apiUploadFile,
    editorAPI,
    storageLoad,
    storageSave,
    wsClient,
    isStorageLimitError,
    trialMode,
    UploadedFile,
    EditOp,
  } from "./lib/core";

  // values derived from the URL/WS sync that describe the current session.
  let roomId = "";
  let roomExpiresAt = 0;
  let roomExpired = false;
  let roomReady = false; // true once roomId is set and WS connects
  let isNewRoom = false; // used to auto‑open share panel on first visit

  // miscellaneous UI flags and timers used by the status bar / editor.
  let wsReady = false;
  let saveStatus: "saved" | "saving" | "error" = "saved";
  let files: UploadedFile[] = [];
  let noteLoaded = false;
  let fileSizeWarning = false;
  let fileSizeWarningTimer: ReturnType<typeof setTimeout> | null = null;
  let fileLimitWarning = false;
  let fileLimitWarningTimer: ReturnType<typeof setTimeout> | null = null;

  function showFileSizeWarning() {
    fileSizeWarning = true;
    if (fileSizeWarningTimer) clearTimeout(fileSizeWarningTimer);
    fileSizeWarningTimer = setTimeout(() => {
      fileSizeWarning = false;
    }, 3000);
  }

  // analogous warning when too many files have been uploaded
  function showFileLimitWarning() {
    fileLimitWarning = true;
    if (fileLimitWarningTimer) clearTimeout(fileLimitWarningTimer);
    fileLimitWarningTimer = setTimeout(() => {
      fileLimitWarning = false;
    }, 3000);
  }

  let now = Date.now();
  const ticker = setInterval(() => {
    now = Date.now();
  }, 1000);
  onDestroy(() => clearInterval(ticker));

  // Check room expiry every second; when the timer passes we tear down the
  // websocket and show the expired screen.
  $: if (roomExpiresAt > 0 && now > roomExpiresAt && !roomExpired) {
    roomExpired = true;
    wsClient.destroy();
    wsReady = false;
  }

  // Load note once the editor instance is registered via the shared store
  const unsubEditor = editorAPI.subscribe((api) => {
    if (api && !noteLoaded && roomId) {
      noteLoaded = true;
      loadNote();
    }
  });

  // fetch initial document content from the server, falling back to
  // localStorage if the request fails (or the room has expired).
  async function loadNote() {
    try {
      const content = await apiLoadNote(roomId);
      $editorAPI?.setValueForce(content);
      storageSave(content);
    } catch (err: unknown) {
      const e = err as { code?: string };
      if (e?.code === "room_expired") {
        roomExpired = true;
        return;
      }
      const local = storageLoad();
      $editorAPI?.setValueForce(local);
    }
  }

  // updates local storage and sends a patch message
  // over websocket. status flags drive the UI
  async function saveNote(detail: { changes: EditOp[]; fullContent: string }) {
    const { changes, fullContent } = detail;
    storageSave(fullContent);
    saveStatus = "saving";
    try {
      wsClient.send({
        type: "note:patch",
        edits: changes,
        content: fullContent,
      });
      saveStatus = "saved";
    } catch {
      saveStatus = "error";
    }
  }

  // establish or rejoin a room, hook websocket events to local state, and
  // return a cleanup function that removes all listeners.
  async function initRoom() {
    const pathRoom = window.location.pathname.replace(/^\//, "").trim();

    if (pathRoom && /^[a-z]+-[a-z]+-[a-z]+$/.test(pathRoom)) {
      // Visiting an existing room URL
      roomId = pathRoom;
    } else {
      const data = await apiCreateRoom();
      roomId = data.roomId;
      roomExpiresAt = data.expiresAt;
      history.pushState({}, "", "/" + roomId);
      isNewRoom = true;
    }

    roomReady = true;

    const removeStatus = wsClient.onStatus((ready) => {
      wsReady = ready;
      // Try loading note once connected (after initial fullSync WS message)
    });
    wsReady = wsClient.ready;

    const removeWS = wsClient.addHandler((msg) => {
      switch (msg.type) {
        case "room:sync":
          roomExpiresAt = msg.expiresAt;
          trialMode.set(msg.trialMode ?? false);
          if (Array.isArray(msg.files) && msg.files.length > 0) {
            files = msg.files.sort((a, b) => b.deleteAt - a.deleteAt);
          }
          if (typeof msg.content === "string") {
            const current = $editorAPI?.getValue();
            if (current !== msg.content) $editorAPI?.setValue(msg.content);
            storageSave(msg.content);
          }
          break;
        case "note:patch":
          $editorAPI?.applyRemoteEdits(msg.edits);
          // Reconcile: if delta left content wrong, fall back to full replace
          if (typeof msg.content === "string") {
            const current = $editorAPI?.getValue();
            if (current !== msg.content) $editorAPI?.setValue(msg.content);
            storageSave(msg.content);
          }
          break;
        case "note:sync":
          if (typeof msg.content === "string") {
            const current = $editorAPI?.getValue();
            if (current !== msg.content) $editorAPI?.setValue(msg.content);
            storageSave(msg.content);
          }
          break;
        case "file:added":
          if (!files.some((f) => f.filename === msg.file.filename)) {
            files = [msg.file, ...files];
          }
          break;
      }
    });

    function handleCopy(e: Event) {
      const text = (e as CustomEvent<string>).detail;
      if (text) wsClient.send({ type: "clipboard:share", text });
    }
    window.addEventListener("synclippy:copy", handleCopy);

    wsClient.connect(roomId);

    return () => {
      removeWS();
      removeStatus();
      window.removeEventListener("synclippy:copy", handleCopy);
      unsubEditor();
    };
  }

  // store cleanup function for the current room so it can be invoked when
  // the component unmounts.
  let roomCleanup: (() => void) | null = null;
  onDestroy(() => roomCleanup?.());

  // incoming clipboard:share messages are written to the local system clipboard
  // so that all room participants share a unified clipboard. This is intentional
  // for the ephemeral trust model because everyone in a room is a trusted collaborator.
  const removeClipboardHandler = wsClient.addHandler((msg) => {
    if (msg.type === "clipboard:share" && msg.text) {
      $editorAPI?.appendText(msg.text);
      navigator.clipboard?.writeText(msg.text).catch(() => {});
    }
  });
  onDestroy(() => removeClipboardHandler());

  onMount(() => {
    // start the room initiation flow once component is mounted
    initRoom().then((cleanup) => {
      roomCleanup = cleanup;
    });
  });

  function handleFilePasted(e: CustomEvent<UploadedFile>) {
    const f = e.detail;
    if (!files.some((x) => x.filename === f.filename)) {
      files = [f, ...files];
    }
  }

  // uploads via API, inserts link, and updates the local file list.
  // also handles size/limit errors with warnings.
  async function uploadFile(file: File) {
    if (file.size > 50 * 1024 * 1024) {
      showFileSizeWarning();
      return;
    }
    try {
      const result = await apiUploadFile(roomId, file);
      if (!files.some((x) => x.filename === result.filename))
        files = [result, ...files];
      const fullUrl = window.location.origin + result.url;
      $editorAPI?.insertText(fullUrl + "\n");
    } catch (err: any) {
      if (isStorageLimitError(err)) {
        showFileLimitWarning();
        return;
      }
      console.error("Upload failed", err);
    }
  }

  function handleDrop(e: DragEvent) {
    // file drag+drop handler attached to main container
    const file = e.dataTransfer?.files?.[0];
    if (file) uploadFile(file);
  }

  // invoked when the expired-room screen requests a new session
  async function handleCreateNewRoom() {
    const data = await apiCreateRoom();
    history.pushState({}, "", "/" + data.roomId);
    window.location.reload();
  }
</script>

{#if roomExpired}
  <RoomExpired on:newRoom={handleCreateNewRoom} />
{:else if roomReady}
  <div
    class="h-screen flex flex-col bg-background text-foreground font-mono overflow-hidden"
    role="application"
    on:dragover|capture|preventDefault
    on:drop|capture|preventDefault={handleDrop}
  >
    <Toolbar {wsReady} {roomId} initialShowShare={isNewRoom} />

    <div class="flex flex-1 min-h-0 overflow-hidden">
      <div class="flex flex-col flex-1 min-w-0 min-h-0">
        <div class="relative flex-1 min-h-0 overflow-hidden">
          <Editor
            {roomId}
            {files}
            {now}
            on:change={(e) => saveNote(e.detail)}
            on:filePasted={handleFilePasted}
            on:fileSizeError={showFileSizeWarning}
            on:fileLimitError={showFileLimitWarning}
            on:onClearNote={() => {
              $editorAPI?.setValueForce("");
              saveNote({ changes: [], fullContent: "" });
            }}
          />
        </div>
      </div>
    </div>

    <StatusBar
      {wsReady}
      {saveStatus}
      {roomId}
      {roomExpiresAt}
      {now}
      {fileSizeWarning}
      {fileLimitWarning}
    />
  </div>
{/if}

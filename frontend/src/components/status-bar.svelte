<script lang="ts">
  import { Hourglass, X } from "lucide-svelte";
  // inputs from parent (status of websocket/save etc.)
  export let wsReady: boolean;
  export let saveStatus: "saved" | "saving" | "error";
  export let roomId: string = ""; // shown in the corner when present
  export let roomExpiresAt: number = 0; // unix ms
  export let now: number = Date.now(); // updated by parent every second
  export let fileSizeWarning: boolean = false; // transient upload alerts
  export let fileLimitWarning: boolean = false;

  // remaining milliseconds until the room expires; zero once passed
  $: roomMs = roomExpiresAt > 0 ? Math.max(0, roomExpiresAt - now) : 0;
  $: roomTimer =
    roomMs > 0
      ? `${Math.floor(roomMs / 60000)}:${String(Math.floor((roomMs % 60000) / 1000)).padStart(2, "0")}`
      : "";
  // color the timer yellow when less than a minute remains
  $: timerColor =
    roomMs < 60000 && roomMs > 0 ? "text-yellow-500" : "text-muted";
</script>

<footer
  class="h-6 shrink-0 flex items-center px-3 gap-4 select-none bg-background"
>
  <span
    class="text-xs font-mono flex items-center gap-1.5 {wsReady
      ? 'text-green-500'
      : 'text-muted'}"
  >
    <span
      class="w-1.5 h-1.5 rounded-full {wsReady
        ? 'bg-green-500'
        : 'bg-zinc-600'}"
    ></span>
    {wsReady ? "connected" : "disconnected"}
  </span>
  <span
    class="text-xs font-mono {saveStatus === 'error'
      ? 'text-red-400'
      : 'text-muted'} truncate sm:inline"
  >
    {saveStatus === "saving"
      ? "saving..."
      : saveStatus === "error"
        ? "save error"
        : "auto-saved"}
  </span>
  {#if fileSizeWarning}
    <div
      class="fixed bottom-8 inset-x-0 flex justify-center px-4 z-50 pointer-events-none"
    >
      <div
        class="pointer-events-auto flex items-start gap-3 w-full max-w-sm border border-border bg-background shadow-lg rounded-sm px-3 py-2 font-mono text-xs text-muted"
      >
        <span class="flex-1 leading-relaxed text-orange-500"
          >Max Upload File Size Exceeded</span
        >
      </div>
    </div>
  {/if}
  {#if fileLimitWarning}
    <div
      class="fixed bottom-8 inset-x-0 flex justify-center px-4 z-50 pointer-events-none"
    >
      <div
        class="pointer-events-auto flex items-start gap-3 w-full max-w-sm border border-border bg-background shadow-lg rounded-sm px-3 py-2 font-mono text-xs text-muted"
      >
        <span class="flex-1 leading-relaxed text-orange-500"
          >Max 5 files per room</span
        >
      </div>
    </div>
  {/if}
  <span class="flex-1" />
  {#if roomId}
    <span
      class="text-xs font-mono text-muted whitespace-nowrap shrink-0 sm:inline"
      >{roomId}</span
    >
  {/if}
  {#if roomTimer}
    <span
      class="inline-flex items-center gap-1 text-xs font-mono {timerColor}"
      title="Room expires in {roomTimer}"
    >
      <Hourglass size={12} />{roomTimer}
    </span>
  {/if}
</footer>

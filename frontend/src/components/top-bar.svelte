<script lang="ts">
  // top bar with connection indicator and share button.
  import RoomShare from "./room-share.svelte";
  export let wsReady: boolean; // show green dot when true
  export let roomId: string = ""; // displayed beside app name
  export let initialShowShare: boolean = false; // optionally open share panel on load
  import { QrCode } from "lucide-svelte";

  let showShare = initialShowShare;
  let shareButtonEl: HTMLButtonElement;

  // reactive anchors used to position the floating share panel next to the
  // button.  calculated on the client because the DOM metrics are required.
  $: anchorRight =
    typeof window !== "undefined"
      ? window.innerWidth - (shareButtonEl?.getBoundingClientRect().right ?? 0)
      : 8;
  $: anchorTop = shareButtonEl?.getBoundingClientRect().bottom ?? 40;
</script>

<header
  class="flex items-center justify-between px-3 h-10 shrink-0 select-none gap-2"
>
  <div class="flex items-center gap-2 min-w-0">
    <span
      class="w-2 h-2 rounded-full shrink-0 {wsReady
        ? 'bg-green-500'
        : 'bg-zinc-600'}"
      title={wsReady ? "Connected" : "Disconnected"}
    ></span>
    <span class="text-xs font-mono text-muted truncate sm:inline"
      >synclippy</span
    >
    {#if roomId}
      <span class="text-xs font-mono text-muted/50 truncate sm:inline"
        >/ {roomId}</span
      >
    {/if}
  </div>
  <div class="flex items-center gap-1 sm:gap-1">
    <button
      bind:this={shareButtonEl}
      on:click={() => (showShare = !showShare)}
      title="Share room link / QR code"
      class="flex items-center gap-1 text-xs font-mono border border-border px-2 py-1 rounded-sm hover:bg-accent transition-colors text-foreground {showShare
        ? 'bg-accent'
        : ''}"
    >
      <QrCode size={18} />
    </button>
  </div>
</header>

{#if showShare}
  <RoomShare
    {roomId}
    {anchorRight}
    {anchorTop}
    on:close={() => (showShare = false)}
  />
{/if}

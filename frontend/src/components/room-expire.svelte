<script lang="ts">
  // shown when a collaboration room has timed out; emits a `newRoom` event
  // so the parent can create a fresh session.
  import { createEventDispatcher } from "svelte";
  import { Hourglass } from "lucide-svelte";
  const dispatch = createEventDispatcher();
</script>

<div
  class="h-screen flex flex-col items-center justify-center bg-background text-foreground font-mono select-none gap-6"
>
  <div class="flex flex-col items-center text-center gap-2">
    <Hourglass size={24} class="opacity-30" />
    <h1 class="text-lg font-semibold text-foreground">Room expired</h1>
    <p class="text-xs text-muted max-w-xs">
      All content was ephemeral, nothing was stored.
    </p>
  </div>

  <button
    on:click={() => dispatch("newRoom")}
    class="text-xs border border-border px-4 py-2 rounded-sm hover:bg-accent transition-colors text-foreground"
  >
    Create new room
  </button>
</div>

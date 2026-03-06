<script lang="ts">
  // popover that shows a QR code + shareable URL for the current room.
  import { createEventDispatcher, onMount, onDestroy } from "svelte";
  import QRCode from "qrcode";
  import { Copy, SquareCheckBig } from "lucide-svelte";

  export let roomId: string;
  export let anchorRight: number = 8;
  export let anchorTop: number = 40;

  const dispatch = createEventDispatcher();

  let canvas: HTMLCanvasElement;
  let copied = false;
  let cardEl: HTMLDivElement;

  // derive full URL from the roomId
  $: roomUrl = window.location.origin + "/" + roomId;

  // calculate inline style so the share card stays fully on-screen;
  // if not enough room below the anchor, flip it upward instead of using
  // top/left coordinates.
  $: cardStyle = (() => {
    if (typeof window === "undefined")
      return `top:${anchorTop}px;right:${anchorRight}px`;
    const cardH = cardEl?.offsetHeight ?? 220;
    const spaceBelow = window.innerHeight - anchorTop;
    if (spaceBelow < cardH) {
      return `bottom:${window.innerHeight - anchorTop + 4}px;right:${anchorRight}px`;
    }
    return `top:${anchorTop + 4}px;right:${anchorRight}px`;
  })();

  onMount(() => {
    // render the QR code once the canvas is in the DOM; size matches its
    // container width so it scales nicely when the component is resized.
    if (canvas) {
      const size = canvas.closest("div")?.clientWidth ?? 112;
      QRCode.toCanvas(canvas, roomUrl, {
        width: size,
        margin: 1,
        color: { dark: "#e2e8f0", light: "#09090b" },
      });
    }
  });

  let copyTimer: ReturnType<typeof setTimeout>;

  function copyLink() {
    navigator.clipboard.writeText(roomUrl).then(() => {
      copied = true;
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => {
        copied = false;
      }, 2000);
    });
  }

  onDestroy(() => clearTimeout(copyTimer));

  function handleKey(e: KeyboardEvent) {
    if (e.key === "Escape") dispatch("close");
  }
</script>

<svelte:window on:keydown={handleKey} />

<div
  class="fixed inset-0 z-40"
  role="presentation"
  on:click={() => dispatch("close")}
></div>

<div
  bind:this={cardEl}
  class="fixed z-50 bg-background border border-border rounded-sm shadow-2xl font-mono w-72"
  style={cardStyle}
  role="dialog"
  aria-modal="true"
  aria-label="Share room"
>
  <div class="flex gap-2 p-2">
    <div
      class="w-28 self-start shrink-0 border-2 border-border rounded-sm p-1 overflow-hidden"
    >
      <canvas bind:this={canvas} class="w-full max-w-full block rounded-sm" />
    </div>

    <div class="flex flex-col gap-2 min-w-0 flex-1">
      <div
        class="relative border border-border rounded-sm px-2 py-1.5 flex-1 overflow-hidden"
      >
        <button
          on:click={copyLink}
          class="absolute top-1.5 right-1.5 transition-colors {copied
            ? 'text-green-400'
            : 'text-muted hover:text-foreground'}"
          title="Copy link"
        >
          {#if copied}<SquareCheckBig size={12} />{:else}<Copy size={12} />{/if}
        </button>
        <code class="block text-xs text-muted break-all leading-snug pr-4"
          >{roomUrl}</code
        >
      </div>

      <p class="text-xs text-orange-500/80 leading-snug">
        Experimental. Ephemeral content.
      </p>
    </div>
  </div>
</div>

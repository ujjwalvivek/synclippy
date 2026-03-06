<script lang="ts">
    import { onMount } from "svelte";
    import { editorAPI, wsClient } from "../lib/core";

    // positioning props and callbacks from parent
    export let x: number;
    export let y: number;
    export let onClose: () => void;
    export let onClearNote: () => void;

    let menuEl: HTMLDivElement;

    // keep menu inside viewport and close on Escape
    onMount(() => {
        const w = document.documentElement.clientWidth;
        const h = document.documentElement.clientHeight;
        const menuW = menuEl.offsetWidth;
        const menuH = menuEl.offsetHeight;
        if (x + menuW > w) x = Math.max(0, w - menuW - 4);
        if (y + menuH > h) y = Math.max(0, h - menuH - 4);

        function onKeydown(e: KeyboardEvent) {
            if (e.key === "Escape") {
                e.preventDefault();
                onClose();
            }
        }
        window.addEventListener("keydown", onKeydown);
        return () => window.removeEventListener("keydown", onKeydown);
    });

    // clipboard helper with optional websocket share
    async function doCopy() {
        const sel = $editorAPI?.getSelectedText() ?? "";
        if (sel) {
            navigator.clipboard.writeText(sel).catch(() => {});
            wsClient.send({ type: "clipboard:share", text: sel });
        }
        onClose();
    }

    async function doPaste() {
        try {
            const text = await navigator.clipboard.readText();
            if (text) $editorAPI?.insertText(text);
        } catch {}
        onClose();
    }

    function clearNote() {
        onClose();
        onClearNote();
    }
</script>

<div
    class="fixed inset-0 z-40"
    on:click={onClose}
    on:keydown={() => {}}
    role="presentation"
></div>

<div
    bind:this={menuEl}
    class="fixed z-50 min-w-[10rem] border border-border bg-background shadow-2xl rounded-sm py-1"
    style="left: {x}px; top: {y}px"
>
    <button
        class="w-full flex items-center justify-between px-3 py-1.5 text-xs font-mono hover:bg-accent transition-colors text-foreground"
        on:click={doCopy}
    >
        <span>Copy</span>
        <span class="text-muted ml-6">Ctrl+C</span>
    </button>
    <button
        class="w-full flex items-center justify-between px-3 py-1.5 text-xs font-mono hover:bg-accent transition-colors text-foreground"
        on:click={doPaste}
    >
        <span>Paste</span>
        <span class="text-muted ml-6">Ctrl+V</span>
    </button>
    <div class="border-t border-border my-1"></div>
    <button
        class="w-full text-left px-3 py-1.5 text-xs font-mono hover:bg-accent transition-colors text-foreground"
        on:click={clearNote}>Clear Note</button
    >
</div>

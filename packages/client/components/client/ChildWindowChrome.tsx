import { JSX, onCleanup, onMount } from "solid-js";

import { DeviceProvider } from "@revolt/common";
import { bindKeybinds } from "@revolt/keybinds/keybindHandler";
import { ModalRenderer } from "@revolt/modal";
import { ContextMenuGuard, FileDropGuard, FloatingManager } from "@revolt/ui";
import { Masks } from "@revolt/ui/themes/Masks";

import { type WindowCtx, WindowCtxProvider } from "./windowCtx";

/**
 * Per-window furniture for a chat window.
 *
 * A chat window is not a second app instance: it is an `about:blank` child
 * document that the MAIN app renders into, through
 * `<Portal mount={ctx.doc.body}>`, from inside the main component tree. That
 * is what lets the window share the one client, state, voice session, modal
 * controller and i18n without any syncing — every context above the portal
 * is inherited as-is.
 *
 * What is NOT inherited is anything bound to a document. The main window's
 * own copies of these are mounted once at the root and only ever see the
 * main document: its SVG masks are not in the child's DOM (so the holepunch
 * avatars would render unmasked), its guards listen on the main `window`, its
 * floating layer and modals portal into the main `#floating`, its keybinds
 * listen to main key events, and its device layout follows the main
 * viewport. So each window mounts its own set here, under a
 * `WindowCtxProvider` that tells them which document and window they serve.
 *
 * Callers wrap the chat window's content in this; see `childWindow.ts`.
 */
export function ChildWindowChrome(props: {
  ctx: WindowCtx;
  children: JSX.Element;
}): JSX.Element {
  onMount(() => {
    // Key events in the child never reach the main document's listeners, so
    // this window's are attached here, for exactly as long as it is rendered.
    const off = bindKeybinds(props.ctx);
    onCleanup(off);
  });

  // A window's ctx is fixed for the life of the window (the handle owns one
  // document and one `Window`), so the provider reading it once is correct.
  // DeviceProvider wraps the furniture too, not just the content: modals and
  // floating cards rendered here pick their layout from the device context,
  // and they must follow this window's viewport, not the main one.
  return (
    // eslint-disable-next-line solid/reactivity
    <WindowCtxProvider value={props.ctx}>
      <DeviceProvider>
        <Masks />
        <FileDropGuard />
        <ContextMenuGuard />
        <FloatingManager />
        <ModalRenderer windowId={props.ctx.id} />
        {props.children}
      </DeviceProvider>
    </WindowCtxProvider>
  );
}

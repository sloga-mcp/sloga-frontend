/**
 * Which `ModalRenderer` draws a modal.
 *
 * Every window (main, plus each chat window) mounts its own renderer, and
 * each modal is stamped with the id of the window it was opened for. A modal
 * must be drawn by exactly one renderer, and never by none: an E2EE identity
 * or downgrade prompt that nobody can see blocks the flow behind it as surely
 * as one the user dismissed, so anything that cannot be placed falls back to
 * the main window.
 *
 * Kept free of imports so the rule loads under `node --test`.
 */

export const MAIN_WINDOW_ID = "main";

/**
 * @param modalWindowId the window the modal was stamped for (undefined = main)
 * @param rendererWindowId the renderer's window (undefined = main)
 * @param isAvailable whether a chat window is still open AND has a renderer
 * mounted; never asked about main
 */
export function modalRendersIn(
  modalWindowId: string | undefined,
  rendererWindowId: string | undefined,
  isAvailable: (windowId: string) => boolean,
): boolean {
  const target = modalWindowId ?? MAIN_WINDOW_ID;
  const renderer = rendererWindowId ?? MAIN_WINDOW_ID;

  if (renderer === MAIN_WINDOW_ID) {
    return target === MAIN_WINDOW_ID || !isAvailable(target);
  }

  // A chat window's renderer can outlive its window by a tick (the window is
  // unregistered before its portal unmounts). Main has adopted the modal by
  // then, so this one must let go or the modal would mount twice.
  return target === renderer && isAvailable(renderer);
}

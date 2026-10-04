import { createResource, createSignal } from "solid-js";

/**
 * What the "Support Sloga" dialog needs from outside, passed in so the flow
 * runs without a browser
 */
export interface SupportSlogaDeps<T extends { code: string }> {
  /** POST /users/@me/supporter/code */
  fetchCode(): Promise<T>;
  /** `navigator.clipboard.writeText`, which throws outside secure contexts */
  writeClipboard(value: string): Promise<void>;
  /** Open the Ko-fi page in a new tab */
  openKofi(): void;
  /** Close the dialog */
  close(): void;
}

/**
 * State and actions behind the "Support Sloga" dialog. Call it from the
 * component so the resource has an owner.
 */
export function createSupportSlogaFlow<T extends { code: string }>(
  deps: SupportSlogaDeps<T>,
) {
  // The server hands back the account's live code if it has one, so opening
  // the dialog again does not mint a new code each time
  const [code] = createResource(() => deps.fetchCode());

  /**
   * The code once it has loaded. Reading an errored resource throws, so
   * everything outside the error branch reads it through this
   */
  const value = () => (code.state === "ready" ? code() : undefined);

  const [copyFailed, setCopyFailed] = createSignal(false);

  /**
   * Copy the code. The write starts synchronously, before Ko-fi opens: the
   * clipboard refuses writes once the new tab has taken focus.
   */
  function copy(text: string): Promise<boolean> {
    setCopyFailed(false);

    let write: Promise<void>;
    try {
      write = deps.writeClipboard(text);
    } catch {
      setCopyFailed(true);
      return Promise.resolve(false);
    }

    return write.then(
      () => true,
      () => {
        setCopyFailed(true);
        return false;
      },
    );
  }

  function donateWithoutCode() {
    deps.openKofi();
    deps.close();
  }

  /**
   * Copy the code and open Ko-fi, or just open Ko-fi when there is no code
   * (still loading, or the request failed)
   */
  async function copyAndOpen() {
    const current = value()?.code;
    if (!current) {
      donateWithoutCode();
      return;
    }

    const copied = copy(current);
    // Opened in the same tick as the click, or browsers block the popup
    deps.openKofi();
    // Stay open when the copy failed, so the code can still be copied by hand
    if (await copied) deps.close();
  }

  return { code, value, copyFailed, copy, copyAndOpen, donateWithoutCode };
}

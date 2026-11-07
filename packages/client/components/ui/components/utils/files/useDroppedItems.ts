import { useLingui } from "@lingui-solid/solid/macro";

import { useModals } from "@revolt/modal";

import {
  type DropFailure,
  type DroppedItem,
  resolveDroppedItems,
  resolvePickedFolder,
} from "./folderAttachments";

/**
 * Report attach failures in one error dialog, so nothing disappears without
 * a word
 * @returns Takes a resolver's result, reports its failures, returns its files
 */
function useReportFailures() {
  const { t } = useLingui();
  const { openModal } = useModals();

  /**
   * Message for one failure
   * @param failure Failure
   * @returns Message
   */
  function describe(failure: DropFailure) {
    const name = failure.name;
    switch (failure.reason) {
      case "too_large":
        return t`The folder "${name}" is too large to send (over 4 GB or 65,535 files).`;
      case "read_failed":
        return t`The folder "${name}" couldn't be read, so it wasn't attached.`;
      default:
        return t`"${name}" couldn't be read, so it wasn't attached. If it's a folder, zip it first.`;
    }
  }

  return ({ files, failures }: { files: File[]; failures: DropFailure[] }) => {
    if (failures.length) {
      openModal({
        type: "error2",
        error: new Error(failures.map(describe).join("\n")),
      });
    }
    return files;
  };
}

/**
 * Resolve taken drop/paste items into Files (folders zipped), reporting
 * anything that could not be attached
 * @returns Resolver; resolves to the Files to attach
 */
export function useDroppedItems() {
  const report = useReportFailures();
  return async (items: DroppedItem[]) =>
    report(await resolveDroppedItems(items));
}

/**
 * Resolve the files of a folder chosen in a folder picker into one zip,
 * reporting a folder that could not be zipped
 * @returns Resolver; resolves to the Files to attach
 */
export function usePickedFolder() {
  const report = useReportFailures();
  return async (picked: File[]) => report(await resolvePickedFolder(picked));
}

/**
 * Whether this browser can pick a folder. Mobile browsers and the Android
 * webview expose the property but open an ordinary file picker.
 * @param isMobile From `useDevice`
 * @returns Whether to offer folder picking
 */
export function canPickFolder(isMobile: boolean) {
  return (
    !isMobile &&
    typeof HTMLInputElement !== "undefined" &&
    "webkitdirectory" in HTMLInputElement.prototype
  );
}

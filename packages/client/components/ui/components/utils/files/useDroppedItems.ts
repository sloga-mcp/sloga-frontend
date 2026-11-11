import { useLingui } from "@lingui-solid/solid/macro";

import { useModals } from "@revolt/modal";

import {
  type DropFailure,
  type DroppedItem,
  resolveDroppedItems,
  resolvePickedFolder,
} from "./folderAttachments";
import { humanFileSize } from "./humanFileSize";
import { watchZips } from "./zipProgress";

/**
 * Where a drop, paste or pick goes, captured at the gesture: a zip can
 * finish long after, when the composer may show another channel
 */
export interface ZipTarget {
  /** Strip that shows the zip progress (one per channel) */
  owner: object;
  /** Upload limit of that channel; a bigger folder is refused unread */
  maxBytes?: number;
}

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
      case "over_limit": {
        const limit = humanFileSize(failure.limit);
        return t`The folder "${name}" is over the ${limit} upload limit, so it wasn't attached.`;
      }
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
 * @returns Resolver; give it the target captured at the gesture. Resolves
 * to the Files to attach.
 */
export function useDroppedItems() {
  const report = useReportFailures();
  return async (items: DroppedItem[], target?: ZipTarget) =>
    report(
      await resolveDroppedItems(
        items,
        target && watchZips(target.owner),
        target?.maxBytes,
      ),
    );
}

/**
 * Resolve the files of a folder chosen in a folder picker into one zip,
 * reporting a folder that could not be zipped
 * @returns Resolver; give it the target captured when the picker opened.
 * Resolves to the Files to attach.
 */
export function usePickedFolder() {
  const report = useReportFailures();
  return async (picked: File[], target?: ZipTarget) =>
    report(
      await resolvePickedFolder(
        picked,
        target && watchZips(target.owner),
        target?.maxBytes,
      ),
    );
}

/**
 * Whether this device can pick a folder. Mobile browsers and the Android
 * webview expose the property but open an ordinary file picker (or none),
 * and tablets don't say "Mobi" in their user agent: an iPad asks for a
 * desktop site as a Mac with a touchscreen, an Android tablet just says
 * Android.
 * @param isMobile From `useDevice`
 * @returns Whether to offer folder picking
 */
export function canPickFolder(isMobile: boolean) {
  if (isMobile) return false;
  if (typeof HTMLInputElement === "undefined") return false;
  if (!("webkitdirectory" in HTMLInputElement.prototype)) return false;
  if (typeof navigator === "undefined") return true;

  const ua = navigator.userAgent;
  if (/Android|iPad|iPhone|iPod/i.test(ua)) return false;
  return !(/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

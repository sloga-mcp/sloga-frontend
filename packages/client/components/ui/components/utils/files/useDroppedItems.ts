import { useLingui } from "@lingui-solid/solid/macro";

import { useModals } from "@revolt/modal";

import {
  type DropFailure,
  type DroppedItem,
  resolveDroppedItems,
} from "./folderAttachments";

/**
 * Resolve taken drop/paste items into Files (folders zipped) and tell the
 * user about anything that could not be attached, so nothing disappears
 * without a word
 * @returns Resolver; resolves to the Files to attach
 */
export function useDroppedItems() {
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

  return async (items: DroppedItem[]) => {
    const { files, failures } = await resolveDroppedItems(items);

    if (failures.length) {
      openModal({
        type: "error2",
        error: new Error(failures.map(describe).join("\n")),
      });
    }

    return files;
  };
}

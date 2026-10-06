import { useLingui } from "@lingui-solid/solid/macro";

/**
 * Translated name and one-line meaning for each presence, so every status dot
 * can explain itself.
 *
 * Call once in component setup (it reads the lingui context); the returned
 * functions are safe to call from JSX, tooltips and memos.
 *
 * Anything unrecognised, a missing presence, and "Invisible" all read as
 * offline to viewers: an invisible user must look exactly like an offline
 * one. Only your own presence picker (`pickerLabel`, `pickerDescription`)
 * names "Invisible" for what it is.
 */
export function usePresenceText() {
  const { t } = useLingui();

  /**
   * Name of a presence, as shown to other people
   */
  function label(presence?: string) {
    switch (presence) {
      case "Online":
        return t`Online`;
      case "Idle":
        return t`Idle`;
      case "Focus":
        return t`Focus`;
      case "Busy":
        return t`Do not disturb`;
      case "LookingForGroup":
        return t({
          message: "LFG",
          comment: "Short for Looking For Group, a presence status",
        });
      case "LookingForMore":
        return t({
          message: "LFM",
          comment: "Short for Looking For More, a presence status",
        });
      default:
        return t`Offline`;
    }
  }

  /**
   * What a presence means, as explained to other people
   */
  function description(presence?: string) {
    switch (presence) {
      case "Online":
        return t`Around and available`;
      case "Idle":
        return t`Away from the keyboard for a bit`;
      case "Focus":
        return t`Online but concentrating; messages still come through`;
      case "Busy":
        return t`Notifications are muted, so they may not see your message`;
      case "LookingForGroup":
        return t`Looking for group: wants to join a group to play or hang out`;
      case "LookingForMore":
        return t`Looking for more: already in a group and looking for more people to join`;
      default:
        return t`Not online, or appearing offline`;
    }
  }

  /**
   * Name of a presence in your own presence picker
   */
  function pickerLabel(presence?: string) {
    return presence === "Invisible" ? t`Invisible` : label(presence);
  }

  /**
   * What choosing a presence does, as explained in your own presence picker
   */
  function pickerDescription(presence?: string) {
    switch (presence) {
      case "Online":
        return t`Around and available`;
      case "Idle":
        return t`Away from the keyboard for a bit`;
      case "Focus":
        return t`Only mentions notify you`;
      case "Busy":
        return t`Mutes all your notifications`;
      case "LookingForGroup":
        return t`Let people know you want to join a group`;
      case "LookingForMore":
        return t`Let people know your group wants more people`;
      default:
        return t`Appear offline to everyone`;
    }
  }

  return { label, description, pickerLabel, pickerDescription };
}

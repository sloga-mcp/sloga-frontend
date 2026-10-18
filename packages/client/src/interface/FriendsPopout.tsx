import { onMount } from "solid-js";

/**
 * The web friends popout is retired: the "Friends and direct messages"
 * setting puts the friends list and the DMs in the same place, and a list in
 * a second window opened its conversations behind it.
 *
 * The route stays so a popout still open from an older version, or a
 * bookmark, lands somewhere defined. A window booted here is still flagged
 * `IS_POPOUT_WINDOW` (frozen at boot, see @revolt/client/popout), and
 * `Interface` bounces such a window back to this path, so it must leave by a
 * full navigation, never the router: close the popup, or load the friends
 * page as a normal window.
 */
export function FriendsPopout() {
  onMount(() => {
    if (window.opener) window.close();
    // A window the page did not open itself refuses to close
    setTimeout(() => {
      if (!window.closed) window.location.replace("/friends");
    }, 100);
  });

  return null;
}

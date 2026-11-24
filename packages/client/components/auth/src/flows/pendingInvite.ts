/**
 * Longest invite code the server accepts on onboarding
 */
const INVITE_CODE_MAX_LENGTH = 128;

/**
 * Server invite code from a saved `/invite/:code` path, if a signed-out
 * visitor arrived from an invite link
 * @param path Path saved to return to after sign-in
 * @returns Invite code, if the path is an invite
 */
export function pendingInviteCode(
  path: string | undefined,
): string | undefined {
  const code = path?.match(/^\/invite\/([^/?#]+)\/?$/)?.[1];
  return code && code.length <= INVITE_CODE_MAX_LENGTH ? code : undefined;
}

/**
 * Whether "Continue with Google" can be offered here. Google rejects OAuth
 * from embedded webviews (disallowed_useragent), so no native shell (Tauri,
 * Electron or the phone apps) shows it, and the server must have Google
 * sign-in turned on.
 * @param nativeShell Whether this is a native shell (`isNativeShell()`)
 * @param config Root API response, if it loaded
 * @returns Whether to show the button
 */
export function googleSignInOffered(
  nativeShell: boolean,
  config: unknown,
): boolean {
  if (nativeShell) return false;
  const features = (config as { features?: { oauth_google?: unknown } } | null)
    ?.features;
  return features?.oauth_google === true;
}

import type { Client } from "stoat.js";

import { CONFIGURATION } from "@revolt/common";

/**
 * Streaming-connection (linked Twitch / YouTube channel) API helpers.
 *
 * All calls use plain fetch: these routes are newer than the generated
 * stoat-api schema, and the typed client drops bodies for unknown routes
 * (they arrive as `{}` and Rocket 422s) — same gotcha as completeOauth.
 */

export type StreamPlatform = "twitch" | "youtube";

/** A linked channel as returned by the API / present on User objects */
export type UserConnection = {
  platform: "Twitch" | "YouTube";
  handle: string;
  display_name: string;
  live?: boolean;
  live_title?: string;
  live_since?: string;
};

/** External channel URL for a connection */
export function connectionUrl(connection: UserConnection): string {
  if (connection.platform === "Twitch") {
    return `https://twitch.tv/${connection.handle}`;
  }

  // YouTube: handle is "@custom" when the channel has one, otherwise the
  // raw channel id
  return connection.handle.startsWith("@")
    ? `https://youtube.com/${connection.handle}`
    : `https://youtube.com/channel/${connection.handle}`;
}

/**
 * Which platforms the server has linking enabled for (root config flags)
 */
export async function fetchStreamingFlags(): Promise<{
  twitch: boolean;
  youtube: boolean;
}> {
  try {
    const response = await fetch(`${CONFIGURATION.DEFAULT_API_URL}/`);
    if (!response.ok) return { twitch: false, youtube: false };
    const config = await response.json();
    return {
      twitch: !!config?.features?.oauth_twitch,
      youtube: !!config?.features?.oauth_youtube,
    };
  } catch {
    return { twitch: false, youtube: false };
  }
}

function authHeaders(client: Client): Record<string, string> {
  const [header, token] = client.authenticationHeader;
  return { [header]: token };
}

/**
 * Begin the link flow; returns the provider authorize URL to navigate to
 */
export async function beginStreamLink(
  client: Client,
  platform: StreamPlatform,
): Promise<string> {
  const response = await fetch(
    `${CONFIGURATION.DEFAULT_API_URL}/users/@me/connections/${platform}/authorize`,
    { method: "POST", headers: authHeaders(client) },
  );

  if (!response.ok) {
    throw new Error(`Failed to begin link (${response.status})`);
  }

  const { url } = (await response.json()) as { url: string };
  return url;
}

/**
 * Finalize a link with the one-time handoff code from the callback
 * redirect; the server verifies the session user initiated the flow
 */
export async function completeStreamLink(
  client: Client,
  platform: StreamPlatform,
  code: string,
): Promise<UserConnection> {
  const response = await fetch(
    `${CONFIGURATION.DEFAULT_API_URL}/users/@me/connections/complete`,
    {
      method: "POST",
      headers: { ...authHeaders(client), "Content-Type": "application/json" },
      body: JSON.stringify({ platform, code }),
    },
  );

  if (!response.ok) {
    throw new Error(`Failed to complete link (${response.status})`);
  }

  return (await response.json()) as UserConnection;
}

/**
 * Unlink a channel (revokes provider tokens server-side, best-effort)
 */
export async function unlinkStream(
  client: Client,
  platform: StreamPlatform,
): Promise<void> {
  const response = await fetch(
    `${CONFIGURATION.DEFAULT_API_URL}/users/@me/connections/${platform}`,
    { method: "DELETE", headers: authHeaders(client) },
  );

  if (!response.ok && response.status !== 404) {
    throw new Error(`Failed to unlink (${response.status})`);
  }
}

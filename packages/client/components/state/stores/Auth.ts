import { CONFIGURATION } from "@revolt/common";

import { State } from "..";

import { AbstractStore } from ".";

export type Session = {
  _id: string;
  token: string;
  userId: string;
  valid: boolean;
};

export type TypeAuth = {
  /**
   * Session information
   */
  session?: Session;

  /**
   * Whether to keep the user logged in after the app is closed.
   * Defaults to true; when false the session is dropped on next launch.
   */
  remember?: boolean;
};

/**
 * sessionStorage key marking that this app instance already resumed the
 * session — lets non-remembered sessions survive reloads but not app restarts.
 */
const ACTIVE_MARKER = "auth:active";

/**
 * Authentication details store
 */
export class Auth extends AbstractStore<"auth", TypeAuth> {
  /**
   * Construct store
   * @param state State
   */
  constructor(state: State) {
    super(state, "auth");
  }

  /**
   * Hydrate external context
   */
  hydrate(): void {
    if (CONFIGURATION.DEVELOPMENT_TOKEN && CONFIGURATION.DEVELOPMENT_USER_ID) {
      this.setSession({
        _id: CONFIGURATION.DEVELOPMENT_SESSION_ID ?? "0",
        token: CONFIGURATION.DEVELOPMENT_TOKEN,
        userId: CONFIGURATION.DEVELOPMENT_USER_ID,
        valid: true,
      });
    }

    // Drop non-remembered sessions on a fresh app launch (survives reloads
    // within the same window via the sessionStorage marker).
    try {
      const { session, remember } = this.get();
      if (
        session &&
        remember === false &&
        !sessionStorage.getItem(ACTIVE_MARKER)
      ) {
        this.removeSession();
      }
      if (this.get().session) {
        sessionStorage.setItem(ACTIVE_MARKER, "1");
      }
    } catch {
      // sessionStorage unavailable; keep the session
    }
  }

  /**
   * Generate default values
   */
  default(): TypeAuth {
    return {
      session: undefined,
      remember: true,
    };
  }

  /**
   * Validate the given data to see if it is compliant and return a compliant object
   */
  clean(input: Partial<TypeAuth>): TypeAuth {
    const remember = input.remember !== false;
    let session;
    if (typeof input.session === "object") {
      if (
        typeof input.session._id === "string" &&
        typeof input.session.token === "string" &&
        typeof input.session.userId === "string" &&
        input.session.valid
      ) {
        session = {
          _id: input.session._id,
          token: input.session.token,
          userId: input.session.userId,
          valid: true,
        };
      }
    }

    return {
      session,
      remember,
    };
  }

  /**
   * Get current session.
   * @returns Session
   */
  getSession() {
    return this.get().session;
  }

  /**
   * Add a new session to the auth manager.
   * @param session Session
   */
  setSession(session: Session) {
    this.set("session", session);
    try {
      sessionStorage.setItem(ACTIVE_MARKER, "1");
    } catch {
      /* ignore */
    }
  }

  /**
   * Set whether the session should be kept after the app is closed
   */
  setRemember(remember: boolean) {
    this.set("remember", remember);
  }

  /**
   * Remove existing session.
   */
  removeSession() {
    this.set("session", undefined!);
  }

  /**
   * Mark current session as valid
   */
  markValid() {
    const session = this.get().session;
    if (session && !session.valid) {
      this.set("session", "valid", true);
    }
  }
}

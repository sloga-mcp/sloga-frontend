/**
 * Post-resolve epoch backstop for the native key push (iOS call E2EE phase 2,
 * ruling R4, W3 MUST 5).
 *
 * On iOS, core emits `callKeysChanged {group_id, epoch}` BEFORE the call
 * command's promise resolves (RelayTests). A push that is lost on the way
 * leaves this device sending under the previous epoch's key, and nothing
 * would ever notice. So after each epoch-advancing command resolves
 * (`callCreate`; `callProcess` with a `welcome_joined` / `commit_applied`
 * outcome; `callCommitWon`), the caller hands the outcome epoch to
 * `afterResolve`:
 *   - a push for that group already reached that epoch (or a later one):
 *     nothing to do;
 *   - otherwise: `pull`, the SAME handler a push drives;
 *   - no usable epoch: `onLost`, the loud path. Never a silent pass.
 *
 * iOS only (`keyPushArrivesBeforeResolve`). On Android the push follows the
 * resolve, so a backstop there would pull a second time and shift the
 * Add-grace timing.
 *
 * Pure and dependency-free so `node --test` can load it. Group ids and
 * epochs are public values; nothing here sees key material.
 */

/** The shells whose native key push lands before the command resolves. */
export function keyPushArrivesBeforeResolve(platform: string): boolean {
  return platform === "ios";
}

/** A native MLS epoch: a non-negative integer (core's `i64`, never below 0). */
function isEpoch(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * The epoch a resolved call command moved its group to, read from the
 * command's real result shape (e2ee-core `shell.rs` / `mls/mod.rs`):
 *   - `"create"` → `MlsCallCreated {group_id, payload}`. It has no `epoch`
 *     field: core establishes epoch 0 and fires `keys_changed(group_id, 0)`
 *     (`ShellEngine::call_create`). A well-formed result (non-empty string
 *     `group_id`) is therefore epoch 0.
 *   - `"process"` → `MlsProcessOutcome {group_id, kind, epoch, removed_self,
 *     removed?, ctl?}`. `kind` `welcome_joined` / `commit_applied` advance
 *     the epoch (core fires the push for exactly these two); `duplicate` /
 *     `ctl_received` do not.
 *   - `"commitWon"` → `MlsProcessOutcome`, always an advance (core fires on
 *     every success; the kind is `commit_applied`).
 *
 * Returns the epoch; `null` when the outcome does not advance an epoch
 * (nothing to check); `undefined` when the outcome should have advanced one
 * but no epoch can be read from it. An unknown or missing `kind`, or a result
 * that is not an object, is `undefined` too: nobody can tell it did not
 * advance, so it goes loud rather than being skipped.
 */
export function outcomeEpoch(
  command: "create" | "process" | "commitWon",
  outcome: unknown,
): number | undefined | null {
  if (command === "create") {
    if (!isRecord(outcome)) return undefined;
    const groupId = outcome.group_id;
    return typeof groupId === "string" && groupId !== "" ? 0 : undefined;
  }
  if (!isRecord(outcome)) return undefined;
  if (command === "process") {
    const kind = outcome.kind;
    if (kind === "duplicate" || kind === "ctl_received") return null;
    if (kind !== "welcome_joined" && kind !== "commit_applied") {
      return undefined;
    }
  }
  return isEpoch(outcome.epoch) ? outcome.epoch : undefined;
}

export interface KeyPushBackstop {
  /** Record every `callKeysChanged` push seen (before routing it on). */
  notePush(groupId: string, epoch: number): void;
  /**
   * The outcome epoch of an epoch-advancing command, called once the command
   * resolved (`outcomeEpoch`'s result; never call it for `null`).
   */
  afterResolve(groupId: string, epoch: number | undefined): void;
  /** Forget every push seen (a new Room / a new session). */
  reset(): void;
}

export interface KeyPushBackstopDeps {
  /**
   * The SAME handler a push drives (the session's `onLocalKeysChanged`). It
   * may return a promise; a rejection goes loud like a synchronous throw.
   */
  pull: (groupId: string, epoch: number) => void | PromiseLike<void>;
  /**
   * The loud path. `epoch` is `NaN` when the outcome carried no usable epoch.
   * Also called when `pull` throws or its promise rejects.
   */
  onLost: (groupId: string, epoch: number) => void;
}

export function createKeyPushBackstop(
  deps: KeyPushBackstopDeps,
): KeyPushBackstop {
  /** Highest epoch a push reached, per group. */
  const reached = new Map<string, number>();

  return {
    notePush(groupId, epoch) {
      // A push with no usable epoch proves nothing; the backstop for that
      // command's outcome then pulls.
      if (!isEpoch(epoch)) return;
      const known = reached.get(groupId);
      if (known === undefined || epoch > known) reached.set(groupId, epoch);
    },
    afterResolve(groupId, epoch) {
      if (!isEpoch(epoch) || groupId === "") {
        deps.onLost(groupId, typeof epoch === "number" ? epoch : Number.NaN);
        return;
      }
      const known = reached.get(groupId);
      if (known !== undefined && known >= epoch) return;
      let pulled: void | PromiseLike<void>;
      try {
        pulled = deps.pull(groupId, epoch);
      } catch {
        deps.onLost(groupId, epoch);
        return;
      }
      if (pulled && typeof pulled.then === "function") {
        pulled.then(undefined, () => deps.onLost(groupId, epoch));
      }
    },
    reset() {
      reached.clear();
    },
  };
}

type AnyMethod = (...args: unknown[]) => unknown;

/** `value.<key>` when `value` is an object and that member is a string. */
function stringField(value: unknown, key: string): string {
  if (!isRecord(value)) return "";
  const field = value[key];
  return typeof field === "string" ? field : "";
}

/**
 * Wrap the bridge handed to the session so every epoch-advancing call command
 * runs the backstop once it resolves (R4 / R12). Generic so this module stays
 * loadable without the real `E2EEBridge`.
 *
 * E2EEBridge keeps its state in `#private` fields, so the view forwards every
 * prototype member (methods, getters, setters; the nearest one wins) BOUND to
 * the real instance: a method called with `this` = the view would throw on its
 * first private read. The instance's own fields are inherited through the
 * view's prototype link. Only `callCreate`, `callCommitWon` and
 * `processEnvelope` differ (each only where the bridge has it), and each calls
 * the real method and returns or rethrows exactly what it did. A rejection
 * never reaches the backstop.
 *
 * Group ids (R12): `callCreate` → `created.payload.group_id`; `callCommitWon`
 * → its `groupId` argument; `processEnvelope` → `disp.outcome.group_id`, only
 * for a `"processed"` disposition. A group id that is not a string becomes ""
 * (the backstop's loud path). `afterResolve` runs through `deps.defer` (the
 * caller passes a macrotask) so the session records the outcome first; a
 * `null` outcome epoch (nothing advanced) defers nothing.
 */
export function backstopBridge<B extends object>(
  bridge: B,
  backstop: KeyPushBackstop,
  deps: { defer: (f: () => void) => void },
): B {
  const real = bridge as unknown as Record<PropertyKey, unknown>;
  const view = Object.create(bridge) as Record<PropertyKey, unknown>;
  for (
    let proto = Object.getPrototypeOf(bridge) as object | null;
    proto && proto !== Object.prototype;
    proto = Object.getPrototypeOf(proto) as object | null
  ) {
    for (const key of Reflect.ownKeys(proto)) {
      if (key === "constructor" || Object.hasOwn(view, key)) continue;
      const d = Object.getOwnPropertyDescriptor(proto, key);
      if (!d) continue;
      if (typeof d.value === "function") {
        Object.defineProperty(view, key, {
          value: (d.value as AnyMethod).bind(bridge),
          configurable: true,
        });
      } else if (d.get || d.set) {
        const { get, set } = d;
        Object.defineProperty(view, key, {
          get: get && (() => get.call(bridge)),
          set: set && ((value: unknown) => set.call(bridge, value)),
          configurable: true,
        });
      }
    }
  }

  const later = (groupId: string, epoch: number | undefined | null) => {
    if (epoch === null) return; // not an epoch-advancing outcome
    deps.defer(() => backstop.afterResolve(groupId, epoch));
  };
  /** The real method, called on the real instance at call time. */
  const callReal = (name: string, args: unknown[]): unknown =>
    (real[name] as AnyMethod).apply(bridge, args);

  const wrappers: Record<string, AnyMethod> = {
    async callCreate(...args) {
      const created = await callReal("callCreate", args);
      const payload = isRecord(created) ? created.payload : undefined;
      later(stringField(payload, "group_id"), outcomeEpoch("create", created));
      return created;
    },
    async callCommitWon(...args) {
      const outcome = await callReal("callCommitWon", args);
      const groupId = typeof args[0] === "string" ? args[0] : "";
      later(groupId, outcomeEpoch("commitWon", outcome));
      return outcome;
    },
    async processEnvelope(...args) {
      const disp = await callReal("processEnvelope", args);
      if (isRecord(disp) && disp.kind === "processed") {
        later(
          stringField(disp.outcome, "group_id"),
          outcomeEpoch("process", disp.outcome),
        );
      }
      return disp;
    },
  };
  for (const [name, wrapper] of Object.entries(wrappers)) {
    if (typeof real[name] !== "function") continue;
    Object.defineProperty(view, name, {
      value: wrapper,
      configurable: true,
      enumerable: true,
      writable: true,
    });
  }
  return view as unknown as B;
}

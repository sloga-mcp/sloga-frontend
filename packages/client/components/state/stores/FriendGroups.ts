import { batch } from "solid-js";

import { State } from "..";

import { AbstractStore } from ".";

/**
 * Most groups a user can have
 */
export const MAX_FRIEND_GROUPS = 50;

/**
 * Longest group name, counted in code points so a cap never splits an emoji
 */
export const MAX_FRIEND_GROUP_NAME = 40;

/**
 * Most users one group can hold
 */
export const MAX_FRIEND_GROUP_MEMBERS = 1000;

// Synced data is untrusted and a key may hold ~1 MiB, so clean() only looks
// at this many entries of a member list; past it the rest is ignored
const MAX_MEMBER_ENTRIES_SCANNED = MAX_FRIEND_GROUP_MEMBERS * 10;

// Same rule as ULID_RE in components/client/shellToMain.ts (uppercase
// Crockford ULID), copied so this store does not import the shell bridge
const USER_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export type TypeFriendGroups = {
  /**
   * Custom sections of the friends list, kept sorted with `order` = index
   */
  groups: { id: string; name: string; order: number }[];

  /**
   * User IDs in each group, keyed by group ID; every group has an entry
   */
  members: Record<string, string[]>;
};

export type FriendGroup = TypeFriendGroups["groups"][number];

// Ids come from crypto.randomUUID(). The pattern also keeps synced data from
// naming a group "__proto__", which would be read off the prototype chain
const GROUP_ID = /^[A-Za-z0-9-]{1,64}$/;

/**
 * Whether a value is a plain record (not null, not an array)
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Trim a group name and check its length
 * @param name Candidate name
 * @param truncate Cut an over-long name down instead of rejecting it
 * @returns Usable name, or null
 */
function groupName(name: unknown, truncate = false): string | null {
  if (typeof name !== "string") return null;

  const chars = Array.from(name.trim());
  if (chars.length === 0) return null;
  if (chars.length <= MAX_FRIEND_GROUP_NAME) return chars.join("");
  if (!truncate) return null;

  // the first character is not whitespace, so this is never empty
  return chars.slice(0, MAX_FRIEND_GROUP_NAME).join("").trimEnd();
}

/**
 * Handles the user's custom friend groups.
 *
 * Collapse state for a group's section lives in the `friends` store under
 * the key `group:<id>`.
 */
export class FriendGroups extends AbstractStore<
  "friend-groups",
  TypeFriendGroups
> {
  /**
   * Construct store
   * @param state State
   */
  constructor(state: State) {
    super(state, "friend-groups");
    this.create = this.create.bind(this);
    this.rename = this.rename.bind(this);
    this.remove = this.remove.bind(this);
    this.move = this.move.bind(this);
    this.assign = this.assign.bind(this);
  }

  /**
   * Get this store's value
   *
   * Reexported to allow equals checking for syncing
   */
  get() {
    return super.get();
  }

  /**
   * Hydrate external context
   */
  hydrate(): void {
    /** nothing needs to be done */
  }

  /**
   * Generate default values
   */
  default(): TypeFriendGroups {
    return {
      groups: [],
      members: {},
    };
  }

  /**
   * Validate the given data to see if it is compliant and return a compliant object
   *
   * The result must be a fixed point (cleaning it again changes nothing), as
   * sync compares cleaned remote data against the live store.
   */
  clean(input: Partial<TypeFriendGroups>): TypeFriendGroups {
    const friendGroups = this.default();
    const raw: Record<string, unknown> = isRecord(input) ? input : {};

    const seen = new Set<string>();
    const candidates: (FriendGroup & { index: number })[] = [];

    const groups = Array.isArray(raw.groups) ? raw.groups : [];
    groups.forEach((group: unknown, index) => {
      if (!isRecord(group)) return;

      const { id, order } = group;
      if (typeof id !== "string" || !GROUP_ID.test(id) || seen.has(id)) {
        return;
      }

      const name = groupName(group.name, true);
      if (name === null) return;

      seen.add(id);
      candidates.push({
        id,
        name,
        // a group without a usable position goes after the ones with one
        order:
          typeof order === "number" && Number.isFinite(order)
            ? order
            : Number.POSITIVE_INFINITY,
        index,
      });
    });

    candidates.sort((a, b) =>
      a.order === b.order ? a.index - b.index : a.order < b.order ? -1 : 1,
    );

    const members = isRecord(raw.members) ? raw.members : {};

    for (const { id, name } of candidates.slice(0, MAX_FRIEND_GROUPS)) {
      friendGroups.groups.push({
        id,
        name,
        order: friendGroups.groups.length,
      });

      const list = Object.prototype.hasOwnProperty.call(members, id)
        ? members[id]
        : undefined;

      // a Set keeps this linear; the scan and the result are both bounded
      const users = new Set<string>();
      if (Array.isArray(list)) {
        const end = Math.min(list.length, MAX_MEMBER_ENTRIES_SCANNED);
        for (let i = 0; i < end; i++) {
          const userId: unknown = list[i];
          if (typeof userId === "string" && USER_ID.test(userId)) {
            users.add(userId);
            if (users.size >= MAX_FRIEND_GROUP_MEMBERS) break;
          }
        }
      }

      friendGroups.members[id] = [...users];
    }

    return friendGroups;
  }

  /**
   * Whether a group exists
   * @param groupId Group ID
   */
  private has(groupId: string) {
    return this.get().groups.some((group) => group.id === groupId);
  }

  /**
   * Members of a group, read only through known groups so a stray key in
   * `members` is never reported
   * @param groupId Group ID
   */
  private list(groupId: string): readonly string[] {
    if (!this.has(groupId)) return [];

    const list = this.get().members[groupId];
    return Array.isArray(list) ? list : [];
  }

  /**
   * Write the groups back in the given order
   * @param groups Groups in display order
   */
  private setGroups(groups: readonly FriendGroup[]) {
    this.set(
      "groups",
      groups.map(({ id, name }, order) => ({ id, name, order })),
    );
  }

  /**
   * Create a new, empty group at the end of the list
   * @param name Group name, trimmed; 1 to 40 characters
   * @returns New group ID, or null if the name is unusable or the user
   * already has the maximum number of groups
   */
  create(name: string): string | null {
    const groupNameValue = groupName(name);
    if (groupNameValue === null) return null;

    const groups = this.ordered();
    if (groups.length >= MAX_FRIEND_GROUPS) return null;

    const id = crypto.randomUUID();

    // the members entry exists before anything can see the group
    batch(() => {
      this.set("members", id, []);
      this.setGroups([...groups, { id, name: groupNameValue, order: 0 }]);
    });

    return id;
  }

  /**
   * Rename a group
   * @param id Group ID
   * @param name New name, trimmed; 1 to 40 characters
   * @returns Whether the group was renamed
   */
  rename(id: string, name: string): boolean {
    const groupNameValue = groupName(name);
    if (groupNameValue === null) return false;

    const index = this.get().groups.findIndex((group) => group.id === id);
    if (index === -1) return false;

    this.set("groups", index, "name", groupNameValue);
    return true;
  }

  /**
   * Delete a group and its member list
   * @param id Group ID
   */
  remove(id: string): void {
    const groups = this.ordered();
    if (!groups.some((group) => group.id === id)) return;

    batch(() => {
      this.setGroups(groups.filter((group) => group.id !== id));

      // undefined deletes the key; the setter's types don't model deletion
      this.set("members", id, undefined as unknown as string[]);
    });
  }

  /**
   * Move a group to a new position in the list
   * @param id Group ID
   * @param toIndex Target position, clamped to the list
   */
  move(id: string, toIndex: number): void {
    if (typeof toIndex !== "number" || Number.isNaN(toIndex)) return;

    const groups = this.ordered();
    const from = groups.findIndex((group) => group.id === id);
    if (from === -1) return;

    const to = Math.min(Math.max(Math.trunc(toIndex), 0), groups.length - 1);
    if (to === from) return;

    const [group] = groups.splice(from, 1);
    groups.splice(to, 0, group);
    this.setGroups(groups);
  }

  /**
   * Add a user to a group or take them out of it
   * @param groupId Group ID
   * @param userId User ID
   * @param on Whether the user should be in the group
   * @returns Whether the user's membership now matches `on`; false for an
   * unknown group, a malformed user ID, or a group already at
   * MAX_FRIEND_GROUP_MEMBERS
   */
  assign(groupId: string, userId: string, on: boolean): boolean {
    // clean() drops anything else, so storing it would break the fixed point
    if (typeof userId !== "string" || !USER_ID.test(userId)) return false;
    if (!this.has(groupId)) return false;

    const list = this.list(groupId);
    const member = list.includes(userId);

    if (on && !member) {
      if (list.length >= MAX_FRIEND_GROUP_MEMBERS) return false;
      this.set("members", groupId, [...list, userId]);
    } else if (!on && member) {
      this.set(
        "members",
        groupId,
        list.filter((id) => id !== userId),
      );
    }

    return true;
  }

  /**
   * Groups a user is in
   * @param userId User ID
   * @returns Group IDs in display order
   */
  groupsOf(userId: string): string[] {
    return this.ordered()
      .filter((group) => this.list(group.id).includes(userId))
      .map((group) => group.id);
  }

  /**
   * All groups in display order
   * @returns Copies of the groups
   */
  ordered(): FriendGroup[] {
    return this.get()
      .groups.map(({ id, name, order }) => ({ id, name, order }))
      .sort((a, b) => a.order - b.order);
  }

  /**
   * Users in a group
   * @param groupId Group ID
   * @returns Copy of the member list; empty for an unknown group
   */
  membersOf(groupId: string): string[] {
    return [...this.list(groupId)];
  }

  /**
   * Whether a user is in a group
   * @param groupId Group ID
   * @param userId User ID
   */
  isMember(groupId: string, userId: string): boolean {
    return this.list(groupId).includes(userId);
  }
}

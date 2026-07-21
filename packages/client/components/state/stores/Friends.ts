import { State } from "..";

import { AbstractStore } from ".";

export interface TypeFriends {
  /**
   * User IDs pinned to the top of the friends list
   */
  favourites: string[];

  /**
   * Section keys the user has collapsed
   */
  collapsed: string[];
}

/**
 * Handles per-user presentation of the friends list.
 */
export class Friends extends AbstractStore<"friends", TypeFriends> {
  /**
   * Construct store
   * @param state State
   */
  constructor(state: State) {
    super(state, "friends");
    this.toggleFavourite = this.toggleFavourite.bind(this);
    this.toggleCollapsed = this.toggleCollapsed.bind(this);
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
  default(): TypeFriends {
    return {
      favourites: [],
      collapsed: [],
    };
  }

  /**
   * Validate the given data to see if it is compliant and return a compliant object
   */
  clean(input: Partial<TypeFriends>): TypeFriends {
    const friends = this.default();

    for (const key of ["favourites", "collapsed"] as const) {
      const values = input[key];
      if (!Array.isArray(values)) continue;

      for (const value of values) {
        if (typeof value === "string" && !friends[key].includes(value)) {
          friends[key].push(value);
        }
      }
    }

    return friends;
  }

  /**
   * Whether a user is marked as a favourite
   * @param userId User ID
   */
  isFavourite(userId: string) {
    return this.get().favourites.includes(userId);
  }

  /**
   * Add or remove a user from favourites
   * @param userId User ID
   */
  toggleFavourite(userId: string) {
    const favourites = this.get().favourites;

    this.set(
      "favourites",
      favourites.includes(userId)
        ? favourites.filter((id) => id !== userId)
        : [...favourites, userId],
    );
  }

  /**
   * Whether a section of the list is collapsed
   * @param section Section key
   */
  isCollapsed(section: string) {
    return this.get().collapsed.includes(section);
  }

  /**
   * Expand or collapse a section of the list
   * @param section Section key
   */
  toggleCollapsed(section: string) {
    const collapsed = this.get().collapsed;

    this.set(
      "collapsed",
      collapsed.includes(section)
        ? collapsed.filter((key) => key !== section)
        : [...collapsed, section],
    );
  }
}

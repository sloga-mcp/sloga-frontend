import { State } from "..";

import { AbstractStore } from ".";
import {
  type HomeBlockId,
  type HomeColumn,
  type HomeMove,
  type TypeHomeLayout,
  applyDrop,
  cleanHomeLayout,
  columnOf,
  defaultHomeLayout,
  moveBlock,
  sameHomeLayout,
  setBlockHidden,
  shownBlocks,
} from "./homeLayoutRules";

export type { TypeHomeLayout };

/**
 * Where each card sits on the Home page and which ones are switched off.
 *
 * Synced, so the arrangement follows the account to every device; the rules
 * (and the cleaning of synced data) live in `homeLayoutRules.ts`.
 */
export class HomeLayout extends AbstractStore<"home-layout", TypeHomeLayout> {
  /**
   * Construct store
   * @param state State
   */
  constructor(state: State) {
    super(state, "home-layout");
    this.drop = this.drop.bind(this);
    this.move = this.move.bind(this);
    this.setHidden = this.setHidden.bind(this);
    this.reset = this.reset.bind(this);
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
  default(): TypeHomeLayout {
    return defaultHomeLayout();
  }

  /**
   * Validate the given data to see if it is compliant and return a compliant object
   */
  clean(input: Partial<TypeHomeLayout>): TypeHomeLayout {
    return cleanHomeLayout(input);
  }

  /**
   * Store a layout the rules produced, unless nothing changed. Compared by
   * value: every write is synced, and a drop back in place or Reset on the
   * default layout builds new lists with the same cards in them.
   * @param next New layout
   */
  private write(next: TypeHomeLayout) {
    if (sameHomeLayout(next, this.get())) return;
    this.set({ main: next.main, side: next.side, hidden: next.hidden });
  }

  /**
   * Cards a column draws right now, in order
   * @param column Column
   * @param available Whether a card has anything to show
   */
  shown(
    column: HomeColumn,
    available: (id: HomeBlockId) => boolean,
  ): HomeBlockId[] {
    return shownBlocks(this.get(), column, available);
  }

  /**
   * The column a card is in
   * @param id Card
   */
  columnOf(id: HomeBlockId): HomeColumn | undefined {
    return columnOf(this.get(), id);
  }

  /**
   * Whether a card is switched off
   * @param id Card
   */
  isHidden(id: HomeBlockId): boolean {
    return this.get().hidden.includes(id);
  }

  /**
   * Apply a drag: the order a column now draws
   * @param column Column the card was dropped in
   * @param ids Card ids the column draws, in order
   * @param shown Cards that were drawn (in either column) before the drop
   */
  drop(column: HomeColumn, ids: string[], shown: ReadonlySet<HomeBlockId>) {
    // A move between columns arrives as two drops, one per column, in either
    // order. Cleaning after each keeps the stored layout whole in between: a
    // card the first drop took out goes back to its default column until the
    // second drop places it.
    this.write(cleanHomeLayout(applyDrop(this.get(), column, ids, shown)));
  }

  /**
   * Move a card from its menu
   * @param id Card
   * @param move Up, down or to the other column
   * @param shown Cards drawn right now
   */
  move(id: HomeBlockId, move: HomeMove, shown: ReadonlySet<HomeBlockId>) {
    this.write(moveBlock(this.get(), id, move, shown));
  }

  /**
   * Switch a card off or back on
   * @param id Card
   * @param hidden Whether it should be hidden
   */
  setHidden(id: HomeBlockId, hidden: boolean) {
    this.write(setBlockHidden(this.get(), id, hidden));
  }

  /**
   * Put every card back where it started and switch them all on
   */
  reset() {
    this.write(defaultHomeLayout());
  }
}

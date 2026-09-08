import { dndzone } from "solid-dnd-directive";
import {
  Accessor,
  For,
  JSX,
  Setter,
  createEffect,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";

import { claimSlideGesture } from "../navigation/SlideDrawer";

interface Props<T> {
  type?: string;
  items: Item<T>[];
  disabled?: boolean;
  dragHandles?: boolean;
  children: (item: {
    item: T;
    dragDisabled: Accessor<boolean>;
    setDragDisabled: Setter<boolean>;
  }) => JSX.Element;
  onChange: (ids: string[]) => void;
  minimumDropAreaHeight?: string;
}

type Item<T> = { id: string } & T;

/**
 * How long a finger has to rest on a row before it picks the row up.
 *
 * Long enough that flicking the list past does not trip it, short enough that
 * somebody deliberately holding does not give up first.
 */
const LONG_PRESS_MS = 400;

/**
 * How far the finger may drift during that hold before it counts as a scroll
 * rather than a press.
 */
const LONG_PRESS_SLOP_PX = 10;

/**
 * The dnd zone library requires you to have an id key
 */
interface ContainerItem<T> {
  id: string;
  item: T;
}

interface DragHandleEvent<T> {
  detail: {
    items: ContainerItem<T>[];
  };
  type: "consider" | "finalize";
}

/**
 * Typescript removes dndzone because it thinks that it is not being used.
 * This trick prevents that from happening.
 * https://github.com/solidjs/solid/issues/1005#issuecomment-1134778606
 */
void dndzone;

/**
 * Resolve the row a touch landed in, i.e. the direct child of the drop zone
 * that contains the element the finger is actually over
 */
function rowOf(target: EventTarget | null) {
  let el = target instanceof Element ? target : null;
  while (el && !el.parentElement?.hasAttribute("data-dnd-zone"))
    el = el.parentElement;
  return (el as HTMLElement | null) ?? undefined;
}

/**
 * Start the drop zone's own pointer drag for a touch that is already down.
 *
 * The library only ever begins a drag from a `touchstart` or `mousedown` on the
 * row, and it only listens for those while dragging is enabled. Enabling it is
 * what the handle and the press-and-hold below both do — but by then the touch
 * that enabled it has bubbled past, so nothing is left to start the drag.
 * Replaying the touch is what turns a hold, or a touch on the handle, into a
 * drag inside the same gesture; every `touchmove` after it is picked up by the
 * window listeners the library adds in response.
 *
 * A mouse press stands in where `TouchEvent` cannot be constructed (older
 * WebKit). It arms the same code path, but the library then also watches
 * `mousemove`, so on a device that has both a finger and a pointer an idle
 * mouse twitch can start the drag early.
 */
function beginPointerDrag(row: HTMLElement, touch: Touch) {
  try {
    row.dispatchEvent(
      new TouchEvent("touchstart", {
        bubbles: true,
        cancelable: true,
        touches: [touch],
        targetTouches: [touch],
        changedTouches: [touch],
      }),
    );
  } catch {
    row.dispatchEvent(
      new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
        clientX: touch.clientX,
        clientY: touch.clientY,
      }),
    );
  }
}

/**
 * The gesture currently handed to a drag, if any
 */
let claimedGesture: (() => void) | undefined;

/**
 * Take the current touch gesture for a drag until the finger lifts.
 *
 * Two things want it otherwise: the slide drawers, which read its sideways
 * component as a page swipe, and the click the browser synthesises at the end
 * of it, which would open whatever the row navigates to.
 */
function claimTouchGesture() {
  if (claimedGesture) return;

  const releaseDrawers = claimSlideGesture();
  const blockClick = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  window.addEventListener("click", blockClick, true);

  const end = () => {
    window.removeEventListener("touchend", end);
    window.removeEventListener("touchcancel", end);
    releaseDrawers();
    claimedGesture = undefined;
    // the click lands after touchend, so the blocker has to outlive it
    setTimeout(() => window.removeEventListener("click", blockClick, true), 50);
  };

  window.addEventListener("touchend", end);
  window.addEventListener("touchcancel", end);
  claimedGesture = end;
}

/**
 * Draggable list container
 */
export function Draggable<T>(props: Props<T>) {
  const [dragDisabled, setDragDisabled] = createSignal(
    // eslint-disable-next-line solid/reactivity
    props.dragHandles || false,
  );

  const [containerItems, setContainerItems] = createSignal<ContainerItem<T>[]>(
    [],
  );

  let zone!: HTMLDivElement;
  let dragging = false;

  createEffect(() => setDragDisabled(props.dragHandles || false));

  createEffect(() => {
    const newContainerItems = props.items.map((item) => ({
      id: item.id,
      item,
    }));

    setContainerItems(newContainerItems);
  });

  /**
   * Handle DND event from solid-dnd-directive
   * @param e
   */
  function handleDndEvent(e: DragHandleEvent<T>) {
    dragging = e.type === "consider";
    setDragDisabled(props.dragHandles || false);

    const { items: newContainerItems } = e.detail;
    setContainerItems(newContainerItems);

    if (e.type === "finalize") {
      props.onChange(
        newContainerItems.map((containerItems) => containerItems.id),
      );
    }
  }

  function isDisabled() {
    return props.disabled || dragDisabled();
  }

  onMount(() => {
    // Press and hold anywhere on a row to pick it up.
    //
    // The handle is a pointer affordance: on a phone it is a 20px target and
    // the rest of the row does nothing, so the natural gesture — hold the row
    // and move it — reached the settings drawer instead and swiped the whole
    // page away. Holding arms exactly the drag the handle arms, so this is
    // offered wherever handles are.
    if (!props.dragHandles) return;

    let timer: ReturnType<typeof setTimeout> | undefined;
    let row: HTMLElement | undefined;
    let point: Touch | undefined;
    let id = -1;
    let startX = 0,
      startY = 0;

    /**
     * Give up on the hold that is being timed, without touching a drag that
     * has already started from it
     */
    function stopTimer() {
      clearTimeout(timer);
      timer = undefined;
      row = undefined;
      point = undefined;
    }

    /**
     * Stop following this gesture entirely
     */
    function detach() {
      stopTimer();
      window.removeEventListener("touchmove", move);
      window.removeEventListener("touchend", end);
      window.removeEventListener("touchcancel", end);
    }

    /**
     * Find the touch this gesture is tracking
     */
    function tracked(touches: TouchList) {
      for (let i = 0; i < touches.length; i++)
        if (touches[i].identifier === id) return touches[i];
    }

    function pickUp() {
      const target = row,
        at = point;
      stopTimer();
      if (!target || !at || props.disabled || dragging) return;

      claimTouchGesture();
      // arms the drop zone's own pointer listeners, synchronously
      setDragDisabled(false);
      navigator.vibrate?.(8);
      beginPointerDrag(target, at);
    }

    function move(e: TouchEvent) {
      if (!timer) return;
      const touch = tracked(e.changedTouches);
      if (!touch) return;

      point = touch;

      // a finger that travels is scrolling the list, not picking a row up
      if (
        Math.abs(touch.clientX - startX) > LONG_PRESS_SLOP_PX ||
        Math.abs(touch.clientY - startY) > LONG_PRESS_SLOP_PX
      )
        detach();
    }

    function end(e: TouchEvent) {
      if (!tracked(e.changedTouches)) return;
      detach();

      // a hold that never became a drag leaves the list armed; re-arm the
      // handle so the next touch scrolls instead of dragging. No-op while a
      // drag is running, which already reset this on its first event.
      if (!dragging) setDragDisabled(props.dragHandles || false);
    }

    function start(e: TouchEvent) {
      if (timer || dragging || props.disabled || e.touches.length !== 1) return;

      const target = rowOf(e.target);
      if (!target) return;

      const touch = e.touches[0];
      id = touch.identifier;
      startX = touch.clientX;
      startY = touch.clientY;
      point = touch;
      row = target;

      window.addEventListener("touchmove", move, { passive: true });
      window.addEventListener("touchend", end);
      window.addEventListener("touchcancel", end);
      timer = setTimeout(pickUp, LONG_PRESS_MS);
    }

    zone.addEventListener("touchstart", start, { passive: true });
    onCleanup(() => {
      zone.removeEventListener("touchstart", start);
      detach();
    });
  });

  return (
    <div
      ref={zone}
      data-dnd-zone
      use:dndzone={{
        type: props.type,
        items: containerItems,
        dragDisabled: isDisabled,
        flipDurationMs: 0,
        // transformDraggedElement: (el?: HTMLElement) => {
        //   if (el) {
        //     el.style.cursor = "grabbing !important";
        //     el.style.outline = "1px solid red";
        //   }
        // },
        dropTargetStyle: {
          outline:
            "2px solid color-mix(in srgb, 40% var(--md-sys-color-primary), transparent)",
          borderRadius: "4px",
          outlineOffset: "-2px",
          minHeight: "24px",
        },
      }}
      // @ts-expect-error missing jsx typing
      on:consider={handleDndEvent}
      on:finalize={handleDndEvent}
    >
      <For each={containerItems()}>
        {(containerItem) =>
          props.children({
            item: containerItem.item,
            dragDisabled,
            setDragDisabled,
          })
        }
      </For>
    </div>
  );
}

export function createDragHandle(
  dragDisabled: Accessor<boolean>,
  setDragDisabled: Setter<boolean>,
) {
  function startDrag(e: Event) {
    e.preventDefault();
    setDragDisabled(false);
  }

  function endDrag() {
    setDragDisabled(true);
  }

  /**
   * Touching the handle has to do more than enable dragging.
   *
   * On a pointer the handle is hovered before it is pressed, so enabling on
   * `mouseenter` leaves the drop zone listening by the time `mousedown` lands.
   * A finger has no hover: the touch that enables dragging is the same one that
   * is meant to start it, and it has already gone by. So start the drag here,
   * and hold the gesture off the drawers for as long as it lasts.
   */
  function startTouchDrag(e: TouchEvent) {
    setDragDisabled(false);

    const row = rowOf(e.currentTarget);
    const touch = e.touches[0];
    if (!row || !touch) return;

    claimTouchGesture();
    beginPointerDrag(row, touch);

    // put the handle back on its guard once the finger lifts; a drag that got
    // going has already done this itself, and setting it twice costs nothing
    const rearm = () => {
      window.removeEventListener("touchend", rearm);
      window.removeEventListener("touchcancel", rearm);
      setDragDisabled(true);
    };
    window.addEventListener("touchend", rearm);
    window.addEventListener("touchcancel", rearm);
  }

  function handleKeyDown(e: KeyboardEvent) {
    if ((e.key === "Enter" || e.key === " ") && dragDisabled())
      setDragDisabled(false);
  }

  return {
    tabindex: dragDisabled() ? 0 : -1,
    onmouseenter: startDrag,
    ontouchstart: startTouchDrag,
    onmouseleave: endDrag,
    onkeydown: handleKeyDown,
    "aria-label": "drag-handle",
  };
}

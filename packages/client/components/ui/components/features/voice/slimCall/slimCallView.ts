import { createSignal } from "solid-js";

// Whether the user has minimised the Slim view call screen back to the docked
// call card. There is one signal for the whole page, so the call screen, the
// call card and the Android Back handler all read and write the same value.
// The rules that use it are in `slimCallPolicy.ts`.
const [minimised, setMinimised] = createSignal(false);

/**
 * Whether the Slim view call screen is minimised. Reading it inside a memo,
 * an effect or JSX tracks it like any other signal.
 * @returns The minimised flag
 */
export function slimCallMinimised(): boolean {
  return minimised();
}

/**
 * Sets whether the Slim view call screen is minimised.
 * @param v The new value
 */
export function setSlimCallMinimised(v: boolean): void {
  setMinimised(v);
}

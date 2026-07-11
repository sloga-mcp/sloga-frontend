/**
 * MediaRecorder blobs are streamed containers with no duration header, so
 * players report `Infinity` and the seek bar is unusable. Seeking far past
 * the end forces the browser to scan the container and compute the real
 * duration, after which we rewind to the start.
 */
export function fixBlobDuration(el: HTMLMediaElement) {
  el.addEventListener("loadedmetadata", () => {
    if (el.duration !== Infinity) return;

    el.currentTime = 1e101;
    el.addEventListener(
      "timeupdate",
      () => {
        el.currentTime = 0;
      },
      { once: true },
    );
  });
}

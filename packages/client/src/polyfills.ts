/**
 * Polyfills for older webviews. The Android system WebView can lag years
 * behind Chrome (ES2023 array methods landed in Chrome 110); without these,
 * message rendering dies silently on such devices.
 *
 * Non-enumerable via defineProperty, matching native behaviour.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

if (!Array.prototype.toSorted) {
  Object.defineProperty(Array.prototype, "toSorted", {
    value: function (compareFn?: (a: any, b: any) => number) {
      return [...this].sort(compareFn);
    },
    writable: true,
    configurable: true,
  });
}

if (!Array.prototype.toReversed) {
  Object.defineProperty(Array.prototype, "toReversed", {
    value: function () {
      return [...this].reverse();
    },
    writable: true,
    configurable: true,
  });
}

if (!Array.prototype.toSpliced) {
  Object.defineProperty(Array.prototype, "toSpliced", {
    value: function (start: number, deleteCount?: number, ...items: any[]) {
      const copy = [...this];
      copy.splice(start, deleteCount as number, ...items);
      return copy;
    },
    writable: true,
    configurable: true,
  });
}

if (!Array.prototype.with) {
  Object.defineProperty(Array.prototype, "with", {
    value: function (index: number, value: any) {
      const copy = [...this];
      copy[index < 0 ? copy.length + index : index] = value;
      return copy;
    },
    writable: true,
    configurable: true,
  });
}

export {};

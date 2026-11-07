import { type Accessor, createSignal } from "solid-js";

import type { WatchZip } from "./folderAttachments";

/** A folder being zipped, shown as a placeholder in the attachment strip */
export interface ZipJob {
  id: number;
  /** Folder name; the attachment will be `<name>.zip` */
  name: string;
  /** Fraction read (0 to 1), or null while the folder is still listed */
  fraction: Accessor<number | null>;
  /** Stop zipping; the folder is not attached and nothing is reported */
  cancel(): void;
}

interface OwnedJob extends ZipJob {
  owner: object;
}

const [jobs, setJobs] = createSignal<OwnedJob[]>([]);
let nextId = 0;

/**
 * Track zips started for one owner (a composer), so its strip shows them
 * and no other composer's does
 * @param owner Any object unique to the composer
 * @returns Watcher to hand to the folder resolvers
 */
export function watchZips(owner: object): WatchZip {
  return (name) => {
    const [fraction, setFraction] = createSignal<number | null>(null);
    const controller = new AbortController();
    const remove = () =>
      setJobs((list) => list.filter((entry) => entry !== job));

    const job: OwnedJob = {
      id: ++nextId,
      owner,
      name,
      fraction,
      cancel() {
        controller.abort();
        // Gone at once: the zip notices between reads and then calls done
        remove();
      },
    };
    setJobs((list) => [...list, job]);

    return {
      signal: controller.signal,
      progress(value) {
        // Whole percent steps: a 4 MB read per update is plenty, but there
        // is no point re-rendering for a change nobody can see
        const rounded = value === null ? null : Math.floor(value * 100) / 100;
        if (rounded !== fraction()) setFraction(rounded);
      },
      done: remove,
    };
  };
}

/**
 * Zips in progress for an owner
 * @param owner Owner passed to `watchZips`
 * @returns Jobs, in start order
 */
export function zipJobs(owner: object): ZipJob[] {
  return jobs().filter((job) => job.owner === owner);
}

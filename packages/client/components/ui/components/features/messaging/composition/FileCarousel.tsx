import { For, Match, Show, Switch } from "solid-js";

import { useLingui } from "@lingui-solid/solid/macro";
import { cva } from "styled-system/css";
import { styled } from "styled-system/jsx";

import { CONFIGURATION } from "@revolt/common";
import { ALLOWED_IMAGE_TYPES } from "@revolt/state/stores/Draft";
import { Ripple, typography } from "@revolt/ui/components/design";
import { OverflowingText, iconSize } from "@revolt/ui/components/utils";

import MdAdd from "@material-design-icons/svg/outlined/add.svg?component-solid";
import MdCancel from "@material-design-icons/svg/outlined/cancel.svg?component-solid";
import MdFile from "@material-design-icons/svg/outlined/description.svg?component-solid";
import MdFolderUpload from "@material-design-icons/svg/outlined/drive_folder_upload.svg?component-solid";
import MdEdit from "@material-design-icons/svg/outlined/edit.svg?component-solid";

interface Props {
  /**
   * Files to display in carousel
   */
  files: string[];

  /**
   * Get file by ID
   * @param fileId ID
   */
  getFile(fileId: string): {
    file: File;
    dataUri?: string;
  };

  /**
   * Invoke file picker to add file
   */
  addFile(): void;

  /**
   * Invoke folder picker to add a folder as a zip (omitted where folders
   * can't be picked)
   */
  addFolder?(): void;

  /**
   * Remove file by ID
   * @param fileId ID
   */
  removeFile(fileId: string): void;

  /**
   * Open the image editor for a file (images only)
   * @param fileId ID
   */
  editFile(fileId: string): void;
}

/**
 * Determine file size
 * @param size Bytes
 * @returns Human-readable size
 */
export function determineFileSize(size: number) {
  if (size > 1e6) {
    return `${(size / 1e6).toFixed(2)} MB`;
  } else if (size > 1e3) {
    return `${(size / 1e3).toFixed(2)} KB`;
  }

  return `${size} B`;
}

/**
 * File carousel
 */
export function FileCarousel(props: Props) {
  const { t } = useLingui();

  return (
    <Show when={props.files.length}>
      <Container>
        <div class={carousel()} use:scrollable={{ direction: "x" }}>
          <For each={props.files}>
            {(id, index) => {
              /**
               * Get the actual file
               */
              const file = () => props.getFile(id);

              /**
               * Whether this entry is an image (previewable)
               */
              const isImage = () =>
                ALLOWED_IMAGE_TYPES.includes(file().file.type);

              /**
               * Editable images exclude GIFs — the editor flattens to a
               * still frame, which would silently drop the animation
               */
              const isEditable = () =>
                isImage() && file().file.type !== "image/gif";

              return (
                <>
                  <Show when={index() === CONFIGURATION.MAX_ATTACHMENTS}>
                    <Divider />
                  </Show>

                  <Entry ignored={index() >= CONFIGURATION.MAX_ATTACHMENTS}>
                    <PreviewBox image={isImage()}>
                      <Switch
                        fallback={
                          <EmptyEntry>
                            <MdFile {...iconSize(36)} />
                          </EmptyEntry>
                        }
                      >
                        <Match when={isImage()}>
                          <Image
                            src={file().dataUri}
                            alt={file().file.name}
                            loading="eager"
                          />
                        </Match>
                      </Switch>
                      <Overlay>
                        <Show when={isEditable()}>
                          <OverlayAction
                            type="button"
                            aria-label={t`Edit image`}
                            onClick={() => props.editFile(id)}
                          >
                            <MdEdit {...iconSize(28)} />
                          </OverlayAction>
                        </Show>
                        <OverlayAction
                          type="button"
                          aria-label={t`Remove attachment`}
                          onClick={() => props.removeFile(id)}
                        >
                          <MdCancel {...iconSize(28)} />
                        </OverlayAction>
                      </Overlay>
                    </PreviewBox>
                    <FileName>
                      <OverflowingText>{file().file.name}</OverflowingText>
                    </FileName>
                    <Size>{determineFileSize(file().file.size)}</Size>
                  </Entry>
                </>
              );
            }}
          </For>
          <EmptyEntry onClick={props.addFile}>
            <Ripple />
            <MdAdd {...iconSize(48)} />
          </EmptyEntry>
          <Show when={props.addFolder}>
            {(addFolder) => (
              <EmptyEntry
                role="button"
                aria-label={t`Attach folder`}
                title={t`Attach folder`}
                onClick={() => addFolder()()}
              >
                <Ripple />
                <MdFolderUpload {...iconSize(40)} />
              </EmptyEntry>
            )}
          </Show>
        </div>
      </Container>
    </Show>
  );
}

/**
 * Image preview container
 */
const PreviewBox = styled("div", {
  base: {
    display: "grid",
    justifyItems: "center",
    gridTemplate: `"main" var(--preview-size) / minmax(var(--preview-size), 1fr)`,

    overflow: "hidden",
    borderRadius: "var(--gap-md)",

    fill: "white",
    background: "var(--md-sys-color-surface-variant)",

    "& > *": {
      gridArea: "main",
    },
  },
  variants: {
    image: {
      true: {},
    },
  },
});

/**
 * Image preview
 */
const Image = styled("img", {
  base: {
    width: "100%",
    objectFit: "cover",
    marginBottom: "var(--gap-md)",
    height: "var(--preview-size)",
  },
});

/**
 * Overlay container
 */
const Overlay = styled("div", {
  base: {
    zIndex: 1,

    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "var(--gap-md)",

    width: "100%",
    height: "100%",

    opacity: 0,
    color: "white",
    background: "rgba(0, 0, 0, 0.8)",
    transition: "var(--transitions-fast) opacity",

    "&:hover": {
      opacity: 1,
    },

    // no hover on touch devices; keep the actions visible instead
    "@media (pointer: coarse)": {
      opacity: 1,
      background: "rgba(0, 0, 0, 0.5)",
    },
  },
});

/**
 * Individual action button on the preview overlay
 */
const OverlayAction = styled("button", {
  base: {
    display: "grid",
    placeItems: "center",

    padding: "var(--gap-sm)",
    border: "none",
    borderRadius: "var(--borderRadius-lg)",

    cursor: "pointer",
    color: "white",
    fill: "white",
    background: "transparent",
    transition: "var(--transitions-fast) background",

    "&:hover": {
      background: "rgba(255, 255, 255, 0.2)",
    },
  },
});

/**
 * Empty entry container
 */
const EmptyEntry = styled("div", {
  base: {
    position: "relative",

    display: "grid",
    flexShrink: 0,
    placeItems: "center",
    width: "var(--preview-size)",
    height: "var(--preview-size)",

    cursor: "pointer",
    borderRadius: "var(--gap-md)",
    fill: "var(--md-sys-color-on-surface-variant)",
    background: "var(--md-sys-color-surface-variant)",
  },
});

/**
 * Carousel entry container
 */
const Entry = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    flexDirection: "column",
    opacity: 1,
  },
  variants: {
    ignored: {
      true: {
        opacity: 0.4,
      },
    },
  },
});

/**
 * File name information
 */
const FileName = styled("span", {
  base: {
    maxWidth: "var(--preview-size)",
    textAlign: "center",

    ...typography.raw({ class: "label" }),
  },
});

/**
 * File size information
 */
const Size = styled("span", {
  base: {
    ...typography.raw({ class: "label", size: "small" }),
  },
});

/**
 * Divider between files to be uploaded and files for next upload
 */
const Divider = styled("div", {
  base: {
    height: "130px",
    flexShrink: 0,
    width: "var(--gap-sm)",
    borderRadius: "var(--borderRadius-md)",
    background: "var(--md-sys-color-outline)",
  },
});

/**
 * Inner carousel container
 */
const carousel = cva({
  base: {
    display: "flex",
    flexShrink: 0,
    flexDirection: "row",
    overflowX: "auto !important",
    gap: "var(--gap-md)",
  },
});

/**
 * Outer carousel container
 */
const Container = styled("div", {
  base: {
    display: "flex",
    userSelect: "none",
    flexDirection: "column",

    width: "fit-content",
    maxWidth: "100%",

    gap: "var(--gap-md)",
    padding: "var(--gap-md)",
    margin: "var(--gap-md) 0",
    borderRadius: "var(--borderRadius-lg)",

    // Sloga logo dark-blue satellite
    background: "#2B2BD8",
    color: "white",

    "--preview-size": "100px",
  },
});

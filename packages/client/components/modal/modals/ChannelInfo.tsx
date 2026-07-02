import { Trans } from "@lingui-solid/solid/macro";

import { Markdown } from "@revolt/markdown";
import { Dialog, DialogProps } from "@revolt/ui";

import { parseChannelPassword } from "../../../src/lib/channelPassword";
import { Modals } from "../types";

export function ChannelInfoModal(
  props: DialogProps & Modals & { type: "channel_info" },
) {
  const { cleanDescription } = parseChannelPassword(props.channel.description);
  return (
    <Dialog
      show={props.show}
      onClose={props.onClose}
      title={`#${props.channel.name}`}
      actions={[{ text: <Trans>Close</Trans> }]}
    >
      <Markdown content={cleanDescription} />
    </Dialog>
  );
}

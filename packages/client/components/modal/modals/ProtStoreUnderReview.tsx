import { Trans, useLingui } from "@lingui-solid/solid/macro";

import { Dialog, DialogProps, Text } from "@revolt/ui";

import { Modals } from "../types";

/**
 * An in-app Prot purchase the launch recovery found held for staff review:
 * crediting it would take the wallet over its cap (S6 R66). ProtStoreWorker
 * opens it once per purchase per device; the purchase stays unfinished in
 * the store either way. The body is the shop's own under-review note, word
 * for word, and nothing about the purchase itself is shown.
 */
export function ProtStoreUnderReviewModal(
  props: DialogProps & Modals & { type: "prot_store_under_review" },
) {
  const { t } = useLingui();

  return (
    <Dialog
      show={props.show}
      onClose={props.onClose}
      title={<Trans>Purchase under review</Trans>}
      actions={[{ text: <Trans>OK</Trans> }]}
    >
      <Text>
        {t`This purchase is under review because it would take your Prot wallet over its limit. We'll add the Prot or help you get a refund.`}
      </Text>
    </Dialog>
  );
}

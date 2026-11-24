/**
 * Why a watch-together write was refused for not being encrypted. The
 * refusal (the SDK's guard or the server) reaches the overlay as the bare
 * type `EncryptionRequired`, without a side, so the reason is read from the
 * policy instead. Pure, so `node --test` loads it (`watchRefusal.test.ts`).
 */
import { ENCRYPTION_REQUIRED_ERROR_TYPE } from "../../../../../client/apiErrorType.ts";
import {
  type BlockReason,
  type PlainWriteInput,
  guardReason,
} from "../../../../../client/encryptedOnlyPolicy.ts";

/**
 * The reason to show for a watch error.
 * @param errorType The watch store's error type
 * @param input The policy facts for the call's channel, if there is one
 * @returns The reason, or `null` when the error is another one or the
 * policy names none (the caller shows the error's own words)
 */
export function watchRefusalReason(
  errorType: string | undefined,
  input: PlainWriteInput | undefined,
): BlockReason | null {
  if (errorType !== ENCRYPTION_REQUIRED_ERROR_TYPE || !input) return null;
  return guardReason("watch", input);
}

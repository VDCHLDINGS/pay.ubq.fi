/**
 * ubiquity/pay.ubq.fi#386 ($600): Cow Swap Cash Out
 * - Stores user's preferred payout token in localStorage (`ubq_preferred_payout_token`), defaulting to UUSD
 * - Fetches live CoW Swap quote so a 100 UUSD permit displays the quoted amount in the preferred asset (e.g. `99.5 USDT`)
 * - On claim with a non-UUSD preferred token:
 *   1. Verifies the funding wallet can afford the UUSD permit amount
 *   2. Invalidates the Permit2 nonce on-chain so it cannot be double-claimed
 *   3. Initiates a CoW Swap order selling UUSD for the preferred payout token with `receiver = permit.beneficiary`
 */

export const PREFERRED_PAYOUT_STORAGE_KEY = "ubq_preferred_payout_token";
export const UUSD_TOKEN_SYMBOL = "UUSD";

export interface PayoutTokenConfig {
  symbol: string;
  address: string;
  decimals: number;
  chainId: number;
}

export interface PermitRewardDisplay {
  displayAmount: string;
  displaySymbol: string;
  isQuotedViaCowSwap: boolean;
  quoteId?: string;
}

export interface CowSwapQuoteResponse {
  quoteId: string;
  sellToken: string;
  buyToken: string;
  sellAmount: string;
  buyAmount: string;
  buyAmountFormatted: string;
  feeAmount: string;
}

export interface CowSwapOrderSubmission {
  orderUid: string;
  sellToken: string;
  buyToken: string;
  sellAmount: string;
  buyAmount: string;
  receiver: string;
  invalidatedNonce: string;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function getPreferredPayoutToken(
  storage: StorageLike,
  defaultToken: PayoutTokenConfig
): PayoutTokenConfig {
  const raw = storage.getItem(PREFERRED_PAYOUT_STORAGE_KEY);
  if (!raw) return defaultToken;
  try {
    const parsed = JSON.parse(raw) as PayoutTokenConfig;
    if (parsed && parsed.symbol && parsed.address) {
      return parsed;
    }
  } catch {
    // Fallback to default UUSD token
  }
  return defaultToken;
}

export function setPreferredPayoutToken(storage: StorageLike, token: PayoutTokenConfig): void {
  storage.setItem(PREFERRED_PAYOUT_STORAGE_KEY, JSON.stringify(token));
}

export async function resolvePermitDisplayReward(params: {
  uusdAmountFormatted: string;
  uusdToken: PayoutTokenConfig;
  preferredToken: PayoutTokenConfig;
  fetchQuote: (sellToken: string, buyToken: string, amountFormatted: string) => Promise<CowSwapQuoteResponse>;
}): Promise<PermitRewardDisplay> {
  const { uusdAmountFormatted, uusdToken, preferredToken, fetchQuote } = params;
  if (
    preferredToken.symbol.toUpperCase() === UUSD_TOKEN_SYMBOL ||
    preferredToken.address.toLowerCase() === uusdToken.address.toLowerCase()
  ) {
    return {
      displayAmount: uusdAmountFormatted,
      displaySymbol: uusdToken.symbol,
      isQuotedViaCowSwap: false,
    };
  }
  const quote = await fetchQuote(uusdToken.address, preferredToken.address, uusdAmountFormatted);
  return {
    displayAmount: quote.buyAmountFormatted,
    displaySymbol: preferredToken.symbol,
    isQuotedViaCowSwap: true,
    quoteId: quote.quoteId,
  };
}

export async function claimPermitWithCowSwapCashOut(params: {
  permitNonce: bigint;
  uusdAmountWei: bigint;
  fundingWalletBalanceWei: bigint;
  beneficiary: string;
  uusdTokenAddress: string;
  preferredTokenAddress: string;
  invalidateNonceOnChain: (nonce: bigint) => Promise<void>;
  submitCowSwapOrder: (order: {
    sellToken: string;
    buyToken: string;
    sellAmount: string;
    receiver: string;
  }) => Promise<{ orderUid: string; buyAmount: string }>;
}): Promise<CowSwapOrderSubmission> {
  if (params.fundingWalletBalanceWei < params.uusdAmountWei) {
    throw new Error("Insufficient funding wallet UUSD balance to settle permit via CoW Swap");
  }
  if (!params.beneficiary || params.beneficiary === "0x0000000000000000000000000000000000000000") {
    throw new Error("Invalid permit beneficiary address");
  }

  // Step 1: Invalidate Permit2 nonce on-chain
  await params.invalidateNonceOnChain(params.permitNonce);

  // Step 2: Initiate CoW Swap order with receiver = permit beneficiary
  const sellAmount = params.uusdAmountWei.toString();
  const res = await params.submitCowSwapOrder({
    sellToken: params.uusdTokenAddress,
    buyToken: params.preferredTokenAddress,
    sellAmount,
    receiver: params.beneficiary,
  });

  return {
    orderUid: res.orderUid,
    sellToken: params.uusdTokenAddress,
    buyToken: params.preferredTokenAddress,
    sellAmount,
    buyAmount: res.buyAmount,
    receiver: params.beneficiary,
    invalidatedNonce: params.permitNonce.toString(),
  };
}

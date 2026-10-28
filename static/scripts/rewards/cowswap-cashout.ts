/**
 * ubiquity/pay.ubq.fi#386 ($600): Cow Swap Cash Out
 * Provides gasless CoW Protocol order quoting and settlement for Permit2 reward claims.
 */

export const PREFERRED_PAYOUT_STORAGE_KEY = "ubq_preferred_payout_token";
export const UUSD_TOKEN_SYMBOL = "UUSD";

/**
 * Configuration describing an ERC-20 payout token on a specific chain.
 */
export interface PayoutTokenConfig {
  symbol: string;
  address: string;
  decimals: number;
  chainId: number;
}

/**
 * Formatted reward display metadata shown on the claim card.
 */
export interface PermitRewardDisplay {
  displayAmount: string;
  displaySymbol: string;
  isQuotedViaCowSwap: boolean;
  quoteId?: string;
}

/**
 * Quote payload returned by the CoW Protocol orderbook quote endpoint.
 */
export interface CowSwapQuoteResponse {
  quoteId: string;
  sellToken: string;
  buyToken: string;
  sellAmount: string;
  buyAmount: string;
  buyAmountFormatted: string;
  feeAmount: string;
}

/**
 * Result returned after a CoW Swap cash-out order is settled and the permit nonce is consumed.
 */
export interface CowSwapOrderSubmission {
  orderUid: string;
  sellToken: string;
  buyToken: string;
  sellAmount: string;
  buyAmount: string;
  receiver: string;
  invalidatedNonce: string;
}

/**
 * Minimal synchronous key-value storage interface compatible with Web Storage.
 */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Reads and validates the user's preferred payout token from persistent storage,
 * falling back to `defaultToken` when unset or malformed.
 *
 * @param storage - Storage backend implementing `getItem` and `setItem`.
 * @param defaultToken - Default payout token configuration (typically UUSD).
 * @returns Validated payout token configuration.
 */
export function getPreferredPayoutToken(
  storage: StorageLike,
  defaultToken: PayoutTokenConfig
): PayoutTokenConfig {
  const raw = storage.getItem(PREFERRED_PAYOUT_STORAGE_KEY);
  if (!raw) return defaultToken;
  try {
    const parsed = JSON.parse(raw) as Partial<PayoutTokenConfig>;
    if (
      parsed &&
      typeof parsed.symbol === "string" &&
      parsed.symbol.trim().length > 0 &&
      typeof parsed.address === "string" &&
      /^0x[a-fA-F0-9]{40}$/.test(parsed.address) &&
      typeof parsed.decimals === "number" &&
      Number.isInteger(parsed.decimals) &&
      parsed.decimals >= 0 &&
      typeof parsed.chainId === "number" &&
      Number.isInteger(parsed.chainId) &&
      parsed.chainId > 0
    ) {
      return parsed as PayoutTokenConfig;
    }
  } catch {
    // Fallback to default UUSD token when JSON parsing fails
  }
  return defaultToken;
}

/**
 * Persists the user's preferred payout token configuration into storage.
 *
 * @param storage - Storage backend implementing `setItem`.
 * @param token - Payout token configuration to store.
 */
export function setPreferredPayoutToken(storage: StorageLike, token: PayoutTokenConfig): void {
  storage.setItem(PREFERRED_PAYOUT_STORAGE_KEY, JSON.stringify(token));
}

/**
 * Resolves the displayed reward amount and token symbol for a permit claim card,
 * querying a live CoW Protocol quote when the preferred token differs from UUSD.
 *
 * @param params - Permit reward display resolution parameters.
 * @returns Resolved display amount, symbol, and quote metadata.
 */
export async function resolvePermitDisplayReward(params: {
  uusdAmountFormatted: string;
  uusdToken: PayoutTokenConfig;
  preferredToken: PayoutTokenConfig;
  fetchQuote: (sellToken: string, buyToken: string, amountFormatted: string) => Promise<CowSwapQuoteResponse>;
}): Promise<PermitRewardDisplay> {
  const { uusdAmountFormatted, uusdToken, preferredToken, fetchQuote } = params;
  if (
    preferredToken.chainId === uusdToken.chainId &&
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

/**
 * Executes a gasless CoW Swap cash-out flow for a Permit2 reward claim.
 * Submits and confirms the CoW Swap order settlement before invalidating the Permit2 nonce
 * so the beneficiary never loses claimability on an rejected or unfilled order.
 *
 * @param params - CoW Swap cash-out execution parameters and callbacks.
 * @returns Settled order submission details and invalidated nonce.
 */
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
  }) => Promise<{ orderUid: string; buyAmount: string; settled?: boolean }>;
  awaitOrderSettlement?: (orderUid: string) => Promise<boolean>;
}): Promise<CowSwapOrderSubmission> {
  if (params.fundingWalletBalanceWei < params.uusdAmountWei) {
    throw new Error("Insufficient funding wallet UUSD balance to settle permit via CoW Swap");
  }
  if (!params.beneficiary || params.beneficiary === "0x0000000000000000000000000000000000000000") {
    throw new Error("Invalid permit beneficiary address");
  }

  // Step 1: Submit CoW Swap order with receiver = permit beneficiary
  const sellAmount = params.uusdAmountWei.toString();
  const res = await params.submitCowSwapOrder({
    sellToken: params.uusdTokenAddress,
    buyToken: params.preferredTokenAddress,
    sellAmount,
    receiver: params.beneficiary,
  });

  // Step 2: Confirm order settlement before consuming the Permit2 nonce
  if (params.awaitOrderSettlement) {
    const isSettled = await params.awaitOrderSettlement(res.orderUid);
    if (!isSettled) {
      throw new Error(`CoW Swap order ${res.orderUid} did not settle; permit nonce preserved`);
    }
  } else if (res.settled === false) {
    throw new Error(`CoW Swap order ${res.orderUid} was not settled; permit nonce preserved`);
  }

  // Step 3: Invalidate Permit2 nonce on-chain only after payout order settlement is confirmed
  await params.invalidateNonceOnChain(params.permitNonce);

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

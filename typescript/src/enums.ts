/**
 * Wire-safe enumerations for the Daraja API — mirrors go/enums.go and
 * python/mpesa/enums.py. Each enum wraps a bare wire string Safaricom matches
 * exactly (case-sensitive): wrong case → silent rejection; dropped letter →
 * silent rejection. Use the static instances instead of bare strings.
 *
 * @see {@link TransactionType} — STK Push / C2B Simulate (docs/apis/stk-push.md, c2b.md)
 * @see {@link CommandID} — B2C, Transaction Status, Reversal, Account Balance
 * @see {@link ResponseType} — C2B URL-registration fallback (docs/apis/c2b.md)
 * @see {@link QRTrxCode} — Dynamic QR transaction types (docs/apis/dynamic-qr.md)
 * @packageDocumentation
 */

/**
 * Base class for wire-safe string enums. Each instance carries a semantic
 * `value` and a `wireKey` emitted on the wire. `toString()`, `toJSON()` and
 * `Symbol.toPrimitive` all return `wireKey` so template literals, logging and
 * `JSON.stringify` emit the exact gateway string — matches Go/Python convention.
 */
export class MpesaEnum<T extends string> {
  /** The semantic value (matches the wire key for standard enums). */
  readonly value: T;
  /** The exact string emitted on the wire; `toString()`/`toJSON()` return this. */
  readonly wireKey: string;

  constructor(value: T, wireKey: string = value) {
    this.value = value;
    this.wireKey = wireKey;
  }

  /** Returns `wireKey` for URL encoding and template-literal interpolation. */
  toString(): string { return this.wireKey; }
  /** Returns `wireKey` so `JSON.stringify()` emits the exact gateway string. */
  toJSON(): string { return this.wireKey; }
  /** Returns `wireKey` for implicit coercion in template literals and string ops. */
  [Symbol.toPrimitive](_hint: string): string { return this.wireKey; }

  /**
   * Strict exact-match lookup — never trimmed, case-folded or fuzzy.
   * Throws a descriptive `TypeError` on invalid input; never returns undefined.
   *
   * @example
   * ```ts
   * const cmd = MpesaEnum.coerce(rawInput, CommandID.ALL.map(e => e.value));
   * ```
   */
  static coerce<T extends string>(value: unknown, validSet: readonly T[]): T {
    if (typeof value === "string" && validSet.includes(value as T)) {
      return value as T;
    }
    throw new TypeError(
      `invalid enum value: expected one of ${JSON.stringify(validSet)}, got ${JSON.stringify(value)}`,
    );
  }
}

/**
 * STK Push `TransactionType` — REQUIRED, no default. Caller must pick
 * explicitly: wrong merchant type → authorization failure.
 *
 * @example
 * ```ts
 * const body = { TransactionType: TransactionType.BillPayGoods.wireKey };
 * ```
 * @see docs/apis/stk-push.md
 */
export class TransactionType extends MpesaEnum<'CustomerPayBillOnline' | 'CustomerBuyGoodsOnline'> {
  /** Paybill accounts (shortcode + account number). */
  static readonly BillPayGoods = new TransactionType('CustomerPayBillOnline');
  /** Buy Goods tills (till number, no account reference). */
  static readonly BillPayGoodsGoods = new TransactionType('CustomerBuyGoodsOnline');
  /** All `TransactionType` instances. */
  static get ALL(): readonly TransactionType[] {
    return Object.freeze([TransactionType.BillPayGoods, TransactionType.BillPayGoodsGoods]);
  }
}

/**
 * `CommandID` strings shared by B2C, Transaction Status, Reversal,
 * Account Balance and C2B Simulate — each endpoint accepts a subset.
 *
 * @example
 * ```ts
 * const body = { CommandID: CommandID.BusinessPayment.wireKey };
 * ```
 * @see docs/apis/b2c.md, transaction-status.md, reversal.md, account-balance.md, c2b.md
 */
export class CommandID extends MpesaEnum<
  | 'CustomerPayBillOnline' | 'CustomerBuyGoodsOnline'
  | 'SalaryPayment' | 'BusinessPayment' | 'PromotionPayment'
  | 'TransactionStatusQuery' | 'AccountBalance' | 'TransactionReversal'
> {
  /** C2B Simulate — paybill direction. */
  static readonly PayBill = new CommandID('CustomerPayBillOnline');
  /** C2B Simulate — buy-goods/till direction. */
  static readonly PayGoods = new CommandID('CustomerBuyGoodsOnline');
  /** B2C — recipient must be M-Pesa registered (unregistered numbers fail). */
  static readonly SalaryPayment = new CommandID('SalaryPayment');
  /** B2C — works for registered and unregistered recipients. */
  static readonly BusinessPayment = new CommandID('BusinessPayment');
  /** B2C — promotional payouts; registered recipients; pair with Occasion. */
  static readonly PromotionPayment = new CommandID('PromotionPayment');
  /** Transaction Status — only valid CommandID for that endpoint. */
  static readonly TransactionStatusQuery = new CommandID('TransactionStatusQuery');
  /** Account Balance — only valid CommandID for that endpoint. */
  static readonly AccountBalance = new CommandID('AccountBalance');
  /**
   * Reversal — only valid CommandID for that endpoint. Member named after
   * the operation; wire value is Safaricom's `"TransactionReversal"`
   * (docs/apis/reversal.md; Go `CommandTransactionReversal`).
   */
  static readonly ReverseTransaction = new CommandID('TransactionReversal');
  /** All `CommandID` instances. */
  static get ALL(): readonly CommandID[] {
    return Object.freeze([
      CommandID.PayBill, CommandID.PayGoods, CommandID.SalaryPayment,
      CommandID.BusinessPayment, CommandID.PromotionPayment,
      CommandID.TransactionStatusQuery, CommandID.AccountBalance,
      CommandID.ReverseTransaction,
    ]);
  }
}

/**
 * C2B URL-registration fallback when ValidationURL is unreachable.
 * Wire values are sentence-case — NOT SCREAMING_CASE.
 *
 * @example
 * ```ts
 * const body = { ResponseType: ResponseType.Success.wireKey };
 * ```
 * @see docs/apis/c2b.md
 */
export class ResponseType extends MpesaEnum<'Success' | 'Fail'> {
  /** Validation succeeded or was unreachable — accept the payment. */
  static readonly Success = new ResponseType('Success');
  /** Validation explicitly rejected the payment. */
  static readonly Fail = new ResponseType('Fail');
  /** All `ResponseType` instances. */
  static get ALL(): readonly ResponseType[] {
    return Object.freeze([ResponseType.Success, ResponseType.Fail]);
  }
}

/**
 * Dynamic QR transaction type — five documented wire codes
 * (docs/apis/dynamic-qr.md): `BG` Pay Merchant (Buy Goods), `WA` Withdraw
 * Cash at Agent Till, `PB` Paybill/Business number, `SM` Send Money (mobile),
 * `SB` Sent to Business (CPI in MSISDN format).
 *
 * @example
 * ```ts
 * const qr = { TrxCode: QRTrxCode.BuyGoods.wireKey }; // "BG"
 * ```
 * @see docs/apis/dynamic-qr.md
 */
export class QRTrxCode extends MpesaEnum<'BG' | 'WA' | 'PB' | 'SM' | 'SB'> {
  /** `"BG"` — pay merchant (Buy Goods till). */
  static readonly BuyGoods = new QRTrxCode('BG');
  /** `"WA"` — withdraw cash at an agent till. */
  static readonly WithdrawAtAgentTill = new QRTrxCode('WA');
  /** `"PB"` — pay a paybill/business number. */
  static readonly Paybill = new QRTrxCode('PB');
  /** `"SM"` — send money to a mobile MSISDN (P2P). */
  static readonly SendMoney = new QRTrxCode('SM');
  /** `"SB"` — sent to business; CPI supplied in MSISDN format. */
  static readonly SendToBusiness = new QRTrxCode('SB');
  /** All `QRTrxCode` instances. */
  static get ALL(): readonly QRTrxCode[] {
    return Object.freeze([
      QRTrxCode.BuyGoods, QRTrxCode.WithdrawAtAgentTill, QRTrxCode.Paybill,
      QRTrxCode.SendMoney, QRTrxCode.SendToBusiness,
    ]);
  }
}

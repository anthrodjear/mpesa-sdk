/**
 * Tests for src/enums.ts — wire-key rendering, coercion, identity, and safety.
 *
 * Mirrors go/enums.go (const-block wire values) and python/mpesa/enums.py
 * (_WireEnum str/Enum + coerce pattern) translated to TypeScript's class-based
 * enum approach.
 */
import { describe, expect, it } from "vitest";
import { MpesaEnum, TransactionType, CommandID, ResponseType, QRTrxCode } from "../src/enums.js";

describe("MpesaEnum base — rendering", () => {
  it("toString returns wireKey", () => {
    const e = new MpesaEnum("value", "wire");
    expect(e.toString()).toBe("wire");
  });

  it("toJSON returns wireKey for JSON.stringify", () => {
    const e = new MpesaEnum("value", "wire");
    expect(JSON.stringify({ k: e })).toBe('{"k":"wire"}');
  });

  it("Symbol.toPrimitive returns wireKey for template literals", () => {
    const e = new MpesaEnum("value", "wire");
    expect(`${e}`).toBe("wire");
    expect(String(e)).toBe("wire");
  });

  it("constructor defaults wireKey to value when omitted", () => {
    const e = new MpesaEnum("CustomerPayBillOnline" as const);
    expect(e.value).toBe("CustomerPayBillOnline");
    expect(e.wireKey).toBe("CustomerPayBillOnline");
    expect(e.toString()).toBe("CustomerPayBillOnline");
  });
});

describe("MpesaEnum.coerce", () => {
  it("returns the value when it is in the valid set", () => {
    expect(MpesaEnum.coerce("Success", ["Success", "Fail"] as const)).toBe("Success");
  });

  it("throws TypeError on invalid string", () => {
    expect(() => MpesaEnum.coerce("Unknown", ["Success", "Fail"] as const)).toThrow(TypeError);
  });

  it("throws TypeError on non-string input", () => {
    expect(() => MpesaEnum.coerce(123, ["Success", "Fail"] as const)).toThrow(TypeError);
    expect(() => MpesaEnum.coerce(null, ["Success", "Fail"] as const)).toThrow(TypeError);
    expect(() => MpesaEnum.coerce(undefined, ["Success", "Fail"] as const)).toThrow(TypeError);
  });

  it("does not trim or case-fold input", () => {
    expect(() => MpesaEnum.coerce(" success", ["Success"] as const)).toThrow(TypeError);
    expect(() => MpesaEnum.coerce("SUCCESS", ["Success"] as const)).toThrow(TypeError);
  });
});

describe("TransactionType", () => {
  it("static instances have correct values and wireKeys", () => {
    expect(TransactionType.BillPayGoods.value).toBe("CustomerPayBillOnline");
    expect(TransactionType.BillPayGoodsGoods.value).toBe("CustomerBuyGoodsOnline");
  });

  it("toString and JSON emit wireKey", () => {
    expect(TransactionType.BillPayGoods.toString()).toBe("CustomerPayBillOnline");
    expect(JSON.stringify({ type: TransactionType.BillPayGoods }))
      .toBe('{"type":"CustomerPayBillOnline"}');
  });

  it("ALL contains both instances", () => {
    expect(TransactionType.ALL).toHaveLength(2);
    expect(TransactionType.ALL).toContain(TransactionType.BillPayGoods);
    expect(TransactionType.ALL).toContain(TransactionType.BillPayGoodsGoods);
  });

  it("coerce validates exact wire values via base class", () => {
    const valid = TransactionType.ALL.map(e => e.value);
    expect(MpesaEnum.coerce("CustomerPayBillOnline", valid)).toBe("CustomerPayBillOnline");
    expect(MpesaEnum.coerce("CustomerBuyGoodsOnline", valid)).toBe("CustomerBuyGoodsOnline");
    expect(() => MpesaEnum.coerce("bad", valid)).toThrow(TypeError);
  });
});

describe("CommandID", () => {
  it("has 8 static instances covering the union", () => {
    expect(CommandID.ALL).toHaveLength(8);
  });

  it("every instance renders its wireKey via toString and toJSON", () => {
    for (const cmd of CommandID.ALL) {
      expect(cmd.toString()).toBe(cmd.wireKey);
      expect(JSON.parse(JSON.stringify({ c: cmd })).c).toBe(cmd.wireKey);
    }
  });

  it("coerce round-trips every member via base class", () => {
    const valid = CommandID.ALL.map(e => e.value);
    for (const cmd of CommandID.ALL) {
      expect(MpesaEnum.coerce(cmd.value, valid)).toBe(cmd.value);
    }
  });

  it("convenience names map to expected wire values", () => {
    expect(CommandID.PayBill.wireKey).toBe("CustomerPayBillOnline");
    expect(CommandID.PayGoods.wireKey).toBe("CustomerBuyGoodsOnline");
    expect(CommandID.BusinessPayment.wireKey).toBe("BusinessPayment");
    expect(CommandID.MerchantPayment.wireKey).toBe("MerchantPayment");
    expect(CommandID.B2C.wireKey).toBe("B2C");
    expect(CommandID.TransactionStatusQuery.wireKey).toBe("TransactionStatusQuery");
    expect(CommandID.AccountBalance.wireKey).toBe("AccountBalance");
    expect(CommandID.ReverseTransaction.wireKey).toBe("ReverseTransaction");
  });
});

describe("ResponseType", () => {
  it("has exactly 2 members: Success and Fail", () => {
    expect(ResponseType.ALL).toHaveLength(2);
    expect(ResponseType.Success.value).toBe("Success");
    expect(ResponseType.Fail.value).toBe("Fail");
  });

  it("coerce rejects values from other enum domains", () => {
    expect(() => MpesaEnum.coerce("Completed", ResponseType.ALL.map(e => e.value)))
      .toThrow(TypeError);
  });
});

describe("QRTrxCode", () => {
  it("has a single DynamicQRCode member", () => {
    expect(QRTrxCode.ALL).toHaveLength(1);
    expect(QRTrxCode.DynamicQRCode.value).toBe("DynamicQRCode");
  });
});

describe("immutability", () => {
  it("ALL arrays are frozen at runtime", () => {
    expect(Object.isFrozen(TransactionType.ALL)).toBe(true);
    expect(Object.isFrozen(CommandID.ALL)).toBe(true);
    expect(Object.isFrozen(ResponseType.ALL)).toBe(true);
    expect(Object.isFrozen(QRTrxCode.ALL)).toBe(true);
  });
});

describe("export styles", () => {
  it("named imports and static-property access both work", () => {
    expect(TransactionType).toBeDefined();
    expect(CommandID).toBeDefined();
    expect(ResponseType).toBeDefined();
    expect(QRTrxCode).toBeDefined();
    expect(TransactionType.BillPayGoods).toBeInstanceOf(MpesaEnum);
    expect(CommandID.AccountBalance).toBeInstanceOf(MpesaEnum);
    expect(ResponseType.Success).toBeInstanceOf(MpesaEnum);
    expect(QRTrxCode.DynamicQRCode).toBeInstanceOf(MpesaEnum);
  });
});

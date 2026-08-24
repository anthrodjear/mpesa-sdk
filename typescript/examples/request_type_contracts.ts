/**
 * Compile-time contract tests for request types (no runtime behavior —
 * this file exists to be type-checked by `npm run typecheck:examples`).
 *
 * TransactionStatusRequest enforces transactionID ⊕ originalConversationID
 * via a discriminated union: both-present and both-absent must be compile
 * errors, single-identifier variants must compile cleanly.
 */
import { CommandID, type TransactionStatusRequest } from "@mpesa-sdk/core";

const base = {
  initiator: "testapi",
  securityCredential: "cred",
  commandID: CommandID.TransactionStatusQuery,
  partyA: "600992",
  remarks: "reconcile",
  resultURL: "https://example.com/result",
  queueTimeOutURL: "https://example.com/timeout",
} as const;

// OK: receipt-based lookup.
const byReceipt: TransactionStatusRequest = { ...base, transactionID: "NLJ7RT61SV" };

// OK: conversation-based lookup.
const byConversation: TransactionStatusRequest = {
  ...base,
  originalConversationID: "AG_20240706_20106e9209f64bebd05b",
};

// @ts-expect-error both identifiers present is a TYPE error (XOR contract)
const bothPresent: TransactionStatusRequest = {
  ...base,
  transactionID: "NLJ7RT61SV",
  originalConversationID: "AG_20240706_20106e9209f64bebd05b",
};

// @ts-expect-error neither identifier present is a TYPE error (XOR contract)
const bothAbsent: TransactionStatusRequest = { ...base };

// Optional fields accept explicit `undefined` (EOPT friction removal)...
const withExplicitUndefineds: TransactionStatusRequest = {
  ...base,
  commandID: undefined,
  identifierType: undefined,
  occasion: undefined,
  transactionID: "NLJ7RT61SV",
};

// ...and remarks is REQUIRED on TransactionStatusRequest.
// @ts-expect-error omitting remarks is a TYPE error
const missingRemarks: TransactionStatusRequest = {
  initiator: "testapi",
  securityCredential: "cred",
  partyA: "600992",
  resultURL: "https://example.com/result",
  queueTimeOutURL: "https://example.com/timeout",
  transactionID: "NLJ7RT61SV",
};

void byReceipt;
void byConversation;
void bothPresent;
void bothAbsent;
void withExplicitUndefineds;
void missingRemarks;

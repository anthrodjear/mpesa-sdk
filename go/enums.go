// Enums: environment selector and Safaricom wire enum values.

package mpesa

// Environment selects the Daraja deployment a Client talks to.
type Environment int

const (
	// Sandbox is the developer test environment, wire base URL
	// https://sandbox.safaricom.co.ke.
	Sandbox Environment = iota
	// Production is the live environment, wire base URL
	// https://api.safaricom.co.ke.
	Production
)

// BaseURL returns the platform root for the environment.
func (e Environment) BaseURL() string {
	if e == Production {
		return "https://api.safaricom.co.ke"
	}
	return "https://sandbox.safaricom.co.ke"
}

// CommandID is the wire CommandID enum string shared by B2C, Transaction
// Status, Reversal, Account Balance and C2B Simulate.
type CommandID string

// TrxCode is the Dynamic QR transaction-type enum string (wire values
// BG/WA/PB/SM/SB).
type TrxCode string

// ResponseType is the C2B URL-registration fallback enum string.
type ResponseType string

// Shared enum values using Safaricom's exact spellings.
const (
	// TransactionTypePayBillOnline is wire value "CustomerPayBillOnline",
	// accepted by STK Push and C2B Simulate.
	TransactionTypePayBillOnline = "CustomerPayBillOnline"
	// TransactionTypeBuyGoodsOnline is wire value "CustomerBuyGoodsOnline",
	// accepted by STK Push and C2B Simulate.
	TransactionTypeBuyGoodsOnline = "CustomerBuyGoodsOnline"

	// CommandSalaryPayment is wire value "SalaryPayment" for B2C payouts.
	CommandSalaryPayment CommandID = "SalaryPayment"
	// CommandBusinessPayment is wire value "BusinessPayment" for B2C payouts.
	CommandBusinessPayment CommandID = "BusinessPayment"
	// CommandPromotionPayment is wire value "PromotionPayment" for B2C
	// payouts.
	CommandPromotionPayment CommandID = "PromotionPayment"
	// CommandTransactionStatusQuery is wire value "TransactionStatusQuery",
	// the only valid CommandID for Transaction Status.
	CommandTransactionStatusQuery CommandID = "TransactionStatusQuery"
	// CommandTransactionReversal is wire value "TransactionReversal", the
	// only valid CommandID for Reversal.
	CommandTransactionReversal CommandID = "TransactionReversal"
	// CommandAccountBalance is wire value "AccountBalance", the only valid
	// CommandID for Account Balance.
	CommandAccountBalance CommandID = "AccountBalance"

	// ResponseTypeCompleted is wire value "Completed" for C2B URL
	// registration: complete the transaction when validation is unreachable.
	ResponseTypeCompleted ResponseType = "Completed"
	// ResponseTypeCancelled is wire value "Cancelled" for C2B URL
	// registration: cancel the transaction when validation is unreachable.
	ResponseTypeCancelled ResponseType = "Cancelled"

	// IdentifierOrgShortcode is wire value "4": organization shortcode,
	// used by Transaction Status and Account Balance IdentifierType.
	IdentifierOrgShortcode = "4"
	// ReceiverIdentifierOrg is wire value "11": organization shortcode as
	// the Reversal RecieverIdentifierType (Safaricom's misspelled field).
	ReceiverIdentifierOrg = "11"

	// QRTrxBuyGoods is wire value "BG": pay merchant (buy goods), Dynamic QR.
	QRTrxBuyGoods TrxCode = "BG"
	// QRTrxWithdrawAtAgentTill is wire value "WA": withdraw cash at agent
	// till, Dynamic QR.
	QRTrxWithdrawAtAgentTill TrxCode = "WA"
	// QRTrxPaybill is wire value "PB": paybill/business number, Dynamic QR.
	QRTrxPaybill TrxCode = "PB"
	// QRTrxSendMoney is wire value "SM": send money (mobile MSISDN),
	// Dynamic QR.
	QRTrxSendMoney TrxCode = "SM"
	// QRTrxSendToBusiness is wire value "SB": sent to business (CPI in
	// MSISDN format), Dynamic QR.
	QRTrxSendToBusiness TrxCode = "SB"
)

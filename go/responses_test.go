package mpesa

import (
	"encoding/json"
	"testing"
)

func TestC2BAckParsesMisspelledField(t *testing.T) {
	payload := `{"OriginatorCoversationID":"53e3-4aa8-9fe0-8fb5e4092cdd3405976","ResponseCode":"0","ResponseDescription":"Accept the service request successfully."}`
	var ack C2BAckResponse
	if err := json.Unmarshal([]byte(payload), &ack); err != nil {
		t.Fatal(err)
	}
	if ack.OriginatorConversationID != "53e3-4aa8-9fe0-8fb5e4092cdd3405976" {
		t.Fatalf("OriginatorConversationID = %q", ack.OriginatorConversationID)
	}
}

func TestSTKQueryResponseResultCodeCoercesStringOrInt(t *testing.T) {
	for _, payload := range []string{
		`{"ResponseCode":"0","ResultCode":"1032","ResultDesc":"Request cancelled by user"}`,
		`{"ResponseCode":"0","ResultCode":1032,"ResultDesc":"Request cancelled by user"}`,
	} {
		var resp STKQueryResponse
		if err := json.Unmarshal([]byte(payload), &resp); err != nil {
			t.Fatal(err)
		}
		if resp.ResultCode.String() != "1032" {
			t.Errorf("ResultCode = %q, want 1032 (payload %s)", resp.ResultCode.String(), payload)
		}
		if got := ClassifyResultCode(resp.ResultCode.String()); got != ResultClassFailure {
			t.Errorf("1032 classified %q, want failure (user-cancelled is terminal, new intent ok)", got)
		}
	}
}

func TestSTKPushResponseIsAccepted(t *testing.T) {
	if !(STKPushResponse{ResponseCode: "0"}).IsAccepted() {
		t.Error(`ResponseCode "0" must be accepted`)
	}
	if (STKPushResponse{ResponseCode: "1"}).IsAccepted() {
		t.Error(`ResponseCode "1" must not be accepted`)
	}
}

func TestConversationResponseUnmarshalShape(t *testing.T) {
	payload := `{"OriginatorConversationID":"o-1","ConversationID":"AG_20240706_20106e9209f64bebd05b","ResponseCode":"0","ResponseDescription":"Accept the service request successfully."}`
	var cr ConversationResponse
	if err := json.Unmarshal([]byte(payload), &cr); err != nil {
		t.Fatal(err)
	}
	if cr.OriginatorConversationID != "o-1" || cr.ConversationID != "AG_20240706_20106e9209f64bebd05b" ||
		cr.ResponseCode != "0" || cr.ResponseDescription == "" {
		t.Fatalf("shape mismatch: %+v", cr)
	}
}

func TestQRCodeResponseUnmarshalShape(t *testing.T) {
	payload := `{"ResponseCode":"AG_20191219_000043fdf61864fe9ff5","RequestID":"16738-27456357-1","ResponseDescription":"QR Code Successfully Generated","QRCode":"imgdata"}`
	var qr QRCodeResponse
	if err := json.Unmarshal([]byte(payload), &qr); err != nil {
		t.Fatal(err)
	}
	if qr.ResponseCode != "AG_20191219_000043fdf61864fe9ff5" || qr.RequestID != "16738-27456357-1" ||
		qr.QRCode != "imgdata" || qr.ResponseDescription == "" {
		t.Fatalf("shape mismatch: %+v", qr)
	}
}

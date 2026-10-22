package mpesa

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

// Cross-engine conformance harness.
//
// The Go, Python and TypeScript engines are hand-written copies of ONE wire
// contract, and hand-written copies drift: the Python engine dropped numeric
// error-envelope members (so its 401 retry never fired) and never grew the
// 2**53 balance gate Go and TypeScript already had. Every case below is read
// from the SHARED corpus in contract/fixtures (schema: contract/README.md),
// which the Python and TypeScript harnesses read too -- so a divergence is a
// failing test in the drifting engine rather than a difference nobody
// notices.
//
// This file is the Go half of that net. The corpus is the source of truth
// for the schema, not this struct: keep them in step.

// contractCase is one shared wire fixture.
type contractCase struct {
	ID   string `json:"id"`
	Kind string `json:"kind"`
	// StatusCode is an INPUT -- the HTTP status the harness feeds the
	// engine -- not an expectation. Asserting that the engine echoed back
	// the status it was given can never fail, so it is not an assertion.
	StatusCode int             `json:"statusCode"`
	Body       json.RawMessage `json:"body"`
	Expect     struct {
		Class        string         `json:"class"`
		ResultCode   string         `json:"resultCode"`
		Metadata     map[string]any `json:"metadata"`
		ErrorCode    *string        `json:"errorCode"`
		ErrorMessage *string        `json:"errorMessage"`
		Segments     int            `json:"segments"`
		Skipped      int            `json:"skipped"`
	} `json:"expect"`
}

// contractFixtureDir resolves the shared corpus. The Go package directory is
// <repo>/go, so one ".." is the repository root.
func contractFixtureDir(t *testing.T) string {
	t.Helper()
	dir, err := filepath.Abs(filepath.Join("..", "contract", "fixtures"))
	if err != nil {
		t.Fatalf("resolve contract fixture dir: %v", err)
	}
	if _, err := os.Stat(dir); err != nil {
		t.Fatalf("contract fixture dir %s missing: %v", dir, err)
	}
	return dir
}

// loadContractCases reads every fixture in the corpus. A missing or empty
// corpus is a hard failure: a harness that silently asserts nothing is worse
// than no harness at all, because it reports green.
func loadContractCases(t *testing.T) []contractCase {
	t.Helper()
	paths, err := filepath.Glob(filepath.Join(contractFixtureDir(t), "*.json"))
	if err != nil {
		t.Fatalf("glob contract fixtures: %v", err)
	}
	if len(paths) == 0 {
		t.Fatal("no contract fixtures found")
	}
	cases := make([]contractCase, 0, len(paths))
	for _, p := range paths {
		raw, err := os.ReadFile(p)
		if err != nil {
			t.Fatalf("read %s: %v", p, err)
		}
		var c contractCase
		if err := json.Unmarshal(raw, &c); err != nil {
			t.Fatalf("decode %s: %v", p, err)
		}
		cases = append(cases, c)
	}
	return cases
}

// contractRawBody returns the bytes the engine must SEE for a fixture body.
// A JSON string body IS the raw body text (a WAF page, an HTML error page);
// an object body is the raw JSON document. The Python and TypeScript
// harnesses apply the same rule, so the corpus can express both a JSON
// envelope and a non-JSON gateway response.
func contractRawBody(t *testing.T, body json.RawMessage) []byte {
	t.Helper()
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) > 0 && trimmed[0] == '"' {
		var text string
		if err := json.Unmarshal(trimmed, &text); err != nil {
			t.Fatalf("decode string body: %v", err)
		}
		return []byte(text)
	}
	return trimmed
}

// contractContentType mirrors what the transport would have reported for the
// raw body. It reaches only the optional diagnostic logger (nil here), but
// keeping it honest documents which body shape each fixture carries.
func contractContentType(raw []byte) string {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) > 0 && (trimmed[0] == '{' || trimmed[0] == '[') {
		return "application/json"
	}
	return "text/html"
}

// contractNumericRe is the plain-decimal grammar a metadata STRING must
// match to count as numeric: optional sign, digits, optional fractional
// part.
//
// Deliberately plain-decimal-only. strconv.ParseFloat also accepts "Inf",
// "NaN" and "0x1p-2", Python's float() also accepts "inf" and "nan", and
// TypeScript's Number() also accepts "0x10" and "1e3" -- three permissive
// parsers would classify the same metadata text three different ways. One
// grammar, applied identically in all three harnesses, removes that class
// of drift by construction.
var contractNumericRe = regexp.MustCompile(`^-?\d+(\.\d+)?$`)

// contractNumeric reports whether a metadata value is numeric and, if so,
// its numeric value.
//
// A JSON number is numeric. A STRING is numeric only when its trimmed text
// matches the plain-decimal grammar above. Everything else (booleans, null,
// objects, arrays, and any text the grammar rejects) compares as a string.
func contractNumeric(v any) (float64, bool) {
	switch t := v.(type) {
	case int64:
		return float64(t), true
	case float64:
		if math.IsNaN(t) || math.IsInf(t, 0) {
			return 0, false
		}
		return t, true
	case string:
		text := strings.TrimSpace(t)
		if !contractNumericRe.MatchString(text) {
			return 0, false
		}
		f, err := strconv.ParseFloat(text, 64)
		if err != nil || math.IsInf(f, 0) {
			// A plain decimal beyond the float64 range is not a number
			// this harness can compare numerically; Python and TypeScript
			// treat it the same way.
			return 0, false
		}
		return f, true
	}
	return 0, false
}

// contractMetadataEqual compares one metadata value against the fixture's
// expectation: numerically when BOTH sides parse as numbers, as trimmed
// strings otherwise. A type mismatch between a number and its string
// spelling is therefore NOT a failure.
func contractMetadataEqual(got, want any) bool {
	if g, ok := contractNumeric(got); ok {
		if w, ok := contractNumeric(want); ok {
			return g == w
		}
	}
	return strings.TrimSpace(fmt.Sprint(got)) == strings.TrimSpace(fmt.Sprint(want))
}

// TestContractFixtures runs every shared fixture through the Go engine.
func TestContractFixtures(t *testing.T) {
	for _, c := range loadContractCases(t) {
		t.Run(c.ID, func(t *testing.T) {
			switch c.Kind {
			case "stk_callback":
				raw := contractRawBody(t, c.Body)
				res, err := ParseSTKCallback(raw)
				if err != nil {
					t.Fatalf("ParseSTKCallback: %v", err)
				}
				if got := string(res.Classify()); got != c.Expect.Class {
					t.Errorf("class = %q, want %q", got, c.Expect.Class)
				}
				if got := res.ResultCode.String(); got != c.Expect.ResultCode {
					t.Errorf("resultCode = %q, want %q", got, c.Expect.ResultCode)
				}
				meta := res.MetadataMap()
				for k, want := range c.Expect.Metadata {
					got, ok := meta[k]
					if !ok {
						t.Errorf("metadata[%q] missing", k)
						continue
					}
					if !contractMetadataEqual(got, want) {
						t.Errorf("metadata[%q] = %v (%T), want %v (%T)",
							k, got, got, want, want)
					}
				}
			case "balance_segment":
				var body struct {
					Text string `json:"text"`
				}
				if err := json.Unmarshal(c.Body, &body); err != nil {
					t.Fatalf("decode balance body: %v", err)
				}
				segments, skipped := ParseBalanceSegments(body.Text)
				if len(segments) != c.Expect.Segments {
					t.Errorf("segments = %d, want %d", len(segments), c.Expect.Segments)
				}
				if skipped != c.Expect.Skipped {
					t.Errorf("skipped = %d, want %d", skipped, c.Expect.Skipped)
				}
			case "error_envelope":
				raw := contractRawBody(t, c.Body)
				status := c.StatusCode
				if status == 0 {
					// statusCode is an input, not an expectation, so a
					// fixture that omits it would feed the engine a
					// status no gateway ever sends.
					t.Fatalf("fixture %q has no top-level statusCode", c.ID)
				}
				err := parseError(status, contractContentType(raw), raw, nil)
				merr, ok := err.(*MpesaError)
				if !ok {
					t.Fatalf("parseError returned %T, want *MpesaError", err)
				}
				// A null expectation means "absent": the Go surface carries an
				// empty string where Python and TypeScript carry None/null.
				if c.Expect.ErrorCode == nil {
					if merr.ErrorCode != "" {
						t.Errorf("errorCode = %q, want absent", merr.ErrorCode)
					}
				} else if merr.ErrorCode != *c.Expect.ErrorCode {
					t.Errorf("errorCode = %q, want %q", merr.ErrorCode, *c.Expect.ErrorCode)
				}
				if c.Expect.ErrorMessage == nil {
					if merr.ErrorMessage != "" {
						t.Errorf("errorMessage = %q, want absent", merr.ErrorMessage)
					}
				} else if merr.ErrorMessage != *c.Expect.ErrorMessage {
					t.Errorf("errorMessage = %q, want %q",
						merr.ErrorMessage, *c.Expect.ErrorMessage)
				}
			default:
				t.Fatalf("unknown fixture kind %q", c.Kind)
			}
		})
	}
}

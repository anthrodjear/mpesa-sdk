package mpesa

import (
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
// contract, and hand-written copies drift: the Python engine DROPPED a
// numeric error-envelope member (D1), so the typed error a caller received
// lost the gateway's error code (error_code was None instead of "401") while
// the envelope's other members survived. (The 401 retry probe is NOT
// affected: it keys on the DOTTED code "401.003.01", which a numeric member
// would never have matched anyway -- Go and Python behave identically
// there.) The Python engine also never grew the 2**53 balance gate Go and
// TypeScript already had (D3), and the TypeScript engine embedded the raw
// upstream body in its exception text (D7). All three are FIXED now: the
// corpus caught them, the ENGINE changed, and every case is green in all
// three engines.
//
// Every case below is read from the SHARED corpus in contract/fixtures
// (schema: contract/README.md), which the Python and TypeScript harnesses
// read too -- so a divergence is a failing test in the drifting engine
// rather than a difference nobody notices.
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
		// Every field a kind REQUIRES is presence-checked. A fixture that
		// forgets one is a BROKEN fixture, and decoding it into a zero
		// would let the case pass while asserting nothing.
		Class        *string         `json:"class"`
		ResultCode   *string         `json:"resultCode"`
		Metadata     map[string]any  `json:"metadata"`
		ErrorCode    json.RawMessage `json:"errorCode"`
		ErrorMessage json.RawMessage `json:"errorMessage"`
		Segments     *int            `json:"segments"`
		Skipped      *int            `json:"skipped"`
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
//
// Fixture ids must be UNIQUE: a duplicate would produce two identically
// named sub-tests, and only one of them would be read as the case the
// author meant.
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
	seen := make(map[string]string, len(paths))
	for _, p := range paths {
		raw, err := os.ReadFile(p)
		if err != nil {
			t.Fatalf("read %s: %v", p, err)
		}
		var c contractCase
		if err := json.Unmarshal(raw, &c); err != nil {
			t.Fatalf("decode %s: %v", p, err)
		}
		if c.ID == "" {
			t.Fatalf("fixture %s has no id", p)
		}
		if prev, dup := seen[c.ID]; dup {
			t.Fatalf("duplicate fixture id %q in %s and %s", c.ID, prev, p)
		}
		seen[c.ID] = p
		cases = append(cases, c)
	}
	return cases
}

// contractRequireString reads a required string expectation. A fixture that
// omits it is broken, and a broken fixture must fail loudly rather than
// decode into an empty string that happens to match.
func contractRequireString(t *testing.T, c contractCase, field string, v *string) string {
	t.Helper()
	if v == nil {
		t.Fatalf("fixture %q has no expect.%s", c.ID, field)
	}
	return *v
}

// contractRequireInt reads a required integer expectation, with the same
// loud-failure rule as contractRequireString: a missing "segments" must
// never decode into 0 and pass a case that asserted nothing.
func contractRequireInt(t *testing.T, c contractCase, field string, v *int) int {
	t.Helper()
	if v == nil {
		t.Fatalf("fixture %q has no expect.%s", c.ID, field)
	}
	return *v
}

// contractNullableString reads an expectation whose JSON null means
// "absent". A MISSING key and a present null are different facts, so the
// raw bytes are kept to tell them apart.
func contractNullableString(t *testing.T, c contractCase, field string, raw json.RawMessage) (string, bool) {
	t.Helper()
	if raw == nil {
		t.Fatalf("fixture %q has no expect.%s", c.ID, field)
	}
	if string(raw) == "null" {
		return "", false
	}
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		t.Fatalf("fixture %q: expect.%s is not a string: %v", c.ID, field, err)
	}
	return s, true
}

// contractRawBody returns the bytes the engine must SEE for a fixture body.
// A JSON string body IS the raw body text (a WAF page, an HTML error page);
// an object body is the raw JSON document. The Python and TypeScript
// harnesses apply the same rule, so the corpus can express both a JSON
// envelope and a non-JSON gateway response.
func contractRawBody(t *testing.T, c contractCase) []byte {
	t.Helper()
	if len(c.Body) == 0 {
		// A fixture with no body would feed the engine an empty body --
		// an input no gateway ever sent -- and hide the broken fixture
		// behind whatever the engine made of it.
		t.Fatalf("fixture %q has no body", c.ID)
	}
	trimmed := contractSkipSpace(c.Body)
	if len(trimmed) > 0 && trimmed[0] == '"' {
		var text string
		if err := json.Unmarshal(trimmed, &text); err != nil {
			t.Fatalf("decode string body: %v", err)
		}
		return []byte(text)
	}
	return trimmed
}

// contractSkipSpace skips leading ASCII space, tab, CR and LF -- and
// nothing else. Unicode whitespace (NBSP) and a UTF-8 BOM are NOT
// whitespace here: the rule describes the ASCII framing of an HTTP body,
// and a body that starts with a BOM is a DIFFERENT wire body. All three
// harnesses skip exactly this set, so the three engines receive the same
// input for the same fixture.
func contractSkipSpace(raw []byte) []byte {
	i := 0
	for i < len(raw) {
		switch raw[i] {
		case ' ', '\t', '\r', '\n':
			i++
		default:
			return raw[i:]
		}
	}
	return raw[i:]
}

// contractContentType mirrors what the transport would have reported for the
// raw body: skip the leading ASCII whitespace, then look at the first byte.
// It reaches only the optional diagnostic logger (nil here), but keeping it
// honest documents which body shape each fixture carries.
func contractContentType(raw []byte) string {
	trimmed := contractSkipSpace(raw)
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

// TestContractNumericGrammar pins the plain-decimal grammar the metadata
// comparison relies on.
//
// The grammar is a LOCAL helper, so it needs its own test: a future swap
// for strconv.ParseFloat -- which also accepts "Inf", "NaN" and "0x1p-2" --
// would silently re-open the cross-engine divergence the grammar exists to
// close, with Go calling "1e3" a number while Python and TypeScript do not.
func TestContractNumericGrammar(t *testing.T) {
	for _, s := range []string{"1e3", "0x10", "Inf", "NaN", "1_000"} {
		if _, ok := contractNumeric(s); ok {
			t.Errorf("contractNumeric(%q) = numeric, want rejected", s)
		}
	}
	for s, want := range map[string]float64{"100": 100, "-100": -100, "100.50": 100.5} {
		got, ok := contractNumeric(s)
		if !ok {
			t.Errorf("contractNumeric(%q) = not numeric, want accepted", s)
			continue
		}
		if got != want {
			t.Errorf("contractNumeric(%q) = %v, want %v", s, got, want)
		}
	}
	// A JSON number is numeric by construction, whatever its magnitude.
	if got, ok := contractNumeric(int64(100)); !ok || got != 100 {
		t.Errorf("contractNumeric(int64(100)) = %v, %v, want 100, true", got, ok)
	}
	// Booleans are not numbers: true must never compare equal to 1.
	if _, ok := contractNumeric(true); ok {
		t.Error("contractNumeric(true) = numeric, want rejected")
	}
}

// TestContractFixtures runs every shared fixture through the Go engine.
func TestContractFixtures(t *testing.T) {
	for _, c := range loadContractCases(t) {
		t.Run(c.ID, func(t *testing.T) {
			switch c.Kind {
			case "stk_callback":
				raw := contractRawBody(t, c)
				res, err := ParseSTKCallback(raw)
				if err != nil {
					t.Fatalf("ParseSTKCallback: %v", err)
				}
				wantClass := contractRequireString(t, c, "class", c.Expect.Class)
				if got := string(res.Classify()); got != wantClass {
					t.Errorf("class = %q, want %q", got, wantClass)
				}
				wantCode := contractRequireString(t, c, "resultCode", c.Expect.ResultCode)
				if got := res.ResultCode.String(); got != wantCode {
					t.Errorf("resultCode = %q, want %q", got, wantCode)
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
				// Routed through the same body check as the other kinds, so
				// a fixture with no body fails with the same message in
				// all three engines.
				raw := contractRawBody(t, c)
				var body struct {
					Text string `json:"text"`
				}
				if err := json.Unmarshal(raw, &body); err != nil {
					t.Fatalf("decode balance body: %v", err)
				}
				segments, skipped := ParseBalanceSegments(body.Text)
				wantSegments := contractRequireInt(t, c, "segments", c.Expect.Segments)
				if len(segments) != wantSegments {
					t.Errorf("segments = %d, want %d", len(segments), wantSegments)
				}
				wantSkipped := contractRequireInt(t, c, "skipped", c.Expect.Skipped)
				if skipped != wantSkipped {
					t.Errorf("skipped = %d, want %d", skipped, wantSkipped)
				}
			case "error_envelope":
				raw := contractRawBody(t, c)
				status := c.StatusCode
				if status == 0 {
					// statusCode is an input, not an expectation, so a
					// fixture that omits it -- or sets 0, which is not a
					// real HTTP status -- would feed the engine a status
					// no gateway ever sends.
					t.Fatalf("fixture %q has no valid top-level statusCode: %d",
						c.ID, status)
				}
				err := parseError(status, contractContentType(raw), raw, nil)
				merr, ok := err.(*MpesaError)
				if !ok {
					t.Fatalf("parseError returned %T, want *MpesaError", err)
				}
				// A null expectation means "absent": the Go surface carries an
				// empty string where Python and TypeScript carry None/null.
				wantCode, codePresent := contractNullableString(t, c, "errorCode", c.Expect.ErrorCode)
				if !codePresent {
					if merr.ErrorCode != "" {
						t.Errorf("errorCode = %q, want absent", merr.ErrorCode)
					}
				} else if merr.ErrorCode != wantCode {
					t.Errorf("errorCode = %q, want %q", merr.ErrorCode, wantCode)
				}
				wantMsg, msgPresent := contractNullableString(t, c, "errorMessage", c.Expect.ErrorMessage)
				if !msgPresent {
					if merr.ErrorMessage != "" {
						t.Errorf("errorMessage = %q, want absent", merr.ErrorMessage)
					}
				} else if merr.ErrorMessage != wantMsg {
					t.Errorf("errorMessage = %q, want %q", merr.ErrorMessage, wantMsg)
				}
			default:
				t.Fatalf("unknown fixture kind %q", c.Kind)
			}
		})
	}
}

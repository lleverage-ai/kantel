// Package api is Kantel's API client for the command lines: the methods and types in client_gen.go and types_gen.go
// are generated from the OpenAPI document (go run ./internal/api/gen); this file is what they call.
package api

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"reflect"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Client calls one Kantel's API.
type Client struct {
	// BaseURL is the API's URL with its version, such as https://kantel.example/v1.
	BaseURL string
	// Token is the bearer: a personal access token (kpt_…) or an API key (ksk_…). Empty sends none.
	Token string
	// UserAgent is sent on every call.
	UserAgent string
	// HTTP sends the calls; default http.DefaultClient.
	HTTP *http.Client
	// Sleep waits between retries; default a timer that stops when the call's context does. Returning an error ends
	// the retries with the last error.
	Sleep func(ctx context.Context, d time.Duration) error
	// RetryDelays are the waits before each retry of a call that is safe to send again; nil is RetryDelays.
	RetryDelays []time.Duration
}

// RetryDelays are the waits before each retry: a backoff that doubles, five tries over 7.5 s in all, enough for a
// gateway's restart or a network blip, and then the error.
var RetryDelays = []time.Duration{500 * time.Millisecond, time.Second, 2 * time.Second, 4 * time.Second}

// Call is one request, as the generated methods describe it.
type Call struct {
	Method string
	// Path is relative to BaseURL, its parameters already escaped.
	Path  string
	Query url.Values
	// Body is sent as JSON.
	Body any
	// Raw is sent as it is, with ContentType, in place of Body.
	Raw         io.Reader
	ContentType string
	// Idempotent calls take an Idempotency-Key: each call gets one (or CallOption IdempotencyKey's), which its retries
	// share, so Kantel does it once.
	Idempotent bool
	// Out is where the JSON answer is decoded; nil drops it.
	Out any
}

type callOptions struct {
	raw            *json.RawMessage
	idempotencyKey string
	requestID      string
	noRetry        bool
}

// CallOption changes one call.
type CallOption func(*callOptions)

// Raw keeps the call's JSON answer as Kantel sent it, for --json to print as it is.
func Raw(into *json.RawMessage) CallOption { return func(o *callOptions) { o.raw = into } }

// IdempotencyKey sends this key rather than a new one.
func IdempotencyKey(key string) CallOption { return func(o *callOptions) { o.idempotencyKey = key } }

// RequestID is sent as kantel-request-id, which correlates the call in Kantel's audit trail.
func RequestID(id string) CallOption { return func(o *callOptions) { o.requestID = id } }

// NoRetry sends the call once, whatever it is.
func NoRetry() CallOption { return func(o *callOptions) { o.noRetry = true } }

// Error is an error Kantel answered with: its code (or unauthenticated), message and HTTP status, and its details.
type Error struct {
	Status  int
	Code    string
	Message string
	Details map[string]any
	// Reason is why a sandbox couldn't be placed (details.reason), such as no_host_offers_size.
	Reason string
}

func (e *Error) Error() string { return e.Code + ": " + e.Message }

// UnreachableError is Kantel out of reach: its connection refused or dropped before it answered.
type UnreachableError struct {
	Origin string
	Err    error
}

func (e *UnreachableError) Error() string {
	return fmt.Sprintf("couldn't reach Kantel at %s: %v", e.Origin, e.Err)
}

func (e *UnreachableError) Unwrap() error { return e.Err }

// Nullable is a value that may be null, as a field that may also be absent: the zero value is absent (omitzero), Null
// sends null, and Of sends the value.
type Nullable[T any] struct {
	Set   bool
	Null  bool
	Value T
}

// Of is a Nullable holding v.
func Of[T any](v T) Nullable[T] { return Nullable[T]{Set: true, Value: v} }

// Null is a Nullable that is null.
func Null[T any]() Nullable[T] { return Nullable[T]{Set: true, Null: true} }

// IsZero says the field is absent, for omitzero.
func (n Nullable[T]) IsZero() bool { return !n.Set }

func (n Nullable[T]) MarshalJSON() ([]byte, error) {
	if !n.Set || n.Null {
		return []byte("null"), nil
	}
	return json.Marshal(n.Value)
}

func (n *Nullable[T]) UnmarshalJSON(data []byte) error {
	n.Set = true
	if bytes.Equal(bytes.TrimSpace(data), []byte("null")) {
		n.Null = true
		return nil
	}
	return json.Unmarshal(data, &n.Value)
}

// Get is the value and whether there is one (set and not null).
func (n Nullable[T]) Get() (T, bool) { return n.Value, n.Set && !n.Null }

// Ptr is a pointer to v, for an optional field.
func Ptr[T any](v T) *T { return &v }

// setQuery adds one query parameter: nothing for nil, a record as name.key=value, a list as repeated names.
func setQuery(v url.Values, name string, value any) {
	switch x := value.(type) {
	case nil:
	case *string:
		if x != nil {
			v.Set(name, *x)
		}
	case *bool:
		if x != nil {
			v.Set(name, strconv.FormatBool(*x))
		}
	case *int64:
		if x != nil {
			v.Set(name, strconv.FormatInt(*x, 10))
		}
	case *float64:
		if x != nil {
			v.Set(name, strconv.FormatFloat(*x, 'f', -1, 64))
		}
	case map[string]string:
		keys := make([]string, 0, len(x))
		for k := range x {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			v.Add(name+"."+k, x[k])
		}
	case []string:
		for _, item := range x {
			v.Add(name, item)
		}
	default:
		// A named string type (an enum), through a pointer.
		r := reflect.ValueOf(value)
		if r.Kind() == reflect.Pointer && !r.IsNil() && r.Elem().Kind() == reflect.String {
			v.Set(name, r.Elem().String())
		}
	}
}

var retriedStatuses = map[int]bool{502: true, 503: true, 504: true}

// keyedRetries are the keyed calls retried: those every control plane that takes keys has kept the promise on
// (creating and forking a sandbox, running a command). Others are sent with a key, but once, since an older control
// plane ignores the key on them and would do them again.
var keyedRetries = []*regexp.Regexp{
	regexp.MustCompile(`^POST /sandboxes$`),
	regexp.MustCompile(`^POST /sandboxes/[^/]+/fork$`),
	regexp.MustCompile(`^POST /sandboxes/[^/]+/commands$`),
}

// sameAgain are the changes whose second sending leaves things as the first did: a file's write replaces the whole
// file with the same bytes.
var sameAgain = []*regexp.Regexp{regexp.MustCompile(`^PUT /sandboxes/[^/]+/files$`)}

func retried(call Call, keyed bool) bool {
	switch call.Method {
	case http.MethodGet, http.MethodHead, http.MethodOptions:
		return true
	}
	if call.Raw != nil {
		// A body read once can't be sent again.
		return false
	}
	line := call.Method + " " + call.Path
	for _, re := range sameAgain {
		if re.MatchString(line) {
			return true
		}
	}
	if !keyed {
		return false
	}
	for _, re := range keyedRetries {
		if re.MatchString(line) {
			return true
		}
	}
	return false
}

// Do sends one call, and its retries where it is safe to send again, and decodes its answer into call.Out.
func (c *Client) Do(ctx context.Context, call Call, opts ...CallOption) error {
	var o callOptions
	for _, opt := range opts {
		opt(&o)
	}
	key := ""
	if call.Idempotent {
		key = o.idempotencyKey
		if key == "" {
			key = newUUID()
		}
	}
	var body []byte
	if call.Raw == nil && call.Body != nil {
		var err error
		if body, err = json.Marshal(call.Body); err != nil {
			return err
		}
	}
	again := !o.noRetry && retried(call, key != "")
	delays := c.RetryDelays
	if delays == nil {
		delays = RetryDelays
	}
	for attempt := 0; ; attempt++ {
		answer, status, err := c.send(ctx, call, body, key, o)
		retry := again && attempt < len(delays) && ctx.Err() == nil
		if err != nil {
			var unreachable *UnreachableError
			if !retry || !errors.As(err, &unreachable) {
				return err
			}
		} else if status >= 400 {
			apiErr := errorOf(status, answer)
			// Kantel's own answer is the call's outcome, even a 503; only a proxy's failure, which never said what
			// Kantel did, is sent again.
			if !retry || !retriedStatuses[status] || kantelAnswered(answer) {
				return apiErr
			}
		} else {
			if o.raw != nil {
				*o.raw = append(json.RawMessage(nil), answer...)
			}
			if call.Out != nil && len(bytes.TrimSpace(answer)) > 0 {
				if err := json.Unmarshal(answer, call.Out); err != nil {
					return fmt.Errorf("Kantel's answer to %s %s isn't what this kantel expects: %w", call.Method, call.Path, err)
				}
			}
			return nil
		}
		if err := c.sleep(ctx, delays[attempt]); err != nil {
			return err
		}
	}
}

func (c *Client) sleep(ctx context.Context, d time.Duration) error {
	if c.Sleep != nil {
		return c.Sleep(ctx, d)
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

func (c *Client) send(ctx context.Context, call Call, body []byte, key string, o callOptions) ([]byte, int, error) {
	target := strings.TrimRight(c.BaseURL, "/") + call.Path
	if len(call.Query) > 0 {
		target += "?" + call.Query.Encode()
	}
	var reader io.Reader
	switch {
	case call.Raw != nil:
		reader = call.Raw
	case body != nil:
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, call.Method, target, reader)
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Accept", "application/json")
	if c.UserAgent != "" {
		req.Header.Set("User-Agent", c.UserAgent)
	}
	if c.Token != "" {
		req.Header.Set("Authorization", "Bearer "+c.Token)
	}
	switch {
	case call.Raw != nil:
		req.Header.Set("Content-Type", call.ContentType)
	case body != nil:
		req.Header.Set("Content-Type", "application/json")
	}
	if key != "" {
		req.Header.Set("Idempotency-Key", key)
	}
	if o.requestID != "" {
		req.Header.Set("Kantel-Request-Id", o.requestID)
	}
	client := c.HTTP
	if client == nil {
		client = http.DefaultClient
	}
	res, err := client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return nil, 0, ctx.Err()
		}
		var urlErr *url.Error
		if errors.As(err, &urlErr) {
			err = urlErr.Err
		}
		return nil, 0, &UnreachableError{Origin: origin(c.BaseURL), Err: err}
	}
	defer res.Body.Close()
	answer, err := io.ReadAll(res.Body)
	if err != nil {
		return nil, 0, &UnreachableError{Origin: origin(c.BaseURL), Err: err}
	}
	if res.StatusCode >= 400 && !strings.Contains(res.Header.Get("Content-Type"), "application/json") {
		// A proxy's page, not Kantel's JSON: its code comes from the status alone.
		return []byte{}, res.StatusCode, nil
	}
	return answer, res.StatusCode, nil
}

// kantelAnswered says whether an error's body is Kantel's own, {"error": {"code": …}}.
func kantelAnswered(answer []byte) bool {
	var body struct {
		Error *struct {
			Code *string `json:"code"`
		} `json:"error"`
	}
	return json.Unmarshal(answer, &body) == nil && body.Error != nil && body.Error.Code != nil
}

func errorOf(status int, answer []byte) *Error {
	var body struct {
		Error *struct {
			Code    string         `json:"code"`
			Message string         `json:"message"`
			Details map[string]any `json:"details"`
		} `json:"error"`
	}
	_ = json.Unmarshal(answer, &body)
	e := &Error{Status: status}
	if body.Error != nil {
		e.Code, e.Message, e.Details = body.Error.Code, body.Error.Message, body.Error.Details
	}
	if e.Code == "" {
		if status == http.StatusUnauthorized {
			e.Code = "unauthenticated"
		} else {
			e.Code = "unavailable"
		}
	}
	if e.Message == "" {
		e.Message = fmt.Sprintf("Kantel answered %d", status)
	}
	if reason, ok := e.Details["reason"].(string); ok {
		e.Reason = reason
	}
	return e
}

// origin is a URL's scheme and host: https://kantel.example.
func origin(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return raw
	}
	return u.Scheme + "://" + u.Host
}

func newUUID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}

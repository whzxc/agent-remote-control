package core

import (
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"os"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
)

var ingressCounterNames = []string{
	"received", "completed", "responseDropped", "handlerCancelled", "httpErrors", "bodyTimeouts",
	"connectionErrors", "headerTimeouts", "capacityRejected", "durationMs", "responseBytes",
}

type ingressCounters struct {
	mu     sync.Mutex
	totals map[string]uint64
}

func (c *ingressCounters) add(changes map[string]uint64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.totals == nil {
		c.totals = make(map[string]uint64)
	}
	for name, count := range changes {
		c.totals[name] += min(math.MaxUint64-c.totals[name], count)
	}
}

func (c *ingressCounters) snapshot() object {
	c.mu.Lock()
	defer c.mu.Unlock()
	result := object{"scope": "ingress-instance"}
	for _, key := range ingressCounterNames {
		result[key] = c.totals[key]
	}
	left := c.totals["received"]
	for _, key := range []string{"completed", "responseDropped", "handlerCancelled"} {
		left -= min(left, c.totals[key])
	}
	result["inFlight"] = left
	return result
}

func recordIngressObservation(row object, event string) {
	row["time"] = now()
	level := "INFO"
	if slices.Contains([]string{"response_dropped", "handler_cancelled", "connection_error", "capacity_rejected"}, event) {
		level = "WARN"
	}
	row["level"], row["event"], row["msg"] = level, event, "Ingress "+event
	if err := appendLog(row); err != nil {
		fmt.Fprintln(os.Stderr, "Cannot persist ingress observation:", err)
	}
}

var ingressFieldName = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,64}$`)
var ingressGrantID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)
var ingressRay = regexp.MustCompile(`^[A-Fa-f0-9]{16}(?:-[A-Za-z0-9]{1,8})?$`)
var ingressErrorCode = regexp.MustCompile(`^[A-Z0-9_]{0,80}$`)

func ingressShape(value any, depth int, budget *int) object {
	*budget--
	switch value := value.(type) {
	case object:
		fields := object{}
		if depth < 3 {
			for _, name := range keys(value) {
				if *budget == 0 {
					break
				}
				if ingressFieldName.MatchString(name) {
					fields[name] = ingressShape(value[name], depth+1, budget)
				}
			}
		}
		return object{"type": "object", "fields": fields, "omittedFields": len(value) - len(fields)}
	case []any:
		items := []any{}
		if depth < 3 {
			for _, item := range value[:min(3, len(value))] {
				if *budget == 0 {
					break
				}
				items = append(items, ingressShape(item, depth+1, budget))
			}
		}
		return object{"type": "array", "items": items, "omittedItems": len(value) - len(items)}
	case bool:
		return object{"type": "boolean"}
	case json.Number, int, uint64:
		return object{"type": "number"}
	case string:
		return object{"type": "string"}
	default:
		return object{"type": "null"}
	}
}

type ingressObservation struct {
	ingress *networkIngress
	mu      sync.Mutex
	row     object
	started time.Time
}

func observeIngressRequest(ingress *networkIngress, connection string, r *http.Request) *ingressObservation {
	route, method := "other", "other"
	switch p := r.URL.Path; {
	case p == "/mcp":
		route = "mcp"
	case strings.HasPrefix(p, "/.well-known/"):
		route = "discovery"
	case strings.HasPrefix(p, "/oauth/"):
		route = "oauth"
	}
	if slices.Contains([]string{"GET", "POST", "DELETE", "OPTIONS"}, r.Method) {
		method = r.Method
	}
	li := &ingressObservation{ingress: ingress, started: time.Now(),
		row: object{"ingressId": ingress.id, "connectionId": connection, "traceId": id(), "route": route, "method": method, "cfRay": nil}}
	if ray := r.Header.Get("Cf-Ray"); ingressRay.MatchString(ray) {
		li.row["cfRay"] = ray
	}
	ingress.requests.add(map[string]uint64{"received": 1})
	names := []string{}
	for key := range r.Header {
		if name := strings.ToLower(key); ingressFieldName.MatchString(name) {
			names = append(names, name)
		}
	}
	total := len(r.Header)
	if r.Host != "" {
		names = append(names, "host")
		total++
	}
	slices.Sort(names)
	names = names[:min(64, len(names))]
	received := clone(li.row)
	received["headerNames"], received["omittedHeaderNames"] = names, total-len(names)
	recordIngressObservation(received, "request_received")
	return li
}

func (o *ingressObservation) authenticated(principal object) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if client := text(principal, "clientId"); client != "" {
		o.row["oauthClientHash"] = hash([]byte(client))
	}
	o.row["authenticated"] = true
	if grant := text(principal, "grantId"); ingressGrantID.MatchString(grant) {
		o.row["grantId"] = grant
	}
}

var ingressOAuthFields = map[string][]string{
	"/oauth/register":  {"client_name", "redirect_uris", "grant_types", "response_types", "scope", "token_endpoint_auth_method"},
	"/oauth/authorize": {"client_id", "redirect_uri", "response_type", "resource", "scope", "code_challenge", "code_challenge_method", "state"},
	"/oauth/token":     {"client_id", "client_secret", "grant_type", "code", "code_verifier", "redirect_uri", "resource", "scope", "refresh_token"},
	"/oauth/revoke":    {"token", "token_type_hint", "client_id", "client_secret"},
}

func (o *ingressObservation) oauthFields(endpoint, location string, value object) {
	known, ok := ingressOAuthFields[endpoint]
	if !ok {
		return
	}
	o.mu.Lock()
	row := clone(o.row)
	o.mu.Unlock()
	row["oauthEndpoint"], row["location"] = endpoint, location
	budget := 64
	schema := ingressShape(value, 0, &budget)
	row["schema"] = schema
	unknown := []string{}
	for _, key := range keys(obj(schema["fields"])) {
		if !slices.Contains(known, key) {
			unknown = append(unknown, key)
		}
	}
	row["unrecognizedFields"] = unknown
	if endpoint == "/oauth/token" {
		grant := text(value, "grant_type")
		if grant != "authorization_code" && grant != "refresh_token" {
			grant = "other"
		}
		row["grantType"] = grant
	}
	recordIngressObservation(row, "request_metadata")
}

func (o *ingressObservation) dispatch(request object) {
	o.mu.Lock()
	defer o.mu.Unlock()
	method := text(request, "method")
	switch method {
	case "initialize", "server/discover", "ping", "tools/list", "tools/call", "events/list", "events/subscribe", "events/unsubscribe":
		o.row["mcpMethod"] = method
	default:
		o.row["mcpMethod"] = "other"
	}
	if method == "initialize" || method == "server/discover" {
		metadata := clone(o.row)
		metadata["stage"] = "mcp-initialize"
		if method == "server/discover" {
			metadata["stage"] = "mcp-discover"
		}
		params, present := request["params"]
		budget := 64
		metadata["paramsPresent"], metadata["schema"] = present, ingressShape(params, 0, &budget)
		recordIngressObservation(metadata, "request_metadata")
	}
	if method == "tools/call" {
		params := obj(request["params"])
		envelope := obj(params["arguments"])
		op := text(envelope, "op")
		if params["name"] == "guide" {
			op = "guide"
		}
		if operation(op) != nil {
			o.row["op"] = op
			rid, exists := envelope["requestId"]
			if !exists {
				rid = field(envelope["args"], "requestId")
			}
			if _, err := uuid.Parse(str(rid)); err == nil {
				o.row["requestId"] = rid
			}
		}
	}
	o.row["dispatchAfterMs"] = time.Since(o.started).Milliseconds()
	recordIngressObservation(clone(o.row), "request_dispatch")
}

func (o *ingressObservation) result(result object, err error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if err != nil {
		o.row["errorCode"] = "MCP_TRANSPORT_ERROR"
		return
	}
	payload, err := egressToolValue(result["result"])
	if err != nil {
		return
	}
	if rid := text(payload, "requestId"); rid != "" {
		if _, err := uuid.Parse(rid); err == nil {
			o.row["requestId"] = rid
		}
	}
	if code, ok := field(field(payload, "error"), "code").(string); ok && ingressErrorCode.MatchString(code) {
		o.row["errorCode"] = code
	}
}

type ingressObservedWriter struct {
	http.ResponseWriter
	observation *ingressObservation
	status      int
	bytes       uint64
	failed      bool
}

func (w *ingressObservedWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func (w *ingressObservedWriter) WriteHeader(status int) {
	if w.status != 0 {
		return
	}
	w.status = status
	o := w.observation
	o.mu.Lock()
	row := clone(o.row)
	o.mu.Unlock()
	row["httpStatus"], row["headersAfterMs"] = status, time.Since(o.started).Milliseconds()
	recordIngressObservation(row, "response_headers")
	if status >= 400 {
		o.ingress.requests.add(map[string]uint64{"httpErrors": 1})
	}
	if status == http.StatusRequestTimeout {
		o.ingress.requests.add(map[string]uint64{"bodyTimeouts": 1})
	}
	w.ResponseWriter.WriteHeader(status)
}

func (w *ingressObservedWriter) Write(body []byte) (int, error) {
	if w.status == 0 {
		w.WriteHeader(http.StatusOK)
	}
	n, err := w.ResponseWriter.Write(body)
	w.bytes += uint64(n)
	w.failed = w.failed || err != nil
	return n, err
}

func (w *ingressObservedWriter) FlushError() error {
	if w.status == 0 {
		w.WriteHeader(http.StatusOK)
	}
	err := http.NewResponseController(w.ResponseWriter).Flush()
	w.failed = w.failed || err != nil
	return err
}

func (w *ingressObservedWriter) finish(r *http.Request) {
	metric, event := "completed", "response_finished"
	switch {
	case w.status == 0 && r.Context().Err() != nil:
		metric, event = "handlerCancelled", "handler_cancelled"
	case w.failed || r.Context().Err() != nil:
		metric, event = "responseDropped", "response_dropped"
	case w.status == 0:
		w.WriteHeader(http.StatusOK)
	}
	o := w.observation
	duration := uint64(time.Since(o.started).Milliseconds())
	o.ingress.requests.add(map[string]uint64{metric: 1, "durationMs": duration, "responseBytes": w.bytes})
	o.mu.Lock()
	row := clone(o.row)
	o.mu.Unlock()
	row["durationMs"], row["responseBytes"] = duration, w.bytes
	recordIngressObservation(row, event)
}

func (i *networkIngress) observeConnection(connection, event, code string) {
	changes := map[string]uint64{}
	if event == "connection_error" {
		changes["connectionErrors"] = 1
	}
	if code == "HEADER_TIMEOUT" {
		changes["headerTimeouts"] = 1
	}
	if event == "capacity_rejected" {
		changes["capacityRejected"] = 1
	}
	i.requests.add(changes)
	recordIngressObservation(object{"ingressId": i.id, "connectionId": connection, "code": code}, event)
}

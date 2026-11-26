package core

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

const notificationEventName = "notification"
const notificationEventTTL = 24 * time.Hour
const notificationPayloadLimit = 256 * 1024

var notificationEventOperation sync.Mutex
var notificationFixtureCallback func(*url.URL) bool

type notificationEventAccess uint8

const (
	notificationEventSourceUnavailable notificationEventAccess = iota
	notificationEventPrincipalRevoked
	notificationEventDisconnected
	notificationEventConnected
)

var notificationEventAuthorize func(context.Context, *service, requestSource, string) (requestSource, notificationEventAccess)
var notificationEventList = sync.OnceValue(func() object {
	var catalog object
	if err := decodeObject([]byte(`{"events":[{"name":"notification","description":"ARC notifications. Read guide({topic:notify}) for supported op and args contracts. Currently task_status wakes only for completed, failed, interrupted, stalled, or needs-input tasks from this source. Lifecycle and handoff records remain inbox-only. Work wakeups may take minutes; read full results with query.","delivery":["webhook"],
        "inputSchema":null,
        "payloadSchema":{"type":"object","properties":{"op":{"type":"string"},"kind":{"type":"string"},"summary":{"type":"string"},"threadId":{"type":["string","null"]},"taskId":{"type":["string","null"]},"turnId":{"type":"string"},"agent":{"type":"string"},"project":{"type":"string"},"title":{"type":"string"},"query":{"type":"object"},"progress":{"type":["object","null"]},
        "recovery":{"type":["object","null"],"properties":{"recoveredAt":{"type":"string","format":"date-time"},"affectedTasks":{"type":"integer","minimum":0}},"required":["recoveredAt","affectedTasks"],"additionalProperties":false},
        "continuation":{"type":["object","null"],"properties":{"turnId":{"type":"string"},"state":{"type":"string","enum":["running","completed","failed","interrupted","needs-input","unknown"]}},"required":["turnId","state"],"additionalProperties":false},
        "reconciliation":{"type":["object","null"],"properties":{"endedAt":{"type":["string","null"],"format":"date-time"},"durationMs":{"type":["integer","null"],"minimum":0},"timeBasis":{"type":"string","enum":["native-terminal","last-observed-activity","unknown","observed-terminal"]}},"required":["endedAt","durationMs","timeBasis"],"additionalProperties":false},
        "ownership":{"type":["object","null"],"properties":{"eventId":{"type":"string"},"from":{"type":"string"},"to":{"type":"string"},"observedAt":{"type":"string","format":"date-time"},"evidence":{"type":["string","null"]},"timeBasis":{"type":"string"}},"required":["eventId","from","to","observedAt","evidence","timeBasis"],"additionalProperties":false}},"required":["op","kind","summary","threadId","taskId","turnId","agent","project","title","query","ownership","reconciliation","continuation","recovery"],"additionalProperties":false}}]}`), &catalog); err != nil {
		panic(err)
	}
	obj(arr(catalog["events"])[0])["inputSchema"] = eventGuide()["inputSchema"]
	return catalog
})

func notificationRPCError(code int, reason string) error {
	message := "Invalid event request"
	if code == -32015 {
		message = "CallbackEndpointError"
	}
	return dispatchObjectError(object{"code": code, "message": message, "data": object{"reason": reason}})
}

func notificationSigningKey(secret string) ([]byte, error) {
	encoded, ok := strings.CutPrefix(secret, "whsec_")
	key, err := base64.StdEncoding.Strict().DecodeString(encoded)
	if !ok || err != nil || len(key) < 24 || len(key) > 64 || strings.ContainsAny(encoded, "\r\n") {
		return nil, notificationRPCError(-32602, "invalid_signing_secret")
	}
	return key, nil
}

func notificationSignature(secret, messageID string, at int64, body []byte) (string, error) {
	key, err := notificationSigningKey(secret)
	if err != nil {
		return "", err
	}
	sign := hmac.New(sha256.New, key)
	_, _ = fmt.Fprintf(sign, "%s.%d.", messageID, at)
	_, _ = sign.Write(body)
	return "v1," + base64.StdEncoding.EncodeToString(sign.Sum(nil)), nil
}

func notificationPublicIP(ip netip.Addr) bool {
	if ip.Is4() {
		b := ip.As4()
		a, c, d := b[0], b[1], b[2]
		return !(a == 0 || a == 10 || a == 127 || a >= 224 ||
			a == 100 && c >= 64 && c <= 127 ||
			a == 169 && c == 254 ||
			a == 172 && c >= 16 && c <= 31 ||
			a == 192 && (c == 0 || c == 168 || c == 88 && d == 99) ||
			a == 198 && (c == 18 || c == 19 || c == 51 && d == 100) ||
			a == 203 && c == 0 && d == 113)
	}
	if !ip.Is6() {
		return false
	}
	b := ip.As16()
	first, second := binary.BigEndian.Uint16(b[:2]), binary.BigEndian.Uint16(b[2:4])
	return first&0xe000 == 0x2000 && first != 0x2002 && first != 0x3ffe &&
		!(first == 0x2001 && (second < 0x200 || second == 0xdb8)) &&
		!(first == 0x3fff && second < 0x1000)
}

func notificationCallbackURL(raw string) (*url.URL, bool, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Hostname() == "" {
		return nil, false, notificationRPCError(-32015, "invalid_url")
	}
	if u.Path == "" {
		u.Path = "/"
	}
	if notificationFixtureCallback != nil && notificationFixtureCallback(u) {
		return u, true, nil
	}
	if u.Scheme != "https" || u.User != nil || strings.Contains(raw, "#") {
		return nil, false, notificationRPCError(-32015, "invalid_url")
	}
	host := strings.ToLower(u.Hostname())
	if port := u.Port(); port != "" && port != "443" {
		if number, err := strconv.ParseUint(port, 10, 16); err != nil || number == 0 {
			return nil, false, notificationRPCError(-32015, "invalid_url")
		}
		u.Host = net.JoinHostPort(host, port)
	} else if strings.Contains(host, ":") {
		u.Host = "[" + host + "]"
	} else {
		u.Host = host
	}
	return u, false, nil
}

func postNotificationWebhook(ctx context.Context, sub object, messageID string, body []byte) (int, []byte, error) {
	if len(body) > notificationPayloadLimit {
		return 0, nil, errors.New("payload_too_large")
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	webhook := obj(sub["webhook"])
	if webhook == nil {
		return 0, nil, errors.New("missing_webhook")
	}
	u, fixture, err := notificationCallbackURL(text(webhook, "url"))
	if err != nil {
		return 0, nil, errors.New("invalid_url")
	}
	addresses, err := net.DefaultResolver.LookupNetIP(ctx, "ip", u.Hostname())
	if err != nil {
		return 0, nil, errors.New("dns_failed")
	}
	if len(addresses) == 0 {
		return 0, nil, errors.New("non_public_address")
	}
	for _, ip := range addresses {
		if !fixture && !notificationPublicIP(ip) {
			return 0, nil, errors.New("non_public_address")
		}
	}
	dialer := &net.Dialer{}
	transport := &http.Transport{DisableKeepAlives: true, ForceAttemptHTTP2: true,
		DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
			_, port, err := net.SplitHostPort(address)
			if err != nil {
				return nil, err
			}
			for _, ip := range addresses {
				conn, err := dialer.DialContext(ctx, network, net.JoinHostPort(ip.String(), port))
				if err == nil {
					return conn, nil
				}
			}
			return nil, errors.New("connection_failed")
		},
	}
	defer transport.CloseIdleConnections()
	client := http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	at := time.Now().Unix()
	sig, err := notificationSignature(text(webhook, "secret"), messageID, at, body)
	if err != nil {
		return 0, nil, err
	}
	if old := text(webhook, "previousSecret"); old != "" && uintOr(webhook["rotateUntil"], 0) > uint64(at) {
		previous, err := notificationSignature(old, messageID, at, body)
		if err != nil {
			return 0, nil, err
		}
		sig += " " + previous
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, u.String(), strings.NewReader(string(body)))
	if err != nil {
		return 0, nil, errors.New("invalid_url")
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("webhook-id", messageID)
	request.Header.Set("webhook-timestamp", strconv.FormatInt(at, 10))
	request.Header.Set("webhook-signature", sig)
	request.Header.Set("X-MCP-Subscription-Id", text(sub, "id"))
	response, err := client.Do(request)
	if err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			return 0, nil, errors.New("timeout")
		}
		return 0, nil, errors.New("connection_failed")
	}
	defer response.Body.Close()
	if !strings.HasPrefix(messageID, "msg_verification_") {
		return response.StatusCode, nil, nil
	}
	reply, err := io.ReadAll(io.LimitReader(response.Body, 8193))
	if err != nil {
		return 0, nil, errors.New("response_failed")
	}
	if len(reply) > 8192 {
		return 0, nil, errors.New("response_too_large")
	}
	return response.StatusCode, reply, nil
}

func notificationEventPayload(op string, event object) object {
	pending := event["kind"] == "needs-input"
	var query object
	switch {
	case obj(event["device"]) != nil:
		query = object{"op": "device", "args": field(event["next"], "args")}
	case event["kind"] == "recovered":
		query = object{"op": "notify_status", "args": object{"target": event["target"]}}
	case event["agent"] != "codex":
		next := "agent_read"
		if pending {
			next = "agent_pending"
		}
		query = object{"op": next, "args": object{"agent": event["agent"], "taskId": event["taskId"]}}
	default:
		next := "codex_read"
		if pending {
			next = "codex_pending"
		}
		query = object{"op": next, "args": object{"threadId": event["threadId"]}}
	}
	data := object{"op": op, "query": query}
	for _, key := range []string{"kind", "summary", "threadId", "taskId", "turnId", "agent", "project", "title",
		"ownership", "reconciliation", "continuation", "recovery", "progress"} {
		data[key] = event[key]
	}
	for _, item := range []struct{ key, field string }{{"ownership", "causedBySourceId"}, {"recovery", "message"}} {
		if sub := clone(obj(data[item.key])); sub != nil {
			delete(sub, item.field)
			data[item.key] = sub
		}
	}
	stripNotificationInternal(data)
	return data
}

func notificationEventsRequest(ctx context.Context, s *service, source requestSource, method string, params object) (object, error) {
	sourceID := text(source.origin, "sourceId")
	principal := text(source.origin, "eventPrincipal")
	if principal == "" || sourceID == "" {
		return nil, notificationRPCError(-32001, "authenticated_principal_required")
	}
	current, access := notificationEventAuthorize(ctx, s, source, principal)
	if access == notificationEventSourceUnavailable || access == notificationEventPrincipalRevoked {
		return nil, notificationRPCError(-32001, "access_revoked")
	}
	if method != "events/unsubscribe" && (access == notificationEventDisconnected ||
		!policyAllows(current.policy, "codex_read") && !policyAllows(current.policy, "agent_read")) {
		if method == "events/list" {
			return object{"events": []any{}}, nil
		}
		return nil, notificationRPCError(-32001, "event_access_denied")
	}
	if method == "events/list" {
		return notificationEventList(), nil
	}
	delivery := obj(params["delivery"])
	if params["name"] != notificationEventName || delivery["mode"] != "webhook" {
		return nil, notificationRPCError(-32602, "Use name=notification, delivery.mode=webhook and arguments={op:task_status,args:{}}; see guide({topic:notify})")
	}
	args, err := validateNotificationSubscription(params["arguments"])
	if err != nil {
		return nil, err
	}
	u, _, err := notificationCallbackURL(text(delivery, "url"))
	if err != nil {
		return nil, err
	}
	subID := "sub_" + hash([]byte(wire([]any{sourceID, principal, notificationEventName, args, u.String()})))
	notificationTransportMu.Lock()
	defer notificationTransportMu.Unlock()
	notificationEventOperation.Lock()
	defer notificationEventOperation.Unlock()
	state, err := readNotificationState()
	if err != nil {
		return nil, err
	}
	rows := arr(state["subscriptions"])
	if method == "events/unsubscribe" {
		removeNotificationSubscription(state, subID)
		if err := finishNotificationSubscriptionDeliveries(subID); err != nil {
			return nil, err
		}
		return object{}, saveNotificationState(state)
	}
	if params["cursor"] != nil {
		return nil, dispatchObjectError(object{"code": -32602, "message": "Invalid event request",
			"data": object{"reason": "replay_not_supported", "next": object{"via": "query", "op": "notify_status", "args": object{},
				"hint": "Event replay is unavailable. Read subscription expiry and delivery diagnosis, read the referenced tasks, then renew the same subscription without a cursor if expired."}}})
	}
	secret := text(delivery, "secret")
	key, err := notificationSigningKey(secret)
	if err != nil {
		return nil, err
	}
	ttl := uint64(notificationEventTTL.Milliseconds())
	if params["ttlMs"] != nil {
		n, ok := uintValue(params["ttlMs"])
		if !ok || n == 0 || n > 1<<63-1 {
			return nil, notificationRPCError(-32602, "invalid_ttl")
		}
		ttl = min(n, ttl)
	}
	nowAt := time.Now()
	webhook := object{"principal": principal, "url": u.String(), "secret": secret, "previousSecret": nil, "rotateUntil": 0, "verifiedUntil": 0}
	sub := object{"id": subID, "sourceId": sourceID, "channel": "mcp-events", "target": subID,
		"op": "task_status", "args": args["args"], "turn": nil, "createdAt": nowAt.UnixMilli(),
		"webhook": webhook, "muted": false, "until": nil}
	if old := find(rows, "id", subID); old != nil {
		if notificationSubscriptionActive(old, nowAt.UnixMilli()) {
			sub["createdAt"] = old["createdAt"]
		}
		sub["muted"], sub["until"] = old["muted"] == true, old["until"]
		if w := obj(old["webhook"]); w != nil {
			if w["secret"] != secret {
				webhook["previousSecret"], webhook["rotateUntil"] = w["secret"], nowAt.Unix()+300
			} else {
				webhook["previousSecret"], webhook["rotateUntil"] = w["previousSecret"], w["rotateUntil"]
			}
		}
	}
	var verifiedUntil uint64
	for _, row := range rows {
		w := obj(field(row, "webhook"))
		if field(row, "sourceId") == sourceID && w["principal"] == principal && w["url"] == webhook["url"] && w["secret"] == secret {
			verifiedUntil = max(verifiedUntil, uintOr(w["verifiedUntil"], 0))
		}
	}
	if verifiedUntil <= uint64(nowAt.Unix()) {
		challenge := id() + id()
		status, reply, err := postNotificationWebhook(ctx, sub, "msg_verification_"+id(), []byte(wire(object{"type": "verification", "challenge": challenge})))
		if err != nil {
			return nil, notificationRPCError(-32015, err.Error())
		}
		var response object
		_ = decodeObject(reply, &response)
		digest := func(value string) []byte {
			mac := hmac.New(sha256.New, key)
			_, _ = mac.Write([]byte(value))
			return mac.Sum(nil)
		}
		if status < 200 || status >= 300 || !hmac.Equal(digest(challenge), digest(text(response, "challenge"))) {
			return nil, notificationRPCError(-32015, "challenge_failed")
		}
		verifiedUntil = uint64(nowAt.Unix() + 300)
	}
	webhook["verifiedUntil"] = verifiedUntil
	if _, access := notificationEventAuthorize(ctx, s, source, principal); access == notificationEventSourceUnavailable || access == notificationEventPrincipalRevoked {
		return nil, notificationRPCError(-32001, "access_revoked")
	}
	expires := time.UnixMilli(time.Now().UnixMilli() + int64(ttl)).UTC()
	sub["expiresAt"] = expires.UnixMilli()
	removeNotificationSubscription(state, subID)
	state["subscriptions"] = append(arr(state["subscriptions"]), sub)
	if err := saveNotificationState(state); err != nil {
		return nil, err
	}
	return object{"id": subID, "refreshBefore": notificationISO(expires), "cursor": nil, "truncated": false}, nil
}

func notificationISO(t time.Time) string {
	if t.Nanosecond() == 0 {
		return t.UTC().Format("2006-01-02T15:04:05+00:00")
	}
	return t.UTC().Format("2006-01-02T15:04:05.000+00:00")
}

func init() {
	for _, method := range []string{"events/list", "events/subscribe", "events/unsubscribe"} {
		registerMCPMethod(method, func(ctx context.Context, s *service, source requestSource, params object) (object, error) {
			return notificationEventsRequest(ctx, s, source, method, params)
		})
	}
}

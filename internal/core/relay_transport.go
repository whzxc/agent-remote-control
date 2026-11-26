package core

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"encoding/base64"

	"github.com/coder/websocket"
	"github.com/whzxc/agent-remote-control/internal/canonjson"
)

type relayControlError struct {
	status  int
	message string
}

func (err *relayControlError) Error() string { return err.message }

func networkHTTPClient(proxy networkProxy) *http.Client {
	return &http.Client{Transport: &http.Transport{
		DialContext: (&net.Dialer{Timeout: 20 * time.Second}).DialContext,
		Proxy:       proxy.proxyFor,
	}, CheckRedirect: relayNoRedirect}
}

func relayHTTPClient(ctx context.Context, config object) (*http.Client, error) {
	proxy, err := resolveRelayNetworkProxy(ctx, config)
	if err != nil {
		return nil, err
	}
	return networkHTTPClient(proxy), nil
}

func relayNoRedirect(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }

func relayHTTP(ctx context.Context, client *http.Client, method, address string, body any, bound time.Duration) (result any, status string, statusCode int, err error) {
	wait, cancel := context.WithTimeout(ctx, bound)
	defer cancel()
	var reader io.Reader
	if body != nil {
		reader = strings.NewReader(wire(body))
	}
	request, err := http.NewRequestWithContext(wait, method, address, reader)
	if err != nil {
		return nil, "", 0, err
	}
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
		request.GetBody = nil
	}
	res, err := client.Do(request)
	if err != nil {
		return nil, "", 0, err
	}
	defer res.Body.Close()
	status, statusCode = res.Status, res.StatusCode
	bytes, err := io.ReadAll(io.LimitReader(res.Body, maxFrameBytes+1))
	if err != nil {
		return nil, status, statusCode, err
	}
	if len(bytes) > maxFrameBytes {
		return nil, status, statusCode, errors.New("relay response too large")
	}
	err = canonjson.Unmarshal(bytes, &result)
	return result, status, statusCode, err
}

func relayEnvelope(ctx context.Context, client *http.Client, origin string, identity relayIdentity, payload any) (object, error) {
	result, status, code, err := relayHTTP(ctx, client, http.MethodPost, origin+"/challenge", nil, 20*time.Second)
	if code == 0 {
		var urlErr *url.Error
		if errors.As(err, &urlErr) {
			err = urlErr.Err
		}
		return nil, fmt.Errorf("Cannot reach relay challenge endpoint: %v", err)
	}
	if code/100 != 2 {
		return nil, &relayControlError{code, "Relay challenge HTTP " + status}
	}
	if err != nil {
		return nil, errors.New("Invalid relay challenge")
	}
	return identity.envelope(origin, text(result, "challenge"), payload), nil
}

func relayControl(ctx context.Context, client *http.Client, origin string, identity relayIdentity, payload object) (any, error) {
	auth, err := relayEnvelope(ctx, client, origin, identity, payload)
	if err != nil {
		return nil, err
	}
	result, status, code, err := relayHTTP(ctx, client, http.MethodPost, origin+"/control", auth, 30*time.Second)
	switch {
	case code == 0:
		return nil, errors.New("Relay management request failed; read status before retrying")
	case err != nil:
		return nil, &relayControlError{code, "Invalid relay management response"}
	case code/100 != 2:
		return nil, &relayControlError{code, "Relay HTTP " + status + ": " + text(result, "error")}
	default:
		return result, nil
	}
}

func relayWaitDeployed(ctx context.Context, client *http.Client, origin string) error {
	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	delay := time.Second
	for ctx.Err() == nil {
		value, _, status, err := relayHTTP(ctx, client, http.MethodPost, origin+"/challenge", nil, 10*time.Second)
		if _, ok := field(value, "challenge").(string); err == nil && status/100 == 2 && ok && field(value, "version") == buildVersion {
			return nil
		}
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
		case <-timer.C:
		}
		delay = min(2*delay, 8*time.Second)
	}
	return errors.New("Worker deployed, but workers.dev is not ready after 60 seconds; check proxy and retry relay.redeploy")
}

func relayUpgrade(ctx context.Context, client *http.Client, origin, instance string, auth object) (*websocket.Conn, error) {
	wait, cancel := context.WithTimeout(ctx, 25*time.Second)
	defer cancel()
	socket, response, err := websocket.Dial(wait, origin+"/connect/"+instance, &websocket.DialOptions{
		HTTPClient: client, HTTPHeader: http.Header{"X-Arc-Auth": []string{wire(auth)}},
	})
	if err != nil {
		if response != nil {
			return nil, fmt.Errorf("Relay WebSocket upgrade rejected: HTTP %s", response.Status)
		}
		return nil, errors.New("Relay WebSocket connection failed")
	}
	socket.SetReadLimit(65536)
	return socket, nil
}

type relayRequest struct {
	body   chan []byte
	credit chan struct{}
	cancel context.CancelFunc
}

type relayCompleted struct {
	id      string
	request *relayRequest
}

type relayIncoming struct {
	frame object
	pong  bool
	err   error
}

func relayRead(ctx context.Context, socket *websocket.Conn, out chan<- relayIncoming) {
	for {
		kind, data, err := socket.Read(ctx)
		next := relayIncoming{}
		switch {
		case err != nil:
			next.err = errors.New("Relay receive failed")
		case kind != websocket.MessageText:
			next.err = errors.New("Invalid relay message")
		case string(data) == "pong":
			next.pong = true
		case decodeObject(data, &next.frame) != nil:
			next.err = errors.New("Invalid relay frame")
		}
		select {
		case out <- next:
		case <-ctx.Done():
			return
		}
		if next.err != nil {
			return
		}
	}
}

func relayRun(parent context.Context, socket *websocket.Conn, local string) error {
	ctx, cancel := context.WithCancel(parent)
	var tasks sync.WaitGroup
	defer tasks.Wait()
	defer socket.CloseNow()
	defer cancel()
	transport := &http.Transport{}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, CheckRedirect: relayNoRedirect}
	out := make(chan object, 128)
	incoming := make(chan relayIncoming)
	finished := make(chan relayCompleted, 64)
	requests := map[string]*relayRequest{}
	tasks.Go(func() { relayRead(ctx, socket, incoming) })
	lastPong := time.Now()
	ticks := time.NewTicker(25 * time.Second)
	defer ticks.Stop()
	sendText := func(text string) error {
		wait, cancel := context.WithTimeout(ctx, 15*time.Second)
		defer cancel()
		err := socket.Write(wait, websocket.MessageText, []byte(text))
		if errors.Is(wait.Err(), context.DeadlineExceeded) {
			return errors.New("Relay send timed out")
		}
		if err != nil {
			return errors.New("Relay send failed")
		}
		return nil
	}
	if err := sendText("ping"); err != nil {
		return err
	}
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticks.C:
			recordRuntimeWork(ctx, runtimeWorkCost{Owner: "relay", Reason: "timer", Rows: 1, ScanSet: len(requests) + 1})
			if time.Since(lastPong) > 75*time.Second {
				return errors.New("Relay heartbeat timed out")
			}
			if err := sendText("ping"); err != nil {
				return err
			}
		case item := <-finished:
			if requests[item.id] == item.request {
				delete(requests, item.id)
			}
		case frame := <-out:
			if err := sendText(wire(frame)); err != nil {
				return err
			}
		case msg := <-incoming:
			if msg.err != nil {
				return msg.err
			}
			if msg.pong {
				lastPong = time.Now()
				continue
			}
			frame := msg.frame
			id := text(frame, "id")
			request := requests[id]
			switch text(frame, "type") {
			case "request":
				if len(requests) >= 64 || request != nil {
					return errors.New("Relay request limit exceeded")
				}
				wait, stop := context.WithCancel(ctx)
				request = &relayRequest{body: make(chan []byte, 2), credit: make(chan struct{}, 1), cancel: stop}
				requests[id] = request
				body := request.body
				tasks.Go(func() {
					defer stop()
					err := relayForward(wait, client, local, frame, body, request.credit, out)
					if err != nil && wait.Err() == nil {
						_ = relayQueue(wait, out, object{"type": "error", "id": id})
					}
					select {
					case finished <- relayCompleted{id, request}:
					case <-ctx.Done():
					}
				})
			case "request-chunk":
				data, err := base64.StdEncoding.Strict().DecodeString(text(frame, "data"))
				if err != nil {
					return errors.New("Invalid relay body")
				}
				if len(data) > 32768 {
					return errors.New("Relay chunk too large")
				}
				if request != nil && request.body != nil {
					select {
					case request.body <- data:
					default:
						return errors.New("Relay upload credit exceeded")
					}
				}
			case "request-end":
				if request != nil && request.body != nil {
					close(request.body)
					request.body = nil
				}
			case "response-credit":
				if request != nil {
					select {
					case request.credit <- struct{}{}:
					default:
						return errors.New("Invalid relay credit")
					}
				}
			case "cancel":
				if request != nil {
					request.cancel()
					delete(requests, id)
				}
			default:
				return errors.New("Unknown relay frame")
			}
		}
	}
}

type relayUpload struct {
	ctx       context.Context
	id        string
	in        <-chan []byte
	out       chan<- object
	remaining []byte
}

func (r *relayUpload) Read(dst []byte) (int, error) {
	if len(dst) == 0 {
		return 0, nil
	}
	for len(r.remaining) == 0 {
		select {
		case <-r.ctx.Done():
			return 0, r.ctx.Err()
		case next, ok := <-r.in:
			if !ok {
				return 0, io.EOF
			}
			if err := relayQueue(r.ctx, r.out, object{"type": "request-credit", "id": r.id}); err != nil {
				return 0, err
			}
			r.remaining = next
		}
	}
	read := copy(dst, r.remaining)
	r.remaining = r.remaining[read:]
	return read, nil
}

func relayQueue(ctx context.Context, out chan<- object, value object) error {
	select {
	case out <- value:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func relayForward(ctx context.Context, client *http.Client, local string, frame object, body <-chan []byte, credit <-chan struct{}, out chan<- object) error {
	id, path := text(frame, "id"), text(frame, "path")
	if !strings.HasPrefix(path, "/") || strings.HasPrefix(path, "//") || strings.ContainsRune(path, '#') {
		return errors.New("Invalid relay path")
	}
	method := text(frame, "method")
	if method == "" {
		return errors.New("Invalid method")
	}
	req, err := http.NewRequestWithContext(ctx, method, local+path, &relayUpload{ctx: ctx, id: id, in: body, out: out})
	if err != nil {
		return err
	}
	headers := arr(frame["headers"])
	if headers == nil {
		return errors.New("Invalid headers")
	}
	for _, raw := range headers {
		item := arr(raw)
		if len(item) < 2 {
			return errors.New("Invalid header")
		}
		name, nameOK := item[0].(string)
		value, valueOK := item[1].(string)
		if !nameOK || !valueOK {
			return errors.New("Invalid header")
		}
		if slices.Contains([]string{"host", "connection", "transfer-encoding", "upgrade", "expect"}, strings.ToLower(name)) {
			continue
		}
		if strings.EqualFold(name, "Content-Length") {
			length, err := strconv.ParseInt(value, 10, 64)
			if err != nil || length < 0 {
				return errors.New("Invalid Content-Length")
			}
			req.ContentLength = length
			if length == 0 {
				req.Body = http.NoBody
			}
			continue
		}
		bytes := make([]byte, 0, len(value))
		for _, char := range value {
			if char > 255 {
				return errors.New("Invalid header byte")
			}
			bytes = append(bytes, byte(char))
		}
		req.Header.Add(name, string(bytes))
	}
	res, err := client.Do(req)
	if err != nil {
		return errors.New("Local ingress request failed")
	}
	defer res.Body.Close()
	headerList := [][2]string{}
	for name, values := range res.Header {
		for _, value := range values {
			text := make([]byte, 0, len(value))
			for i := range len(value) {
				text = utf8.AppendRune(text, rune(value[i]))
			}
			headerList = append(headerList, [2]string{strings.ToLower(name), string(text)})
		}
	}
	slices.SortStableFunc(headerList, func(a, b [2]string) int { return strings.Compare(a[0], b[0]) })
	if err := relayQueue(ctx, out, object{"type": "response", "id": id, "status": res.StatusCode, "headers": headerList}); err != nil {
		return err
	}
	var buf [32768]byte
	for {
		count, err := res.Body.Read(buf[:])
		if count != 0 {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-credit:
			}
			if err := relayQueue(ctx, out, object{"type": "response-chunk", "id": id, "data": base64.StdEncoding.EncodeToString(buf[:count])}); err != nil {
				return err
			}
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return errors.New("Local response interrupted")
		}
	}
	return relayQueue(ctx, out, object{"type": "response-end", "id": id})
}

func relayConnect(ctx context.Context, ingress *networkIngress, config object, local string) error {
	identity, err := relayInstance()
	if err != nil {
		return err
	}
	if config["relayInstanceId"] != identity.id() {
		return errors.New("Relay instance identity does not match this machine")
	}
	client, err := relayHTTPClient(ctx, config)
	if err != nil {
		return err
	}
	defer client.CloseIdleConnections()
	origin, err := relayOrigin(text(config, "relayUrl"))
	if err != nil {
		return err
	}
	auth, err := relayEnvelope(ctx, client, origin, identity, object{"op": "connect", "id": identity.id()})
	if err != nil {
		return err
	}
	socket, err := relayUpgrade(ctx, client, origin, identity.id(), auth)
	if err != nil {
		return err
	}
	defer socket.CloseNow()
	wait, cancel := context.WithTimeout(ctx, 10*time.Second)
	kind, body, err := socket.Read(wait)
	deadline := wait.Err()
	cancel()
	if errors.Is(deadline, context.DeadlineExceeded) {
		return errors.New("Relay ready timed out")
	}
	if err != nil {
		return errors.New("Relay ready failed")
	}
	var ready object
	if kind != websocket.MessageText || decodeObject(body, &ready) != nil {
		return errors.New("Invalid relay ready")
	}
	if ready["type"] != "ready" {
		return errors.New("Relay did not acknowledge connection")
	}
	ingress.mu.Lock()
	ingress.running, ingress.failure = true, ""
	ingress.providerStatus = object{"state": "ready", "error": "", "workerVersion": ready["version"]}
	ingress.mu.Unlock()
	return relayRun(ctx, socket, local)
}

func startRelayIngress(ingress *networkIngress, config object) error {
	if runtimeFixture {
		return errors.New(PortPending)
	}
	address, err := listenHTTPSIngress(ingress, object{"httpsProvider": "relay"})
	if err != nil {
		return err
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	ingress.mu.Lock()
	ingress.url = text(config, "relayUrl") + "/u/" + text(config, "relayInstanceId") + "/mcp"
	ingress.providerStatus = object{"state": "connecting", "error": ""}
	ingress.providerStop = func() { cancel(); <-done }
	ingress.mu.Unlock()
	go func() {
		defer close(done)
		delay := time.Second
		for ctx.Err() == nil {
			start := time.Now()
			ingress.mu.RLock()
			current := obj(ingress.entry["config"])
			ingress.mu.RUnlock()
			err := relayConnect(ctx, ingress, current, "http://"+address)
			if ctx.Err() != nil {
				return
			}
			if time.Since(start) > time.Minute {
				delay = time.Second
			}
			message := "Relay disconnected"
			if err != nil {
				message = err.Error()
			}
			ingress.mu.Lock()
			ingress.running = false
			ingress.providerStatus = object{"state": "reconnecting", "error": message, "retrySeconds": int64(delay / time.Second)}
			ingress.mu.Unlock()
			timer := time.NewTimer(delay)
			select {
			case <-ctx.Done():
				timer.Stop()
				return
			case <-timer.C:
			}
			delay = min(delay*2, time.Minute)
		}
	}()
	return nil
}

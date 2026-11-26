package core

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"maps"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
)

var relayFingerprint = regexp.MustCompile("^[0-9a-f]{64}$")

func relayValidateConfig(config object) error {
	if _, err := relayOrigin(text(config, "relayUrl")); err != nil {
		return err
	}
	if !relayFingerprint.MatchString(text(config, "relayInstanceId")) {
		return errors.New("Invalid relay instance id")
	}
	return nil
}

func relayDirectory(id string) (string, error) {
	if _, err := uuid.Parse(id); err != nil {
		return "", errors.New("Invalid relay id")
	}
	return filepath.Join(root(), "relay", id), nil
}

func readRelay(id string) (object, error) {
	dir, err := relayDirectory(id)
	if err != nil {
		return nil, err
	}
	raw, err := load(filepath.Join(dir, "config.json"))
	return obj(raw), err
}

func saveRelay(info object) error {
	dir, err := relayDirectory(text(info, "id"))
	if err != nil {
		return err
	}
	return save(filepath.Join(dir, "config.json"), info)
}

func relayRecords() ([]any, error) {
	dir := filepath.Join(root(), "relay")
	entries, err := os.ReadDir(dir)
	rows := []any{}
	if errors.Is(err, os.ErrNotExist) {
		return rows, nil
	}
	if err != nil {
		return nil, err
	}
	for _, entry := range entries {
		path := filepath.Join(dir, entry.Name(), "config.json")
		if _, err := os.Stat(path); errors.Is(err, os.ErrNotExist) || !entry.IsDir() {
			continue
		}
		row, err := load(path)
		if err != nil {
			return nil, err
		}
		rows = append(rows, row)
	}
	return rows, nil
}

func relayOwner(config object) (relayIdentity, error) {
	if config["owner"] != true {
		return nil, errors.New("Only the relay owner can manage or invite instances")
	}
	dir, err := relayDirectory(text(config, "id"))
	if err != nil {
		return nil, err
	}
	content, err := load(filepath.Join(dir, "secrets.json"))
	if err != nil {
		return nil, err
	}
	key, err := base64.StdEncoding.Strict().DecodeString(text(content, "managementPrivateKey"))
	if err != nil {
		return nil, errors.New("Invalid management key")
	}
	return loadRelayIdentity(key)
}

func relayUndeployed(config object) bool {
	return config["owner"] == true && config["deleted"] != true && config["deploymentStarted"] != true &&
		text(config, "url") == "" && text(config, "ingressId") == ""
}

var relayWorkerLabel = regexp.MustCompile("^[a-z0-9-]{1,63}$")
var relayAccountID = regexp.MustCompile("^[0-9A-Fa-f]{32}$")

func relayLabel(body object) (string, error) {
	name, ok := body["name"].(string)
	if !ok {
		name = "Shared relay"
	}
	name = strings.TrimSpace(name)
	if !validDeviceName(name) {
		return "", errors.New("Invalid relay display name")
	}
	return name, nil
}

func relayDraft(config, body object) (object, error) {
	if config == nil {
		id := id()
		config = object{"id": id, "url": "", "owner": true, "workerName": "arc-relay-" + id[:8], "ingressId": "", "workerVersion": nil}
	}
	name, err := relayLabel(body)
	if err != nil {
		return nil, err
	}
	config["name"] = name
	if worker, ok := body["workerName"]; ok {
		config["workerName"] = worker
	}
	if !relayWorkerLabel.MatchString(text(config, "workerName")) {
		return nil, errors.New("Worker name must contain lowercase letters, digits or hyphens (1-63)")
	}
	return config, nil
}

type relayJob struct {
	mu     sync.Mutex
	status object
	cancel context.CancelFunc
	done   chan struct{}
}

func (job *relayJob) snapshot() object {
	job.mu.Lock()
	defer job.mu.Unlock()
	return clone(job.status)
}
func (job *relayJob) update(fields object) {
	job.mu.Lock()
	defer job.mu.Unlock()
	maps.Copy(job.status, fields)
}
func (job *relayJob) running() bool {
	if job == nil {
		return false
	}
	select {
	case <-job.done:
		return false
	default:
		return true
	}
}

type relayManager struct {
	ctx   context.Context
	owner *gatewayOwner
	mu    sync.Mutex
	job   *relayJob
}

var relayManagers sync.Map

func (m *relayManager) cancel() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	job := m.job
	if !job.running() {
		return ""
	}
	job.cancel()
	<-job.done
	job.update(object{"phase": "failed", "cancelled": true, "reason": "Cancelled. Completed remote effects are retained; use relay.list to reconnect, redeploy or delete.", "loginUrl": nil})
	return text(job.snapshot(), "ingressId")
}

func relayNetworkSettings() object {
	value, err := load(filepath.Join(root(), "app/preferences.json"))
	if err != nil {
		value = ingressDefaults()
	}
	return obj(value)
}

func configuredRelayHTTP(ctx context.Context) (*http.Client, error) {
	return relayHTTPClient(ctx, relayNetworkSettings())
}

func (m *relayManager) connect(ctx context.Context, info object, job *relayJob) (object, error) {
	job.update(object{"phase": "connecting"})
	instance, err := relayInstance()
	if err != nil {
		return nil, err
	}
	if text(info, "ingressId") == "" {
		info["ingressId"] = id()
		if err := saveRelay(info); err != nil {
			return nil, err
		}
	}
	id := text(info, "ingressId")
	job.update(object{"ingressId": id})
	if _, err := m.owner.management(ctx, "_entry/"+id, http.MethodGet, object{}); err != nil {
		_, err = m.owner.management(ctx, "ingress", http.MethodPost, object{
			"id": id, "name": info["name"], "controlSource": "shared-relay", "transport": "relay", "auth": "oauth", "enabled": true,
			"config": object{"relayUrl": info["url"], "relayInstanceId": instance.id(), "autoStart": true},
		})
		if err != nil {
			return nil, err
		}
	}
	if _, err := m.owner.management(ctx, "ingress/"+id+"/start", http.MethodPost, object{}); err != nil {
		return nil, err
	}
	if _, err := m.owner.management(ctx, "_relay_ready/"+id, http.MethodGet, object{}); err != nil {
		return nil, err
	}
	return object{"relayId": info["id"], "ingressId": id, "url": text(info, "url") + "/u/" + instance.id() + "/mcp"}, nil
}

func (m *relayManager) removeIngress(ctx context.Context, info object) error {
	name := text(info, "ingressId")
	if name == "" {
		return nil
	}
	if _, err := m.owner.management(ctx, "_entry/"+name, http.MethodGet, object{}); err != nil {
		return nil
	}
	_, err := m.owner.management(ctx, "ingress/"+name, http.MethodDelete, object{})
	return err
}

func (m *relayManager) join(ctx context.Context, client *http.Client, body object, job *relayJob) (any, error) {
	address, token, err := relayParseLink(text(body, "link"))
	if err != nil {
		return nil, err
	}
	records, err := relayRecords()
	if err != nil {
		return nil, err
	}
	info := find(records, "url", address)
	if info["owner"] == true {
		return nil, errors.New("This machine owns the relay; use relay.connect or relay.redeploy")
	}
	instance, err := relayInstance()
	if err != nil {
		return nil, err
	}
	if info == nil {
		info = object{"id": id(), "url": address, "owner": false, "ingressId": ""}
	}
	name, err := relayLabel(body)
	if err != nil {
		return nil, err
	}
	info["name"] = name
	job.update(object{"relayId": info["id"]})
	if err := saveRelay(info); err != nil {
		return nil, err
	}
	publicKey := base64.StdEncoding.EncodeToString(instance.public())
	if _, err := relayControl(ctx, client, address, instance, object{"op": "register", "publicKey": publicKey, "name": deviceDisplayName(), "token": token}); err != nil {
		return nil, err
	}
	return m.connect(ctx, info, job)
}

func (m *relayManager) execute(ctx context.Context, action string, body object, job *relayJob) (any, error) {
	if runtimeFixture {
		return nil, errors.New(PortPending)
	}
	client, err := configuredRelayHTTP(ctx)
	if err != nil {
		return nil, err
	}
	defer client.CloseIdleConnections()
	if action == "join" {
		return m.join(ctx, client, body, job)
	}
	var info object
	if action == "create" {
		rows, err := relayRecords()
		if err != nil {
			return nil, err
		}
		for _, raw := range rows {
			if config := obj(raw); relayUndeployed(config) {
				info = config
				break
			}
		}
		info, err = relayDraft(info, body)
		if err != nil {
			return nil, err
		}
		dir, _ := relayDirectory(text(info, "id"))
		path := filepath.Join(dir, "secrets.json")
		if _, err := os.Stat(path); errors.Is(err, os.ErrNotExist) {
			key, err := generateRelayIdentity()
			if err != nil {
				return nil, err
			}
			if err := save(path, object{"managementPrivateKey": base64.StdEncoding.EncodeToString(key)}); err != nil {
				return nil, err
			}
		}
		if err := saveRelay(info); err != nil {
			return nil, err
		}
	} else {
		info, err = readRelay(text(body, "id"))
		if err != nil {
			return nil, err
		}
	}
	if account, present := body["accountId"]; present {
		if !relayAccountID.MatchString(str(account)) {
			return nil, errors.New("Invalid accountId")
		}
		info["accountId"] = account
		if err := saveRelay(info); err != nil {
			return nil, err
		}
	}
	job.update(object{"relayId": info["id"]})
	if action == "connect" {
		return m.connect(ctx, info, job)
	}
	key, err := relayOwner(info)
	if err != nil {
		return nil, err
	}
	if info["deleted"] == true && action != "delete" {
		return nil, errors.New("Relay deleted; finish relay.delete cleanup")
	}
	address := text(info, "url")
	if action == "delete" {
		return m.delete(ctx, client, info, key, job)
	}
	address, err = relayDeployWorker(ctx, info, base64.StdEncoding.EncodeToString(key.public()), job, body["openBrowser"] != false)
	if err != nil {
		return nil, err
	}
	info, err = readRelay(text(info, "id"))
	if err != nil {
		return nil, err
	}
	info["url"], info["workerVersion"] = address, buildVersion
	if err := saveRelay(info); err != nil {
		return nil, err
	}
	instance, err := relayInstance()
	if err != nil {
		return nil, err
	}
	job.update(object{"phase": "connecting"})
	if err := relayWaitDeployed(ctx, client, address); err != nil {
		return nil, err
	}
	if _, err := relayControl(ctx, client, address, key, object{"op": "register", "publicKey": base64.StdEncoding.EncodeToString(instance.public()), "name": deviceDisplayName()}); err != nil {
		return nil, err
	}
	dir, _ := relayDirectory(text(info, "id"))
	path := filepath.Join(dir, "secrets.json")
	secrets, err := load(path)
	if err != nil {
		return nil, err
	}
	if text(secrets, "sharedToken") == "" {
		token, err := relayControl(ctx, client, address, key, object{"op": "rotate"})
		if err != nil {
			return nil, err
		}
		obj(secrets)["sharedToken"] = field(token, "token")
		if err := save(path, secrets); err != nil {
			return nil, err
		}
	}
	return m.connect(ctx, info, job)
}

func (m *relayManager) delete(ctx context.Context, client *http.Client, info object, key relayIdentity, job *relayJob) (any, error) {
	job.update(object{"phase": "deploying"})
	missing := false
	if address := text(info, "url"); info["deleted"] != true && address != "" {
		if _, err := relayControl(ctx, client, address, key, object{"op": "delete"}); err != nil {
			var response *relayControlError
			if !errors.As(err, &response) || response.status != http.StatusNotFound || info["deploymentStarted"] != true {
				return nil, err
			}
			var check error
			missing, check = relayWorkerAccountMissing(ctx, info, job)
			if check != nil {
				return nil, check
			}
			if !missing {
				return nil, err
			}
		}
	}
	info["deleted"] = true
	if err := saveRelay(info); err != nil {
		return nil, err
	}
	if err := m.removeIngress(ctx, info); err != nil {
		return nil, err
	}
	if info["deploymentStarted"] == true && !missing {
		if err := relayDeleteWorker(ctx, info, job); err != nil {
			return nil, err
		}
	}
	dir, _ := relayDirectory(text(info, "id"))
	return object{"deleted": true}, os.RemoveAll(dir)
}

func (m *relayManager) manage(ctx context.Context, action, method string, body object) (any, error) {
	if action == "list" {
		rows, err := relayRecords()
		return object{"relays": rows, "version": buildVersion}, err
	}
	if action == "progress" {
		recordRuntimeWork(ctx, runtimeWorkCost{Owner: "relay", Reason: "poll", Rows: 1, ScanSet: 1})
		m.mu.Lock()
		defer m.mu.Unlock()
		if m.job == nil {
			return object{"phase": "idle"}, nil
		}
		return m.job.snapshot(), nil
	}
	if method != http.MethodPost {
		return nil, errors.New("UNKNOWN_ROUTE")
	}
	if action == "cancel" {
		if name := m.cancel(); name != "" {
			if holder, ok := networkGateways.Load(m.owner); ok {
				if i, err := holder.(*ingressGateway).get(name); err == nil {
					i.lifecycle.Lock()
					i.stop()
					i.lifecycle.Unlock()
				}
			}
		}
		return object{"cancelled": true}, nil
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.job.running() {
		return nil, errors.New("A relay operation is already running")
	}
	if slices.Contains([]string{"create", "redeploy", "join", "connect", "delete"}, action) {
		phase := "connecting"
		var stage any
		if action == "create" || action == "redeploy" {
			phase, stage = "login", "preparing"
		}
		wait, cancel := context.WithCancel(m.ctx)
		j := &relayJob{status: object{"jobId": id(), "action": action, "phase": phase, "reason": nil, "loginUrl": nil, "loginStage": stage}, cancel: cancel, done: make(chan struct{})}
		m.job = j
		initial := j.snapshot()
		go func() {
			defer close(j.done)
			defer cancel()
			result, err := m.execute(wait, action, body, j)
			if err != nil {
				j.update(object{"failedPhase": j.snapshot()["phase"], "phase": "failed", "reason": err.Error(), "loginUrl": nil})
			} else {
				j.update(object{"phase": "ready", "result": result, "loginUrl": nil})
			}
		}()
		return initial, nil
	}
	return m.single(ctx, action, body)
}

var fixtureRelayWorker func(string) bool

func (m *relayManager) single(ctx context.Context, action string, body object) (any, error) {
	info, err := readRelay(text(body, "id"))
	if err != nil {
		return nil, err
	}
	dir, _ := relayDirectory(text(info, "id"))
	address := text(info, "url")
	if runtimeFixture && action != "share" && (fixtureRelayWorker == nil || !fixtureRelayWorker(address)) {
		return nil, errors.New(PortPending)
	}
	client, err := configuredRelayHTTP(ctx)
	if err != nil {
		return nil, err
	}
	defer client.CloseIdleConnections()
	switch action {
	case "me", "leave":
		key, err := relayInstance()
		if err != nil {
			return nil, err
		}
		result, err := relayControl(ctx, client, address, key, object{"op": action})
		if action == "me" {
			return result, err
		}
		if err != nil {
			var response *relayControlError
			if !errors.As(err, &response) || response.status != http.StatusNotFound {
				return nil, err
			}
			missing, check := relayWorkerMissing(ctx, client, address)
			if check != nil {
				return nil, check
			}
			if !missing {
				return nil, err
			}
		}
		if err := m.removeIngress(ctx, info); err != nil {
			return nil, err
		}
		if info["owner"] == true {
			info["ingressId"] = ""
			err = saveRelay(info)
		} else {
			err = os.RemoveAll(dir)
		}
		return object{"left": true}, err
	case "instances", "remove", "share", "reset-token":
		key, err := relayOwner(info)
		if err != nil {
			return nil, err
		}
		if action == "instances" || action == "remove" {
			payload := object{"op": "list"}
			if action == "remove" {
				payload = object{"op": "remove", "id": body["instanceId"]}
			}
			result, err := relayControl(ctx, client, address, key, payload)
			if err != nil {
				return nil, err
			}
			instance, err := relayInstance()
			if err != nil {
				return nil, err
			}
			if action == "remove" && body["instanceId"] == instance.id() {
				err = m.removeIngress(ctx, info)
			} else {
				for _, member := range arr(result) {
					obj(member)["isSelf"] = field(member, "id") == instance.id()
				}
			}
			return result, err
		}
		path := filepath.Join(dir, "secrets.json")
		secrets, err := load(path)
		if err != nil {
			return nil, err
		}
		if action == "reset-token" {
			value, err := relayControl(ctx, client, address, key, object{"op": "rotate"})
			if err != nil {
				return nil, err
			}
			obj(secrets)["sharedToken"] = field(value, "token")
			if err := save(path, secrets); err != nil {
				return nil, err
			}
		}
		token := text(secrets, "sharedToken")
		if token == "" {
			return nil, errors.New("No shared token; reset the token first")
		}
		return object{"link": relayShareLink(address, token)}, nil
	default:
		return nil, errors.New("UNKNOWN_ROUTE")
	}
}

func relayWorkerMissing(ctx context.Context, client *http.Client, address string) (bool, error) {
	for _, probe := range [][2]string{{http.MethodGet, "/"}, {http.MethodPost, "/challenge"}} {
		_, _, status, err := relayHTTP(ctx, client, probe[0], address+probe[1], nil, 20*time.Second)
		if status == 0 {
			var e *url.Error
			if errors.As(err, &e) {
				err = e.Err
			}
			return false, fmt.Errorf("Cannot confirm missing relay Worker: %v", err)
		}
		if status != http.StatusNotFound {
			return false, nil
		}
	}
	return true, nil
}

func init() {
	gatewayStartup = append(gatewayStartup, func(ctx context.Context, g *gatewayOwner) error {
		manager := &relayManager{ctx: ctx, owner: g}
		relayManagers.Store(g, manager)
		g.cleanup = append(g.cleanup, func() { manager.cancel(); relayManagers.Delete(g) })
		return nil
	})
	for method, pattern := range map[string]string{
		http.MethodGet:  `relay/(list|progress)`,
		http.MethodPost: `relay/(create|redeploy|join|connect|delete|cancel|me|leave|instances|remove|share|reset-token)`,
	} {
		registerGatewayRoute(method, pattern, func(ctx context.Context, g *gatewayOwner, body object, params []string) (any, error) {
			if entry, ok := relayManagers.Load(g); ok {
				return entry.(*relayManager).manage(ctx, params[0], method, body)
			}
			return nil, errors.New("core shutting down")
		})
		registerRoutePattern(method, pattern, func(ctx context.Context, _ *service, body object, params []string) (any, error) {
			return gatewayRequest(ctx, "relay/"+params[0], method, body)
		})
	}
}

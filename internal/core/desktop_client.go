// The Desktop shares the CLI's authenticated front-door transport and leases.
package core

import (
	"context"
	"errors"
	"github.com/google/uuid"
	"github.com/whzxc/agent-remote-control/internal/canonjson"
	"io"
	"net/http"
	"os/exec"
)

// DesktopClient owns a Desktop lease and an authenticated callback listener.
type DesktopClient struct {
	*runtimeClient
	transport *desktopTransport
}

func ConnectDesktop(owner func(context.Context, string, string, map[string]any) (any, error)) (*DesktopClient, error) {
	binary, err := runtimeBinary()
	if err != nil {
		return nil, err
	}
	if _, err := processBuildID(); err != nil {
		return nil, err
	}
	transport, err := listenDesktop(owner)
	if err != nil {
		return nil, err
	}
	client, err := newDesktopRuntimeClient(binary, transport.endpoint)
	if err != nil {
		transport.close()
		return nil, err
	}
	return &DesktopClient{client, transport}, nil
}

func (c *DesktopClient) Request(ctx context.Context, route, method string, body map[string]any) (any, error) {
	return c.request(ctx, route, method, body)
}

func (c *DesktopClient) Control(ctx context.Context, action string) error {
	return c.controlCore(ctx, action)
}

func (c *DesktopClient) Health(ctx context.Context) (map[string]any, error) {
	return c.hubHealth(ctx)
}

func (c *DesktopClient) Close(ctx context.Context) {
	c.close(ctx)
	c.transport.close()
}

func (c *DesktopClient) Shutdown(ctx context.Context) error { return c.shutdown(ctx) }
func (c *DesktopClient) Resume()                            { c.resume() }

func (c *DesktopClient) UpdateHTTPClient(ctx context.Context) (*http.Client, error) {
	settings, err := c.networkPreferences(ctx)
	if err != nil {
		return nil, err
	}
	proxy, err := resolveNetworkProxy(ctx, obj(settings))
	if err != nil {
		return nil, err
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = proxy.proxyFor
	return &http.Client{Transport: transport}, nil
}

func PrepareDesktopUpdate(ctx context.Context) (io.Closer, error) {
	return prepareFrontDoorInstall(ctx)
}

func DesktopRelaunch() (*exec.Cmd, io.Closer, error) { return desktopRelaunchCommand() }
func DesktopRoute(route string) bool                 { return desktopRoute(route) }
func DesktopStateDir() string                        { return root() }
func DesktopBuildID() (string, error)                { return processBuildID() }
func DesktopVersion() string                         { return buildVersion }
func DesktopSourceName(product string) string        { return text(sourcePreset(product), "displayName") }
func ValidateDesktopSnapshot(body map[string]any) error {
	_, _, _, err := managementResolve("app.snapshot", object{"body": body})
	return err
}

func RunBundledCLI(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	binary, err := runtimeBinary()
	if err != nil {
		return exitResult(stderr, err)
	}
	cmd := exec.Command(binary, args...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = stdin, stdout, stderr
	if err := cmd.Run(); err != nil {
		if failed, ok := err.(*exec.ExitError); ok {
			return failed.ExitCode()
		}
		return exitResult(stderr, err)
	}
	return 0
}

func RequestDesktopScreenPermission(ctx context.Context, id string) error {
	_, err := callNativeScreen(ctx, object{"action": "request", "permissionId": id})
	return err
}

// Source containers share Core's URL and account-identity contracts.
func DesktopSourceSupported() bool           { return srcPlatformSupported() }
func DesktopSourceOpenURL(raw string) string { return srcOpenURL(raw) }
func DesktopSourceAllowed(raw string) bool   { return srcWebsiteURL(raw) != nil }
func DesktopSourceExpired(raw string) bool   { return srcSessionExpired(raw) }
func DesktopSourceReference(raw string) any  { return field(srcURLReference(raw), "url") }

func DesktopSourceImportGuard(account string, org *uuid.UUID, known any, allow bool) (map[string]any, error) {
	raw, err := canonjson.Marshal(known)
	if err != nil {
		return nil, err
	}
	var accounts []srcOrgAccount
	if known == nil || canonjson.Unmarshal(raw, &accounts) != nil {
		return nil, errors.New("SRC_IMPORT_IDENTITY_INVALID")
	}
	if state := srcImportGuard(account, org, accounts, allow); state != nil {
		return state.response(account), nil
	}
	return nil, nil
}

func DesktopSourceImportState(account string, importing, installed bool, err error) map[string]any {
	if importing {
		return srcImporting().response(account)
	}
	return srcImportFinished(installed, err).response(account)
}

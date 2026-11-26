package core

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509/pkix"
	"encoding/asn1"
	"encoding/base64"
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/whzxc/agent-remote-control/internal/canonjson"
)

type relayIdentity ed25519.PrivateKey

// Ring persists OneAsymmetricKey with the implicit public-key bit string.
type relayKeyDER struct {
	Version   int
	Algorithm pkix.AlgorithmIdentifier
	Private   []byte
	Public    asn1.BitString `asn1:"tag:1"`
}

var relayEd25519OID = asn1.ObjectIdentifier{1, 3, 101, 112}
var relayIdentityLock sync.Mutex

func generateRelayIdentity() ([]byte, error) {
	public, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, errors.New("Cannot generate relay identity")
	}
	seed, err := asn1.Marshal(key.Seed())
	if err != nil {
		return nil, err
	}
	return asn1.Marshal(relayKeyDER{
		Version: 1, Algorithm: pkix.AlgorithmIdentifier{Algorithm: relayEd25519OID},
		Private: seed, Public: asn1.BitString{Bytes: public, BitLength: ed25519.PublicKeySize * 8},
	})
}

func loadRelayIdentity(data []byte) (relayIdentity, error) {
	invalid := errors.New("Invalid relay private key")
	var stored relayKeyDER
	rest, err := asn1.Unmarshal(data, &stored)
	if err != nil || len(rest) != 0 || stored.Version != 1 ||
		!stored.Algorithm.Algorithm.Equal(relayEd25519OID) || len(stored.Algorithm.Parameters.FullBytes) != 0 ||
		stored.Public.BitLength != ed25519.PublicKeySize*8 {
		return nil, invalid
	}
	var seed []byte
	rest, err = asn1.Unmarshal(stored.Private, &seed)
	if err != nil || len(rest) != 0 || len(seed) != ed25519.SeedSize {
		return nil, invalid
	}
	key := ed25519.NewKeyFromSeed(seed)
	if !bytes.Equal(key.Public().(ed25519.PublicKey), stored.Public.Bytes) {
		return nil, invalid
	}
	return relayIdentity(key), nil
}

func relayInstance() (relayIdentity, error) {
	relayIdentityLock.Lock()
	defer relayIdentityLock.Unlock()
	path := filepath.Join(root(), "relay/instance.pkcs8")
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		data, err = generateRelayIdentity()
		if err == nil {
			err = saveBytes(path, data)
		}
	}
	if err != nil {
		return nil, err
	}
	return loadRelayIdentity(data)
}

func (identity relayIdentity) public() ed25519.PublicKey {
	return ed25519.PrivateKey(identity).Public().(ed25519.PublicKey)
}

func (identity relayIdentity) id() string { return hash(identity.public()) }

func (identity relayIdentity) envelope(origin, challenge string, value any) object {
	payload := wire(value)
	message := "arc-relay-v1\n" + origin + "\n" + challenge + "\n" + hash([]byte(payload))
	return object{
		"publicKey": base64.StdEncoding.EncodeToString(identity.public()),
		"challenge": challenge, "payload": payload,
		"signature": base64.StdEncoding.EncodeToString(ed25519.Sign(ed25519.PrivateKey(identity), []byte(message))),
	}
}

func relayOrigin(value string) (string, error) {
	u, err := url.Parse(value)
	if err != nil || !u.IsAbs() || u.Scheme == "https" && u.Hostname() == "" {
		return "", errors.New("Invalid relay URL")
	}
	if !ingressURLAllowed(u, "https", "/") || strings.Contains(value, "#") {
		return "", errors.New("Relay URL must be an HTTPS origin without credentials, path or query")
	}
	return ingressURLOrigin(u), nil
}

func relayShareLink(origin, token string) string {
	return origin + "/#arc-relay=" + base64.RawURLEncoding.EncodeToString([]byte(wire(object{"url": origin, "token": token})))
}

func relayParseLink(link string) (string, string, error) {
	if len(link) > 8192 {
		return "", "", errors.New("Shared relay link is too long")
	}
	invalid := errors.New("Invalid shared relay link")
	outer, err := url.Parse(link)
	if err != nil || !outer.IsAbs() {
		return "", "", invalid
	}
	encoded, ok := strings.CutPrefix(outer.Fragment, "arc-relay=")
	if !ok {
		return "", "", invalid
	}
	data, err := base64.RawURLEncoding.Strict().DecodeString(encoded)
	if err != nil {
		return "", "", invalid
	}
	var value any
	if err := canonjson.Unmarshal(data, &value); err != nil {
		return "", "", invalid
	}
	origin, err := relayOrigin(text(value, "url"))
	if err != nil {
		return "", "", err
	}
	outer.Fragment, outer.RawFragment = "", ""
	outerOrigin, err := relayOrigin(outer.String())
	if err != nil {
		return "", "", err
	}
	if outerOrigin != origin {
		return "", "", errors.New("Shared relay link origin mismatch")
	}
	token := text(value, "token")
	key, err := base64.StdEncoding.Strict().DecodeString(token)
	if err != nil || len(key) != 32 {
		return "", "", errors.New("Invalid shared token")
	}
	return origin, token, nil
}

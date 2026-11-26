package core

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"errors"
	"math/big"
	"os"
	"path/filepath"
	"time"

	"github.com/whzxc/agent-remote-control/internal/platform"
)

type deviceIdentity struct {
	id, publicKey string
	certificate   tls.Certificate
}

func loadDeviceIdentity(directory string) (*deviceIdentity, error) {
	if err := platform.PrivateDir(directory); err != nil {
		return nil, err
	}
	path := filepath.Join(directory, "identity.json")
	value, err := load(path)
	if errors.Is(err, os.ErrNotExist) {
		value, err = generateDeviceIdentity()
		if err == nil {
			err = save(path, value)
		}
	}
	if err != nil {
		return nil, err
	}
	keyBytes, err := base64.StdEncoding.DecodeString(text(value, "key"))
	if err != nil {
		return nil, err
	}
	certBytes, err := base64.StdEncoding.DecodeString(text(value, "certificate"))
	if err != nil {
		return nil, err
	}
	key, err := x509.ParsePKCS8PrivateKey(keyBytes)
	if err != nil {
		return nil, err
	}
	p256, ok := key.(*ecdsa.PrivateKey)
	if !ok || p256.Curve != elliptic.P256() {
		return nil, errors.New("Device identity requires a P-256 private key")
	}
	cert, fingerprint, publicKey, err := deviceCertificateIdentity(certBytes)
	if err != nil {
		return nil, err
	}
	public, ok := cert.PublicKey.(*ecdsa.PublicKey)
	if !ok || !public.Equal(&p256.PublicKey) {
		return nil, errors.New("Device certificate does not match its private key")
	}
	return &deviceIdentity{fingerprint, publicKey, tls.Certificate{
		Certificate: [][]byte{certBytes},
		PrivateKey:  p256,
		Leaf:        cert,
	}}, nil
}

func generateDeviceIdentity() (object, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 127))
	if err != nil {
		return nil, err
	}
	template := &x509.Certificate{
		SerialNumber: serial.Add(serial, big.NewInt(1)),
		Subject:      pkix.Name{CommonName: "rcgen self signed cert"},
		DNSNames:     []string{"arc-peer.local"},
		NotBefore:    time.Date(1975, 1, 1, 0, 0, 0, 0, time.UTC),
		NotAfter:     time.Date(4096, 1, 1, 0, 0, 0, 0, time.UTC),
	}
	cert, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		return nil, err
	}
	keyBytes, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return nil, err
	}
	return object{"key": base64.StdEncoding.EncodeToString(keyBytes), "certificate": base64.StdEncoding.EncodeToString(cert)}, nil
}

func deviceCertificateIdentity(der []byte) (*x509.Certificate, string, string, error) {
	cert, err := x509.ParseCertificate(der)
	if err != nil || !bytes.Equal(cert.RawIssuer, cert.RawSubject) ||
		cert.CheckSignature(cert.SignatureAlgorithm, cert.RawTBSCertificate, cert.Signature) != nil {
		return nil, "", "", errors.New("Invalid device certificate encoding or self-signature")
	}
	key := cert.RawSubjectPublicKeyInfo
	return cert, hash(key), base64.StdEncoding.EncodeToString(key), nil
}

func (identity *deviceIdentity) sign(message []byte) (string, error) {
	digest := sha256.Sum256(message)
	sig, err := ecdsa.SignASN1(rand.Reader, identity.certificate.PrivateKey.(*ecdsa.PrivateKey), digest[:])
	if err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(sig), nil
}

package core

import (
	"crypto/tls"
	"crypto/x509"
	"errors"
)

const deviceALPN = "arc-peer/3"

func deviceTLSConfig(identity *deviceIdentity, authorize func(string) bool) *tls.Config {
	return &tls.Config{
		MinVersion:             tls.VersionTLS13,
		MaxVersion:             tls.VersionTLS13,
		Certificates:           []tls.Certificate{identity.certificate},
		NextProtos:             []string{deviceALPN},
		SessionTicketsDisabled: true,
		VerifyPeerCertificate: func(rawCerts [][]byte, _ [][]*x509.Certificate) error {
			if len(rawCerts) != 1 {
				return errors.New("Device certificates must be self-signed")
			}
			_, fingerprint, _, err := deviceCertificateIdentity(rawCerts[0])
			if err != nil {
				return err
			}
			if !authorize(fingerprint) {
				return errors.New("Device fingerprint is not authorized")
			}
			return nil
		},
	}
}

func deviceServerTLS(identity *deviceIdentity, authorize func(string) bool) *tls.Config {
	config := deviceTLSConfig(identity, authorize)
	// TLS still verifies CertificateVerify against the presented certificate.
	config.ClientAuth = tls.RequireAnyClientCert
	return config
}

func deviceClientTLS(identity *deviceIdentity, fingerprint string) *tls.Config {
	config := deviceTLSConfig(identity, func(candidate string) bool { return candidate == fingerprint })
	// VerifyPeerCertificate authenticates the pinned key. TLS verifies proof of possession.
	config.InsecureSkipVerify = true
	config.ServerName = "arc-peer.local"
	return config
}

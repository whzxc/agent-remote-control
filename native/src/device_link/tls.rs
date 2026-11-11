//! Pin public keys, and let rustls verify possession in CertificateVerify.
use super::{identity::*, Manager};
use crate::*;
use rustls::{
    client::danger::{ServerCertVerified, ServerCertVerifier},
    pki_types::{CertificateDer, ServerName, UnixTime},
    server::danger::{ClientCertVerified, ClientCertVerifier},
    DigitallySignedStruct, SignatureScheme,
};

pub(super) const ALPN: &[u8] = b"arc-peer/2";
#[derive(Debug)]
struct Pin {
    server: Option<String>,
    member: Option<std::sync::Weak<Manager>>,
}
impl Pin {
    fn check(
        &self,
        cert: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
    ) -> std::result::Result<(), rustls::Error> {
        if !intermediates.is_empty() {
            return Err(rustls::Error::General(
                "Device certificates must be self-signed".into(),
            ));
        }
        let (id, _) = certificate_identity(cert)?;
        let allowed = if let Some(pin) = &self.server {
            *pin == id
        } else {
            self.member
                .as_ref()
                .and_then(|m| m.upgrade())
                .is_some_and(|m| m.accept_certificate(&id))
        };
        if allowed {
            Ok(())
        } else {
            Err(rustls::Error::General(
                "Device fingerprint is not authorized".into(),
            ))
        }
    }
    fn schemes(&self) -> Vec<SignatureScheme> {
        rustls::crypto::ring::default_provider()
            .signature_verification_algorithms
            .supported_schemes()
    }
    fn signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
        tls13: bool,
    ) -> std::result::Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        let provider = rustls::crypto::ring::default_provider();
        if tls13 {
            rustls::crypto::verify_tls13_signature(
                message,
                cert,
                dss,
                &provider.signature_verification_algorithms,
            )
        } else {
            rustls::crypto::verify_tls12_signature(
                message,
                cert,
                dss,
                &provider.signature_verification_algorithms,
            )
        }
    }
}
impl ServerCertVerifier for Pin {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        _: &ServerName<'_>,
        _: &[u8],
        _: UnixTime,
    ) -> std::result::Result<ServerCertVerified, rustls::Error> {
        self.check(end_entity, intermediates)?;
        Ok(ServerCertVerified::assertion())
    }
    fn verify_tls12_signature(
        &self,
        m: &[u8],
        c: &CertificateDer<'_>,
        s: &DigitallySignedStruct,
    ) -> std::result::Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        self.signature(m, c, s, false)
    }
    fn verify_tls13_signature(
        &self,
        m: &[u8],
        c: &CertificateDer<'_>,
        s: &DigitallySignedStruct,
    ) -> std::result::Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        self.signature(m, c, s, true)
    }
    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.schemes()
    }
}
impl ClientCertVerifier for Pin {
    fn root_hint_subjects(&self) -> &[rustls::DistinguishedName] {
        &[]
    }
    fn verify_client_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        _: UnixTime,
    ) -> std::result::Result<ClientCertVerified, rustls::Error> {
        self.check(end_entity, intermediates)?;
        Ok(ClientCertVerified::assertion())
    }
    fn verify_tls12_signature(
        &self,
        m: &[u8],
        c: &CertificateDer<'_>,
        s: &DigitallySignedStruct,
    ) -> std::result::Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        self.signature(m, c, s, false)
    }
    fn verify_tls13_signature(
        &self,
        m: &[u8],
        c: &CertificateDer<'_>,
        s: &DigitallySignedStruct,
    ) -> std::result::Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        self.signature(m, c, s, true)
    }
    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.schemes()
    }
}
pub(super) fn server(
    manager: &Arc<Manager>,
    identity: &Identity,
) -> Result<tokio_rustls::TlsAcceptor> {
    let mut config = rustls::ServerConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_protocol_versions(&[&rustls::version::TLS13])
    .map_err(|e| e.to_string())?
    .with_client_cert_verifier(Arc::new(Pin {
        server: None,
        member: Some(Arc::downgrade(manager)),
    }))
    .with_single_cert(vec![identity.certificate.clone()], identity.private_key())
    .map_err(|e| e.to_string())?;
    config.alpn_protocols = vec![ALPN.to_vec()];
    // Every connection must run certificate verification; no resumed authorization.
    config.send_tls13_tickets = 0;
    config.session_storage = Arc::new(rustls::server::NoServerSessionStorage {});
    Ok(tokio_rustls::TlsAcceptor::from(Arc::new(config)))
}
pub(super) fn client(identity: &Identity, pin: String) -> Result<tokio_rustls::TlsConnector> {
    let mut config = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_protocol_versions(&[&rustls::version::TLS13])
    .map_err(|e| e.to_string())?
    .dangerous()
    .with_custom_certificate_verifier(Arc::new(Pin {
        server: Some(pin),
        member: None,
    }))
    .with_client_auth_cert(vec![identity.certificate.clone()], identity.private_key())
    .map_err(|e| e.to_string())?;
    config.alpn_protocols = vec![ALPN.to_vec()];
    config.resumption = rustls::client::Resumption::disabled();
    Ok(tokio_rustls::TlsConnector::from(Arc::new(config)))
}

pub(super) fn protocol_mismatch(error: &std::io::Error) -> bool {
    matches!(
        error
            .get_ref()
            .and_then(|error| error.downcast_ref::<rustls::Error>()),
        Some(
            rustls::Error::NoApplicationProtocol
                | rustls::Error::AlertReceived(rustls::AlertDescription::NoApplicationProtocol)
        )
    )
}

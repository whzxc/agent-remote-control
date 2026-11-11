//! A device key is independent of its display label and transport addresses.
use crate::*;
use base64::{engine::general_purpose::STANDARD, Engine};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};

pub(super) struct Identity {
    pub id: String,
    pub public_key: String,
    pub certificate: CertificateDer<'static>,
    key: Vec<u8>,
}
impl Identity {
    pub fn load_or_create(directory: &Path) -> Result<Self> {
        private_dir(directory)?;
        let path = directory.join("identity.json");
        let stored = if path.exists() {
            load(&path)?
        } else {
            let key = rcgen::KeyPair::generate().map_err(|e| e.to_string())?;
            let params = rcgen::CertificateParams::new(vec!["arc-peer.local".into()])
                .map_err(|e| e.to_string())?;
            let certificate = params.self_signed(&key).map_err(|e| e.to_string())?;
            let stored = json!({"key":STANDARD.encode(key.serialize_der()),"certificate":STANDARD.encode(certificate.der())});
            save(&path, &stored)?;
            stored
        };
        let key = STANDARD
            .decode(string(&stored, "key"))
            .map_err(|e| e.to_string())?;
        let certificate = CertificateDer::from(
            STANDARD
                .decode(string(&stored, "certificate"))
                .map_err(|e| e.to_string())?,
        );
        let (id, public_key) = certificate_identity(&certificate).map_err(|e| e.to_string())?;
        // Loading through rustls also checks that the saved certificate matches the key.
        let identity = Self {
            id,
            public_key,
            certificate,
            key,
        };
        rustls::sign::CertifiedKey::from_der(
            vec![identity.certificate.clone()],
            identity.private_key(),
            &rustls::crypto::ring::default_provider(),
        )
        .map_err(|e| e.to_string())?;
        Ok(identity)
    }
    pub fn private_key(&self) -> PrivateKeyDer<'static> {
        PrivatePkcs8KeyDer::from(self.key.clone()).into()
    }
}

pub(super) fn certificate_identity(
    certificate: &CertificateDer<'_>,
) -> std::result::Result<(String, String), rustls::Error> {
    let invalid = || rustls::Error::InvalidCertificate(rustls::CertificateError::BadEncoding);
    let (remaining, cert) =
        x509_parser::parse_x509_certificate(certificate.as_ref()).map_err(|_| invalid())?;
    if !remaining.is_empty()
        || cert.subject() != cert.issuer()
        || cert.verify_signature(None).is_err()
    {
        return Err(invalid());
    }
    let public_key = cert.public_key().raw;
    Ok((hash(public_key), STANDARD.encode(public_key)))
}

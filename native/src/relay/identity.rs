use crate::*;
use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine,
};
use ring::signature::{Ed25519KeyPair, KeyPair};

pub(super) struct Identity(Ed25519KeyPair);
impl Identity {
    pub fn generate() -> Result<Vec<u8>> {
        Ed25519KeyPair::generate_pkcs8(&ring::rand::SystemRandom::new())
            .map(|v| v.as_ref().to_vec())
            .map_err(|_| "Cannot generate relay identity".into())
    }
    pub fn from_bytes(bytes: &[u8]) -> Result<Self> {
        Ed25519KeyPair::from_pkcs8(bytes)
            .map(Self)
            .map_err(|_| "Invalid relay private key".into())
    }
    pub fn instance() -> Result<Self> {
        static CREATE: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let _guard = CREATE.lock().map_err(|_| "Relay identity lock failed")?;
        let path = root().join("relay/instance.pkcs8");
        // Serialized by the relay manager for creation; transport only reads it.
        if !path.exists() {
            save_bytes(&path, &Self::generate()?)?;
        }
        Self::from_bytes(&std::fs::read(path).map_err(|e| e.to_string())?)
    }
    pub fn public_key(&self) -> String {
        STANDARD.encode(self.0.public_key().as_ref())
    }
    pub fn id(&self) -> String {
        hash(self.0.public_key().as_ref())
    }
    pub fn envelope(&self, origin: &str, challenge: &str, payload: &Value) -> Value {
        let payload = payload.to_string();
        let message = format!("arc-relay-v1\n{origin}\n{challenge}\n{}", hash(&payload));
        json!({"publicKey":self.public_key(),"challenge":challenge,"payload":payload,"signature":STANDARD.encode(self.0.sign(message.as_bytes()).as_ref())})
    }
}
pub(super) fn origin(value: &str) -> Result<String> {
    let url = reqwest::Url::parse(value).map_err(|_| "Invalid relay URL")?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Relay URL must be an HTTPS origin without credentials, path or query".into());
    }
    Ok(url.origin().ascii_serialization())
}
pub(super) fn share_link(url: &str, token: &str) -> String {
    format!(
        "{url}/#arc-relay={}",
        URL_SAFE_NO_PAD.encode(json!({"url":url,"token":token}).to_string())
    )
}
pub(super) fn parse_link(link: &str) -> Result<(String, String)> {
    if link.len() > 8192 {
        return Err("Shared relay link is too long".into());
    }
    let parsed = reqwest::Url::parse(link).map_err(|_| "Invalid shared relay link")?;
    let encoded = parsed
        .fragment()
        .and_then(|f| f.strip_prefix("arc-relay="))
        .ok_or("Invalid shared relay link")?;
    let value: Value = serde_json::from_slice(
        &URL_SAFE_NO_PAD
            .decode(encoded)
            .map_err(|_| "Invalid shared relay link")?,
    )
    .map_err(|_| "Invalid shared relay link")?;
    let url = origin(string(&value, "url"))?;
    let mut outer = parsed.clone();
    outer.set_fragment(None);
    if origin(outer.as_str())? != url {
        return Err("Shared relay link origin mismatch".into());
    }
    let token = string(&value, "token");
    if STANDARD
        .decode(token)
        .map_err(|_| "Invalid shared token")?
        .len()
        != 32
    {
        return Err("Invalid shared token".into());
    }
    Ok((url, token.into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn signature_binds_origin_challenge_and_exact_payload() {
        // Algorithmic core: signature binds origin challenge and exact payload.
        let key = Identity::from_bytes(&Identity::generate().unwrap()).unwrap();
        let e = key.envelope("https://relay.example", "nonce", &json!({"op":"list"}));
        let sig = STANDARD.decode(string(&e, "signature")).unwrap();
        let public = STANDARD.decode(key.public_key()).unwrap();
        let verifier = ring::signature::UnparsedPublicKey::new(&ring::signature::ED25519, &public);
        let message = format!(
            "arc-relay-v1\nhttps://relay.example\nnonce\n{}",
            hash(string(&e, "payload"))
        );
        verifier.verify(message.as_bytes(), &sig).unwrap();
        assert!(verifier
            .verify(message.replace("nonce", "other").as_bytes(), &sig)
            .is_err());
        assert_eq!(key.id(), hash(public));
    }
    #[test]
    fn links_bind_origin_and_keep_token_in_fragment() {
        // Algorithmic core: links bind origin and keep token in fragment.
        let token = STANDARD.encode([7u8; 32]);
        let link = share_link("https://relay.example", &token);
        assert_eq!(
            parse_link(&link).unwrap(),
            ("https://relay.example".into(), token)
        );
        assert!(parse_link(&link.replacen("relay.example", "other.example", 1)).is_err());
        for url in [
            "http://relay.example",
            "https://user@relay.example",
            "https://relay.example/path",
            "https://relay.example/?secret=x",
        ] {
            assert!(origin(url).is_err());
        }
    }
}

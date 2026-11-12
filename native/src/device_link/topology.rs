//! Pairing graph checks use pinned peer metadata, never business forwarding.
use super::transport::connect_addresses;
use super::*;

fn cycle() -> String {
    error("DEVICE_PAIRING_CYCLE", "Pairing would create a controller/member cycle. Revoke the ancestor relationship locally before pairing; query guide with topic:device.")
}
impl Manager {
    pub(super) async fn reject_cycle(&self, controller: &str) -> Result<()> {
        if self.contains_descendant(controller, vec![]).await? {
            return Err(cycle());
        }
        Ok(())
    }
    pub(super) fn contains_descendant<'a>(
        &'a self,
        target: &'a str,
        mut visited: Vec<String>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<bool>> + Send + 'a>> {
        Box::pin(async move {
            let identity = self.identity()?;
            if identity.id == target {
                return Ok(true);
            }
            if visited.contains(&identity.id) {
                return Err(cycle());
            }
            if visited.len() >= 64 {
                return Err(error("DEVICE_TOPOLOGY_UNAVAILABLE", "Pairing graph exceeds 64 devices in depth; shorten the controller chain and retry."));
            }
            visited.push(identity.id.clone());
            let members = self
                .state
                .lock()
                .unwrap()
                .stored
                .members
                .values()
                .cloned()
                .collect::<Vec<_>>();
            if members.iter().any(|member| member.device_id == target) {
                return Ok(true);
            }
            for member in members {
                let session = client::Session::default();
                let result = tokio::time::timeout(Duration::from_secs(10), async {
                    let addresses = connect_addresses(
                        member
                            .address_override
                            .as_ref()
                            .map(std::slice::from_ref)
                            .unwrap_or(&member.addresses),
                    )?;
                    let channel = session
                        .connect(&identity, &member.device_id, &addresses)
                        .await?;
                    channel
                        .request(
                            "/arc-peer/3/topology",
                            json!({"version":VERSION,"deviceId":target,"visited":visited}),
                            Duration::from_secs(9),
                        )
                        .await
                })
                .await;
                session.close().await;
                let reply = result.map_err(|_| error("DEVICE_TOPOLOGY_UNAVAILABLE", "Pairing graph check timed out. Restore member LAN reachability and retry; query guide with topic:device."))?
                    .map_err(|e| error("DEVICE_TOPOLOGY_UNAVAILABLE", &format!("Cannot verify member {}: {e}. Restore LAN reachability and retry pairing; query guide with topic:device.", member.name)))?;
                match reply["contains"].as_bool() {
                    Some(true) => return Ok(true),
                    Some(false) => (),
                    None => return Err(error("DEVICE_TOPOLOGY_UNAVAILABLE", "Install device-tier support on the member chain before pairing; query guide with topic:device.")),
                }
            }
            Ok(false)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn listener(manager: &Arc<Manager>) -> (SocketAddr, tokio::task::JoinHandle<()>) {
        let socket = tokio::net::TcpListener::bind(lan_sockets(0).unwrap()[0])
            .await
            .unwrap();
        let address = socket.local_addr().unwrap();
        manager.state.lock().unwrap().stored.port = address.port();
        let acceptor = tls::server(manager, &manager.identity().unwrap()).unwrap();
        let manager = manager.clone();
        let task = tokio::spawn(async move {
            let mut connections = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                    accepted = socket.accept() => {
                        let Ok((stream, _)) = accepted else { break; };
                        let permit = Arc::new(tokio::sync::Semaphore::new(1)).acquire_owned().await.unwrap();
                        connections.spawn(manager.clone().accept_connection(stream, acceptor.clone(), permit));
                    },
                    Some(_) = connections.join_next(), if !connections.is_empty() => {},
                }
            }
        });
        (address, task)
    }
    fn edge(controller: &Arc<Manager>, member: &Arc<Manager>, address: SocketAddr) {
        let identity = member.identity().unwrap();
        controller.state.lock().unwrap().stored.members.insert(
            identity.id.clone(),
            Peer {
                device_id: identity.id.clone(),
                public_key: identity.public_key.clone(),
                name: "Example member".into(),
                addresses: vec![address.to_string()],
                tunnel_url: None,
                address_override: None,
            },
        );
        super::super::tunnel_tests::paired(member, &controller.identity().unwrap());
    }
    #[tokio::test]
    async fn descendant_pairing_rejects_three_device_cycle_before_approval() {
        // Regression: a descendant could pair its root controller because pairing checked only the immediate parent.
        if super::super::tunnel_fixture::isolate("device_link::topology::tests::descendant_pairing_rejects_three_device_cycle_before_approval").await { return; }
        crate::init_crypto();
        let directory = crate::root();
        let root = super::super::tests::Fixture::manager(directory.join("root"));
        let middle = super::super::tests::Fixture::manager(directory.join("middle"));
        let leaf = super::super::tests::Fixture::manager(directory.join("leaf"));
        let (root_address, root_task) = listener(&root).await;
        let (middle_address, middle_task) = listener(&middle).await;
        let (leaf_address, leaf_task) = listener(&leaf).await;
        edge(&root, &middle, middle_address);
        edge(&middle, &leaf, leaf_address);
        // A non-cyclic descendant graph still admits a new controller proof.
        let session = client::Session::default();
        let channel = session
            .connect(
                &root.identity().unwrap(),
                &middle.identity().unwrap().id,
                &[middle_address],
            )
            .await
            .unwrap();
        let graph = channel
            .request(
                "/arc-peer/3/topology",
                json!({"version":VERSION,"deviceId":"a".repeat(64),"visited":[]}),
                Duration::from_secs(5),
            )
            .await
            .unwrap();
        assert_eq!(graph["contains"], false);
        session.close().await;
        let secret = "b".repeat(64);
        root.state.lock().unwrap().offer = Some((hash(&secret), Instant::now() + OFFER_TTL));
        let offer = Offer {
            version: VERSION,
            device_id: root.identity().unwrap().id.clone(),
            addresses: vec![root_address.to_string()],
            tunnel_url: None,
            secret,
        };
        let denied = leaf
            .request("pair", json!({"pairingString":offer.encode().unwrap()}))
            .await
            .unwrap_err();
        assert_eq!(
            crate::management::error_code(&denied),
            "DEVICE_PAIRING_CYCLE"
        );
        assert!(root.request("pending", json!({})).await.unwrap()["pending"].is_null());
        for task in [root_task, middle_task, leaf_task] {
            task.abort();
            let _ = task.await;
        }
    }
}

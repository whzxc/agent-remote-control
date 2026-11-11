//! Transfer path admission shares the controller's liveness and pinned channels.
use super::super::transfer::wire::Link;
use super::*;
impl Controller {
    pub(in crate::device_link) async fn transfer_link(
        &self,
        selector: &str,
    ) -> Result<(String, Link)> {
        if !self.running.load(Ordering::SeqCst) {
            return Err(unavailable());
        }
        let member = self.member(selector).await?;
        if !member.status.lock().unwrap().online {
            return Err(offline());
        }
        let link = if member.status.lock().unwrap().path == "tunnel" {
            let closed = member.tunnel.subscribe();
            let (url, token) = self.tunnel_session(&member).await?;
            Link::Tunnel { url, token, closed }
        } else {
            Link::Lan(self.channel(&member, false).await?)
        };
        Ok((member.peer.device_id.clone(), link))
    }
    pub(in crate::device_link) async fn admit_transfer(
        &self,
        device: &str,
    ) -> Result<(String, Link, tokio::sync::OwnedSemaphorePermit)> {
        if !self.running.load(Ordering::SeqCst) {
            return Err(unavailable());
        }
        let member = self.member(device).await?;
        if !member.status.lock().unwrap().online {
            return Err(offline());
        }
        let slot = member.slots.clone().try_acquire_owned().map_err(|_| {
            error(
                "DEVICE_BUSY",
                "Member request capacity reached; wait for an active request.",
            )
        })?;
        let (id, link) = self.transfer_link(device).await?;
        Ok((id, link, slot))
    }
    pub(in crate::device_link) async fn refresh_transfer_link(
        &self,
        device: &str,
        link: &mut Link,
    ) -> Result<()> {
        let member = self.member(device).await?;
        if !member.status.lock().unwrap().online {
            return Err(offline());
        }
        if let Link::Tunnel { url, token, .. } = link {
            let identity = self
                .identity
                .lock()
                .unwrap()
                .clone()
                .ok_or_else(unavailable)?;
            let (_, fresh) = member
                .tunnel
                .prepare(identity.as_ref(), &member.peer.device_id, url)
                .await?;
            *token = fresh;
        }
        Ok(())
    }
    pub(crate) async fn transfer(self: &Arc<Self>, args: Value) -> Result<Value> {
        super::super::transfer::execution::call(self.clone(), args).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn offline_transfer_fails_before_source_or_transport_access() {
        // Contract: DEVICE_OFFLINE rejects transfer admission before opening the source or transmitting a request.
        if crate::device_link::tunnel_fixture::isolate("device_link::controller::transfer::tests::offline_transfer_fails_before_source_or_transport_access").await {return;}
        crate::preferences::write(json!({"values":{"device-link":"on"}})).unwrap();
        let controller = Controller::new(crate::root().join("controller/device-link")).unwrap();
        controller.running.store(true, Ordering::SeqCst);
        let member = Arc::new(Member {
            peer: Peer {
                device_id: "offline-member".into(),
                name: "Example offline".into(),
                public_key: String::new(),
                addresses: vec![],
                address_override: None,
                tunnel_url: None,
            },
            status: StdMutex::new(Status::default()),
            business: Session::default(),
            heartbeat: Session::default(),
            tunnel: Default::default(),
            slots: Arc::new(tokio::sync::Semaphore::new(64)),
            task: Default::default(),
            event_task: Default::default(),
        });
        controller
            .members
            .lock()
            .await
            .insert("offline-member".into(), member);
        let error=controller.transfer(json!({"from":{"path":"/unavailable-source"},"to":{"device":"offline-member","path":"/unavailable-destination"}})).await.unwrap_err();
        let error: Value = serde_json::from_str(&error).unwrap();
        assert_eq!(error["code"], "DEVICE_OFFLINE");
        assert_eq!(error["next"]["op"], "devices");
        controller.stop().await.unwrap();
    }
}

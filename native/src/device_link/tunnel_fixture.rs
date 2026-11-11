use super::*;
use http_body_util::{BodyExt, Full};
use hyper::{body::Bytes, Response};
use std::sync::atomic::{AtomicBool, Ordering};

pub(super) async fn isolate(name: &str) -> bool {
    if std::env::var("ARC_TUNNEL_TEST").ok().as_deref() == Some(name) {
        return false;
    }
    let directory = std::env::temp_dir().join(format!("arc-tunnel-test-{}", id()));
    let status = tokio::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", name, "--nocapture"])
        .env("ARC_TUNNEL_TEST", name)
        .env("ARC_STATE_DIR", &directory)
        .status()
        .await
        .unwrap();
    let _ = std::fs::remove_dir_all(directory);
    assert!(status.success());
    true
}
pub(super) struct Provider {
    pub url: String,
    pub _ingress: Arc<crate::ingress::Ingress>,
    pub lose_response: Arc<AtomicBool>,
    pub gate: Arc<(AtomicBool, tokio::sync::Notify, tokio::sync::Notify)>,
    tasks: Vec<tokio::task::JoinHandle<()>>,
}
impl Provider {
    pub async fn new(member: &Arc<Manager>) -> Self {
        let config = crate::ingress::config::defaults();
        let ingress=crate::ingress::Ingress::with_execution(json!({"id":"peer-fixture","name":"Example HTTPS","controlSource":"custom","transport":"https","auth":"none","enabled":true,"config":config}),None,"fixture".into()).unwrap();
        ingress.connected.store(true, Ordering::SeqCst);
        member.attach_ingress(&ingress);
        let (listener, local) =
            crate::https::listen(ingress.clone(), &json!({"httpsProvider":"fixture"}))
                .await
                .unwrap();
        let proxy = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/arc-peer/3", proxy.local_addr().unwrap());
        *ingress.mcp_url.lock().await = format!("http://{}/mcp", proxy.local_addr().unwrap());
        let lose_response = Arc::new(AtomicBool::new(false));
        let gate = Arc::new((
            AtomicBool::new(false),
            tokio::sync::Notify::new(),
            tokio::sync::Notify::new(),
        ));
        let gate_task = gate.clone();
        let lose = lose_response.clone();
        let task = tokio::spawn(async move {
            let mut connections = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                    accepted=proxy.accept()=>{
                        let Ok((stream,_))=accepted else {break;};
                        let lose=lose.clone();
                        let gate=gate_task.clone();
                        connections.spawn(async move {
                            let service=hyper::service::service_fn(move |request:hyper::Request<hyper::body::Incoming>| {
                                let lose=lose.clone();
                                let gate=gate.clone();
                                async move {
                                    let path=request.uri().path().to_owned();
                                    let auth=request.headers().get("authorization").cloned();
                                    let bytes=request.into_body().collect().await.unwrap().to_bytes();
                                    let mut upstream=reqwest::Client::new().post(format!("http://{local}{path}")).body(bytes);
                                    if let Some(auth)=auth {upstream=upstream.header("authorization",auth);}
                                    let response=upstream.send().await.unwrap().bytes().await.unwrap();
                                    if path.ends_with("/request") && gate.0.load(Ordering::SeqCst) { gate.1.notify_one();gate.2.notified().await; }
                                    let response=if lose.load(Ordering::SeqCst)&&path.ends_with("/request") {Bytes::from_static(b"lost provider response")} else {response};
                                    Ok::<_,std::convert::Infallible>(Response::new(Full::new(response)))
                                }
                            });
                            let _=hyper::server::conn::http1::Builder::new().serve_connection(hyper_util::rt::TokioIo::new(stream),service).await;
                        });
                    },
                    Some(_)=connections.join_next(), if !connections.is_empty()=>{},
                }
            }
        });
        Self {
            url,
            _ingress: ingress,
            lose_response,
            gate,
            tasks: vec![listener, task],
        }
    }
    pub async fn stop(&mut self) {
        for task in self.tasks.drain(..) {
            task.abort();
            let _ = task.await;
        }
    }
}
impl Drop for Provider {
    fn drop(&mut self) {
        for task in &self.tasks {
            task.abort();
        }
    }
}

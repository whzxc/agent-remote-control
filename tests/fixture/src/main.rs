use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
#[tokio::main]
async fn main() {
    let service = connector_core::service::Service::fixture(
        std::env::var("CLC_FIXTURE_BINARY").unwrap().into(),
    )
    .unwrap();
    let _listener = connector_core::transport::listen(service.clone(), None)
        .await
        .unwrap();
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let mut out = tokio::io::stdout();
    while let Some(line) = lines.next_line().await.unwrap() {
        let request = serde_json::from_str(&line).unwrap();
        let response = connector_core::transport::mcp(&service, request)
            .await
            .unwrap();
        if !response.is_null() {
            out.write_all(format!("{response}\n").as_bytes())
                .await
                .unwrap();
            out.flush().await.unwrap();
        }
    }
    service.control.close().await;
}

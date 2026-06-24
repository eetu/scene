#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracker_backend::run_server().await
}

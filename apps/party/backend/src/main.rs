#[tokio::main]
async fn main() -> anyhow::Result<()> {
    party_backend::run_server().await
}

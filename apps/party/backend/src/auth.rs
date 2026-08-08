//! Edge-trust auth (see `scene_backend::auth`). Bypassed by `DEV_AUTH=1`
//! (local work) or `PARTY_OPEN=1` (a LAN-only deploy).

pub use scene_backend::auth::Auth;

impl scene_backend::auth::AuthGate for crate::state::AppState {
    fn auth_bypassed(&self) -> bool {
        self.cfg.dev_auth
    }
}

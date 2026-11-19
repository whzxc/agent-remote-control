//! Native primary Codex home resolution.
use super::*;

fn directory() -> PathBuf {
    root().join("accounts/codex/profiles")
}

/// Legacy managed credential homes must never redirect Core or execution away
/// from the native primary `CODEX_HOME`.
pub fn primary_home(
    configured: Option<&Path>,
    profiles: &Path,
    user_home: Option<&Path>,
) -> Option<PathBuf> {
    let managed = configured
        .and_then(|home| {
            let container = home.parent()?.parent()?;
            let managed_container = container == profiles
                || container.ends_with(Path::new("accounts").join("codex").join("profiles"));
            managed_container
                .then(|| home.strip_prefix(container).ok())
                .flatten()
        })
        .is_some_and(|relative| {
            let mut components = relative.components();
            let profile = components.next().and_then(|part| part.as_os_str().to_str());
            profile.is_some_and(|profile| uuid::Uuid::parse_str(profile).is_ok())
                && components
                    .next()
                    .is_some_and(|part| part.as_os_str() == "home")
                && components.next().is_none()
        });
    configured
        .filter(|_| !managed)
        .map(Path::to_path_buf)
        .or_else(|| user_home.map(|home| home.join(".codex")))
}

pub(crate) fn default_home() -> Result<PathBuf> {
    let configured = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .map(|path| path.canonicalize().unwrap_or(path));
    let profiles = directory();
    let profiles = profiles.canonicalize().unwrap_or(profiles);
    primary_home(
        configured.as_deref(),
        &profiles,
        dirs::home_dir().as_deref(),
    )
    .ok_or_else(|| "CODEX_HOME_UNAVAILABLE".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inherited_managed_home_never_becomes_primary_configuration() {
        // Recurring bug class: persistence ARC launched from a legacy spare Codex task inherited its CODEX_HOME and treated it as the primary home.
        let profiles = Path::new("/state/accounts/codex/profiles");
        let managed = profiles.join("00000000-0000-4000-8000-000000000001/home");
        let user = Path::new("/user");
        assert_eq!(
            primary_home(Some(&managed), profiles, Some(user)),
            Some(user.join(".codex"))
        );
        let other_instance = Path::new(
            "/other-state/accounts/codex/profiles/00000000-0000-4000-8000-000000000002/home",
        );
        assert_eq!(
            primary_home(Some(other_instance), profiles, Some(user)),
            Some(user.join(".codex"))
        );
        let custom = Path::new("/custom-codex");
        assert_eq!(
            primary_home(Some(custom), profiles, Some(user)),
            Some(custom.to_path_buf())
        );
        assert_eq!(
            primary_home(None, profiles, Some(user)),
            Some(user.join(".codex"))
        );
    }
}

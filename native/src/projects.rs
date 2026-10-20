use crate::control::Control;
use crate::*;
use std::collections::BTreeSet;
pub async fn list(c: &Control) -> Result<Vec<Value>> {
    let mut out = Vec::new();
    let mut cursor = Value::Null;
    let mut seen = BTreeSet::new();
    loop {
        let page = c
            .request("project/list", json!({"cursor":cursor}), 60000)
            .await?;
        out.extend(
            page["data"]
                .as_array()
                .ok_or("invalid project list")?
                .iter()
                .cloned(),
        );
        cursor = page["nextCursor"].clone();
        if cursor.is_null() {
            return Ok(out);
        }
        if !seen.insert(cursor.to_string()) {
            return Err("project pagination did not advance".into());
        }
    }
}
pub async fn resolve(c: &Control, id: &str) -> Result<Value> {
    if id.is_empty() {
        return Err("PROJECT_REQUIRED_FOR_RELATIVE_PATH".into());
    }
    let (root, pid, name) = if Path::new(id).is_absolute() {
        (
            PathBuf::from(id),
            id.to_owned(),
            Path::new(id)
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
        )
    } else {
        let catalog = {
            let mut cache = c.projects.lock().await;
            if cache
                .as_ref()
                .is_none_or(|(at, _)| at.elapsed().as_secs() >= 30)
            {
                *cache = Some((std::time::Instant::now(), list(c).await?));
            }
            cache.as_ref().unwrap().1.clone()
        };
        let exact = catalog.iter().find(|p| p["id"] == id);
        let candidates = if let Some(p) = exact {
            vec![p]
        } else {
            catalog.iter().filter(|p| p["name"] == id).collect()
        };
        if candidates.len() != 1 {
            return Err("项目不存在或名称不唯一".into());
        }
        let p = candidates[0];
        let roots = p["roots"].as_array().ok_or("project has no directories")?;
        let named: Vec<_> = roots
            .iter()
            .filter(|r| {
                Path::new(string(r, "path"))
                    .file_name()
                    .is_some_and(|name| name == string(p, "name"))
            })
            .collect();
        let selected = if roots.len() == 1 {
            &roots[0]
        } else if named.len() == 1 {
            named[0]
        } else {
            let mut repositories = Vec::new();
            for candidate in roots {
                let path = Path::new(string(candidate, "path"));
                if let Ok(top) = git(
                    string(candidate, "path"),
                    strings(&["rev-parse", "--show-toplevel"]),
                )
                .await
                {
                    if path.canonicalize().ok().is_some_and(|root| {
                        Path::new(top.trim()).canonicalize().ok().as_ref() == Some(&root)
                    }) {
                        repositories.push(candidate);
                    }
                }
            }
            if repositories.len() != 1 {
                return Err(format!(
                    "多目录项目请指定绝对目录：{}",
                    roots
                        .iter()
                        .map(|r| string(r, "path"))
                        .collect::<Vec<_>>()
                        .join(", ")
                ));
            }
            repositories[0]
        };
        (
            PathBuf::from(string(selected, "path")),
            string(p, "id").into(),
            string(p, "name").into(),
        )
    };
    crate::permissions::check_path(&root)?;
    let root = std::fs::canonicalize(root).map_err(|e| e.to_string())?;
    crate::permissions::check_path(&root)?;
    if !root.is_dir() {
        return Err("project must be a directory".into());
    }
    Ok(json!({"id":pid,"name":name,"root":root}))
}
pub(crate) async fn git(root: &str, args: Vec<String>) -> Result<String> {
    git_command(root, args, false).await
}
// Global configuration is read only by `git config` to extract commit identity.
async fn git_command(root: &str, args: Vec<String>, identity: bool) -> Result<String> {
    String::from_utf8(git_bytes(root, args, identity).await?).map_err(|e| e.to_string())
}
async fn git_bytes(root: &str, args: Vec<String>, identity: bool) -> Result<Vec<u8>> {
    let config_query = args.first().is_some_and(|s| s == "config");
    let mutation = args.first().is_some_and(|s| s == "-c");
    let null = if cfg!(windows) { "NUL" } else { "/dev/null" };
    let missing_ref_check =
        args.first().is_some_and(|s| s == "show-ref") && args.iter().any(|s| s == "--quiet");
    let mut cmd = command("git");
    cmd.kill_on_drop(true);
    cmd.args([
        "--no-optional-locks",
        "--literal-pathspecs",
        "-c",
        "core.fsmonitor=false",
        "-c",
        &format!("core.hooksPath={null}"),
        "-c",
        &format!("core.attributesFile={null}"),
        "-c",
        "diff.external=",
        "-c",
        "color.ui=false",
        "-C",
        root,
    ])
    .args(args)
    .env_clear();
    for k in [
        "PATH",
        "HOME",
        "USERPROFILE",
        "XDG_CONFIG_HOME",
        "SYSTEMROOT",
        "TEMP",
        "TMP",
    ] {
        if let Some(v) = std::env::var_os(k) {
            cmd.env(k, v);
        }
    }
    cmd.env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_PAGER", "cat")
        .env("LC_ALL", "C");
    if mutation {
        cmd.env("GIT_NO_LAZY_FETCH", "1");
    }
    if !identity {
        cmd.env("GIT_CONFIG_GLOBAL", null);
    }
    cmd.stdin(std::process::Stdio::null());
    use tokio::io::AsyncReadExt;
    const LIMIT: u64 = 16 * 1024 * 1024;
    cmd.stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let stdout = child.stdout.take().ok_or("missing Git stdout")?;
    let stderr = child.stderr.take().ok_or("missing Git stderr")?;
    let collect = async |stream: Box<dyn tokio::io::AsyncRead + Unpin + Send>| -> Result<Vec<u8>> {
        let mut bytes = Vec::new();
        stream
            .take(LIMIT + 1)
            .read_to_end(&mut bytes)
            .await
            .map_err(|e| e.to_string())?;
        if bytes.len() > LIMIT as usize {
            return Err("GIT_OUTPUT_LIMIT".into());
        }
        Ok(bytes)
    };
    let (stdout, stderr, status) =
        tokio::time::timeout(std::time::Duration::from_secs(12), async {
            tokio::try_join!(
                collect(Box::new(stdout)),
                collect(Box::new(stderr)),
                async { child.wait().await.map_err(|e| e.to_string()) }
            )
        })
        .await
        .map_err(|_| "GIT_TIMEOUT")??;
    if config_query && status.code() == Some(1) {
        return Ok(Vec::new());
    }
    if !status.success() {
        return Err(
            if String::from_utf8_lossy(&stderr).contains("not a git repository")
                && !Path::new(root)
                    .ancestors()
                    .any(|p| p.join(".git").symlink_metadata().is_ok())
            {
                "NOT_GIT_REPOSITORY".into()
            } else if missing_ref_check && status.code() == Some(1) {
                "GIT_REF_MISSING".into()
            } else if mutation {
                format!(
                    "GIT_WRITE_FAILED: {}\n{}",
                    String::from_utf8_lossy(&stderr)
                        .chars()
                        .take(4096)
                        .collect::<String>(),
                    String::from_utf8_lossy(&stdout)
                        .chars()
                        .take(4096)
                        .collect::<String>()
                )
            } else {
                "GIT_QUERY_FAILED".into()
            },
        );
    }
    Ok(stdout)
}
/// Local Git mutations share Control's durable request reservation and receipts.
pub async fn write(c: &Control, args: &Value) -> Result<Value> {
    let project = resolve(c, string(args, "project")).await?;
    let root = string(&project, "root");
    git(root, strings(&["rev-parse", "--git-dir"])).await?;
    let operation = string(args, "operation");
    let permitted: &[&str] = match operation {
        "add" | "unstage" => &["paths", "all"],
        "commit" => &["message"],
        "branch" => &["branch"],
        "switch" => &["branch", "create"],
        "stash_push" => &["message"],
        "stash_pop" => &[],
        _ => return Err("unsupported Git write operation".into()),
    };
    if args
        .as_object()
        .ok_or("invalid Git arguments")?
        .keys()
        .any(|key| {
            !["project", "operation", "requestId"].contains(&key.as_str())
                && !permitted.contains(&key.as_str())
        })
    {
        return Err("argument does not apply to Git operation".into());
    }
    if operation == "stash_pop"
        && !git(
            root,
            strings(&[
                "config",
                "--name-only",
                "--get-regexp",
                "^merge\\..*\\.driver$",
            ]),
        )
        .await?
        .is_empty()
    {
        return Err("stash_pop does not support configured external merge drivers".into());
    }
    let mut cmd = strings(&[
        "-c",
        "commit.gpgSign=false",
        "-c",
        "tag.gpgSign=false",
        "-c",
        "maintenance.auto=false",
        "-c",
        "gc.auto=0",
        "-c",
        "submodule.recurse=false",
        "-c",
        "rerere.enabled=false",
    ]);
    // A repository's .gitattributes can select local filter commands even with
    // global configuration disabled. Disable every configured filter driver.
    let filters = git(
        root,
        strings(&[
            "config",
            "--null",
            "--name-only",
            "--get-regexp",
            "^filter\\.",
        ]),
    )
    .await?;
    for key in filters.split('\0').filter(|key| !key.is_empty()) {
        if let Some((driver, _)) = key.rsplit_once('.') {
            for (field, value) in [
                ("clean", ""),
                ("smudge", ""),
                ("process", ""),
                ("required", "false"),
            ] {
                cmd.extend(["-c".into(), format!("{driver}.{field}={value}")]);
            }
        }
    }
    if matches!(operation, "commit" | "stash_push") {
        for key in ["user.name", "user.email"] {
            let value = git_command(root, strings(&["config", "--get", key]), true).await?;
            let value = value.trim_end_matches(['\r', '\n']);
            if value.trim().is_empty() {
                return Err(format!(
                    "configure {key} in repository or user Git config before committing"
                ));
            }
            cmd.extend(["-c".into(), format!("{key}={value}")]);
        }
    }
    match operation {
        "add" | "unstage" => {
            let paths = args["paths"].as_array();
            let all = args["all"] == true;
            if all == paths.is_some() || paths.is_some_and(|p| p.is_empty()) {
                return Err("provide either nonempty paths or all=true".into());
            }
            let paths: Vec<String> = if all {
                vec![".".into()]
            } else {
                paths
                    .unwrap()
                    .iter()
                    .map(|v| {
                        let path = v
                            .as_str()
                            .filter(|p| !p.is_empty() && !p.contains('\0'))
                            .ok_or("invalid Git path")?;
                        if Path::new(path).is_absolute()
                            || Path::new(path).components().any(|c| {
                                matches!(
                                    c,
                                    std::path::Component::ParentDir
                                        | std::path::Component::Prefix(_)
                                )
                            })
                        {
                            return Err("Git paths must stay relative to project".to_string());
                        }
                        Ok(path.to_owned())
                    })
                    .collect::<Result<_>>()?
            };
            if operation == "add" {
                cmd.extend(strings(&["add", "--all", "--"]));
            } else if git(root, strings(&["rev-parse", "--verify", "HEAD"]))
                .await
                .is_ok()
            {
                cmd.extend(strings(&["restore", "--staged", "--"]));
            } else {
                // Unborn branch: remove entries only from the index, preserving files.
                let head = git(root, strings(&["symbolic-ref", "HEAD"])).await?;
                match git(
                    root,
                    strings(&["show-ref", "--verify", "--quiet", head.trim()]),
                )
                .await
                {
                    Err(error) if error == "GIT_REF_MISSING" => {}
                    _ => return Err("cannot verify unborn Git branch".into()),
                }
                cmd.extend(strings(&[
                    "rm",
                    "--cached",
                    "--force",
                    "-r",
                    "--ignore-unmatch",
                    "--",
                ]));
            }
            cmd.extend(paths);
        }
        "commit" => {
            let message = string(args, "message");
            if message.trim().is_empty() || message.contains('\0') {
                return Err("commit message is required".into());
            }
            cmd.extend(strings(&[
                "commit",
                "--no-gpg-sign",
                "--cleanup=verbatim",
                "-m",
                message,
            ]));
        }
        "branch" | "switch" => {
            let branch = string(args, "branch");
            if branch.is_empty()
                || branch.starts_with('-')
                || branch.starts_with('@')
                || branch == "HEAD"
            {
                return Err("a literal local branch name is required".into());
            }
            git(
                root,
                strings(&["check-ref-format", &format!("refs/heads/{branch}")]),
            )
            .await?;
            if operation == "branch" {
                cmd.extend(strings(&["branch", "--no-track", "--", branch]));
            } else if args["create"] == true {
                cmd.extend(strings(&["switch", "--no-track", "-c", branch, "--"]));
            } else {
                cmd.extend(strings(&["switch", "--no-guess", branch, "--"]));
            }
        }
        "stash_push" => {
            cmd.extend(strings(&["stash", "push"]));
            if let Some(message) = args["message"].as_str() {
                cmd.extend(strings(&["-m", message]));
            }
        }
        "stash_pop" => cmd.extend(strings(&["stash", "pop"])),
        _ => unreachable!(),
    }
    let text = git(root, cmd).await?;
    Ok(json!({"project":project,"operation":operation,"text":text}))
}
fn strings(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}
async fn state(p: &Value) -> Result<Value> {
    let root = string(p, "root");
    if !Path::new(root)
        .ancestors()
        .any(|path| path.join(".git").symlink_metadata().is_ok())
        && !(Path::new(root).join("HEAD").is_file() && Path::new(root).join("objects").is_dir())
    {
        return Ok(
            json!({"project":p["id"],"root":root,"git":false,"sha":null,"statusHash":null,"observedAt":now()}),
        );
    }
    match git(root, strings(&["rev-parse", "--git-dir"])).await {
        Ok(_) => (),
        Err(e) if e == "NOT_GIT_REPOSITORY" => {
            return Ok(
                json!({"project":p["id"],"root":root,"git":false,"sha":null,"statusHash":null,"observedAt":now()}),
            )
        }
        Err(e) => return Err(e),
    }
    // An unborn repository is Git, but has no HEAD yet.
    let sha = match git(root, strings(&["rev-parse", "--verify", "HEAD"])).await {
        Ok(s) => Some(s.trim().to_owned()),
        Err(e) => {
            let symbolic = git(root, strings(&["symbolic-ref", "HEAD"])).await?;
            if git(
                root,
                strings(&["show-ref", "--verify", "--quiet", symbolic.trim()]),
            )
            .await
            .is_err_and(|e| e == "GIT_REF_MISSING")
            {
                None
            } else {
                return Err(e);
            }
        }
    };
    let branch = git(root, strings(&["branch", "--show-current"])).await?;
    let raw = git(
        root,
        strings(&[
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
            "--ignore-submodules=all",
        ]),
    )
    .await?;
    let mut changes = Vec::new();
    let mut parts = raw.split('\0');
    while let Some(s) = parts.next() {
        if s.len() < 3 {
            continue;
        }
        let code = &s[..2];
        let old = if code.contains('R') || code.contains('C') {
            parts.next()
        } else {
            None
        };
        changes.push(json!({"status":code,"path":&s[3..],"originalPath":old}));
    }
    Ok(
        json!({"project":p["id"],"root":root,"git":true,"sha":sha,"branch":branch.trim(),"dirty":!raw.is_empty(),"statusHash":hash(raw),"changesTruncated":changes.len()>200,"changes":changes.into_iter().take(200).collect::<Vec<_>>(),"observedAt":now()}),
    )
}
fn walk(root: &Path, dir: &Path, out: &mut BTreeSet<String>) -> Result<()> {
    crate::permissions::check_path(dir)?;
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
        let e = entry.map_err(|e| e.to_string())?;
        if e.file_type().map_err(|e| e.to_string())?.is_dir() {
            walk(root, &e.path(), out)?
        } else {
            out.insert(
                e.path()
                    .strip_prefix(root)
                    .map_err(|e| e.to_string())?
                    .to_string_lossy()
                    .replace('\\', "/"),
            );
        }
        if out.len() > 100000 {
            return Err("目录过大，请缩小范围".into());
        }
    }
    Ok(())
}
// Tree reads need only the requested depth, including empty directories.
fn walk_tree(
    root: &Path,
    dir: &Path,
    depth: usize,
    out: &mut BTreeSet<String>,
    remaining: &mut usize,
) -> Result<bool> {
    crate::permissions::check_path(dir)?;
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
        if *remaining == 0 {
            return Ok(true);
        }
        *remaining -= 1;
        let entry = entry.map_err(|e| e.to_string())?;
        let directory = entry.file_type().map_err(|e| e.to_string())?.is_dir();
        let path = entry.path();
        let name = path
            .strip_prefix(root)
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        if directory && depth > 1 {
            // Keep empty directories visible too.
            out.insert(format!("{name}/"));
            if walk_tree(root, &path, depth - 1, out, remaining)? {
                return Ok(true);
            }
        } else {
            out.insert(format!("{name}{}", if directory { "/" } else { "" }));
        }
    }
    Ok(false)
}
async fn files(
    root: &str,
    prefix: &str,
    ignored: bool,
    tree_depth: Option<usize>,
) -> Result<(Vec<String>, bool)> {
    let mut truncated = false;
    let mut args = strings(&["ls-files", "--cached", "--others", "-z"]);
    if !ignored {
        args.push("--exclude-standard".into())
    }
    let entries = match git(root, args).await {
        Ok(s) => s
            .split('\0')
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .collect::<BTreeSet<_>>(),
        Err(e) if e == "NOT_GIT_REPOSITORY" => {
            let mut out = BTreeSet::new();
            if let Some(depth) = tree_depth {
                let directory = Path::new(root).join(prefix);
                truncated = walk_tree(Path::new(root), &directory, depth, &mut out, &mut 10000)?;
                if truncated {
                    out.clear();
                    walk_tree(Path::new(root), &directory, 1, &mut out, &mut 10000)?;
                }
            } else {
                walk(Path::new(root), Path::new(root), &mut out)?;
            }
            out
        }
        Err(e) => return Err(e),
    };
    Ok((
        entries
            .into_iter()
            .filter(|s| prefix.is_empty() || s == prefix || s.starts_with(&format!("{prefix}/")))
            .collect(),
        truncated,
    ))
}
pub(crate) fn read_bytes(root: &str, file: &str) -> Result<Vec<u8>> {
    let path = Path::new(root).join(file);
    crate::permissions::check_path(&path)?;
    if let Ok(resolved) = path.canonicalize() {
        crate::permissions::check_path(&resolved)?;
    }
    let before = std::fs::metadata(&path).map_err(io_reason)?;
    if !before.is_file() {
        return Err("NOT_REGULAR_FILE".into());
    }
    if before.len() > 16 * 1024 * 1024 {
        return Err("FILE_TOO_LARGE".into());
    }
    use std::io::Read;
    let mut bytes = Vec::new();
    std::fs::File::open(&path)
        .map_err(io_reason)?
        .take(16 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(io_reason)?;
    if bytes.len() > 16 * 1024 * 1024 {
        return Err("FILE_TOO_LARGE".into());
    }
    let after = std::fs::metadata(&path).map_err(io_reason)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if before.ino() != after.ino()
            || before.ctime() != after.ctime()
            || before.ctime_nsec() != after.ctime_nsec()
        {
            return Err("FILE_CHANGED_DURING_READ".into());
        }
    }
    if before.modified().ok() != after.modified().ok() || before.len() != after.len() {
        return Err("FILE_CHANGED_DURING_READ".into());
    }
    Ok(bytes)
}
fn read(root: &str, file: &str) -> Result<String> {
    crate::images::text(read_bytes(root, file)?, file)
}
fn io_reason(e: std::io::Error) -> String {
    match e.kind() {
        std::io::ErrorKind::NotFound => "NOT_FOUND",
        std::io::ErrorKind::PermissionDenied => "PERMISSION_DENIED",
        _ => "READ_ERROR",
    }
    .into()
}
pub(crate) fn review_path(root: &str, file: &str) -> Result<()> {
    let root = Path::new(root);
    let private_root = crate::root().canonicalize().ok();
    let path = root.join(file);
    let relative = path.strip_prefix(root).map_err(|_| "OUTSIDE_WORKSPACE")?;
    // Resolve existing ancestors too: deleted Git paths may still traverse a symlink.
    let mut ancestor = path.as_path();
    loop {
        match std::fs::canonicalize(ancestor) {
            Ok(actual) => {
                if private_root.as_ref().is_some_and(|p| actual.starts_with(p)) {
                    return Err("PRIVATE_RUNTIME_STATE".into());
                }
                actual.strip_prefix(root).map_err(|_| "OUTSIDE_WORKSPACE")?;
                break;
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                ancestor = ancestor.parent().ok_or("OUTSIDE_WORKSPACE")?;
            }
            Err(e) => return Err(io_reason(e)),
        }
    }
    if relative
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err("PARENT_PATH_RESTRICTED".into());
    }
    Ok(())
}
fn filter_paths(
    root: &str,
    paths: Vec<String>,
    review: bool,
    skipped: &mut std::collections::BTreeMap<String, usize>,
) -> Vec<String> {
    paths
        .into_iter()
        .filter(|p| {
            if review {
                if let Err(e) = review_path(root, p) {
                    *skipped.entry(e).or_default() += 1;
                    return false;
                }
            }
            true
        })
        .collect()
}
fn filter_state(
    root: &str,
    source: &mut Value,
    review: bool,
    skipped: &mut std::collections::BTreeMap<String, usize>,
) {
    if !review {
        return;
    }
    if let Some(changes) = source["changes"].as_array_mut() {
        changes.retain(|c| {
            for key in ["path", "originalPath"] {
                if let Some(p) = c[key].as_str() {
                    if let Err(e) = review_path(root, p) {
                        *skipped.entry(e).or_default() += 1;
                        return false;
                    }
                }
            }
            true
        });
    }
}
async fn revision(root: &str, rev: &str) -> Result<String> {
    Ok(git(
        root,
        vec![
            "rev-parse".into(),
            "--verify".into(),
            "--end-of-options".into(),
            format!("{rev}^{{commit}}"),
        ],
    )
    .await?
    .trim()
    .into())
}
pub async fn query(c: &Control, action: &str, args: &Value) -> Result<Value> {
    let requested_path = string(args, "path").to_owned();
    let mut normalized = args.clone();
    if matches!(action, "read" | "tree" | "search")
        && Path::new(string(args, "path")).is_absolute()
        && args.get("revision").is_none()
        && (action != "read" || args.get("project").is_none())
    {
        let path = PathBuf::from(string(args, "path"));
        if args["view"] == "review" && args["project"].is_string() {
            let original = resolve(c, string(args, "project")).await?;
            review_path(string(&original, "root"), string(args, "path"))?;
        }
        if action == "read" {
            normalized["project"] = json!(path.parent().ok_or("INVALID_PATH")?);
            normalized["path"] = json!(path.file_name().ok_or("INVALID_PATH")?.to_string_lossy());
        } else {
            normalized["project"] = json!(path);
            normalized["path"] = json!("");
        }
    }
    let args = &normalized;
    let p = resolve(c, string(args, "project")).await?;
    let root = string(&p, "root");
    let started = now();
    let review = args["view"] == "review";
    let mut skipped = std::collections::BTreeMap::new();
    if review {
        review_path(root, "")?;
    }
    let include_source = args["includeSource"] == true;
    let mut source = if include_source || (action == "git" && args["operation"] == "status") {
        match state(&p).await {
            Ok(source) => source,
            Err(e) if action == "git" && args["operation"] == "status" => return Err(e),
            Err(e) => json!({"error":e}),
        }
    } else {
        Value::Null
    };
    let mut source_skipped = std::collections::BTreeMap::new();
    filter_state(root, &mut source, review, &mut source_skipped);
    let file = string(args, "path");
    if file.contains('\0') {
        return Err("invalid path".into());
    }
    if review && !file.is_empty() {
        review_path(root, file)?;
    }
    let mut image_blocks = Vec::new();
    let mut data = match action {
        "overview" => {
            let paths = filter_paths(
                root,
                files(root, "", false, None).await?.0,
                review,
                &mut skipped,
            );
            json!({"listingHash":hash(paths.join("\0")),"truncated":paths.iter().filter_map(|s|s.split('/').next()).collect::<BTreeSet<_>>().len()>100 || paths.iter().filter(|s|s.ends_with("README.md")).count()>30,"name":p["name"],"topLevel":paths.iter().filter_map(|s|s.split('/').next()).collect::<BTreeSet<_>>().into_iter().take(100).collect::<Vec<_>>(),"documentEntrypoints":paths.iter().filter(|s|s.ends_with("README.md")).take(30).collect::<Vec<_>>()})
        }
        "tree" => {
            let prefix = file.trim_end_matches('/');
            let (paths, truncated) = files(
                root,
                prefix,
                args["includeIgnored"] == true,
                Some(num(args, "depth", 2)),
            )
            .await?;
            let paths = filter_paths(root, paths, review, &mut skipped);
            let depth = num(args, "depth", 2)
                + if prefix.is_empty() {
                    0
                } else {
                    prefix.split('/').count()
                };
            let items = paths
                .iter()
                .map(|s| {
                    let parts: Vec<_> = s.split('/').collect();
                    format!(
                        "{}{}",
                        parts
                            .iter()
                            .take(depth)
                            .copied()
                            .collect::<Vec<_>>()
                            .join("/"),
                        if parts.len() > depth { "/" } else { "" }
                    )
                })
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect::<Vec<_>>();
            let offset = num(args, "offset", 0);
            let limit = num(args, "limit", 100);
            json!({"path":file,"truncated":truncated,"depth":if truncated {1}else{num(args,"depth",2)},"entries":items.iter().skip(offset).take(limit).collect::<Vec<_>>(),"metadata":metadata(&Path::new(root).join(file)),"entryMetadata":items.iter().skip(offset).take(limit).map(|p| json!({"path":p,"metadata":metadata(&Path::new(root).join(p.trim_end_matches('/')))})).collect::<Vec<_>>(),"total":items.len(),"listingHash":hash(items.join("\0")),"nextOffset":if offset+limit<items.len(){Some(offset+limit)}else{None}})
        }
        "read" => {
            let rev = if args["revision"].is_string() {
                Some(revision(root, string(args, "revision")).await?)
            } else {
                None
            };
            let bytes = if let Some(ref rev) = rev {
                let entry = git(
                    root,
                    vec!["ls-tree".into(), rev.clone(), "--".into(), file.into()],
                )
                .await?;
                if !entry.starts_with("100644 blob ") && !entry.starts_with("100755 blob ") {
                    return Err("提交中没有可读普通文件".into());
                }
                let oid = entry
                    .split_whitespace()
                    .nth(2)
                    .ok_or("invalid git object")?;
                if git(root, strings(&["cat-file", "-s", oid]))
                    .await?
                    .trim()
                    .parse::<u64>()
                    .unwrap_or(u64::MAX)
                    > 16 * 1024 * 1024
                {
                    return Err("文件过大".into());
                }
                git_bytes(root, strings(&["cat-file", "blob", oid]), false).await?
            } else {
                read_bytes(root, file)?
            };
            if crate::images::format(&bytes, file).is_some() {
                let image = crate::images::prepare(&bytes, file, args)?;
                image_blocks = image.blocks(file);
                image.metadata
            } else {
                let content = crate::images::text(bytes, file)?;
                if content.contains('\0') {
                    return Err("需要文本文件".into());
                }
                let lines: Vec<_> = content.split('\n').collect();
                let start = num(args, "startLine", 1);
                let count = num(args, "lineCount", 160);
                json!({"path":file,"revision":rev.unwrap_or_else(||"working".into()),"sha256":hash(&content),"startLine":start,"totalLines":lines.len(),"nextLine":if start+count<=lines.len(){Some(start+count)}else{None},"text":lines.iter().skip(start-1).take(count).enumerate().map(|(i,s)|format!("{}: {s}",start+i)).collect::<Vec<_>>().join("\n"),"truncated":false})
            }
        }
        "search" => {
            let paths = filter_paths(
                root,
                files(root, file, args["includeIgnored"] == true, None)
                    .await?
                    .0,
                review,
                &mut skipped,
            );
            let needle = string(args, "query");
            let sensitive = args["caseSensitive"] == true;
            let needle = if sensitive {
                needle.into()
            } else {
                needle.to_lowercase()
            };
            let mut results = Vec::new();
            let mut index = num(args, "offset", 0);
            let (mut bytes, mut scanned, mut skipped_count) = (0, 0, 0);
            while index < paths.len()
                && results.len() < num(args, "limit", 30)
                && scanned < 1500
                && bytes < 256 * 1024 * 1024
            {
                let path = &paths[index];
                index += 1;
                match read(root, path) {
                    Ok(text) => {
                        bytes += text.len();
                        scanned += 1;
                        let total_matches = text
                            .lines()
                            .filter(|s| {
                                if sensitive {
                                    s.contains(&needle)
                                } else {
                                    s.to_lowercase().contains(&needle)
                                }
                            })
                            .count();
                        let matches:Vec<_>=text.lines().enumerate().filter(|(_,s)|if sensitive{s.contains(&needle)}else{s.to_lowercase().contains(&needle)}).take(5).map(|(i,s)|json!({"line":i+1,"text":s.chars().take(500).collect::<String>()})).collect();
                        if !matches.is_empty()
                            || (if sensitive {
                                path.clone()
                            } else {
                                path.to_lowercase()
                            })
                            .contains(&needle)
                        {
                            let mut result = json!({"path":path,"matches":matches,"matchesComplete":total_matches<=5 && text.lines().filter(|s| if sensitive {s.contains(&needle)}else{s.to_lowercase().contains(&needle)}).all(|s|s.chars().count()<=500),"totalMatches":total_matches});
                            if args["view"] == "full" {
                                result["sha256"] = json!(hash(&text));
                            }
                            results.push(result);
                        }
                    }
                    Err(e) => {
                        skipped_count += 1;
                        *skipped.entry(e).or_default() += 1;
                    }
                }
            }
            json!({"query":args["query"],"results":results,"scanned":scanned,"skipped":skipped_count,"listingHash":hash(paths.join("\0")),"nextOffset":if index<paths.len(){Some(index)}else{None},"readNext":{"via":"query","op":"read","args":{"project":args["project"],"path":"<result.path>","view":if review{"review"}else{"raw"}}}})
        }
        "git" => {
            let op = string(args, "operation");
            if op == "status" {
                skipped = source_skipped.clone();
                source.clone()
            } else if op == "show" {
                let rev = revision(root, args["revision"].as_str().unwrap_or("HEAD")).await?;
                let raw = git(
                    root,
                    vec![
                        "diff-tree".into(),
                        "--root".into(),
                        "--no-commit-id".into(),
                        "--name-only".into(),
                        "--no-renames".into(),
                        "-r".into(),
                        "-z".into(),
                        rev.clone(),
                    ],
                )
                .await?;
                let paths: Vec<_> = raw.split('\0').filter(|s| !s.is_empty()).collect();
                let paths = filter_paths(
                    root,
                    paths.iter().map(|s| s.to_string()).collect(),
                    review,
                    &mut skipped,
                );
                json!({"revision":rev,"text":git(root, vec!["show".into(),"-s".into(),"--format=%H%n%cs%n%s".into(),rev.clone()]).await?,"truncated":false,"paths":paths.iter().take(200).collect::<Vec<_>>(),"truncatedPaths":paths.len()>200,"hiddenPaths":skipped.values().sum::<usize>()})
            } else {
                let mut cmd = match op {
                    "log" => vec![
                        "log".into(),
                        format!("-{}", num(args, "limit", 10)),
                        "--format=%H %cs %s".into(),
                        revision(root, args["revision"].as_str().unwrap_or("HEAD")).await?,
                    ],
                    "diff" => {
                        if args["baseRevision"].is_string() && !args["revision"].is_string() {
                            return Err("baseRevision requires revision".into());
                        }
                        if args["staged"] == true && args["revision"].is_string() {
                            return Err("staged cannot be combined with revision".into());
                        }
                        let mut v = strings(&[
                            "diff",
                            "--no-ext-diff",
                            "--no-textconv",
                            "--no-renames",
                            "--ignore-submodules=all",
                            "--unified=3",
                        ]);
                        if args["staged"] == true {
                            v.push("--cached".into())
                        }
                        for key in ["baseRevision", "revision"] {
                            if let Some(rev) = args[key].as_str() {
                                v.push(revision(root, rev).await?)
                            }
                        }
                        v
                    }
                    _ => return Err("未知 Git 查询".into()),
                };
                cmd.push("--".into());
                if !file.is_empty() {
                    cmd.push(file.into())
                }
                let mut data = if review && op == "diff" {
                    let mut names = cmd.clone();
                    names.insert(1, "--name-status".into());
                    names.insert(2, "-z".into());
                    names.retain(|s| s != "--no-renames");
                    names.insert(3, "--find-renames".into());
                    // Keep both sides of renames inside the requested workspace.
                    names.truncate(names.iter().position(|s| s == "--").unwrap() + 1);
                    let raw = git(root, names).await?;
                    let mut parts = raw.split('\0').filter(|s| !s.is_empty());
                    let mut candidates = Vec::new();
                    while let Some(status) = parts.next() {
                        let first = parts.next().ok_or("INVALID_GIT_PATH_METADATA")?;
                        let mut pair = vec![first.to_owned()];
                        if status.starts_with('R') || status.starts_with('C') {
                            pair.push(parts.next().ok_or("INVALID_GIT_PATH_METADATA")?.to_owned());
                        }
                        let allowed = filter_paths(root, pair.clone(), true, &mut skipped);
                        if allowed.len() == pair.len() {
                            candidates.extend(pair);
                        }
                    }
                    let mut safe = candidates;
                    safe.retain(|p| {
                        file.is_empty() || p == file || p.starts_with(&format!("{file}/"))
                    });
                    cmd.truncate(cmd.iter().position(|s| s == "--").unwrap() + 1);
                    cmd.extend(safe.clone());
                    json!({"text":if safe.is_empty(){String::new()}else{git(root,cmd.clone()).await?},"truncated":false,"paths":safe})
                } else {
                    json!({"text":git(root,cmd.clone()).await?,"truncated":false})
                };
                if op == "diff" && string(&data, "text").len() > 12000 {
                    let mut stats = cmd;
                    stats.retain(|arg| arg != "--unified=3");
                    stats.insert(1, "--numstat".into());
                    stats.insert(2, "-z".into());
                    let stats = git(root, stats).await?;
                    let files: Vec<_> = stats.split('\0').filter_map(|row| {
                        let fields: Vec<_> = row.splitn(3,'\t').collect();
                        (fields.len()==3).then(|| json!({"path":fields[2],"added":fields[0].parse::<u64>().ok(),"removed":fields[1].parse::<u64>().ok(),"binary":fields[0]=="-"}))
                    }).collect();
                    let full = json!({"text":data["text"],"files":files});
                    let paged = crate::kernel::results::page_output(full, 12000)?;
                    let text = string(&data, "text");
                    let mut end = 12000;
                    while !text.is_char_boundary(end) {
                        end -= 1;
                    }
                    data["text"] = json!(&text[..end]);
                    data["truncated"] = json!(true);
                    data["files"] = json!(files.iter().take(50).collect::<Vec<_>>());
                    if let Some(paths) = data.get_mut("paths").and_then(Value::as_array_mut) {
                        let truncated = paths.len() > 50;
                        paths.truncate(50);
                        data["truncatedPaths"] = json!(truncated);
                    }
                    data["filesTotal"] = json!(files.len());
                    data["filesTruncated"] = json!(files.len() > 50);
                    data["output"] = json!({"outputId":paged["outputId"],"offset":0,"nextAction":"control_output","format":"JSON with complete diff and file statistics"});
                }
                data
            }
        }
        _ => return Err("未知项目查询".into()),
    };
    if action == "read" && args["revision"].is_null() {
        data["metadata"] = metadata(&Path::new(root).join(file));
    }
    if matches!(action, "read" | "tree") && Path::new(&requested_path).is_absolute() {
        data["path"] = json!(requested_path);
    }
    if include_source {
        let paged = !data["nextLine"].is_null() || !data["nextOffset"].is_null();
        let snippets_partial = data["results"]
            .as_array()
            .is_some_and(|r| r.iter().any(|r| r["matchesComplete"] == false));
        data["coverage"] = json!({"state":if paged || snippets_partial || !skipped.is_empty() || data["changesTruncated"]==true || data["truncatedPaths"]==true || data["truncated"]==true || data["state"]=="restricted" {"partial"}else{"complete"},"paged":paged,"snippetsComplete":!snippets_partial,"skippedByReason":skipped});
        source["consistency"] = json!("best-effort");
        source["statusHashScope"] = json!("git-status-text-not-workspace-content");
        source["observationStartedAt"] = json!(started);
        source["observationEndedAt"] = json!(now());
        source["view"] = json!(if review { "review" } else { "raw" });
        source["coverage"] = json!({"state":if source["changesTruncated"]==true || !source_skipped.is_empty(){"partial"}else{"complete"},"skippedByReason":source_skipped});
    }
    if args["expectedHash"].is_string() {
        let actual = if action == "read" {
            &data["sha256"]
        } else {
            &data["listingHash"]
        };
        if actual != &args["expectedHash"] {
            return Err("CONTENT_CHANGED_RESTART_PAGINATION".into());
        }
    }
    let mut result = json!({"data":data});
    if include_source {
        result["source"] = source;
    }
    crate::images::attach(&mut result, image_blocks);
    Ok(result)
}

pub async fn native_id(c: &Control, cwd: &str) -> Result<Option<String>> {
    let target = Path::new(cwd).canonicalize().map_err(|e| e.to_string())?;
    let mut matches = BTreeSet::new();
    for project in list(c).await? {
        for root in project["roots"].as_array().into_iter().flatten() {
            if Path::new(string(root, "path")).canonicalize().ok().as_ref() == Some(&target) {
                matches.insert(string(&project, "id").to_owned());
            }
        }
    }
    Ok(if matches.len() == 1 {
        matches.into_iter().next()
    } else {
        None
    })
}

pub(crate) fn metadata(path: &Path) -> Value {
    match std::fs::symlink_metadata(path) {
        Ok(m) => {
            json!({"type":if m.is_symlink(){"symlink"}else if m.is_dir(){"directory"}else if m.is_file(){"file"}else{"other"},"size":m.len(),"readonly":m.permissions().readonly(),"modifiedAt":m.modified().ok().map(|t| chrono::DateTime::<chrono::Utc>::from(t).to_rfc3339()),"createdAt":m.created().ok().map(|t| chrono::DateTime::<chrono::Utc>::from(t).to_rfc3339())})
        }
        Err(e) => json!({"error":e.to_string()}),
    }
}

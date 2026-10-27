//! Classify transcript user-role content before cleaning loses harness provenance.
use super::*;

/// Metadata identifies injected records; leading harness reminders are not user text.
pub(crate) fn transcript_user_text(record: &Value, text: &str) -> String {
    let sources = [record, &record["message"], &record["payload"]];
    if sources.iter().any(|source| {
        [
            "isMeta",
            "isCompactSummary",
            "isSynthetic",
            "isVisibleInTranscriptOnly",
        ]
        .iter()
        .any(|key| source[*key] == true)
    }) {
        return String::new();
    }
    let kinds: Vec<_> = sources
        .iter()
        .flat_map(|source| {
            [
                source["origin"]["kind"].as_str(),
                source["source"]["kind"].as_str(),
                source["source"].as_str(),
                source["promptSource"].as_str(),
                source["turnOrigin"].as_str(),
            ]
            .into_iter()
            .flatten()
        })
        .collect();
    if kinds.iter().any(|kind| {
        matches!(
            *kind,
            "system"
                | "harness"
                | "task-notification"
                | "task_notification"
                | "tool"
                | "compaction"
                | "compact-summary"
                | "hook"
                | "hook-output"
                | "local-command"
                | "subagent-notification"
                | "subagent_notification"
        )
    }) {
        return String::new();
    }
    // Claude also prefixes genuine human turns with harness reminders, including
    // fork notices. Strip those blocks even when the enclosing turn is human.
    static REMINDERS: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let reminders = REMINDERS.get_or_init(|| {
        regex::Regex::new(
            r"(?is)^(?:\s*<system[-_]reminder(?:\s[^>]*)?>.*?(?:</system[-_]reminder\s*>|\z)\s*)+",
        )
        .unwrap()
    });
    let text = reminders.replace(text, "");
    let text = text.as_ref();
    if kinds
        .iter()
        .any(|kind| matches!(*kind, "human" | "user" | "user-input" | "user_input"))
    {
        return text.to_owned();
    }
    if harness_wrapper(text) {
        return String::new();
    }
    let cleaned = transcript_text(text);
    if harness_wrapper(&cleaned) {
        String::new()
    } else {
        cleaned
    }
}

fn harness_wrapper(text: &str) -> bool {
    let text = text.trim_start().to_ascii_lowercase();
    let Some(rest) = text.strip_prefix('<') else {
        return false;
    };
    let tag = rest
        .split(|c: char| c.is_whitespace() || c == '>' || c == '/')
        .next()
        .unwrap_or("");
    tag.starts_with("local-command-") || matches!(tag,
        "task-notification" | "command-name" | "command-message" | "command-args" |
        "bash-input" | "bash-stdout" | "bash-stderr" | "subagent_notification" |
        "subagent-notification" | "teammate-message" | "hook-output" |
        "user-prompt-submit-hook" | "ide_opened_file" | "ide_selection" | "turn_aborted")
        // Older projections can have discarded the enclosing task-notification tag.
        || tag == "task-id" && (text.contains("<tool-use-id>") || text.contains("<output-file>"))
}

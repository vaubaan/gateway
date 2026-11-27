//! Updates of the app (ADR desktop-app-updated-by-the-tauri-updater-from-the-github-release).
//!
//! Once the gateway answers, then every six hours, the shell reads the update manifest
//! (`plugins.updater.endpoints` in tauri.conf.json). A newer version is offered in a native
//! dialog with its notes, marked when it fixes a security issue; nothing is downloaded
//! unless the person accepts. Then: download (its signature checked against the updater
//! key built into the app), stop the gateway, replace the app, relaunch. A replacement that
//! fails starts the gateway of the running version again.
//!
//! A build without the updater's public key (a developer's, an unsigned run) never checks.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::thread;
use std::time::Duration;

use tauri::{AppHandle, Url, WebviewWindow};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::{Update, UpdaterExt};

const EVERY: Duration = Duration::from_secs(6 * 60 * 60);

/// What the update needs from the shell: stop the gateway, start it again.
pub struct Hooks {
    pub stop: Box<dyn Fn() + Send>,
    pub start: Box<dyn Fn() -> Result<(), String> + Send>,
    /// The shell's log, where the updater writes what it did (`updater: …` lines).
    pub log: PathBuf,
}

/// Whether this build carries the updater's public key (the release workflow sets it).
pub fn enabled(app: &AppHandle) -> bool {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|updater| updater.get("pubkey"))
        .and_then(|key| key.as_str())
        .is_some_and(|key| !key.trim().is_empty())
}

/// Checks now, then every six hours, on a thread of its own; never returns.
pub fn watch(app: AppHandle, window: WebviewWindow, hooks: Hooks) {
    thread::spawn(move || {
        // A version the person declined is not offered again until the app restarts.
        let mut declined: Option<String> = None;
        loop {
            match check(&app) {
                Ok(Some(update)) if declined.as_deref() != Some(update.version.as_str()) => {
                    if offer(&app, &update) {
                        install(&app, &window, &update, &hooks);
                    } else {
                        note(&hooks, &format!("{} declined", update.version));
                        declined = Some(update.version.clone());
                    }
                }
                Ok(_) => {}
                // Offline, or the manifest not attached yet: the next check tries again.
                Err(problem) => note(&hooks, &format!("check failed: {problem}")),
            }
            thread::sleep(EVERY);
        }
    });
}

fn check(app: &AppHandle) -> Result<Option<Update>, String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    tauri::async_runtime::block_on(updater.check()).map_err(|e| e.to_string())
}

/// The dialog: the version, its notes, what installing does. True when the person accepts.
fn offer(app: &AppHandle, update: &Update) -> bool {
    let security = update.raw_json.get("security").and_then(|s| s.as_bool()) == Some(true);
    let mut message = String::new();
    if security {
        message.push_str("This release fixes a security issue: install it soon.\n\n");
    }
    message.push_str(&format!(
        "Vaubaan {} is out; this Mac runs {}.\n\n",
        update.version, update.current_version
    ));
    if let Some(notes) = update.body.as_deref().filter(|n| !n.trim().is_empty()) {
        message.push_str(notes.trim());
        message.push_str("\n\n");
    }
    message.push_str(
        "Installing stops Vaubaan for a moment, replaces the app and opens it again. \
         Your data, your encryption key and your accounts stay as they are.",
    );
    app.dialog()
        .message(message)
        .title(if security { "Security update for Vaubaan" } else { "Vaubaan update" })
        .kind(if security { MessageDialogKind::Warning } else { MessageDialogKind::Info })
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Install and relaunch".into(),
            "Later".into(),
        ))
        .blocking_show()
}

/// Download, stop, replace, relaunch; on a failure the running version goes on.
fn install(app: &AppHandle, window: &WebviewWindow, update: &Update, hooks: &Hooks) {
    note(hooks, &format!("downloading {}", update.version));
    // `download` checks the archive's signature before handing it over.
    let bytes = match tauri::async_runtime::block_on(update.download(|_, _| {}, || {})) {
        Ok(bytes) => bytes,
        Err(e) => {
            fail(app, hooks, &format!("Vaubaan {} could not be downloaded: {e}", update.version));
            return;
        }
    };

    show_installing(window, &update.version);
    (hooks.stop)();
    match update.install(&bytes) {
        Ok(()) => {
            note(hooks, &format!("installed {}, relaunching", update.version));
            app.restart();
        }
        Err(e) => {
            note(hooks, &format!("install failed: {e}; starting the running version again"));
            let restarted = (hooks.start)();
            let mut message = format!("Vaubaan {} could not be installed: {e}.", update.version);
            if let Err(problem) = restarted {
                message.push_str(&format!("\n\nThe running version did not start again: {problem}"));
            }
            fail(app, hooks, &message);
        }
    }
}

fn fail(app: &AppHandle, hooks: &Hooks, message: &str) {
    note(hooks, message);
    app.dialog()
        .message(format!("{message}\n\nThe version you run stays in place."))
        .title("Vaubaan update")
        .kind(MessageDialogKind::Error)
        .blocking_show();
}

/// The bundled start page says the app is being replaced (`start.js` reads the fragment).
fn show_installing(window: &WebviewWindow, version: &str) {
    let page = if cfg!(windows) { "http://tauri.localhost/index.html" } else { "tauri://localhost/index.html" };
    if let Ok(mut url) = Url::parse(page) {
        url.set_fragment(Some(&format!("updating={version}")));
        let _ = window.navigate(url);
    }
}

fn note(hooks: &Hooks, line: &str) {
    if let Ok(mut log) = OpenOptions::new().create(true).append(true).open(&hooks.log) {
        let _ = writeln!(log, "updater: {line}");
    }
}

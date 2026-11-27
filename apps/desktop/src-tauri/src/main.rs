//! Vaubaan on your computer (ADR desktop-app-tauri-shell-over-the-node-standalone-server).
//!
//! The shell does five things and nothing else:
//! 1. reads the master key from the system's credential store, or makes one on the
//!    very first start (never over a store that holds data);
//! 2. starts the bundled Node binary on the gateway's standalone server, in local mode,
//!    listening on 127.0.0.1 only, the key written to its standard input and closed;
//! 3. waits for `/healthz`, then shows the gateway in the window — the setup link the
//!    gateway prints while its setup is open, else the home page;
//! 4. sends every address that is not the gateway's to the default browser (a
//!    service's sign-in page, a link to the docs);
//! 5. stops the server when the app quits;
//! 6. offers a new release once the gateway answers, and installs it only when the
//!    person accepts (`update.rs`).
//!
//! The gateway is the same build as the image: no code path of its own here.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

mod update;

use base64::Engine;
use tauri::webview::DownloadEvent;
use tauri::{Manager, RunEvent, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// The port the gateway answers on. Fixed: it is in every agent's configuration and
/// in the OAuth clients the gateway registers at services.
const PORT: u16 = 3100;
const KEYCHAIN_SERVICE: &str = "com.vaubaan.desktop";
const KEYCHAIN_ACCOUNT: &str = "master-key";
const STORE_FILE: &str = "gateway.db";
const LOG_FILE: &str = "gateway.log";
const SETUP_LINK_MARK: &str = "/admin/bootstrap#token=";
const START_TIMEOUT: Duration = Duration::from_secs(60);
const STOP_TIMEOUT: Duration = Duration::from_secs(10);

struct Gateway {
    child: Mutex<Option<Child>>,
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Vaubaan")
                .inner_size(1280.0, 820.0)
                .min_inner_size(900.0, 600.0)
                // The system webview saves nothing by itself: a download (the encryption key)
                // goes to ~/Downloads under a name not taken, then shows in the Finder.
                .on_download({
                    let saved: Arc<Mutex<Option<PathBuf>>> = Arc::new(Mutex::new(None));
                    move |webview, event| {
                        match event {
                            DownloadEvent::Requested { destination, .. } => {
                                let dir = webview
                                    .app_handle()
                                    .path()
                                    .download_dir()
                                    .unwrap_or_else(|_| std::env::temp_dir());
                                let name = destination
                                    .file_name()
                                    .map(|n| n.to_string_lossy().into_owned())
                                    .filter(|n| !n.is_empty())
                                    .unwrap_or_else(|| "vaubaan-download".to_string());
                                let path = free_path(&dir, &name);
                                *destination = path.clone();
                                if let Ok(mut slot) = saved.lock() {
                                    *slot = Some(path);
                                }
                            }
                            DownloadEvent::Finished { success, .. } => {
                                let path = saved.lock().ok().and_then(|mut slot| slot.take());
                                if let (true, Some(path)) = (success, path) {
                                    reveal(&path);
                                }
                            }
                            _ => {}
                        }
                        true
                    }
                })
                .on_navigation(|url| {
                    if is_inside(url) {
                        return true;
                    }
                    open_in_browser(url.as_str());
                    false
                })
                .build()?;
            let data_dir = app.path().app_data_dir()?;
            let resource_dir = app.path().resource_dir()?;
            let resources = resource_dir.join("gateway");
            // A resource, not an executable of the bundle: in Contents/MacOS macOS gives the
            // server its own icon in the Dock.
            let node = resource_dir.join("runtime").join("node");
            let gateway = Arc::new(Gateway { child: Mutex::new(None) });
            app.manage(gateway.clone());
            let handle = app.handle().clone();
            thread::spawn(move || {
                if let Err(problem) = start(&gateway, &window, &data_dir, &resources, &node) {
                    show_problem(&window, &problem);
                    return;
                }
                if update::enabled(&handle) {
                    let hooks = update::Hooks {
                        stop: Box::new({
                            let gateway = gateway.clone();
                            move || stop(&gateway)
                        }),
                        start: Box::new({
                            let (gateway, window) = (gateway.clone(), window.clone());
                            let (data_dir, resources, node) = (data_dir.clone(), resources.clone(), node.clone());
                            move || start(&gateway, &window, &data_dir, &resources, &node)
                        }),
                        log: data_dir.join(LOG_FILE),
                    };
                    update::watch(handle, window, hooks);
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("the desktop app could not be built");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            if let Some(gateway) = handle.try_state::<Arc<Gateway>>() {
                stop(&gateway);
            }
        }
    });
}

fn origin() -> String {
    format!("http://localhost:{PORT}")
}

/// Starts the gateway and shows it; every failure is a sentence for the window.
fn start(
    gateway: &Gateway,
    window: &WebviewWindow,
    data_dir: &Path,
    resources: &Path,
    node: &Path,
) -> Result<(), String> {
    fs::create_dir_all(data_dir).map_err(|e| format!("Cannot create {}: {e}", data_dir.display()))?;
    let store = data_dir.join(STORE_FILE);
    let key = master_key(&store)?;
    if TcpStream::connect_timeout(&SocketAddr::from(([127, 0, 0, 1], PORT)), Duration::from_millis(300)).is_ok() {
        return Err(format!(
            "Port {PORT} is already in use on this computer. Vaubaan answers on it: stop what uses it (another Vaubaan, a docker run), then open Vaubaan again."
        ));
    }

    let log_path = data_dir.join(LOG_FILE);
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| format!("Cannot write {}: {e}", log_path.display()))?;
    if !node.exists() {
        return Err(format!("The bundled Node is missing ({})", node.display()));
    }
    let server = resources.join("apps").join("gateway").join("server.js");
    let mut child = Command::new(node)
        .arg(&server)
        .current_dir(resources)
        .env_clear()
        .env("NODE_ENV", "production")
        .env("PORT", PORT.to_string())
        // Only this computer: the server listens on loopback, unlike in a container.
        .env("HOSTNAME", "127.0.0.1")
        .env("VAUBAAN_LOCAL", "true")
        .env("VAUBAAN_PUBLIC_URL", origin())
        .env("VAUBAAN_STORE_PATH", &store)
        // Read once at the start, then standard input is closed.
        .env("VAUBAAN_MASTER_KEY_FILE", "/dev/stdin")
        .env("HOME", data_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::from(log.try_clone().map_err(|e| e.to_string())?))
        .spawn()
        .map_err(|e| format!("Cannot start the gateway ({}): {e}", node.display()))?;

    {
        let mut stdin = child.stdin.take().ok_or("the gateway has no standard input")?;
        stdin
            .write_all(format!("{key}\n").as_bytes())
            .map_err(|e| format!("Cannot hand the key to the gateway: {e}"))?;
        // Dropped here: the gateway reads to the end of its input.
    }
    let stdout = child.stdout.take().ok_or("the gateway has no standard output")?;
    *gateway.child.lock().map_err(|_| "the gateway's handle is poisoned")? = Some(child);

    let setup_link: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let seen = setup_link.clone();
    thread::spawn(move || copy_output(stdout, log, &seen));

    wait_healthy(gateway, &log_path)?;
    // The link is printed right before the server reports itself started.
    thread::sleep(Duration::from_millis(200));
    let link = setup_link.lock().ok().and_then(|l| l.clone());
    let target = link.unwrap_or_else(|| format!("{}/", origin()));
    let url = Url::parse(&target).map_err(|e| e.to_string())?;
    window.navigate(url).map_err(|e| e.to_string())
}

/// The key from the credential store, or a new one when there is neither a key nor a
/// store; a store without its key is the one case the shell refuses.
fn master_key(store: &Path) -> Result<String, String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(key) => Ok(key),
        Err(keyring::Error::NoEntry) => {
            if fs::metadata(store).map(|m| m.len() > 0).unwrap_or(false) {
                return Err(format!(
                    "Your encryption key is not in the Keychain, and {} holds data sealed with it. Nothing was generated over it. Put the key back (Keychain Access, service {KEYCHAIN_SERVICE}), or move the data aside to start anew.",
                    store.display()
                ));
            }
            let mut bytes = [0u8; 32];
            getrandom::getrandom(&mut bytes).map_err(|e| e.to_string())?;
            let key = base64::engine::general_purpose::STANDARD.encode(bytes);
            entry
                .set_password(&key)
                .map_err(|e| format!("Cannot keep the encryption key in the Keychain: {e}"))?;
            Ok(key)
        }
        Err(e) => Err(format!("Cannot read the encryption key from the Keychain: {e}")),
    }
}

/// Copies the gateway's output to the log, keeping the setup link it prints.
fn copy_output(stdout: impl Read, mut log: File, setup_link: &Mutex<Option<String>>) {
    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
        if let Some(at) = line.find("http://") {
            let candidate = line[at..].trim();
            if candidate.contains(SETUP_LINK_MARK) {
                if let Ok(mut slot) = setup_link.lock() {
                    *slot = Some(candidate.to_string());
                }
                // The token never reaches the log file.
                let _ = writeln!(log, "(the setup link was printed)");
                continue;
            }
        }
        let _ = writeln!(log, "{line}");
    }
}

fn wait_healthy(gateway: &Gateway, log_path: &Path) -> Result<(), String> {
    let deadline = Instant::now() + START_TIMEOUT;
    while Instant::now() < deadline {
        if let Ok(mut slot) = gateway.child.lock() {
            if let Some(child) = slot.as_mut() {
                if let Ok(Some(status)) = child.try_wait() {
                    return Err(format!(
                        "The gateway stopped ({status}). What it said is in {}.",
                        log_path.display()
                    ));
                }
            }
        }
        if healthz_ok() {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(250));
    }
    Err(format!(
        "The gateway did not answer within {} seconds. What it said is in {}.",
        START_TIMEOUT.as_secs(),
        log_path.display()
    ))
}

/// `GET /healthz` over a bare socket: no HTTP client for one status line.
fn healthz_ok() -> bool {
    let Ok(mut stream) =
        TcpStream::connect_timeout(&SocketAddr::from(([127, 0, 0, 1], PORT)), Duration::from_millis(500))
    else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let request = format!("GET /healthz HTTP/1.1\r\nHost: localhost:{PORT}\r\nConnection: close\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut first = String::new();
    BufReader::new(stream).read_line(&mut first).is_ok() && first.contains(" 200 ")
}

/// Stops the gateway: SIGTERM, then a kill after `STOP_TIMEOUT`.
fn stop(gateway: &Gateway) {
    let Ok(mut slot) = gateway.child.lock() else { return };
    let Some(mut child) = slot.take() else { return };
    #[cfg(unix)]
    unsafe {
        libc::kill(child.id() as libc::pid_t, libc::SIGTERM);
    }
    let deadline = Instant::now() + STOP_TIMEOUT;
    while Instant::now() < deadline {
        if let Ok(Some(_)) = child.try_wait() {
            return;
        }
        thread::sleep(Duration::from_millis(100));
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// The bundled start page and the gateway stay in the window; any other address goes
/// to the default browser (a service's sign-in page, a link to the docs).
fn is_inside(url: &Url) -> bool {
    match url.scheme() {
        "tauri" => true,
        "http" | "https" => match url.host_str() {
            Some("tauri.localhost") => true,
            Some("localhost") => url.scheme() == "http" && url.port() == Some(PORT),
            _ => false,
        },
        _ => false,
    }
}

/// `name`, or `name (2)`, `name (3)`… in `dir`: a download never replaces a file.
fn free_path(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let (stem, ext) = match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => (stem.to_string(), format!(".{ext}")),
        _ => (name.to_string(), String::new()),
    };
    (2..1000)
        .map(|n| dir.join(format!("{stem} ({n}){ext}")))
        .find(|p| !p.exists())
        .unwrap_or(first)
}

/// Shows a saved file in the Finder (Explorer on Windows).
fn reveal(path: &Path) {
    #[cfg(target_os = "macos")]
    let _ = Command::new("open").arg("-R").arg(path).spawn();
    #[cfg(target_os = "windows")]
    let _ = Command::new("explorer").arg(format!("/select,{}", path.display())).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let _ = path;
}

fn open_in_browser(url: &str) {
    #[cfg(target_os = "macos")]
    let _ = Command::new("open").arg(url).spawn();
    #[cfg(target_os = "windows")]
    let _ = Command::new("cmd").args(["/C", "start", "", url]).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let _ = Command::new("xdg-open").arg(url).spawn();
}

/// The bundled start page shows the sentence (`index.html` reads the fragment).
fn show_problem(window: &WebviewWindow, problem: &str) {
    let encoded: String = problem
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect();
    if let Ok(url) = window.url() {
        let mut url = url;
        url.set_fragment(Some(&format!("problem={encoded}")));
        let _ = window.navigate(url);
    }
}

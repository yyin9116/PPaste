use arboard::{Clipboard, ImageData};
use chrono::Utc;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use rusqlite::{Connection, params};
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::borrow::Cow;
use std::collections::HashMap;
#[cfg(any(target_os = "macos", target_os = "windows"))]
use std::process::Command;
use std::str::FromStr;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle,
    Manager,
};
use tauri::Emitter;
use uuid::Uuid;

// --- 数据结构 ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Clip {
    pub id: String,
    pub clip_type: String, // text, image, link, file
    pub category: Option<String>,
    pub content: String,
    pub preview: Option<String>,
    pub timestamp: i64,
    pub source: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClipEvent {
    pub clip: Clip,
    pub action: String,
    pub auto_pin: bool,
    pub clear_auto_pin: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub theme: String,
    pub language: String,
    pub window_opacity: f64,
    pub launch_at_login: bool,
    pub play_sounds: bool,
    pub show_shortcut_hints: bool,
    pub history_retention_days: i32,
    pub max_clips: i32,
    pub ignore_password_managers: bool,
    pub plain_text_only: bool,
    pub storage_path: String,          // 自定义存储路径
    pub screenshot_shortcut: String,   // 截图快捷键
    pub toggle_window_shortcut: String, // 开关窗口快捷键
    pub quick_paste_shortcut: String,   // 快速粘贴最新记录
    pub clear_history_shortcut: String, // 清空历史快捷键
}

impl Default for Settings {
    fn default() -> Self {
        // 获取默认存储路径（应用数据目录）
        let default_storage = dirs::data_local_dir()
            .unwrap_or_else(|| std::env::current_dir().unwrap())
            .join("ppaste")
            .join("storage")
            .to_string_lossy()
            .to_string();
        
        Settings {
            theme: "system".to_string(),
            language: "zh".to_string(),
            window_opacity: 0.92,
            launch_at_login: true,
            play_sounds: false,
            show_shortcut_hints: true,
            history_retention_days: 30,
            max_clips: 500,
            ignore_password_managers: true,
            plain_text_only: false,
            storage_path: default_storage,
            screenshot_shortcut: "Alt+S".to_string(),      // Windows/Linux: Alt+S, macOS: Option+S
            toggle_window_shortcut: "Alt+X".to_string(), // Windows/Linux: Alt+Space, macOS: Option+Space
            quick_paste_shortcut: "CmdOrCtrl+Shift+V".to_string(),
            clear_history_shortcut: "CmdOrCtrl+Shift+Backspace".to_string(),
        }
    }
}

// --- 应用状态 ---

pub struct AppState {
    pub db: Arc<Mutex<Connection>>,
    pub settings: Arc<Mutex<Settings>>,
    pub is_paused: Arc<Mutex<bool>>,
    pub last_clip: Arc<Mutex<Option<String>>>,
    pub suppressed_text: Arc<Mutex<Option<String>>>,
    pub last_image_hash: Arc<Mutex<Option<u64>>>, // 图片去重
    pub active_screenshot_shortcut: Arc<Mutex<String>>,
    pub active_toggle_shortcut: Arc<Mutex<String>>,
    pub active_quick_paste_shortcut: Arc<Mutex<String>>,
    pub active_clear_history_shortcut: Arc<Mutex<String>>,
    pub awaiting_focus_after_show: Arc<Mutex<bool>>,
    pub last_frontmost_app: Arc<Mutex<Option<String>>>,
    pub duplicate_hit_counts: Arc<Mutex<HashMap<u64, u32>>>,
    pub auto_pinned_signature: Arc<Mutex<Option<u64>>>,
}

// --- 数据库初始化 ---

fn app_data_dir() -> std::path::PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| std::env::current_dir().unwrap())
        .join("ppaste")
}

fn legacy_app_data_dir() -> std::path::PathBuf {
    let legacy_name = ["clip", "space"].join("");
    dirs::data_local_dir()
        .unwrap_or_else(|| std::env::current_dir().unwrap())
        .join(legacy_name)
}

fn migrate_legacy_app_data() -> Result<(), String> {
    let new_dir = app_data_dir();
    let legacy_dir = legacy_app_data_dir();

    if new_dir.exists() || !legacy_dir.exists() {
        return Ok(());
    }

    std::fs::rename(&legacy_dir, &new_dir)
        .or_else(|_| {
            std::fs::create_dir_all(&new_dir)?;
            for entry in std::fs::read_dir(&legacy_dir)? {
                let entry = entry?;
                let target = new_dir.join(entry.file_name());
                std::fs::rename(entry.path(), target)?;
            }
            std::fs::remove_dir_all(&legacy_dir)
        })
        .map_err(|e| format!("Failed to migrate legacy app data: {}", e))
}

fn init_db(db_path: &str) -> Result<Connection, rusqlite::Error> {
    let conn = Connection::open(db_path)?;
    
    conn.execute(
        "CREATE TABLE IF NOT EXISTS clips (
            id TEXT PRIMARY KEY,
            clip_type TEXT NOT NULL,
            category TEXT,
            content TEXT NOT NULL,
            preview TEXT,
            timestamp INTEGER NOT NULL,
            source TEXT,
            file_path TEXT  -- 图片/文件的实际存储路径
        )",
        [],
    )?;
    
    conn.execute(
        "CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )",
        [],
    )?;

    migrate_db(&conn)?;
    
    Ok(conn)
}

fn migrate_db(conn: &Connection) -> Result<(), rusqlite::Error> {
    let mut stmt = conn.prepare("PRAGMA table_info(clips)")?;
    let columns = stmt.query_map([], |row| row.get::<_, String>(1))?;

    let mut has_file_path = false;
    for column in columns {
        if column? == "file_path" {
            has_file_path = true;
            break;
        }
    }

    if !has_file_path {
        conn.execute("ALTER TABLE clips ADD COLUMN file_path TEXT", [])?;
    }

    Ok(())
}

fn persist_settings(conn: &Connection, settings: &Settings) -> Result<(), String> {
    let serialized = serde_json::to_string(settings).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params!["app_settings", serialized],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn load_settings(conn: &Connection) -> Settings {
    let stored = conn.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        params!["app_settings"],
        |row| row.get::<_, String>(0),
    );

    match stored {
        Ok(value) => serde_json::from_str::<Settings>(&value).unwrap_or_else(|_| Settings::default()),
        Err(_) => {
            let defaults = Settings::default();
            let _ = persist_settings(conn, &defaults);
            defaults
        }
    }
}

// --- 存储路径管理 ---

fn ensure_storage_dir(storage_path: &str) -> Result<String, String> {
    let path = std::path::Path::new(storage_path);
    std::fs::create_dir_all(path).map_err(|e| format!("Failed to create storage dir: {}", e))?;
    Ok(storage_path.to_string())
}

fn save_image_to_storage(storage_path: &str, image_data: &[u8], clip_id: &str) -> Result<String, String> {
    ensure_storage_dir(storage_path)?;
    let file_path = std::path::Path::new(storage_path).join(format!("{}.png", clip_id));
    std::fs::write(&file_path, image_data).map_err(|e| format!("Failed to save image: {}", e))?;
    Ok(file_path.to_string_lossy().to_string())
}

fn decode_image_clip(content: &str) -> Result<(Vec<u8>, usize, usize), String> {
    let png_bytes = BASE64.decode(content).map_err(|e| format!("Failed to decode image data: {}", e))?;
    let image = image::load_from_memory(&png_bytes)
        .map_err(|e| format!("Failed to parse image data: {}", e))?
        .to_rgba8();
    let (width, height) = image.dimensions();
    Ok((image.into_raw(), width as usize, height as usize))
}

// --- 剪贴板监控 ---

fn start_clipboard_monitor(app: tauri::AppHandle, state: Arc<AppState>) {
    thread::spawn(move || {
        let mut clipboard = match Clipboard::new() {
            Ok(cb) => cb,
            Err(e) => {
                eprintln!("Failed to initialize clipboard: {}", e);
                return;
            }
        };

        if let Ok(text) = clipboard.get_text() {
            let mut last_clip = state.last_clip.lock().unwrap();
            *last_clip = Some(text);
        }

        if let Ok(image_data) = clipboard.get_image() {
            use std::collections::hash_map::DefaultHasher;
            use std::hash::{Hash, Hasher};

            let mut hasher = DefaultHasher::new();
            image_data.bytes.hash(&mut hasher);
            let image_hash = hasher.finish();

            let mut last_hash = state.last_image_hash.lock().unwrap();
            *last_hash = Some(image_hash);
        }
        
        loop {
            let is_paused = *state.is_paused.lock().unwrap();
            
            if !is_paused {
                // 检查文本剪贴板
                match clipboard.get_text() {
                    Ok(text) => {
                        let mut suppressed_text = state.suppressed_text.lock().unwrap();
                        if suppressed_text.as_ref() == Some(&text) {
                            *suppressed_text = None;
                            drop(suppressed_text);

                            let mut last_clip = state.last_clip.lock().unwrap();
                            *last_clip = Some(text.clone());
                        } else {
                            drop(suppressed_text);

                            let last_clip = state.last_clip.lock().unwrap();
                            if let Some(ref last) = *last_clip {
                                if last != &text {
                                    drop(last_clip);
                                    let source = capture_frontmost_app_name().unwrap_or_else(|| "Unknown".to_string());
                                    let ignore_source = {
                                        let settings = state.settings.lock().unwrap();
                                        settings.ignore_password_managers && is_password_manager_source(&source)
                                    };
                                    if ignore_source {
                                        let mut last_clip = state.last_clip.lock().unwrap();
                                        *last_clip = Some(text.clone());
                                    } else {
                                        save_clip(&state, Some(&app), text, "text".to_string(), source);
                                    }
                                }
                            } else {
                                drop(last_clip);
                                let source = capture_frontmost_app_name().unwrap_or_else(|| "Unknown".to_string());
                                let ignore_source = {
                                    let settings = state.settings.lock().unwrap();
                                    settings.ignore_password_managers && is_password_manager_source(&source)
                                };
                                if ignore_source {
                                    let mut last_clip = state.last_clip.lock().unwrap();
                                    *last_clip = Some(text.clone());
                                } else {
                                    save_clip(&state, Some(&app), text, "text".to_string(), source);
                                }
                            }
                        }
                    }
                    Err(_) => {}
                }
                
                // 检查图片剪贴板
                let plain_text_only = {
                    let settings = state.settings.lock().unwrap();
                    settings.plain_text_only
                };
                if plain_text_only {
                    thread::sleep(Duration::from_millis(500));
                    continue;
                }

                match clipboard.get_image() {
                    Ok(image_data) => {
                        use std::collections::hash_map::DefaultHasher;
                        use std::hash::{Hash, Hasher};
                        
                        // 计算图片哈希用于去重
                        let mut hasher = DefaultHasher::new();
                        image_data.bytes.hash(&mut hasher);
                        let image_hash = hasher.finish();
                        
                        let last_hash = state.last_image_hash.lock().unwrap();
                        if let Some(ref last) = *last_hash {
                            if last != &image_hash {
                                drop(last_hash);
                                // 保存为 PNG
                                use image::{ImageBuffer, Rgba};
                                let bytes_vec = image_data.bytes.to_vec();
                                let img = ImageBuffer::<Rgba<u8>, _>::from_raw(
                                    image_data.width as u32,
                                    image_data.height as u32,
                                    bytes_vec
                                ).unwrap();
                                let mut png_bytes = Vec::new();
                                let mut cursor = std::io::Cursor::new(&mut png_bytes);
                                img.write_to(&mut cursor, image::ImageFormat::Png).unwrap();
                                
                                // Base64 编码
                                let base64_data = BASE64.encode(&png_bytes);
                                let source = capture_frontmost_app_name().unwrap_or_else(|| "Clipboard".to_string());
                                let ignore_source = {
                                    let settings = state.settings.lock().unwrap();
                                    settings.ignore_password_managers && is_password_manager_source(&source)
                                };
                                if !ignore_source {
                                    save_clip(&state, Some(&app), base64_data, "image".to_string(), source);
                                }
                                
                                // 更新哈希
                                let mut last_hash_mut = state.last_image_hash.lock().unwrap();
                                *last_hash_mut = Some(image_hash);
                            }
                        } else {
                            drop(last_hash);
                            // 保存第一张图片
                            use image::{ImageBuffer, Rgba};
                            let bytes_vec = image_data.bytes.to_vec();
                            let img = ImageBuffer::<Rgba<u8>, _>::from_raw(
                                image_data.width as u32,
                                image_data.height as u32,
                                bytes_vec
                            ).unwrap();
                            let mut png_bytes = Vec::new();
                            let mut cursor = std::io::Cursor::new(&mut png_bytes);
                            img.write_to(&mut cursor, image::ImageFormat::Png).unwrap();
                            
                            let base64_data = BASE64.encode(&png_bytes);
                            let source = capture_frontmost_app_name().unwrap_or_else(|| "Clipboard".to_string());
                            let ignore_source = {
                                let settings = state.settings.lock().unwrap();
                                settings.ignore_password_managers && is_password_manager_source(&source)
                            };
                            if !ignore_source {
                                save_clip(&state, Some(&app), base64_data, "image".to_string(), source);
                            }
                            
                            let mut last_hash_mut = state.last_image_hash.lock().unwrap();
                            *last_hash_mut = Some(image_hash);
                        }
                    }
                    Err(_) => {}
                }
            }
            
            thread::sleep(Duration::from_millis(500));
        }
    });
}

fn save_clip(state: &AppState, app: Option<&tauri::AppHandle>, content: String, clip_type: String, source: String) {
    save_clip_with_path(state, app, content, clip_type, source, None);
}

fn clip_signature(content: &str, clip_type: &str) -> u64 {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let mut hasher = DefaultHasher::new();
    clip_type.hash(&mut hasher);
    content.hash(&mut hasher);
    hasher.finish()
}

fn save_clip_with_path(
    state: &AppState,
    app: Option<&tauri::AppHandle>,
    content: String,
    clip_type: String,
    source: String,
    file_path: Option<String>,
) {
    let mut last_clip = state.last_clip.lock().unwrap();
    *last_clip = Some(content.clone());
    drop(last_clip);

    let timestamp = Utc::now().timestamp_millis();
    let signature = clip_signature(&content, &clip_type);
    let mut clear_auto_pin = false;
    {
        let mut auto_pinned_signature = state.auto_pinned_signature.lock().unwrap();
        if auto_pinned_signature.as_ref().is_some_and(|value| *value != signature) {
            *auto_pinned_signature = None;
            clear_auto_pin = true;
        }
    }

    let conn = state.db.lock().unwrap();
    let existing_clip = conn
        .query_row(
            "SELECT id, clip_type, category, content, preview, timestamp, source
             FROM clips
             WHERE clip_type = ?1 AND content = ?2
             ORDER BY timestamp DESC
             LIMIT 1",
            params![clip_type, content],
            |row| {
                Ok(Clip {
                    id: row.get(0)?,
                    clip_type: row.get(1)?,
                    category: row.get(2)?,
                    content: row.get(3)?,
                    preview: row.get(4)?,
                    timestamp: row.get(5)?,
                    source: row.get(6)?,
                })
            },
        )
        .optional();

    let event = match existing_clip {
        Ok(Some(mut clip)) => {
            clip.timestamp = timestamp;
            clip.category = detect_category(&content);
            clip.source = Some(source.clone());

            if let Err(e) = conn.execute(
                "UPDATE clips
                 SET category = ?1, timestamp = ?2, source = ?3, file_path = COALESCE(?4, file_path)
                 WHERE id = ?5",
                params![clip.category, clip.timestamp, clip.source, file_path, clip.id],
            ) {
                eprintln!("Failed to promote existing clip: {}", e);
                return;
            }

            let duplicate_hits = {
                let mut duplicate_hit_counts = state.duplicate_hit_counts.lock().unwrap();
                let entry = duplicate_hit_counts.entry(signature).or_insert(0);
                *entry += 1;
                *entry
            };
            let auto_pin = duplicate_hits >= 2;

            if auto_pin {
                let mut auto_pinned_signature = state.auto_pinned_signature.lock().unwrap();
                *auto_pinned_signature = Some(signature);
            }

            ClipEvent {
                clip,
                action: "promoted".to_string(),
                auto_pin,
                clear_auto_pin,
            }
        }
        Ok(None) => {
            let clip = Clip {
                id: Uuid::new_v4().to_string(),
                clip_type,
                category: detect_category(&content),
                content,
                preview: None,
                timestamp,
                source: Some(source),
            };

            eprintln!("insert clip: type={} source={}", clip.clip_type, clip.source.clone().unwrap_or_default());
            if let Err(e) = conn.execute(
                "INSERT INTO clips (id, clip_type, category, content, preview, timestamp, source, file_path)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    clip.id,
                    clip.clip_type,
                    clip.category,
                    clip.content,
                    clip.preview,
                    clip.timestamp,
                    clip.source,
                    file_path
                ],
            ) {
                eprintln!("Failed to insert clip: {}", e);
                return;
            }

            ClipEvent {
                clip,
                action: "inserted".to_string(),
                auto_pin: false,
                clear_auto_pin,
            }
        }
        Err(e) => {
            eprintln!("Failed to query existing clip: {}", e);
            return;
        }
    };

    drop(conn);
    cleanup_history(state);

    if let Some(app) = app {
        let _ = app.emit("new-clip", event);
    }
}

fn detect_category(content: &str) -> Option<String> {
    let trimmed = content.trim();
    let lower = trimmed.to_lowercase();

    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        return Some("Links".to_string());
    }

    if matches!(trimmed.chars().next(), Some('{') | Some('[')) && serde_json::from_str::<Value>(trimmed).is_ok() {
        return Some("JSON".to_string());
    }

    if lower.contains("<!doctype html")
        || lower.contains("<html")
        || lower.contains("<body")
        || lower.contains("<div")
        || lower.contains("<span")
        || lower.contains("<p>")
    {
        return Some("HTML".to_string());
    }

    if trimmed.contains("```")
        || trimmed.lines().any(|line| {
            let line = line.trim_start();
            line.starts_with("# ")
                || line.starts_with("## ")
                || line.starts_with("- ")
                || line.starts_with("* ")
                || line.starts_with("> ")
                || line.starts_with("- [")
                || line.starts_with("* [")
        })
        || (trimmed.contains('[') && trimmed.contains("]("))
    {
        return Some("Markdown".to_string());
    }

    if trimmed.lines().count() > 1
        && trimmed.lines().all(|line| {
            let line = line.trim();
            line.is_empty() || (line.contains(':') && !line.contains('{') && !line.contains('}'))
        })
    {
        return Some("YAML".to_string());
    }

    if lower.contains("select ")
        || lower.contains("insert into ")
        || lower.contains("update ")
        || lower.contains("delete from ")
        || lower.contains("create table ")
    {
        return Some("SQL".to_string());
    }

    if trimmed.starts_with("#!/bin/")
        || trimmed.starts_with("$ ")
        || lower.contains(" && ")
        || lower.contains(" | ")
        || lower.contains("export ")
        || lower.contains("sudo ")
    {
        return Some("Shell".to_string());
    }

    if content.contains("fn ")
        || content.contains("function ")
        || content.contains("const ")
        || content.contains("let ")
        || content.contains("import ")
        || content.contains("return ")
        || content.contains("class ")
        || content.contains("=>")
    {
        return Some("Code".to_string());
    }

    if trimmed.len() < 100 && !trimmed.contains('\n') {
        return Some("Text".to_string());
    }

    None
}

fn is_password_manager_source(source: &str) -> bool {
    let lower = source.to_lowercase();
    [
        "1password",
        "bitwarden",
        "keychain",
        "keepass",
        "keepassxc",
        "dashlane",
        "lastpass",
        "enpass",
        "nordpass",
        "passwords",
    ]
    .iter()
    .any(|item| lower.contains(item))
}

fn cleanup_history(state: &AppState) {
    let settings = state.settings.lock().unwrap().clone();
    let conn = state.db.lock().unwrap();

    if settings.history_retention_days > 0 {
        let cutoff = Utc::now()
            .timestamp_millis()
            - (settings.history_retention_days as i64 * 24 * 60 * 60 * 1000);
        let _ = conn.execute("DELETE FROM clips WHERE timestamp < ?1", params![cutoff]);
    }

    if settings.max_clips > 0 {
        let _ = conn.execute(
            "DELETE FROM clips WHERE id NOT IN (
                SELECT id FROM clips ORDER BY timestamp DESC LIMIT ?1
            )",
            params![settings.max_clips],
        );
    }
}

fn normalize_shortcut(input: &str) -> String {
    input
        .trim()
        .replace("Option", "Alt")
        .replace("OPTION", "Alt")
        .replace("option", "Alt")
        .replace("CmdOrCtrl", "CmdOrCtrl")
        .replace("CommandOrControl", "CmdOrCtrl")
        .replace("CommandOrCtrl", "CmdOrCtrl")
        .replace("COMMANDORCONTROL", "CmdOrCtrl")
        .replace("commandorcontrol", "CmdOrCtrl")
        .replace("Command", "Meta")
        .replace("COMMAND", "Meta")
        .replace("command", "Meta")
        .replace("Meta", "CmdOrCtrl")
}

fn write_clip_to_system_clipboard(state: &AppState, content: &str, clip_type: &str) -> Result<(), String> {
    let mut clipboard = Clipboard::new().map_err(|e| e.to_string())?;

    if clip_type == "text" {
        clipboard.set_text(content).map_err(|e| e.to_string())?;
        let mut suppressed_text = state.suppressed_text.lock().unwrap();
        *suppressed_text = Some(content.to_string());
    } else if clip_type == "image" {
        let (rgba, width, height) = decode_image_clip(content)?;
        clipboard
            .set_image(ImageData {
                width,
                height,
                bytes: Cow::Owned(rgba.clone()),
            })
            .map_err(|e| e.to_string())?;

        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};

        let mut hasher = DefaultHasher::new();
        rgba.hash(&mut hasher);
        let image_hash = hasher.finish();
        let mut last_image_hash = state.last_image_hash.lock().unwrap();
        *last_image_hash = Some(image_hash);
    } else {
        clipboard.set_text(content).map_err(|e| e.to_string())?;
        let mut suppressed_text = state.suppressed_text.lock().unwrap();
        *suppressed_text = Some(content.to_string());
    }

    let mut last_clip = state.last_clip.lock().unwrap();
    *last_clip = Some(content.to_string());

    Ok(())
}

fn show_main_window(app: &AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    app.set_activation_policy(tauri::ActivationPolicy::Regular)
        .map_err(|e| e.to_string())?;

    if let Some(state) = app.try_state::<Arc<AppState>>() {
        let mut awaiting_focus_after_show = state.awaiting_focus_after_show.lock().unwrap();
        *awaiting_focus_after_show = true;
    }

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[cfg(target_os = "macos")]
fn remember_frontmost_app(app: &AppHandle) {
    if let Some(state) = app.try_state::<Arc<AppState>>() {
        if let Some(bundle_id) = capture_frontmost_app_bundle_id() {
            let mut last_frontmost_app = state.last_frontmost_app.lock().unwrap();
            *last_frontmost_app = Some(bundle_id);
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn remember_frontmost_app(_app: &AppHandle) {}

#[cfg(target_os = "macos")]
fn capture_frontmost_app_name() -> Option<String> {
    let output = Command::new("osascript")
        .args([
            "-e",
            r#"tell application "System Events" to get name of first application process whose frontmost is true"#,
        ])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let app_name = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if app_name.is_empty() || app_name == "PPaste" {
        None
    } else {
        Some(app_name)
    }
}

#[cfg(not(target_os = "macos"))]
fn capture_frontmost_app_name() -> Option<String> {
    None
}

#[cfg(target_os = "macos")]
fn capture_frontmost_app_bundle_id() -> Option<String> {
    let output = Command::new("osascript")
        .args([
            "-e",
            r#"tell application "System Events" to get bundle identifier of first application process whose frontmost is true"#,
        ])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let bundle_id = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if bundle_id.is_empty() || bundle_id == "com.yinyin.ppaste" {
        None
    } else {
        Some(bundle_id)
    }
}

#[cfg(not(target_os = "macos"))]
fn capture_frontmost_app_bundle_id() -> Option<String> {
    None
}

fn toggle_main_window(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().map_err(|e| e.to_string())? {
            window.hide().map_err(|e| e.to_string())?;
        } else {
            remember_frontmost_app(app);
            show_main_window(app)?;
        }
    }

    Ok(())
}

fn quick_paste_latest_clip(state: &Arc<AppState>) -> Result<(), String> {
    let target_bundle_id = capture_frontmost_app_bundle_id();

    let (content, clip_type): (String, String) = {
        let conn = state.db.lock().unwrap();
        conn.query_row(
            "SELECT content, clip_type FROM clips ORDER BY timestamp DESC LIMIT 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|e| format!("No clips available: {}", e))?
    };

    write_clip_to_system_clipboard(state.as_ref(), &content, &clip_type)?;

    if clip_type == "text" {
        thread::spawn(move || {
            if let Err(err) = paste_active_app(target_bundle_id) {
                eprintln!("Failed to quick paste latest clip: {}", err);
            }
        });
    }

    Ok(())
}

#[cfg(target_os = "macos")]
fn paste_active_app(target_bundle_id: Option<String>) -> Result<(), String> {
    let mut script_lines = Vec::new();
    if let Some(bundle_id) = target_bundle_id {
        script_lines.push(format!(r#"tell application id "{}" to activate"#, bundle_id.replace('"', "\\\"")));
        script_lines.push("delay 0.22".to_string());
    } else {
        script_lines.push("delay 0.16".to_string());
    }
    script_lines.push(r#"tell application "System Events" to keystroke "v" using command down"#.to_string());

    let output = Command::new("osascript")
        .args(script_lines.iter().flat_map(|line| ["-e", line.as_str()]))
        .output()
        .map_err(|e| format!("Failed to execute paste shortcut: {}", e))?;

    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

#[cfg(target_os = "windows")]
fn paste_active_app(_target_bundle_id: Option<String>) -> Result<(), String> {
    let output = Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "$wshell = New-Object -ComObject WScript.Shell; Start-Sleep -Milliseconds 40; $wshell.SendKeys('^v')",
        ])
        .output()
        .map_err(|e| format!("Failed to execute paste shortcut: {}", e))?;

    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn paste_active_app(_target_bundle_id: Option<String>) -> Result<(), String> {
    Err("Direct paste is only implemented on macOS and Windows".to_string())
}

fn apply_toggle_shortcut(app: &AppHandle, state: &Arc<AppState>, shortcut_raw: String) -> Result<(), String> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;

    let shortcut = normalize_shortcut(&shortcut_raw);

    let previous = state.active_toggle_shortcut.lock().unwrap().clone();
    if !previous.is_empty() {
        let _ = app.global_shortcut().unregister(previous.as_str());
    }

    let parsed = tauri_plugin_global_shortcut::Shortcut::from_str(&shortcut)
        .map_err(|e| format!("Invalid shortcut '{}': {}", shortcut_raw, e))?;

    app.global_shortcut()
        .on_shortcut(parsed, move |app, _shortcut, event| {
            if event.state != tauri_plugin_global_shortcut::ShortcutState::Pressed {
                return;
            }
            let _ = toggle_main_window(app);
        })
        .map_err(|e| e.to_string())?;

    let mut active = state.active_toggle_shortcut.lock().unwrap();
    *active = shortcut;
    Ok(())
}

fn apply_screenshot_shortcut(app: &AppHandle, state: &Arc<AppState>, shortcut_raw: String) -> Result<(), String> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;

    let shortcut = normalize_shortcut(&shortcut_raw);

    let previous = state.active_screenshot_shortcut.lock().unwrap().clone();
    if !previous.is_empty() {
        let _ = app.global_shortcut().unregister(previous.as_str());
    }

    let parsed = tauri_plugin_global_shortcut::Shortcut::from_str(&shortcut)
        .map_err(|e| format!("Invalid shortcut '{}': {}", shortcut_raw, e))?;
    let closure_state = Arc::clone(state);

    app.global_shortcut()
        .on_shortcut(parsed, move |app, _shortcut, event| {
            if event.state != tauri_plugin_global_shortcut::ShortcutState::Pressed {
                return;
            }
            let _ = capture_screenshot_to_history(app, closure_state.as_ref());
        })
        .map_err(|e| e.to_string())?;

    let mut active = state.active_screenshot_shortcut.lock().unwrap();
    *active = shortcut;
    Ok(())
}

fn apply_quick_paste_shortcut(app: &AppHandle, state: &Arc<AppState>, shortcut_raw: String) -> Result<(), String> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;

    let shortcut = normalize_shortcut(&shortcut_raw);

    let previous = state.active_quick_paste_shortcut.lock().unwrap().clone();
    if !previous.is_empty() {
        let _ = app.global_shortcut().unregister(previous.as_str());
    }

    let parsed = tauri_plugin_global_shortcut::Shortcut::from_str(&shortcut)
        .map_err(|e| format!("Invalid shortcut '{}': {}", shortcut_raw, e))?;
    let closure_state = Arc::clone(state);

    app.global_shortcut()
        .on_shortcut(parsed, move |_app, _shortcut, event| {
            if event.state != tauri_plugin_global_shortcut::ShortcutState::Pressed {
                return;
            }
            let _ = quick_paste_latest_clip(&closure_state);
        })
        .map_err(|e| e.to_string())?;

    let mut active = state.active_quick_paste_shortcut.lock().unwrap();
    *active = shortcut;
    Ok(())
}

fn apply_clear_history_shortcut(app: &AppHandle, state: &Arc<AppState>, shortcut_raw: String) -> Result<(), String> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;

    let shortcut = normalize_shortcut(&shortcut_raw);

    let previous = state.active_clear_history_shortcut.lock().unwrap().clone();
    if !previous.is_empty() {
        let _ = app.global_shortcut().unregister(previous.as_str());
    }

    let parsed = tauri_plugin_global_shortcut::Shortcut::from_str(&shortcut)
        .map_err(|e| format!("Invalid shortcut '{}': {}", shortcut_raw, e))?;
    let closure_state = Arc::clone(state);

    app.global_shortcut()
        .on_shortcut(parsed, move |_app, _shortcut, event| {
            if event.state != tauri_plugin_global_shortcut::ShortcutState::Pressed {
                return;
            }
            if let Ok(conn) = closure_state.db.lock() {
                let _ = conn.execute("DELETE FROM clips", []);
            }
        })
        .map_err(|e| e.to_string())?;

    let mut active = state.active_clear_history_shortcut.lock().unwrap();
    *active = shortcut;
    Ok(())
}

// --- Tauri 命令 ---

#[tauri::command]
fn get_clips(state: tauri::State<Arc<AppState>>, limit: i32, offset: i32) -> Vec<Clip> {
    let conn = state.db.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT id, clip_type, category, content, preview, timestamp, source
         FROM clips ORDER BY timestamp DESC LIMIT ?1 OFFSET ?2"
    ).unwrap();
    
    let clips = stmt.query_map(params![limit, offset], |row| {
        Ok(Clip {
            id: row.get(0)?,
            clip_type: row.get(1)?,
            category: row.get(2)?,
            content: row.get(3)?,
            preview: row.get(4)?,
            timestamp: row.get(5)?,
            source: row.get(6)?,
        })
    }).unwrap();
    
    let mut result = Vec::new();
    for clip in clips {
        result.push(clip.unwrap());
    }
    result
}

#[tauri::command]
fn delete_clip(state: tauri::State<Arc<AppState>>, id: String) -> Result<(), String> {
    let conn = state.db.lock().unwrap();
    conn.execute("DELETE FROM clips WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn clear_all_clips(state: tauri::State<Arc<AppState>>) -> Result<(), String> {
    let conn = state.db.lock().unwrap();
    conn.execute("DELETE FROM clips", [])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn write_to_clipboard(state: tauri::State<Arc<AppState>>, content: String, clip_type: String) -> Result<(), String> {
    write_clip_to_system_clipboard(state.as_ref(), &content, &clip_type)
}

#[tauri::command]
fn paste_clip(app: tauri::AppHandle, state: tauri::State<Arc<AppState>>, content: String, clip_type: String) -> Result<(), String> {
    let target_bundle_id = state.last_frontmost_app.lock().unwrap().clone();
    write_to_clipboard(state, content, clip_type)?;
    hide_window(app)?;
    thread::spawn(move || {
        if let Err(err) = paste_active_app(target_bundle_id) {
            eprintln!("Failed to paste into active app: {}", err);
        }
    });
    Ok(())
}

#[tauri::command]
fn get_settings(state: tauri::State<Arc<AppState>>) -> Settings {
    state.settings.lock().unwrap().clone()
}

#[tauri::command]
fn update_settings(state: tauri::State<Arc<AppState>>, settings: Settings) -> Result<(), String> {
    let next_settings = settings.clone();
    {
        let mut current_settings = state.settings.lock().unwrap();

        // 如果存储路径改变，确保新目录存在
        if settings.storage_path != current_settings.storage_path {
            ensure_storage_dir(&settings.storage_path)?;
        }

        *current_settings = settings;
    }

    let conn = state.db.lock().unwrap();
    persist_settings(&conn, &next_settings)?;
    drop(conn);
    cleanup_history(state.inner().as_ref());
    Ok(())
}

#[tauri::command]
fn update_storage_path(state: tauri::State<Arc<AppState>>, path: String) -> Result<(), String> {
    ensure_storage_dir(&path)?;

    let next_settings = {
        let mut settings = state.settings.lock().unwrap();
        settings.storage_path = path;
        settings.clone()
    };

    let conn = state.db.lock().unwrap();
    persist_settings(&conn, &next_settings)
}

#[tauri::command]
fn set_run_at_login(state: tauri::State<Arc<AppState>>, enabled: bool) -> Result<(), String> {
    let next_settings = {
        let mut settings = state.settings.lock().unwrap();
        settings.launch_at_login = enabled;
        settings.clone()
    };

    let conn = state.db.lock().unwrap();
    persist_settings(&conn, &next_settings)?;
    // 注意：实际实现需要使用 tauri-plugin-autostart
    Ok(())
}

#[tauri::command]
fn set_pause_recording(state: tauri::State<Arc<AppState>>, paused: bool) -> bool {
    let mut is_paused = state.is_paused.lock().unwrap();
    *is_paused = paused;
    *is_paused
}

#[tauri::command]
fn get_pause_recording(state: tauri::State<Arc<AppState>>) -> bool {
    *state.is_paused.lock().unwrap()
}

#[tauri::command]
fn hide_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        window.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn show_window(app: tauri::AppHandle) -> Result<(), String> {
    show_main_window(&app)
}

#[tauri::command]
fn reveal_path(path: String) -> Result<(), String> {
    let normalized = path.trim();
    if normalized.is_empty() {
        return Err("Path cannot be empty".to_string());
    }

    let target = if normalized == "~" {
        dirs::home_dir()
            .unwrap_or_else(|| std::path::PathBuf::from(normalized))
            .to_string_lossy()
            .to_string()
    } else if let Some(rest) = normalized.strip_prefix("~/") {
        dirs::home_dir()
            .unwrap_or_else(|| std::path::PathBuf::from(normalized))
            .join(rest)
            .to_string_lossy()
            .to_string()
    } else {
        normalized.to_string()
    };
    let target_path = std::path::PathBuf::from(&target);

    #[cfg(target_os = "macos")]
    {
        let status = if target_path.is_dir() {
            std::process::Command::new("open")
                .arg(&target_path)
                .status()
                .map_err(|e| format!("Failed to open path: {}", e))?
        } else {
            std::process::Command::new("open")
                .args(["-R", &target])
                .status()
                .map_err(|e| format!("Failed to reveal path: {}", e))?
        };

        if status.success() {
            return Ok(());
        }

        return Err("Failed to reveal path in Finder".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        let status = if target_path.is_dir() {
            std::process::Command::new("explorer")
                .arg(&target)
                .status()
                .map_err(|e| format!("Failed to open path: {}", e))?
        } else {
            std::process::Command::new("explorer")
                .arg(format!("/select,{}", target))
                .status()
                .map_err(|e| format!("Failed to reveal path: {}", e))?
        };

        if status.success() {
            return Ok(());
        }

        return Err("Failed to reveal path in Explorer".to_string());
    }

    #[cfg(target_os = "linux")]
    {
        let status = std::process::Command::new("xdg-open")
            .arg(if target_path.is_dir() {
                target_path.as_os_str()
            } else {
                target_path.parent().unwrap_or_else(|| std::path::Path::new(".")).as_os_str()
            })
            .status()
            .map_err(|e| format!("Failed to open path: {}", e))?;

        if status.success() {
            return Ok(());
        }

        return Err("Failed to reveal path".to_string());
    }

    #[allow(unreachable_code)]
    Err("Reveal path is not supported on this platform".to_string())
}

#[tauri::command]
fn update_shortcut(
    app: tauri::AppHandle,
    state: tauri::State<Arc<AppState>>,
    shortcut_type: String,
    shortcut: String,
) -> Result<(), String> {
    let shortcut = shortcut.trim().to_string();
    if shortcut.is_empty() {
        return Err("Shortcut cannot be empty".to_string());
    }

    let next_settings = {
        let mut settings = state.settings.lock().unwrap();
        match shortcut_type.as_str() {
            "screenshot" => settings.screenshot_shortcut = shortcut.clone(),
            "toggle_window" => settings.toggle_window_shortcut = shortcut.clone(),
            "quick_paste" => settings.quick_paste_shortcut = shortcut.clone(),
            "clear_history" => settings.clear_history_shortcut = shortcut.clone(),
            _ => return Err("Unknown shortcut type".to_string()),
        }
        settings.clone()
    };

    match shortcut_type.as_str() {
        "screenshot" => apply_screenshot_shortcut(&app, &state.inner().clone(), shortcut)?,
        "toggle_window" => apply_toggle_shortcut(&app, &state.inner().clone(), shortcut)?,
        "quick_paste" => apply_quick_paste_shortcut(&app, &state.inner().clone(), shortcut)?,
        "clear_history" => apply_clear_history_shortcut(&app, &state.inner().clone(), shortcut)?,
        _ => {}
    }

    let conn = state.db.lock().unwrap();
    persist_settings(&conn, &next_settings)
}

// --- 截图和图片功能 ---

fn capture_screenshot_to_history(app: &AppHandle, state: &AppState) -> Result<String, String> {
    use std::process::Command;

    #[cfg(target_os = "macos")]
    remember_frontmost_app(app);

    let should_restore_window = if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) {
            let _ = window.set_always_on_top(false);
            let _ = window.unminimize();
            let _ = window.hide();
            thread::sleep(Duration::from_millis(280));
            true
        } else {
            false
        }
    } else {
        false
    };
    
    let settings = state.settings.lock().unwrap();
    let storage_path = settings.storage_path.clone();
    drop(settings);
    
    let clip_id = Uuid::new_v4().to_string();
    
    // 跨平台截图支持
    #[cfg(target_os = "macos")]
    {
        let temp_path = "/tmp/ppaste_screenshot.png";
        
        // 使用 screencapture 命令
        let use_interactive = std::env::var("PPASTE_SCREENSHOT_INTERACTIVE")
            .map(|v| v == "1")
            .unwrap_or(false);
        let mut cmd = Command::new("screencapture");
        if use_interactive {
            cmd.args(["-i", "-x", temp_path]);
        } else {
            cmd.args(["-x", temp_path]);
        }

        let output = cmd
            .output()
            .map_err(|e| format!("Failed to capture screen: {}", e))?;
        
        if output.status.success() {
            // 读取图片
            let png_bytes = std::fs::read(temp_path).map_err(|e| e.to_string())?;
            
            // 保存到存储路径
            let file_path = save_image_to_storage(&storage_path, &png_bytes, &clip_id)?;
            let base64_data = BASE64.encode(&png_bytes);
            
            // 保存到历史（同时记录文件路径）
            save_clip_with_path(state, Some(app), base64_data.clone(), "image".to_string(), "Screenshot".to_string(), Some(file_path));
            
            // 清理临时文件
            let _ = std::fs::remove_file(temp_path);
            if should_restore_window {
                #[cfg(target_os = "macos")]
                let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
                let _ = show_main_window(app);
            }
            
            return Ok(base64_data);
        } else {
            if should_restore_window {
                #[cfg(target_os = "macos")]
                let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
                let _ = show_main_window(app);
            }
            return Err("Screenshot command failed".to_string());
        }
    }
    
    #[cfg(target_os = "windows")]
    {
        use image::{ImageBuffer, Rgba};
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};
        use std::time::Instant;

        let hash_image = |bytes: &[u8]| -> u64 {
            let mut hasher = DefaultHasher::new();
            bytes.hash(&mut hasher);
            hasher.finish()
        };

        let previous_image_hash = Clipboard::new()
            .ok()
            .and_then(|mut clipboard| clipboard.get_image().ok())
            .map(|image| hash_image(image.bytes.as_ref()));

        let launch_status = Command::new("cmd")
            .args(["/C", "start", "", "ms-screenclip:"])
            .status();

        let png_bytes = if launch_status.is_ok() {
            let mut snipped_png: Option<Vec<u8>> = None;
            let deadline = Instant::now() + Duration::from_secs(20);

            while Instant::now() < deadline {
                thread::sleep(Duration::from_millis(180));

                let mut clipboard = match Clipboard::new() {
                    Ok(clipboard) => clipboard,
                    Err(_) => continue,
                };

                let image_data = match clipboard.get_image() {
                    Ok(image) => image,
                    Err(_) => continue,
                };

                let current_hash = hash_image(image_data.bytes.as_ref());
                if previous_image_hash == Some(current_hash) {
                    continue;
                }

                let bytes_vec = image_data.bytes.to_vec();
                let img = match ImageBuffer::<Rgba<u8>, _>::from_raw(
                    image_data.width as u32,
                    image_data.height as u32,
                    bytes_vec,
                ) {
                    Some(img) => img,
                    None => continue,
                };

                let mut encoded = Vec::new();
                let mut cursor = std::io::Cursor::new(&mut encoded);
                if img.write_to(&mut cursor, image::ImageFormat::Png).is_ok() {
                    snipped_png = Some(encoded);
                    break;
                }
            }

            match snipped_png {
                Some(bytes) => bytes,
                None => {
                    if should_restore_window {
                        let _ = show_main_window(app);
                    }
                    return Err("Screenshot cancelled".to_string());
                }
            }
        } else {
            let temp_path = std::env::temp_dir().join("ppaste_screenshot.png");

            // fallback to full-screen screenshot
            let ps_script = r#"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$screen = [System.Windows.Forms.Screen]::PrimaryScreen
$bitmap = New-Object System.Drawing.Bitmap $screen.Bounds.Width, $screen.Bounds.Height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($screen.Bounds.Location, [System.Drawing.Point]::Empty, $screen.Bounds.Size)
$bitmap.Save("$env:TEMP\ppaste_screenshot.png")
$graphics.Dispose()
$bitmap.Dispose()
"#;

            let output = Command::new("powershell")
                .args(["-Command", ps_script])
                .output()
                .map_err(|e| format!("Failed to capture screen: {}", e))?;

            if !output.status.success() {
                if should_restore_window {
                    let _ = show_main_window(app);
                }
                return Err("Screenshot command failed".to_string());
            }

            let full_png = std::fs::read(&temp_path).map_err(|e| e.to_string())?;
            let _ = std::fs::remove_file(&temp_path);
            full_png
        };

        let file_path = save_image_to_storage(&storage_path, &png_bytes, &clip_id)?;
        let base64_data = BASE64.encode(&png_bytes);

        save_clip_with_path(
            state,
            Some(app),
            base64_data.clone(),
            "image".to_string(),
            "Screenshot".to_string(),
            Some(file_path),
        );

        if should_restore_window {
            let _ = show_main_window(app);
        }

        return Ok(base64_data);
    }

    #[cfg(target_os = "linux")]
    {
        let temp_path = "/tmp/ppaste_screenshot.png";
        
        // 尝试使用 scrot 或 gnome-screenshot
        let output = Command::new("scrot")
            .arg(temp_path)
            .output();
        
        match output {
            Ok(out) if out.status.success() => {
                let png_bytes = std::fs::read(temp_path).map_err(|e| e.to_string())?;
                let file_path = save_image_to_storage(&storage_path, &png_bytes, &clip_id)?;
                let base64_data = BASE64.encode(&png_bytes);
                
                save_clip_with_path(state, Some(app), base64_data.clone(), "image".to_string(), "Screenshot".to_string(), Some(file_path));
                let _ = std::fs::remove_file(temp_path);
                if should_restore_window {
                    let _ = show_main_window(app);
                }
                
                return Ok(base64_data);
            }
            _ => {
                // 回退到 gnome-screenshot
                let output2 = Command::new("gnome-screenshot")
                    .args(["-f", temp_path])
                    .output()
                    .map_err(|e| format!("Failed to capture screen: {}", e))?;
                
                if output2.status.success() {
                    let png_bytes = std::fs::read(temp_path).map_err(|e| e.to_string())?;
                    let file_path = save_image_to_storage(&storage_path, &png_bytes, &clip_id)?;
                    let base64_data = BASE64.encode(&png_bytes);
                    
                    save_clip_with_path(state, Some(app), base64_data.clone(), "image".to_string(), "Screenshot".to_string(), Some(file_path));
                    let _ = std::fs::remove_file(temp_path);
                    if should_restore_window {
                        let _ = show_main_window(app);
                    }
                    
                    return Ok(base64_data);
                } else {
                    if should_restore_window {
                        let _ = show_main_window(app);
                    }
                    return Err("No screenshot tool found (try installing scrot or gnome-screenshot)".to_string());
                }
            }
        }
    }
    
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        if should_restore_window {
            let _ = show_main_window(app);
        }
        Err("Screenshot not supported on this platform".to_string())
    }
}

#[tauri::command]
fn take_screenshot(app: tauri::AppHandle, state: tauri::State<Arc<AppState>>) -> Result<String, String> {
    capture_screenshot_to_history(&app, state.as_ref())
}

#[tauri::command]
fn save_image_from_clipboard(app: tauri::AppHandle, state: tauri::State<Arc<AppState>>) -> Result<String, String> {
    let mut clipboard = Clipboard::new().map_err(|e| e.to_string())?;
    
    match clipboard.get_image() {
        Ok(image_data) => {
            use image::{ImageBuffer, Rgba};
            
            let bytes_vec = image_data.bytes.to_vec();
            let img = ImageBuffer::<Rgba<u8>, _>::from_raw(
                image_data.width as u32,
                image_data.height as u32,
                bytes_vec
            ).ok_or("Failed to decode image")?;
            
            // 保存为 PNG
            let mut png_bytes = Vec::new();
            let mut cursor = std::io::Cursor::new(&mut png_bytes);
            img.write_to(&mut cursor, image::ImageFormat::Png)
                .map_err(|e| format!("Failed to encode image: {}", e))?;
            
            let base64_data = BASE64.encode(&png_bytes);
            
            // 保存到历史
            save_clip(&state, Some(&app), base64_data.clone(), "image".to_string(), "Clipboard".to_string());
            
            Ok(base64_data)
        }
        Err(e) => Err(format!("No image in clipboard: {}", e))
    }
}

#[tauri::command]
fn get_image_data(clip_id: String, state: tauri::State<Arc<AppState>>) -> Result<String, String> {
    let conn = state.db.lock().unwrap();
    
    let content: String = conn.query_row(
        "SELECT content FROM clips WHERE id = ?1",
        params![clip_id],
        |row| row.get(0)
    ).map_err(|e| format!("Clip not found: {}", e))?;
    
    Ok(content) // Base64 编码的图片数据
}

#[tauri::command]
fn export_image(clip_id: String, file_path: String, state: tauri::State<Arc<AppState>>) -> Result<(), String> {
    let base64_data = get_image_data(clip_id, state)?;
    
    let png_bytes = BASE64.decode(&base64_data).map_err(|e| e.to_string())?;
    
    std::fs::write(&file_path, png_bytes).map_err(|e| e.to_string())?;
    
    Ok(())
}

// --- 导入导出功能 ---

#[derive(Debug, Serialize, Deserialize)]
pub struct ExportData {
    pub version: String,
    pub export_date: i64,
    pub clips: Vec<Clip>,
    pub settings: Settings,
}

#[tauri::command]
fn export_clips(state: tauri::State<Arc<AppState>>, file_path: String) -> Result<usize, String> {
    let conn = state.db.lock().unwrap();
    let settings = state.settings.lock().unwrap();
    
    // 获取所有剪贴板记录
    let mut stmt = conn.prepare(
        "SELECT id, clip_type, category, content, preview, timestamp, source FROM clips ORDER BY timestamp DESC"
    ).map_err(|e| e.to_string())?;
    
    let clips = stmt.query_map([], |row| {
        Ok(Clip {
            id: row.get(0)?,
            clip_type: row.get(1)?,
            category: row.get(2)?,
            content: row.get(3)?,
            preview: row.get(4)?,
            timestamp: row.get(5)?,
            source: row.get(6)?,
        })
    }).map_err(|e| e.to_string())?;
    
    let mut clips_vec = Vec::new();
    for clip in clips {
        clips_vec.push(clip.unwrap());
    }
    
    let export_data = ExportData {
        version: "1.0".to_string(),
        export_date: Utc::now().timestamp_millis(),
        clips: clips_vec.clone(),
        settings: settings.clone(),
    };
    
    let json = serde_json::to_string_pretty(&export_data).map_err(|e| e.to_string())?;
    std::fs::write(&file_path, json).map_err(|e| e.to_string())?;
    
    Ok(clips_vec.len())
}

#[tauri::command]
fn import_clips(state: tauri::State<Arc<AppState>>, file_path: String, merge: bool) -> Result<usize, String> {
    let json_content = std::fs::read_to_string(&file_path).map_err(|e| e.to_string())?;
    let export_data: ExportData = serde_json::from_str(&json_content).map_err(|e| e.to_string())?;
    
    let conn = state.db.lock().unwrap();
    let mut count = 0;
    
    if !merge {
        // 清空现有数据
        conn.execute("DELETE FROM clips", []).map_err(|e| e.to_string())?;
    }
    
    for clip in export_data.clips {
        // 检查是否已存在
        let exists: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM clips WHERE id = ?1)",
            params![clip.id],
            |row| row.get(0)
        ).unwrap_or(false);
        
        if !exists {
            conn.execute(
                "INSERT INTO clips (id, clip_type, category, content, preview, timestamp, source)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    clip.id,
                    clip.clip_type,
                    clip.category,
                    clip.content,
                    clip.preview,
                    clip.timestamp,
                    clip.source
                ],
            ).map_err(|e| e.to_string())?;
            count += 1;
        }
    }
    
    Ok(count)
}

#[tauri::command]
fn export_clips_json(state: tauri::State<Arc<AppState>>) -> Result<String, String> {
    let conn = state.db.lock().unwrap();
    let settings = state.settings.lock().unwrap();

    let mut stmt = conn
        .prepare("SELECT id, clip_type, category, content, preview, timestamp, source FROM clips ORDER BY timestamp DESC")
        .map_err(|e| e.to_string())?;

    let clips = stmt
        .query_map([], |row| {
            Ok(Clip {
                id: row.get(0)?,
                clip_type: row.get(1)?,
                category: row.get(2)?,
                content: row.get(3)?,
                preview: row.get(4)?,
                timestamp: row.get(5)?,
                source: row.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?;

    let mut clips_vec = Vec::new();
    for clip in clips {
        clips_vec.push(clip.map_err(|e| e.to_string())?);
    }

    let export_data = ExportData {
        version: "1.0".to_string(),
        export_date: Utc::now().timestamp_millis(),
        clips: clips_vec,
        settings: settings.clone(),
    };

    serde_json::to_string_pretty(&export_data).map_err(|e| e.to_string())
}

#[tauri::command]
fn import_clips_json(state: tauri::State<Arc<AppState>>, payload: String, merge: bool) -> Result<usize, String> {
    let export_data: ExportData = serde_json::from_str(&payload).map_err(|e| e.to_string())?;

    let conn = state.db.lock().unwrap();
    let mut count = 0;

    if !merge {
        conn.execute("DELETE FROM clips", []).map_err(|e| e.to_string())?;
    }

    for clip in export_data.clips {
        let exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM clips WHERE id = ?1)",
                params![clip.id],
                |row| row.get(0),
            )
            .unwrap_or(false);

        if !exists {
            conn.execute(
                "INSERT INTO clips (id, clip_type, category, content, preview, timestamp, source)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    clip.id,
                    clip.clip_type,
                    clip.category,
                    clip.content,
                    clip.preview,
                    clip.timestamp,
                    clip.source
                ],
            )
            .map_err(|e| e.to_string())?;
            count += 1;
        }
    }

    Ok(count)
}

#[tauri::command]
fn get_stats(state: tauri::State<Arc<AppState>>) -> Result<serde_json::Value, String> {
    let conn = state.db.lock().unwrap();
    
    let total_clips: i64 = conn.query_row(
        "SELECT COUNT(*) FROM clips",
        [],
        |row| row.get(0)
    ).map_err(|e| e.to_string())?;
    
    let total_size: i64 = conn.query_row(
        "SELECT SUM(length(content)) FROM clips",
        [],
        |row| row.get(0)
    ).map_err(|e| e.to_string())?;
    
    let oldest_clip: Option<i64> = conn.query_row(
        "SELECT MIN(timestamp) FROM clips",
        [],
        |row| row.get(0)
    ).ok();
    
    Ok(serde_json::json!({
        "total_clips": total_clips,
        "total_size_bytes": total_size,
        "total_size_mb": (total_size as f64) / 1024.0 / 1024.0,
        "oldest_clip": oldest_clip,
        "database_path": app_data_dir().join("clips.db").to_string_lossy().to_string()
    }))
}

// --- 主函数 ---

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    migrate_legacy_app_data().expect("Failed to migrate legacy data directory");

    // 获取数据库路径
    let db_path = app_data_dir().join("clips.db");
    
    // 确保目录存在
    std::fs::create_dir_all(db_path.parent().unwrap()).unwrap();
    
    // 初始化数据库
    let conn = init_db(db_path.to_str().unwrap()).expect("Failed to initialize database");
    
    let default_settings = load_settings(&conn);
    let app_state = Arc::new(AppState {
        db: Arc::new(Mutex::new(conn)),
        settings: Arc::new(Mutex::new(default_settings.clone())),
        is_paused: Arc::new(Mutex::new(false)),
        last_clip: Arc::new(Mutex::new(None)),
        suppressed_text: Arc::new(Mutex::new(None)),
        last_image_hash: Arc::new(Mutex::new(None)),
        active_screenshot_shortcut: Arc::new(Mutex::new(default_settings.screenshot_shortcut.clone())),
        active_toggle_shortcut: Arc::new(Mutex::new(default_settings.toggle_window_shortcut.clone())),
        active_quick_paste_shortcut: Arc::new(Mutex::new(default_settings.quick_paste_shortcut.clone())),
        active_clear_history_shortcut: Arc::new(Mutex::new(default_settings.clear_history_shortcut.clone())),
        awaiting_focus_after_show: Arc::new(Mutex::new(false)),
        last_frontmost_app: Arc::new(Mutex::new(None)),
        duplicate_hit_counts: Arc::new(Mutex::new(HashMap::new())),
        auto_pinned_signature: Arc::new(Mutex::new(None)),
    });
    cleanup_history(&app_state);
    
    // 剪贴板监控在 setup 后启动

    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .manage(app_state.clone())
        .setup(move |app| {
            // 创建托盘菜单
            let show = MenuItem::with_id(app, "show", "打开剪贴板 / Open Clipboard", true, None::<&str>)?;
            let pause = MenuItem::with_id(app, "pause", "暂停记录 / Pause Recording", true, None::<&str>)?;
            let settings = MenuItem::with_id(app, "settings", "设置 / Settings", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出 PPaste / Quit PPaste", true, None::<&str>)?;
            
            let menu = Menu::with_items(app, &[&show, &pause, &settings, &quit])?;
            
            // 创建托盘图标
            let _tray = TrayIconBuilder::new()
                .icon(tauri::image::Image::from_bytes(include_bytes!("../icons/tray-template.png"))?)
                .icon_as_template(true)
                .menu(&menu)
                .show_menu_on_left_click(false)
                                .on_menu_event({
                    let app_state = Arc::clone(&app_state);
                    move |app, event| match event.id.as_ref() {
                        "show" => {
                            remember_frontmost_app(app);
                            let _ = show_main_window(app);
                        }
                        "pause" => {
                            if let Ok(mut paused) = app_state.is_paused.lock() {
                                *paused = !*paused;
                            }
                        }
                        "settings" => {
                            remember_frontmost_app(app);
                            let _ = show_main_window(app);
                            let _ = app.emit("open-settings", true);
                        }
                        "quit" => {
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    use tauri::tray::{MouseButton, MouseButtonState, TrayIconEvent};

                    let should_open = matches!(
                        event,
                        TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Down,
                            ..
                        } | TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        } | TrayIconEvent::DoubleClick {
                            button: MouseButton::Left,
                            ..
                        }
                    );

                    if !should_open {
                        return;
                    }

                    let app = tray.app_handle();
                    remember_frontmost_app(&app);
                    let _ = show_main_window(&app);
                })
                .build(app)?;

            // 启动应用时主动显示主窗口
            let _ = show_main_window(app.handle());

            // 启动剪贴板监控（需要 AppHandle 用于事件推送）
            start_clipboard_monitor(app.handle().clone(), Arc::clone(&app_state));
            
            // 注册全局快捷键（支持设置页动态修改）
            let screenshot_shortcut = {
                app_state
                    .settings
                    .lock()
                    .map(|s| s.screenshot_shortcut.clone())
                    .unwrap_or_else(|_| "Alt+S".to_string())
            };
            apply_screenshot_shortcut(app.handle(), &app_state, screenshot_shortcut)?;
            let current_shortcut = {
                app_state
                    .settings
                    .lock()
                    .map(|s| s.toggle_window_shortcut.clone())
                    .unwrap_or_else(|_| "Alt+X".to_string())
            };
            apply_toggle_shortcut(app.handle(), &app_state, current_shortcut)?;
            let quick_paste_shortcut = {
                app_state
                    .settings
                    .lock()
                    .map(|s| s.quick_paste_shortcut.clone())
                    .unwrap_or_else(|_| "CmdOrCtrl+Shift+V".to_string())
            };
            apply_quick_paste_shortcut(app.handle(), &app_state, quick_paste_shortcut)?;
            
            Ok(())
        })
        .on_window_event(|window, event| {
            use tauri::WindowEvent;

            if window.label() != "main" {
                return;
            }

            if let WindowEvent::Focused(true) = event {
                if let Some(state) = window.try_state::<Arc<AppState>>() {
                    let mut awaiting_focus_after_show = state.awaiting_focus_after_show.lock().unwrap();
                    *awaiting_focus_after_show = false;
                }
                return;
            }

            if let WindowEvent::Focused(false) = event {
                if let Some(state) = window.try_state::<Arc<AppState>>() {
                    let awaiting_focus_after_show = *state.awaiting_focus_after_show.lock().unwrap();
                    if awaiting_focus_after_show {
                        return;
                    }
                }

                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_clips,
            delete_clip,
            clear_all_clips,
            write_to_clipboard,
            paste_clip,
            get_settings,
            update_settings,
            set_run_at_login,
            set_pause_recording,
            get_pause_recording,
            hide_window,
            show_window,
            reveal_path,
            export_clips,
            import_clips,
            export_clips_json,
            import_clips_json,
            get_stats,
            take_screenshot,
            save_image_from_clipboard,
            get_image_data,
            export_image,
            update_shortcut,
            update_storage_path
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            #[cfg(target_os = "macos")]
            {
                use tauri::RunEvent;
                if let RunEvent::Reopen { .. } = event {
                    remember_frontmost_app(app);
                    let _ = show_main_window(app);
                }
            }

            #[cfg(not(target_os = "macos"))]
            {
                if let tauri::RunEvent::ExitRequested { .. } = event {
                    let _ = app;
                }
            }
        });
}

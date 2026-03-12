use arboard::Clipboard;
use chrono::Utc;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
#[cfg(target_os = "macos")]
use std::process::Command;
use std::str::FromStr;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
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
pub struct Settings {
    pub theme: String,
    pub language: String,
    pub launch_at_login: bool,
    pub play_sounds: bool,
    pub history_retention_days: i32,
    pub max_clips: i32,
    pub ignore_password_managers: bool,
    pub plain_text_only: bool,
    pub storage_path: String,          // 自定义存储路径
    pub screenshot_shortcut: String,   // 截图快捷键
    pub toggle_window_shortcut: String, // 开关窗口快捷键
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
            theme: "dark".to_string(),
            language: "zh".to_string(),
            launch_at_login: true,
            play_sounds: false,
            history_retention_days: 30,
            max_clips: 500,
            ignore_password_managers: true,
            plain_text_only: false,
            storage_path: default_storage,
            screenshot_shortcut: "Alt+S".to_string(),      // Windows/Linux: Alt+S, macOS: Option+S
            toggle_window_shortcut: "Alt+Space".to_string(), // Windows/Linux: Alt+Space, macOS: Option+Space
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
    pub active_toggle_shortcut: Arc<Mutex<String>>,
    pub ignore_focus_loss_until: Arc<Mutex<Option<Instant>>>,
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
                                    save_clip(&state, Some(&app), text, "text".to_string(), "Unknown".to_string());
                                }
                            } else {
                                drop(last_clip);
                                save_clip(&state, Some(&app), text, "text".to_string(), "Unknown".to_string());
                            }
                        }
                    }
                    Err(_) => {}
                }
                
                // 检查图片剪贴板
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
                                save_clip(&state, Some(&app), base64_data, "image".to_string(), "Screenshot".to_string());
                                
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
                            save_clip(&state, Some(&app), base64_data, "image".to_string(), "Screenshot".to_string());
                            
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
    
    let settings = state.settings.lock().unwrap();
    let max_clips = settings.max_clips;
    drop(settings);
    
    let clip = Clip {
        id: Uuid::new_v4().to_string(),
        clip_type,
        category: detect_category(&content),
        content,
        preview: None,
        timestamp: Utc::now().timestamp_millis(),
        source: Some(source),
    };
    
    let conn = state.db.lock().unwrap();
    // 插入新剪贴板
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

    // 清理旧记录
    let _ = conn.execute(
        "DELETE FROM clips WHERE id NOT IN (
            SELECT id FROM clips ORDER BY timestamp DESC LIMIT ?1
        )",
        params![max_clips],
    );

    drop(conn);

    // 通知前端：实时推送新剪贴板项
    if let Some(app) = app {
        let _ = app.emit("new-clip", clip.clone());
    }
}

fn detect_category(content: &str) -> Option<String> {
    if content.starts_with("http://") || content.starts_with("https://") {
        return Some("Links".to_string());
    }
    if content.contains("fn ") || content.contains("function ") || 
       content.contains("const ") || content.contains("let ") ||
       content.contains("import ") || content.contains("return ") {
        return Some("Code".to_string());
    }
    if content.len() < 100 && !content.contains('\n') {
        return Some("Notes".to_string());
    }
    None
}

fn normalize_shortcut(input: &str) -> String {
    input
        .trim()
        .replace("Option", "Alt")
        .replace("OPTION", "Alt")
        .replace("option", "Alt")
        .replace("Command", "Meta")
        .replace("COMMAND", "Meta")
        .replace("command", "Meta")
}

fn show_main_window(app: &AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    app.set_activation_policy(tauri::ActivationPolicy::Regular)
        .map_err(|e| e.to_string())?;

    if let Some(state) = app.try_state::<Arc<AppState>>() {
        let mut ignore_focus_loss_until = state.ignore_focus_loss_until.lock().unwrap();
        *ignore_focus_loss_until = Some(Instant::now() + Duration::from_millis(350));
    }

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
    }

    Ok(())
}

fn toggle_main_window(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().map_err(|e| e.to_string())? {
            window.hide().map_err(|e| e.to_string())?;
        } else {
            show_main_window(app)?;
        }
    }

    Ok(())
}

#[cfg(target_os = "macos")]
fn paste_active_app() -> Result<(), String> {
    thread::sleep(Duration::from_millis(80));

    let output = Command::new("osascript")
        .args([
            "-e",
            r#"tell application "System Events" to keystroke "v" using command down"#,
        ])
        .output()
        .map_err(|e| format!("Failed to execute paste shortcut: {}", e))?;

    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

#[cfg(not(target_os = "macos"))]
fn paste_active_app() -> Result<(), String> {
    Err("Direct paste is only implemented on macOS".to_string())
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
    let mut clipboard = Clipboard::new().map_err(|e| e.to_string())?;
    
    if clip_type == "text" {
        clipboard.set_text(&content).map_err(|e| e.to_string())?;
        let mut suppressed_text = state.suppressed_text.lock().unwrap();
        *suppressed_text = Some(content.clone());
    } else {
        return Err("Only text clips can be copied right now".to_string());
    }

    let mut last_clip = state.last_clip.lock().unwrap();
    *last_clip = Some(content);
    
    Ok(())
}

#[tauri::command]
fn paste_clip(app: tauri::AppHandle, state: tauri::State<Arc<AppState>>, content: String, clip_type: String) -> Result<(), String> {
    write_to_clipboard(state, content, clip_type)?;
    hide_window(app)?;
    paste_active_app()
}

#[tauri::command]
fn get_settings(state: tauri::State<Arc<AppState>>) -> Settings {
    state.settings.lock().unwrap().clone()
}

#[tauri::command]
fn update_settings(state: tauri::State<Arc<AppState>>, settings: Settings) -> Result<(), String> {
    let mut current_settings = state.settings.lock().unwrap();
    
    // 如果存储路径改变，确保新目录存在
    if settings.storage_path != current_settings.storage_path {
        ensure_storage_dir(&settings.storage_path)?;
    }
    
    *current_settings = settings;
    Ok(())
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

    {
        let mut settings = state.settings.lock().unwrap();
        match shortcut_type.as_str() {
            "screenshot" => settings.screenshot_shortcut = shortcut.clone(),
            "toggle_window" => settings.toggle_window_shortcut = shortcut.clone(),
            _ => return Err("Unknown shortcut type".to_string()),
        }
    }

    if shortcut_type == "toggle_window" {
        apply_toggle_shortcut(&app, &state.inner().clone(), shortcut)?;
    }

    Ok(())
}

#[tauri::command]
fn update_storage_path(state: tauri::State<Arc<AppState>>, path: String) -> Result<(), String> {
    ensure_storage_dir(&path)?;
    
    let mut settings = state.settings.lock().unwrap();
    settings.storage_path = path;
    
    Ok(())
}

#[tauri::command]
fn set_run_at_login(state: tauri::State<Arc<AppState>>, enabled: bool) -> Result<(), String> {
    let mut settings = state.settings.lock().unwrap();
    settings.launch_at_login = enabled;
    // 注意：实际实现需要使用 tauri-plugin-autostart
    Ok(())
}

#[tauri::command]
fn toggle_pause(state: tauri::State<Arc<AppState>>) -> bool {
    let mut is_paused = state.is_paused.lock().unwrap();
    *is_paused = !*is_paused;
    *is_paused
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

// --- 截图和图片功能 ---

#[tauri::command]
fn take_screenshot(app: tauri::AppHandle, state: tauri::State<Arc<AppState>>) -> Result<String, String> {
    use std::process::Command;
    
    let settings = state.settings.lock().unwrap();
    let storage_path = settings.storage_path.clone();
    drop(settings);
    
    let clip_id = Uuid::new_v4().to_string();
    
    // 跨平台截图支持
    #[cfg(target_os = "macos")]
    {
        let temp_path = "/tmp/ppaste_screenshot.png";
        
        // 使用 screencapture 命令
        let output = Command::new("screencapture")
            .args(["-x", temp_path]) // -x: 不播放声音
            .output()
            .map_err(|e| format!("Failed to capture screen: {}", e))?;
        
        if output.status.success() {
            // 读取图片
            let png_bytes = std::fs::read(temp_path).map_err(|e| e.to_string())?;
            
            // 保存到存储路径
            let file_path = save_image_to_storage(&storage_path, &png_bytes, &clip_id)?;
            let base64_data = BASE64.encode(&png_bytes);
            
            // 保存到历史（同时记录文件路径）
            save_clip_with_path(&state, Some(&app), base64_data.clone(), "image".to_string(), "Screenshot".to_string(), Some(file_path));
            
            // 清理临时文件
            let _ = std::fs::remove_file(temp_path);
            
            return Ok(base64_data);
        } else {
            return Err("Screenshot command failed".to_string());
        }
    }
    
    #[cfg(target_os = "windows")]
    {
        use std::io::Write;
        let temp_path = std::env::temp_dir().join("ppaste_screenshot.png");
        
        // 使用 PowerShell 截图
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
        
        if output.status.success() {
            let png_bytes = std::fs::read(&temp_path).map_err(|e| e.to_string())?;
            
            // 保存到存储路径
            let file_path = save_image_to_storage(&storage_path, &png_bytes, &clip_id)?;
            let base64_data = BASE64.encode(&png_bytes);
            
            save_clip_with_path(&state, Some(&app), base64_data.clone(), "image".to_string(), "Screenshot".to_string(), Some(file_path));
            
            let _ = std::fs::remove_file(temp_path);
            
            return Ok(base64_data);
        } else {
            return Err("Screenshot command failed".to_string());
        }
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
                
                save_clip_with_path(&state, Some(&app), base64_data.clone(), "image".to_string(), "Screenshot".to_string(), Some(file_path));
                let _ = std::fs::remove_file(temp_path);
                
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
                    
                    save_clip_with_path(&state, Some(&app), base64_data.clone(), "image".to_string(), "Screenshot".to_string(), Some(file_path));
                    let _ = std::fs::remove_file(temp_path);
                    
                    return Ok(base64_data);
                } else {
                    return Err("No screenshot tool found (try installing scrot or gnome-screenshot)".to_string());
                }
            }
        }
    }
    
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        Err("Screenshot not supported on this platform".to_string())
    }
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
    
    let default_settings = Settings::default();
    let app_state = Arc::new(AppState {
        db: Arc::new(Mutex::new(conn)),
        settings: Arc::new(Mutex::new(default_settings.clone())),
        is_paused: Arc::new(Mutex::new(false)),
        last_clip: Arc::new(Mutex::new(None)),
        suppressed_text: Arc::new(Mutex::new(None)),
        last_image_hash: Arc::new(Mutex::new(None)),
        active_toggle_shortcut: Arc::new(Mutex::new(default_settings.toggle_window_shortcut.clone())),
        ignore_focus_loss_until: Arc::new(Mutex::new(None)),
    });
    
    // 剪贴板监控在 setup 后启动

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(app_state.clone())
        .setup(move |app| {
            // 创建托盘菜单
            let show = MenuItem::with_id(app, "show", "打开剪贴板", true, None::<&str>)?;
            let pause = MenuItem::with_id(app, "pause", "暂停记录", true, None::<&str>)?;
            let settings = MenuItem::with_id(app, "settings", "设置", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出 PPaste", true, None::<&str>)?;
            
            let menu = Menu::with_items(app, &[&show, &pause, &settings, &quit])?;
            
            // 启动后默认隐藏，通过托盘或快捷键唤起
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.hide();
            }
            
            // 创建托盘图标
            let _tray = TrayIconBuilder::new()
                .icon(tauri::image::Image::from_bytes(include_bytes!("../icons/tray-template.png"))?)
                .icon_as_template(true)
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        let _ = show_main_window(app);
                    }
                    "pause" => {}
                    "settings" => {}
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
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
                    let _ = show_main_window(&app);
                })
                .build(app)?;

            // 启动剪贴板监控（需要 AppHandle 用于事件推送）
            start_clipboard_monitor(app.handle().clone(), Arc::clone(&app_state));
            
            // 注册全局快捷键（支持设置页动态修改）
            let current_shortcut = {
                app_state
                    .settings
                    .lock()
                    .map(|s| s.toggle_window_shortcut.clone())
                    .unwrap_or_else(|_| "Alt+Space".to_string())
            };
            apply_toggle_shortcut(app.handle(), &app_state, current_shortcut)?;
            
            Ok(())
        })
        .on_window_event(|window, event| {
            use tauri::WindowEvent;

            if window.label() != "main" {
                return;
            }

            if let WindowEvent::Focused(false) = event {
                if let Some(state) = window.try_state::<Arc<AppState>>() {
                    let mut ignore_focus_loss_until = state.ignore_focus_loss_until.lock().unwrap();
                    if ignore_focus_loss_until
                        .as_ref()
                        .is_some_and(|until| Instant::now() <= *until)
                    {
                        return;
                    }
                    *ignore_focus_loss_until = None;
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
            toggle_pause,
            hide_window,
            show_window,
            export_clips,
            import_clips,
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
            use tauri::RunEvent;
            if let RunEvent::Reopen { .. } = event {
                let _ = show_main_window(app);
            }
        });
}

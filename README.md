# 📦 PPaste

**Your Clipboard, Infinite Memory. (你的剪贴板，无限记忆。)**

## 💡 为什么需要 PPaste？

市面上已经有了 Paste、Maccy，为什么还要造轮子？
因为作为重度键盘用户和开发者，我们真正需要的是：

1. **绝对的肌肉记忆：** 不想去记复杂的快捷键组合（`Option+Shift+C` 是什么鬼？）。**连按两次 `Command` 键**，这才是最符合直觉的零摩擦唤起方式。
2. **拒绝“阅后即焚”：** 大多数工具只能存最近 100 条。PPaste 基于 SQLite 构建，致力于做你剪贴板的**永久时光机**，几个月前复制的一段 JSON 也能秒速搜出。
3. **数据主权归你：** 你的复制历史是你“第二大脑”的碎片。PPaste 拒绝数据锁死，原生支持**将历史记录导出为结构化 JSON**，方便你导入 Notion、Obsidian 或喂给 AI 进行分析。

## ✨ 核心特性

* **⚡️ 闪电唤起 (Zero-Friction Trigger)**
* 全局双击 `⌘ Command` 即可呼出，用完即走，绝不打断心流。


* **♾️ 无限持久化 (Infinite Storage)**
* 底层采用高性能 SQLite 驱动，存上万条记录依然保持毫秒级检索。


* **🔍 全文极速检索 (Blazing Fast Search)**
* 支持对历史记录的文本进行模糊匹配，支持按来源 App 过滤。


* **🛡️ 隐私至上 (Privacy First)**
* 数据 100% 存在本地。
* **智能黑名单**：自动忽略来自 1Password、Keychain 等密码管理软件的复制操作，保护你的敏感信息。


* **📦 数据自由 (Data Freedom)**
* 一键将你的剪贴板历史导出为标准 `.json` 文件。

## 🚀 安装指南

### 方法一：下载预编译版本 (推荐)

1. 前往 [Releases](https://www.google.com/search?q=https://github.com/yyin9116/PPaste/releases) 页面。
2. 下载最新版本的 `PPaste.dmg` 或 `PPaste.zip`。
3. 拖入 `Applications` (应用程序) 文件夹。
4. 首次运行请在系统设置中授予**“辅助功能 (Accessibility)”**权限（用于监听全局双击动作）。

### 方法二：自行编译

```bash
git clone https://github.com/yyin9116/PPaste.git
cd PPaste
# 双击打开 PPaste.xcodeproj，使用 Xcode 编译运行
```

## ⌨️ 快捷键速查表

在 PPaste 界面激活时，你可以完全丢掉鼠标：

| 快捷键 | 动作 | 说明 |
| --- | --- | --- |
| `双击 ⌘ Cmd` | **唤起 PPaste** | 任何界面全局生效 |
| `↑` / `↓` | 导航列表 | 切换选中的剪贴板记录 |
| `Enter` | **粘贴** | 自动将当前内容粘贴到你上一个工作的窗口 |
| `⌘ + C` | 仅复制 | 放入系统剪贴板但不执行粘贴动作 |
| `Delete` | 永久删除 | 清除该条历史记录 |
| `Esc` | 隐藏窗口 | 立即退出当前界面 |

## 🛠 数据导出 (JSON) 示例

导出的数据拥有极高的结构化程度，方便开发者二次利用：

```json
{
  "total": 1250,
  "export_date": "2026-03-12T10:00:00Z",
  "records": [
    {
      "id": "A1B2C3D4...",
      "timestamp": "2026-03-12T09:15:22Z",
      "type": "text/plain",
      "content": "function initDatabase() { ... }",
      "source_app": "com.microsoft.VSCode"
    }
  ]
}
```

## 🤝 参与贡献

欢迎提交 PR 或 Issue！如果 PPaste 提升了你的效率，欢迎点个 ⭐️ Star 让更多人看到。

## 📜 开源协议

本项目基于 [MIT License](https://www.google.com/search?q=LICENSE) 协议开源。

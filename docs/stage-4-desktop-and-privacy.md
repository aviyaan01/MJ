# Stage 4 — Windows Desktop Companion & Privacy Hardening

Implements **Sections 14 and 15** (including their hardened defaults) from the MJ Assistant specification while leaving Stage 3 capabilities (long-term memory, arbitrary tool calling, web search, cloud file analysis, and scheduled automation) deferred and non-activatable.

---

## 1. Hardened Permission Defaults (Section 14 & Section 15)

All 8 OS-level capability classes ship **OFF (`false`)** in `DEFAULT_PERMISSIONS_STATE` (`packages/shared/src/privacy.ts`) and are enforced individually by `PermissionsStore` (`apps/server/src/permissionsStore.ts`) and the Tauri Rust companion (`apps/desktop/src-tauri/src/permissions.rs`):

| Capability Key | Description | Default | Notes |
| --- | --- | --- | --- |
| `appOpening` | Approved application launch | `false` | Strictly allowlisted apps only; shells forbidden |
| `fileRead` | Scoped desktop file search | `false` | Never bundled with `fileWrite` |
| `fileWrite` | Local file organization (by extension) | `false` | Separate permission + explicit user confirmation (`409 CONFIRMATION_REQUIRED`) |
| `systemMonitoring` | Local host/Windows OS telemetry | `false` | Real CPU, RAM, storage, network metrics only |
| `notifications` | Desktop alert notifications | `false` | User-invoked desktop notifications |
| `clipboardWrite` | Copy output to system clipboard | `false` | User-initiated copy only |
| `webLaunch` | Open approved HTTPS links in browser | `false` | HTTPS/localhost allowlisted domains only |
| `wakeWordStandby` | Passive wake-word (`"Hey MJ"`) standby | `false` | Persistent UI banner + tray indicator when active |

- **No master enable switch**: `UpdateSinglePermissionSchema` (`.strict()`) only accepts `{ key, enabled }` for one capability at a time.
- **Instant emergency revocation**: `POST /api/privacy/revoke-desktop` (`"Revoke all desktop permissions"`) resets all 8 OS capability classes back to `false` and logs the revocation.
- **Stage 3 locks**: `memoryAccess`, `optionalAutomation`, and `cloudFileProcessing` remain `false` and non-activatable.

---

## 2. Admin Privilege Policy (Standard User Only)

- **Execution level**: `asInvoker` (no UAC manifest elevation in Tauri or Node server).
- **Named admin-only exception**: **System-wide machine administration** (writing under `C:\Windows` or `C:\Program Files`, installing machine-wide software, or reading protected system / other-user directories) would require Windows Administrator privileges and is **intentionally NOT implemented** in MJ Assistant.
- Telemetry reports `adminElevated: false` explicitly.

---

## 3. Guardrails & Privileged-Action Audit Log

- **No arbitrary shell execution**: `cmd.exe`, `powershell.exe`, `pwsh.exe`, `bash`, `sh`, `wsl`, `wscript`, `cscript`, `mshta`, `rundll32`, `regsvr32`, and shell metacharacters (`| & ; \` $ > < " '`) are blocked (`403 SHELL_EXECUTION_FORBIDDEN`) in both TypeScript (`isForbiddenShellTarget`) and Rust (`desktop_actions.rs`), and `@tauri-apps/plugin-shell` is excluded from `apps/desktop/src-tauri/capabilities/default.json`.
- **Distinguished telemetry**:
  - **Browser Telemetry** (`readBrowserTelemetry()` in `apps/web/src/desktop/desktopBridge.ts`): online status, logical cores, `navigator.platform` — clearly labeled `browser-sandbox`.
  - **Local Windows Host Telemetry** (`GET /api/desktop/system-status` + Tauri `desktop_get_system_status`): real OS metrics only; missing values such as battery telemetry in web/Node mode return `null` rather than simulated numbers.
- **Audit Log (`privileged_audit_logs` SQLite table)**: Separate from conversation history/activity (`Privacy` tab -> *Privileged-Action Audit Log*). Every permission toggle, desktop revocation, allowlist addition/removal, desktop action (`allowed` / `denied` / `cancelled`), voice/AI permission block, export, and history wipe records `{ timestamp, capability, action, target, outcome, source, detail }`.

---

## 4. Building & Running the Windows Tauri Companion

1. **Web + Fastify backend**:
   ```bash
   npm install
   npm run db:migrate
   npm run dev
   ```
   Open **http://127.0.0.1:5173** and visit the **Desktop** and **Privacy** navigation tabs.

2. **Native Windows Tauri companion (`apps/desktop`)**:
   - Prerequisites on Windows:
     - **Rust toolchain (`rustup` / `rustc` / `cargo`)** from [rustup.rs](https://rustup.rs/)
     - **Microsoft C++ Build Tools (MSVC)**
     - **Microsoft Edge WebView2 Runtime** (already installed on modern Windows 10/11)
   - Development & build commands:
     ```bash
     npm run desktop:dev
     npm run desktop:build
     ```
   - Notice: Tauri v2 dev mode (`apps/desktop/src-tauri/tauri.conf.json`) loads `http://127.0.0.1:5173` while production builds bundle `apps/web/dist`. Keep the Fastify backend (`http://127.0.0.1:3001`) running when using the desktop shell for Grok API + SQLite persistence, or configure production bundle URL accordingly.

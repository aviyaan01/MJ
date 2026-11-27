# MJ Assistant — Encrypted Database Backup & Restore Guide (`RESTORE.md`)

Covers restoring **MJ Assistant's memory and settings database** (`conversations`, `messages`, `app_settings`, `usage_logs`, `desktop_allowlist`, and `privileged_audit_logs`) from automatic daily encrypted backups (`*.mjbak`).

---

## 1. What Automatic Daily Backup Protects

MJ Assistant stores all personal memory and configuration inside local-first SQLite (`DATABASE_URL`, WAL mode):
- **Conversation memory & transcripts**: `conversations`, `messages`
- **Runtime settings, voice settings & budget limits**: `app_settings` (`mj.runtime_settings.v1`)
- **Privacy permissions, allowlists, shortcuts & audit history**: `app_settings`, `desktop_allowlist`, `privileged_audit_logs`
- **Token & spend telemetry**: `usage_logs`

### Encryption & Integrity Format (`mj-backup-v1`)
When `@mj/server` starts (`BACKUP_ENABLED=true`), `DailyBackupScheduler` checks `BACKUP_DIR` (`./data/backups` locally or `/app/data/backups` in Docker) once at startup and every hour thereafter, automatically creating an encrypted snapshot whenever the newest backup is missing or >= 24 hours (`BACKUP_INTERVAL_HOURS`) old:

1. **Consistent WAL Snapshot**: Runs SQLite `VACUUM INTO` to produce a single atomic, compacted snapshot without copying dirty `-wal` / `-shm` files.
2. **Compression**: Gzips the verified snapshot (`zlib` level 9).
3. **Authenticated Encryption**: Encrypts with **`AES-256-GCM`** using a fresh per-backup 16-byte random salt, 12-byte random IV, `scrypt` key derivation (`N=16384, r=8, p=1`), Additional Authenticated Data (`format|createdAt|sha256`), and 16-byte GCM authentication tag.
4. **Checksum Verification**: Records `sha256Plaintext` of the unencrypted SQLite snapshot inside the envelope and removes temporary plaintext snapshot files immediately in `finally`.
5. **Retention**: Keeps the newest `BACKUP_RETENTION_COUNT` archives (default `14`) and prunes older `.mjbak` files automatically.

> **Important Security Note:** Backup archives are ignored in Git (`*.mjbak`, `backups/`, `data/`). Store `BACKUP_ENCRYPTION_KEY` (or `AUTH_SECRET` if `BACKUP_ENCRYPTION_KEY` is omitted) safely in a password manager — **without the key, `.mjbak` files cannot be decrypted**.

---

## 2. Configure Encryption Key & Manual On-Demand Backup

Set a dedicated backup passphrase (>= 16 chars) in `.env` (or your server secret manager):

```env
BACKUP_ENABLED=true
BACKUP_ENCRYPTION_KEY=your_long_random_backup_key_here
BACKUP_DIR=./data/backups
BACKUP_INTERVAL_HOURS=24
BACKUP_RETENTION_COUNT=14
```

> If `BACKUP_ENCRYPTION_KEY` is unset, MJ Assistant automatically uses `AUTH_SECRET` (provided it is configured and not a placeholder). Using a separate `BACKUP_ENCRYPTION_KEY` allows rotating your session cookie `AUTH_SECRET` without breaking older backups.

Run a manual encrypted backup anytime:

```bash
npm run db:backup
```

---

## 3. Step-by-Step Restore Procedure (Local / Node 24 Host)

### Step 1: Stop the Running MJ Server
Stop `@mj/server` so no active process holds SQLite locks or appends WAL frames:
- Local shell: press `Ctrl+C`
- systemd: `sudo systemctl stop mj-backend`

### Step 2: Locate the Encrypted `.mjbak` File
List available encrypted backups (newest first):

```bash
ls -lh ./data/backups/mj-backup-*.mjbak
```

### Step 3: Ensure Decryption Key is Available
Confirm `BACKUP_ENCRYPTION_KEY` (or the `AUTH_SECRET` used when the backup was created) is set in `.env` or your shell environment:

```bash
export BACKUP_ENCRYPTION_KEY="<key-used-during-backup>"
```

### Step 4: Run `npm run db:restore`
Restore directly to the configured `DATABASE_URL` (or pass `--target <path>`):

```bash
npm run db:restore -- --file ./data/backups/mj-backup-2026-11-27-14-30-00-abcd1234.mjbak
```

Optional flags:
- `--target ./data/mj-assistant.db` — override destination SQLite path
- `--no-safety-copy` — skip saving a `.pre-restore-*.db` copy of the replaced database

What `db:restore` verifies before touching your live database:
1. Deciphers `AES-256-GCM` payload and validates the GCM auth tag (rejects wrong key or tampered archive).
2. Decompresses and checks SHA-256 against `sha256Plaintext`.
3. Runs `PRAGMA integrity_check;` (`ok`) and `runMigrations()` on a temporary restored file.
4. Copies the previous database to `<target>.pre-restore-<timestamp>.db`, removes stale `-wal`/`-shm` sidecars, and atomically moves the verified database into place.
5. Prints restored table counts (`conversations`, `messages`, `app_settings`, `usage_logs`, `allowlist`, `audit_logs`).

### Step 5: Restart & Verify
Start the server cleanly:

```bash
npm start
```

Verify health and memory/settings restoration:
```bash
curl -sS http://127.0.0.1:3001/health
```
Open MJ Assistant in the browser and confirm saved conversations, custom settings, budget thresholds, and allowlists are intact.

---

## 4. Restore in Split Production Docker Setup (`Dockerfile.backend`)

1. Stop only the backend container so SQLite is idle:
   ```bash
   docker compose -f docker-compose.prod.yml stop backend
   ```
2. Run the restore command inside a one-off backend container using your persistent `mj_sqlite_data` volume and production `.env.production`:
   ```bash
   docker compose -f docker-compose.prod.yml run --rm --no-deps backend \
     npm run db:restore -- --file /app/data/backups/<backup-file>.mjbak --target /app/data/mj-assistant.db
   ```
3. Start the backend again and check `/health`:
   ```bash
   docker compose -f docker-compose.prod.yml start backend
   curl -sS https://api.yourdomain.com/health
   ```

---

## 5. Rollback & Troubleshooting

- **Rollback a restore**: Stop the server and rename `<target>.pre-restore-<timestamp>.db` back to `mj-assistant.db` (deleting any `-wal` / `-shm` sidecars created after the restore).
- **`Backup decryption or authentication failed`**: Ensure `BACKUP_ENCRYPTION_KEY` (or legacy `AUTH_SECRET`) exactly matches the key active when that `.mjbak` file was generated. Never edit `.mjbak` bytes; GCM authentication rejects any alteration.
- **Database locked (`EBUSY` / `SQLITE_BUSY`) on Windows**: Stop all running Node/Vite/`tsx` processes accessing `mj-assistant.db` before running `db:restore`.

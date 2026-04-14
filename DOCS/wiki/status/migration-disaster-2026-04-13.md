---
title: Migration Disaster — 2026-04-13
source: Session log, FUCKUPS.md (#43-#45), STATUS.md
updated: 2026-04-13
staleness: none
---

# Migration Disaster — 2026-04-13

## Summary

5+ hours burned attempting to deploy PRECRIME into `BLOOMLEEDZ\precrime` with 351 legacy school principals from `ca_schools.sqlite`. Failed repeatedly due to stale migration tooling that had never been updated when the Prisma schema evolved.

## The Pipeline

```
BLOOMLEEDZ\precrime_4_13\data\ca_schools.sqlite  (351 clients, legacy)
        |
        v
  migrate-db.js --source ... --target ca_schools_migrated.sqlite
        |
        v
  build.bat (no args, from PRECRIME root) → dist\precrime-deploy-YYYYMMDD.zip
        |
        v
  Copy zip to BLOOMLEEDZ\, unzip → BLOOMLEEDZ\precrime\
        |
        v
  Copy ca_schools_migrated.sqlite → precrime\data\myproject.sqlite
        |
        v
  cd precrime && precrime.bat
```

## What Was Broken

### 1. `migrate-db.js` PC_SCHEMA was stale

The hardcoded `PC_SCHEMA` object in the migration script was missing columns and an entire table that `schema.prisma` defines:

| Table | Missing columns |
|-------|----------------|
| Client | `segment`, `dossierScore`, `contactGate`, `intelScore` |
| Config | `defaultBookingAction` |
| ClientFactlet | **entire table missing** |

Result: migrated DBs didn't match what Prisma expected. Runtime errors. The precrime agent tried to auto-fix schema mismatches, burning tokens and producing garbage.

### 2. Template DBs were stale

`data/blank.sqlite` (ships in the zip) and `data/template.sqlite` (used as migration target base) were both missing columns that had been added to `schema.prisma` over prior sessions.

### 3. No WAL checkpoint in migration script

Source DB had SQLite WAL-mode journal files (`-shm`, `-wal`) — unflushed writes. The migration script read the source without checkpointing, risking incomplete data. The output DB also produced WAL files. User caught both issues manually.

### 4. Agent repeatedly re-derived known paths

User had stated the exact directory paths (`precrime_4_13\data\`, `BLOOMLEEDZ\precrime\`, build from `PRECRIME\`) across multiple sessions. Agent spent tokens reading manifest.json, deploy.js, build.bat to "figure out" the pipeline instead of using the paths already given.

## What Was Fixed

1. **`scripts/migrate-db.js`**: PC_SCHEMA updated to match `schema.prisma` exactly. `ClientFactlet` table and aliases added. WAL checkpoint added on source (Step 0) and target (Step 6d) with residual file cleanup.

2. **`data/template.sqlite`**: `defaultBookingAction` added to Config.

3. **`data/blank.sqlite`**: `dossierScore`, `contactGate`, `intelScore` added to Client. `bookingScore`, `contactQuality` added to Booking. `ClientFactlet` table created. `defaultBookingAction` already present.

4. **Migrated DB produced**: `BLOOMLEEDZ\precrime_4_13\data\ca_schools_migrated.sqlite` — 351 clients, 23 factlets, 1 config, all verified, WAL clean.

## Binding Rule Created

**When `schema.prisma` changes, three files MUST be updated in the same commit:**

1. `scripts/migrate-db.js` — PC_SCHEMA
2. `data/blank.sqlite` — ALTER TABLE or regenerate
3. `data/template.sqlite` — ALTER TABLE or regenerate

No schema change is complete until all three are in sync.

## Fuckups Logged

- **#43**: Presented deployment pipeline as if learning it for the first time — user had already stated the exact paths
- **#44**: Migrated without checkpointing WAL, then asked permission to re-run instead of just doing it
- **#45**: Migration script had no WAL checkpoint on source or target — user caught both

## See Also

- `FUCKUPS.md` in project root — full failure log (45 entries)
- `STATUS.md` — disaster section added with root cause and fix details

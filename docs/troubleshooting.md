# Troubleshooting

Start here when installation fails, search results are poor, or behaviour is unexpected.

---

## Installation

### The first `dsh plugin add` fails and mentions `allowBuilds`

pnpm ≥10 blocks install-time build scripts by default: the first `add` may fail and mention `allowBuilds`. Add the keys it prints to the profile's `pnpm-workspace.yaml` and run it again.

This package compiles itself through a `prepare` script (`node build.mjs`) on install, so that build step is required.

### Node version requirement

`node:sqlite` is the runtime dependency: **default-enabled on Node ≥22.13**; **22.5–22.12 needs `--experimental-sqlite`**. There are no native module dependencies.

### Manual install (developers, any DSH installation, no npm)

1. Copy (or symlink) this package into the profile's `node_modules`:

   ```sh
   mkdir -p ~/.dsh/profiles/web/node_modules
   ln -s /path/to/meow-memory ~/.dsh/profiles/web/node_modules/meow-memory
   ```

   (On Windows: `New-Item -ItemType Junction ...` — NTFS junction, no admin needed.)

2. Add `meow-memory` to the profile `package.json`'s `dsh.profile.bundles`.

3. Restart `dsh web`. New sessions pick up the plugin automatically.

### Remove

```sh
dsh plugin --profile web remove meow-memory
```

---

## Retrieval and hits

### Why was there no keyword hit on the first message?

**No keyword hits run on the first turn** (they start from the second message). The first turn injects the long-term memory snapshot instead — a deliberate design, see [Design notes](design-notes.md).

Even when the first user message arrives batched with a plugin notice (e.g. an approval-policy change notification), the snapshot still lands directly before the real user message and hits never fire early.

### Poor hit rate / memories not being found

In order of likelihood:

1. **`promptLang` was never set explicitly.** `promptLang` also shapes the language the model writes memory entries in — keywords are extracted in the entry's language. **Set it explicitly on first use.** The value *is* the subdirectory name and is matched **verbatim**: a name that does not exist under `src/prompts/` (e.g. `pt`) raises nothing and silently falls back to the Chinese pack.
2. **The entry keywords are weak.** Matching is based on **entry keywords** (LLM-extracted or auto bigram), not full text — full-text matching is noisy. Correct them with `memory_update`'s `keywords`.
3. **You are looking at the list, not the answer.** `memory_search` returns a metadata view (origin + id + relative time + keywords) and **not the entry text**; use `memory_read` for the text and `memory_project` for a project's whole picture.

> A language mismatch between queries and stored entries does not degrade recall: the BM25 tokenizer is language-independent since v0.20.0 (category routing); `en` additionally enables English normalization (stopword filter + Porter stemmer), so inflected queries still hit stored entries (`tokenizers` matches `tokenizer`).

### Casual chat hit another project's memories

Unanchored hits search the global scope only, so casual chat stays unaffected. Any `memory_remember/search/update/project` call with a `project` parameter anchors that session's current project.

### What should I put in `project` for global memories?

Global information uses the **global marker** (the active language pack's `project.global` value in `labels.md`: the Chinese pack uses 「全局」, the English pack uses `"global"`), which is distinct from leaving the field blank. When it applies to several projects, separate them with commas (e.g. `"dsh, femo"`) — search and hits decide by "contains the current project name OR global".

---

## Consolidation (dream)

### dream never triggers

Check in order:

| Possible cause | Explanation |
|---|---|
| The window has not been idle long enough | A window becomes eligible after ≥ `idleMinutes` (default **180 min = 3 hours**) idle |
| It is inside a peak-hour window | **Peak-hour suppression** (computed in `timeZone`, default Asia/Shanghai): `suppressWindows` defaults to 09:00–12:00 and 14:00–18:00, plus the `suppressLeadMinutes` (default 15) before each starts. It fires on the next check cycle after the peak ends |
| The window is skipped | Restore it from the "…" menu on its session row |
| The window is too old or archived | Old windows (no live agent, >24h) and archived sessions are left alone |
| Its last chat precedes its last dream | Only windows whose last chat is newer than their last dream get consolidated |

A dream already in progress is never interrupted.

### How do I consolidate right now instead of waiting?

Type `/dream` in the composer to start consolidating this window immediately (same semantics as the `memory_dream` tool, **immune to peak-hour suppression**). It is executed by the dsh command plane, never sent to the model, and shows up in the `/` autocomplete menu. A consolidation already in progress is reported clearly instead of being started twice.

### One window should not be auto-consolidated

Open the "…" menu on that session's sidebar row and click **"跳过梦境整理记忆" (skip dream consolidation)**; click **"取消跳过梦境整理记忆" (un-skip)** to restore. Skipped windows are never picked up by the idle timer again (while `/dream` and `memory_dream` keep working), and their session row shows a **muted-gray "moon with slash" icon** at a glance. The skip flag persists across restarts and stays consistent across both instances (shared memory database).

### What do the session-list icons mean?

| Icon | Meaning |
|---|---|
| **Pale-yellow crescent moon 🌙** | dream has consolidated this session's memory and there has been no new conversation since |
| **White→gold breathing moon** | a dream turn is running (sits to the left of dsh's status dots so it cannot be mistaken for normal work) |
| **Muted-gray "moon with slash"** | this session's dream consolidation is skipped (un-skipping falls back automatically) |

Priority: **breathing > skipped > crescent**. New activity removes the icon.

### A throwaway-task workspace polluted the memory db

List it in `disabledWorkspaces`: cwd is matched exactly (path normalisation: unified slashes + trailing slash removed + case-insensitive), and a matching workspace has memory **fully disabled** (reads, consolidation and writes all refused, **including a manual `/dream`**).

---

## Data and directories

### Where does the memory live?

- Workspace level: `<workspace>/<projectDir>/memory.db` (`projectDir` defaults to `.dsh-meow`)
- Session level traces: `<workspace>/<projectDir>/sessions/<id>.json`
- Instance-level global directory (logs / window-index / prompts overrides / migrate state): decided by `homeDir`

### How do I switch the global data directory?

Just tell the AI (the `memory_home` tool) — no code and no restart. Or set a preset marker / absolute path in the settings page or the `homeDir` field.

A switch = same-volume move / cross-volume copy; **the old directory is never deleted automatically**; if the target already holds content it is enabled as-is without overwriting; an invalid `target` never switches by mistake (it reports clearly and keeps the current directory); a failure leaves data untouched and can be retried later.

> If several dsh instances on this machine share the old directory, update their settings too after switching.

### How do I back it up?

Set `backup.enabled: true`: at the end of each dream, `memory.db` is snapshotted to `memory.db.bak` (`VACUUM INTO` consistent backup, mtime-based incrementality). **Consumed at registration; a change needs a reload.**

### Will a legacy `PROJECT.md` be lost?

`autoMigrate` defaults to `true`: a legacy `PROJECT.md` is migrated when the db is first opened.

---

## Extending and languages

### Why do the UI language and the prompt language differ?

The plugin's UI copy (fold bars, delegate bubbles, session menu item, settings page) goes through a separate **UI copy layer** that follows DSH's Settings → General → Language, while injected prompts keep following `promptLang`. The two layers do not interfere.

On old hosts (no locale service) it degrades to the browser language plus the built-in dictionaries, ending at `zh`.

### How do I add a UI language?

One dictionary file plus one line in `SUPPORTED_UI_LOCALES` (no UI code changes). See [`src/i18n/README.md`](../src/i18n/README.md).

### How do I add a prompt language pack?

Prompt copy is data (one directory per language under `src/prompts/`, hot-read at runtime — no code changes needed). See [`src/prompts/README.md`](../src/prompts/README.md) for the contributor guide and `npm run check-lang`. Instance-level overrides: drop same-named slot files into `<home>/.dsh-meow/prompts/<lang>/` (partial overrides welcome).

---

## See also

- [Tool reference](tool-reference.md) — the seven tools' parameters and returns
- [Configuration reference](configuration-reference.md) — every configuration field
- [Design notes](design-notes.md) — why it is designed this way

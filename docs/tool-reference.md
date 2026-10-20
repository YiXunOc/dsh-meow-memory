# Tool reference

The seven memory tools meow-memory registers, with every parameter and return value. Tools fall into three permission bands: **read** (search / read / find_similar / project), **write** (remember / update / dream), **directory** (home).

> Tool descriptions and returned copy follow the `promptLang` language pack, so under the English or Portuguese pack the descriptions in these tables appear in that language.

---

## At a glance

| Tool | Band | Purpose |
|---|---|---|
| `memory_remember` | write | Write one memory: content / project / keywords / importance required |
| `memory_search` | read | Keyword search (BM25 × recency weight) |
| `memory_project` | read | Fetch a project's whole-project injection paragraph |
| `memory_find_similar` | read | Duplicate and conflict detection |
| `memory_read` | read | Read one entry's complete metadata by id |
| `memory_update` | write | Correct status / importance / goal / keywords / content by id |
| `memory_dream` | write | Manually trigger this window's consolidation (same semantics as `/dream`) |
| `memory_home` | directory | Inspect / switch the global data directory |

> There is also the `/dream` user command (typed straight into the composer) — same semantics as the `memory_dream` tool, immune to peak-hour suppression.

---

## `memory_remember` — write

`content` / `project` / `keywords` / `importance` are required; **a missing one raises its own error and asks you to fill it in**. Writes deduplicate and merge automatically and return a read-back confirmation (keywords, project).

| Parameter | Type | Default | Notes |
|---|---|---|---|
| `content` | string | — | Required. The memory body |
| `project` | string | — | Required. Project name; global information uses the global marker |
| `keywords` | string[] | — | Required. Retrieval keywords (hits are keyword-based, not full-text) |
| `importance` | integer | `1` | Required. Weight, participates in hit scoring |
| `level` | enum | `fact` | One of `soul` / `user` / `project` / `fact` / `lesson` / `topic` / `rules` |
| `subcategory` | enum | — | Only honoured when `level=project`: `overview` / `structure` / `decisions` / `quotes` / `ops` / `todo` |
| `goal` | string | — | Goal sentence (used by the `topic` layer) |
| `corrected` | boolean | `false` | Whether this is a correction-type memory |

**Returns**: `ok` / `id` / `level` / `merged` (whether it merged into an existing entry) / `keywords` / `project`.

> A missing `keywords` and a `keywords` that yields nothing after parsing return **different error messages** (issue #24).

---

## `memory_search` — search

BM25 × recency weight. Default `k=10`, selected as **the top 5 by relevance (seen entries and entries created in this session are *not* excluded) + 5 more filled from further down the ranking while skipping already-seen entries**, ordered by memory timestamp.

| Parameter | Type | Default | Notes |
|---|---|---|---|
| `query` | string | — | Required. Query terms |
| `level` | string | — | Filter by layer |
| `project` | string | — | Filter by project; **comma-separated multi-select (OR semantics)** |
| `status` | string | — | Filter by status; **comma-separated multi-select (OR semantics)** |
| `days` | integer 1–3650 | — | Search only the last N days |
| `k` | integer 1–50 | `10` | Maximum hits |
| `content_max` | integer 0–5000 | `300` | Per-entry truncation length |

**Returns**: `note` + `hits[]`. Each hit is a **metadata view** — origin + full id + relative time + keyword list, and **not the entry text**.

> To browse a project's whole picture use `memory_project`, not a hand-assembled search.

---

## `memory_project` — project panorama

Fetch one project's complete injection paragraph.

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `project` | string | **Yes** | Which project do you want to see? |

**Output rules**:

- Non-`todo` subcategories: every `active` entry
- `todo` subcategory: all `active` entries as the to-do list, plus the latest 5 `stale` (done) entries by `updated_at` as the completed list
- Within a group, ordered oldest → newest by memory timestamp; only `content` plain text is concatenated

**Side effect** (important): passing a non-global, non-multi-project value **anchors the current session's project** — subsequent keyword hits follow that project immediately; the project is also recorded in this session's "consulted" list so the panorama can be re-injected after session compaction.

---

## `memory_find_similar` — duplicate check

| Parameter | Type | Default | Notes |
|---|---|---|---|
| `id` | string | — | Required. Reference memory id |
| `k` | integer 1–20 | `5` | Number of similar entries to return |
| `content_max` | integer 0–5000 | `200` | Truncation length |

---

## `memory_read` — read one entry

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `id` | string | Yes | Memory id |

Returns that entry's complete metadata (keywords / status / importance / goal / timestamps and so on).

> Only a single `memory_read` records the "consulted" trace; a full `memory_project` panorama does not (the third dream round re-checks projects specifically).

---

## `memory_update` — correct

| Parameter | Type | Notes |
|---|---|---|
| `id` | string | Required |
| `content` | string | Rewrite the body |
| `status` | enum | `active` / `archived` / `stale` |
| `importance` | integer | Weight |
| `goal` | string | Goal sentence |
| `project` | string | Project attribution |
| `keywords` | string[] | Manually correct keywords |

> `updated_at` (the memory timestamp) is refreshed by `memory_update` or by dream stamping; every displayed timestamp is `updated_at`.

---

## `memory_dream` — manual consolidation

No parameters (the scope is fixed to this window). Same semantics as the `/dream` command and **immune to peak-hour suppression**.

> A consolidation already in progress is reported clearly instead of being started twice.

---

## `memory_home` — global data directory

Inspect or switch the instance-level global data directory (logs / window-index / prompts overrides / migrate state).

| Parameter | Type | Notes |
|---|---|---|
| `target` | string | Omit to only inspect the current directory and the preset locations; pass a preset marker or an absolute path to switch |

**Three preset markers**:

| Marker | Location |
|---|---|
| `default` | The platform user home directory |
| `dsh-storage` | `<DSH home>/storages/meow-memory` |
| `plugin-root` | `<plugin root>/storage` |

**Switch behaviour**: same-volume move / cross-volume copy; **the old directory is never deleted automatically**; if the target already holds content it is enabled as-is without overwriting; an invalid `target` never switches by mistake (it reports clearly and keeps the current directory). A failed switch leaves data untouched and can be retried later.

> If several dsh instances on this machine share the old directory, update their settings too after switching.

---

## Layers and subcategories

| Layer | Meaning |
|---|---|
| `soul` | The AI itself |
| `user` | User basics and preferences |
| `project` | Project information (with `subcategory`) |
| `fact` | Atomic facts |
| `lesson` | Mistakes and corrections |
| `topic` | Ongoing discussion arcs (with a `goal` sentence) |
| `rules` | Design principles and behavioral rules |

`project` subcategories: `overview` / `structure` / `decisions` / `quotes` / `ops` / `todo`.

**Global marker**: the `project.global` value of the active language pack's `labels.md` (the Chinese pack uses 「全局」, the English pack uses `"global"`). It follows `promptLang` — otherwise a `"global"` written by the model under the English pack would be treated as a project literally named global: global rules would stop being injected and a phantom project would appear in the project list.

---

## See also

- [Configuration reference](configuration-reference.md) — every configuration field
- [Design notes](design-notes.md) — why it is designed this way
- [Troubleshooting](troubleshooting.md) — install failures, poor search results, reading errors

# Changelog

- Every active local run backs up automatically, including old local-recovery bookmarks. No enable-sync button or permanent local-only mode.

- Online saves recover into independent browser backup streams, preserving old copies. Continuous play syncs within 30 seconds; long adventure histories and temporary ledger failures no longer block new run publication.

Player-facing updates to [neohack.dev](https://neohack.dev).

## Unreleased

- WebMCP runs retain their automation flag and optional harness/model names across
  reloads and control handoffs. The ledger badge shows that attribution.
- Agent actions play back at a readable pace while execution works ahead. Long
  queues accelerate; Go live catches up without taking a game turn. Human input
  catches up before selecting a target or answering a question.

- Nearby actions (stairs, containers, doors) sit above Search and always show
  their hotkeys. Open container and Open door glow like a hungry Eat cue.
- `go`/`explore`/`descend` now say why there is no known path: occupied, unknown,
  closed door or disconnected, with a next-tool hint. Partial legs point at recover
  instead of inviting a blind retry.
- More actions includes auto:explore (`v`) and auto:descend: walk perceived
  frontiers, remembered downstairs, or into adjacent darkness. They stop for
  choices, damage and hunger, not every newly seen creature. Right-click a
  remembered square to walk there. These are neohack helpers, not vanilla NetHack
  commands. Escape ends the current walk.
- The ledger can hide missing or broken replay links without removing adventures,
  scores or written tales. Archive audits verify complete recordings and compact
  both input logs and older public frame files while retaining existing links.
- Replay uploads are combined into larger compressed CDN files instead of one
  file per sync. Playback still starts with a small opening scene, and exact
  retries, checkpoints and original engine pins are preserved.
- Replay links open a dedicated page with the adventure's tale above the player.
  New tales appear as they are written, with replay progress first and tapped
  names opening compact encyclopedia popovers.
- Long replays fetch several recording chunks ahead while preserving their
  exact order and integrity checks.
- Smoother dungeon rendering: static scenery and sprites are reused while camera
  movement, animation and visibility fades run through the browser compositor.
- Thin, muted scrollbars now match across the game, ledger, workshop, account
  dialogs and replay viewer, including embedded and offline views.
- More actions opens with Ctrl+K (Cmd+K on Mac), with fuzzy search and highlighted
  matches. Item and spell choices stay in the same compact dialog; Escape returns
  to actions, preserving the search. Targets and warnings remain explicit.
- Replay details follow the moment being watched. Final location, turns and
  outcome are kept under Run totals, rather than appearing to describe the
  opening scene.
- More actions now includes Chat: search `chat`, then choose whom to talk to.
  This reaches the Oracle's consultations and other conversations through the
  game's own dialogue and explicit choices.
- More actions is a compact searchable menu. Open it with `#`, type an action or
  command, and press Enter to try the selected match. Shortcuts stay visible and
  buttons use consistent, tighter spacing with larger targets on touch screens.
- Inspected map tiles have a clear outline beneath creatures and items. It follows
  keyboard selection and disappears when tile options close.
- The ledger opens with a chart of the latest 200 updated adventures, colored by
  class. Filter classes, compare turns with depth or hero level, and select a run
  for its replay. Today's and the last seven days' level and depth leaders appear
  below, using UTC dates.
- The front page shows the total games played, with a link to the ledger.
  Loading this count never delays entering the dungeon or playing offline.
- The top bar brings game controls together. Inspection stays in one place,
  offers numbered shortcuts and opens contextual encyclopedia entries with a
  return to the same tile or item.
- Thirty equipment and statue sprites appear consistently on the map, in the
  backpack and in the HUD, using only perceived shapes and statue subjects.
- Agents use shorter, consistent commands across browser and native MCP. Item
  actions use explicit item IDs, and each question shows how to answer it;
  inspecting a square provides ready-to-use action arguments.
- Agent observation queries keep your backpack, selected equipment and keyboard
  focus in place. Agent actions still clear outdated equipment selections.
- Restoring an online backup uses its latest valid level checkpoint before
  replaying the remaining actions. The full action history stays intact.
- Agent-assisted adventures retain their WebMCP attribution when another tab
  sends an older manual-play summary.
- Long adventurer names stay clear of the level label on phones and desktop.
- Long journal messages stay compact over the map; opening the journal still
  shows the full original text.
- New adventures register for online backup before sending their first batch,
  avoiding temporary access errors while play continues locally. Closing a run
  cancels pending network work promptly and keeps unsent inputs for later.
- Agent answers stay bound to the question they were given, so an older answer
  cannot confirm a different action after another player changes the prompt.
- Phone equipment slots and instructions fit above Automatic pickup, including
  on tall phones with a height-limited character sheet.

- Different tabs can play independent adventures. Opening the same run transfers it safely, with a Play here button in the previous tab and no lost or repeated moves.
- Search the game's encyclopedia from the menu, with readable lore on desktop and phone. Reading costs no turns and works offline.
- Agent exploration can cover several frontiers within an explicit action budget, stopping for decisions and changes in health, hunger or conditions.
- Older recordings upload in bounded batches and recover an interrupted upload without duplicating replay steps.

- New runs record compact action logs instead of copying the map after every move. Backup happens quietly in the background and retries after reconnecting.
- Replays start from static CDN files and play locally, including in embeds. Real level checkpoints speed up resume and seeking.
- Install the game for offline play, new adventures and local resumption. Workshop scripts save their source locally before starting; account outages do not stop a test.

- Local adventures open without waiting for cloud downloads. Startup shows its current stage, with slow starts reported privately for diagnosis.

- A conflicting online save no longer blocks starting or resuming local games. Independent backup streams retain both copies.

- Failed resumes offer Open local copy while continuing automatic background backup.

- Destination walking follows known routes across the level instead of stopping after eight actions. Real decisions and changed circumstances still pause movement.

- Container dialogs keep transfer actions visible while compact item lists scroll independently.
- Double-click a map square to walk there; successful arrival stays quiet.
- Large cloud saves upload in bounded chunks, and sync failures stay in the save status instead of covering the game.
- Browser agents can connect using older WebMCP implementations.

- Select a map square to preview a known route and walk one bounded leg. Stop walking or Escape cancels further steps; new circumstances and choices pause the journey.

- Account owners can make a recorded run public and share its replay while keeping saves, script source and notes private.

- Replays begin after their first frames arrive, buffer in the background and use CDN-cacheable public chunks.

- The adventure ledger focuses on runs and replays; operational error reports now go to private Vercel logs.

- Equipment stays visible beside a scrolling bag, with highlighted destinations,
  exact ring-hand selection and a tap-to-equip alternative to dragging.
- Temporary online-save and public-replay failures retry in the background; pending
  uploads stay in this browser through reloads.
- The HUD and sheet share status labels, and journal scrolls follow actual engine
  passages instead of grouping ordinary messages into apparent stories.
- Public ledger statistics can be rebuilt without deleting run history.

- A redesigned character sheet puts stats beside the portrait, equipment in a
  paper-doll layout, and item icons/actions in a compact scrolling bag. Drag equipment
  to request Wear or Wield; normal engine decisions still apply.

- Clearer phone HUD and journal spacing, a bounded character sheet, readable
  status labels, and steadier workshop navigation and replay loading feedback.

- A redesigned workshop chooser pairs a short code preview with clear starter
  examples, private saved scripts, and a mobile layout that scrolls naturally.

- A compact ledger provides explicit Show replay buttons and a “With replay”
  view. Missing recordings stay clearly marked; error reports have a prominent summary.

- New adventures suggest editable, rerollable names instead of always using Ada.
- Short journal notices stay inline; readable scrolls require at least four lines.

- Restored missing ledger history after the hosting move. Storage outages now show
  an explicit notice; fresh adventures can still start and resume in this browser.

- A character sheet separates worn gear, ready weapons and carried items, with
  exact equipment positions, attributes and mobile Equipment/Backpack views.
  Removing equipment updates the sheet immediately; unknown assignments stay unknown.

- Full story passages can be reopened as journal scrolls; your opening story appears
  automatically after character creation.

- Cleaner backpack entries with a compact row of action icons.
- Corrected door, wall and cave-rock overlaps, plus more natural layering of
  characters and ground objects.

## 2026-09-06 — A more welcoming dungeon

- **Walk into your adventure.** The welcome courtyard introduces playing,
  bringing an agent, and building something new. Click the glowing doorway to
  walk inside. Character creation offers thirteen classes and keeps its submit
  button within reach on small screens.
- **A richer world.** Dungeon, damp stone and cave appearances add variety that
  stays consistent when you revisit a level. Better wall cutaways keep nearby
  occupants readable. Characters and companions have consistent scale, with
  distinct art for more encounters. Optional footsteps, door and combat sounds
  start muted.
- **More comfortable controls.** Move with WASD, arrows or the direction pad;
  search with F. Scroll to zoom and middle-drag to look around. A faint classic
  symbol map sits above the pad, and contextual controls keep stairs and nearby
  interactions close at hand.
- **Clearer actions and prompts.** Backpack items expose their available actions.
  Known unavailable actions explain why, and drinking works at a fountain underfoot.
  Map-browsing prompts now offer visible Help, Done and Cancel controls. Warnings
  and consequential choices still ask for your answer.
- **Easier container transfers.** Inspect a container, then choose what to take
  and what to put away in one dialog. Review your selections before applying them,
  or use Take everything to select the contents.
- **Automatic pickup, your way.** Start with Gold + arrows, then choose item
  categories and whether to leave corpses or known cursed items. Edit preferences
  during creation, from the game menu or from Backpack. Choices are remembered
  for future characters in the same browser.
- **Come back to your run.** Bookmark an adventure to resume it later. Online
  saving runs in the background after five idle seconds, with clearer save status
  and improved recovery from interrupted sessions and competing tabs.
- **A public adventure ledger.** Visit [/dashboard](https://neohack.dev/dashboard)
  to browse successful runs, class activity and overall adventure totals.
  Results are labeled as browser-reported.
- **Your own adventure history.** Sign in with a passkey to keep a private history
  of runs and watch recorded moments back, with account controls available across
  the site.
- **Bring an agent—or make one.** A WebMCP walkthrough helps an agent play the
  adventure you watch in the browser. The new
  [Ascender workshop](https://neohack.dev/bots) adds an editor, a Curious imp
  starter, a live dungeon view and a Stop button for trying your own bot.

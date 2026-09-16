# Interactive presentation template

## Overview

A reusable web presentation with three surfaces connected in real time:

| Surface | Purpose |
| --- | --- |
| **Stage** (`/`) | Present slides, live or final poll results, approved messages, interactive exams, and a QR code for joining. |
| **Audience** (`/participar/`) | Vote, post public messages, send private questions, explore exams on a phone, and optionally join the points ranking. |
| **Control room (régie)** (`/regie/`) | Manage the session, polls, points, messages, questions, and uploaded studies. Use **Settings** to edit the presentation. |

A Cloudflare Worker serves the pages and handles presenter authentication. A
SQLite-backed Durable Object named `Room` stores the session and synchronizes
clients over WebSockets. Cloudflare's free plan is enough to run the template
within its usage quotas; it supports the configured SQLite-backed Durable
Object. See [Cloudflare's Durable Objects pricing and free-plan limits](https://developers.cloudflare.com/durable-objects/platform/pricing/).

## Getting started

Use Node.js 20 or newer and npm. A Cloudflare account is needed for deployment.

```bash
npm install
npm run dev
```

Open these three local URLs:

| Surface | Local URL |
| --- | --- |
| Stage | `http://localhost:8787/?k=change-this-key` |
| Audience | `http://localhost:8787/participar/` |
| Control room | `http://localhost:8787/regie/?k=change-this-key` |

The stage and control room use the development key `?k=change-this-key` from
`wrangler.jsonc`. After validating it, the Worker creates a private presenter
session cookie and redirects to the same URL with the key removed. The audience
page is public and needs no key.

The audience link and QR code use the stage's current origin. To join from real
phones, open the stage through a deployed or network-reachable address; a phone's
`localhost` points to the phone itself.

## Customize

Click **Settings** in the stage toolbar, or open the control room and select
**Settings**. Locally, use `http://localhost:8787/regie/?k=change-this-key#settings`.
The form edits the title and subtitle, presenter and contact links, citation,
brand and colors, the Canvas IP/URL, total and per-slide timing, and slide text
and lists.
Changing the presentation title also updates cover titles that still match it.

Click **Save settings** to apply changes to connected stage and audience pages
without reloading them. The current slide, running timer, exam viewers, and
audience drafts stay in place. Settings persist in the room's storage across
page reloads and session resets. **Discard changes** returns to the latest saved
values. **Restore defaults** fills the form with the template defaults; click
**Save settings** to apply them. A stale draft cannot overwrite another control
room's save.

[public/presentation.config.js](public/presentation.config.js) still defines the
template defaults, activity definitions, and slide order. Edit that file to add
or reorder slides and configure polls, boards, and exams. Saved settings override
the editable defaults without modifying this file.

| Setting | What to change |
| --- | --- |
| `title`, `subtitle` | Presentation name and default cover description. Set the cover slide's own `title` to match when renaming the template. |
| `presenter.name`, `presenter.role` | Presenter identity shown in the closing contact section. |
| `presenter.contact` | `email`, `linkedin`, and `github` links for the stage and audience closing sections. |
| `citation.text`, `citation.url` | Citation text and source link displayed on the closing slide. |
| `brand.name`, `brand.colors` | Brand identity and the color tokens `background`, `surface`, `text`, `muted`, `accent`, and `accentStrong`. |
| `features.canvas` | Configure this in **Settings → Canvas**: enable it, enter the Canvas server URL (IP or hostname, such as `http://192.168.0.10:8086/`), and set its toolbar label. The template default is disabled with an empty URL. |
| `features.points.enabled` | Initial value of the control room's **Points system** toggle. The template defaults to `false`; a full reset restores this default. |
| `timing.totalMinutes` | Planned total presentation time, initially 30 minutes. |
| `timing.slides` | Planned minutes keyed by slide ID, such as `{ 'poll-live': 5, 'exam-1': 8 }`. |
| `polls` | Polls keyed by activity ID, with `question`, `type`, and `options: [{ id, label }]`. An optional `correct` option ID makes a single-choice poll scored. |
| `boards` | Public boards keyed by activity ID, with `title` and a default `moderation` mode: `auto` or `manual`. The control room can change the mode during a session. |
| `exams` | Exam entries keyed by activity ID, each with `title`, `studyId`, and `src` pointing to a packaged `study.js`. |
| `slides` | Ordered slide objects using the composable schema below. |

Polls support `type: 'single'` and `type: 'multiple'`. A multiple-choice poll can
define an `exclusive` option ID: selecting it clears the other choices, and
selecting another choice clears it. Use `correct` with a single-choice poll;
scoring awards a point only for an exact match to that option ID.

For example, a scored poll entry inside `CONFIG.polls` can be:

```js
diagnosis: {
  question: 'What is the most likely diagnosis?',
  type: 'single',
  correct: 'infection',
  options: [
    { id: 'infection', label: 'Infection' },
    { id: 'trauma', label: 'Trauma' }
  ]
}
```

For timing, declared slide durations are added first. Slides without a duration,
except covers, share `max(0, totalMinutes - declaredMinutes)` equally. An
undeclared cover receives zero minutes. In the default 30-minute schedule, the
declared slides use 26 minutes, including two minutes for `cloudflare-hosting`,
so `poll-results`, `exam-1-continued`, `pause`, and `exam-2-results` each receive
one minute. The break title “Back in 5 minutes”
is slide text; set `timing.slides.pause` to `5` if the break should receive five
minutes in the pace schedule.

## Slides

Each slide has a unique ID and a layout type. Use `content` to combine a stage
poll, board, exam, and supporting text. The `cover`, `pause`, and `closing`
types have dedicated layouts. Audience overrides apply to every slide type.

| Field | Meaning |
| --- | --- |
| `id` | Required unique string matching `^[a-z][a-z0-9-]*$`; used by navigation, room state, and timing. |
| `type` | `cover`, `content`, `pause`, or `closing`. |
| `eyebrow` | Small label above the title. |
| `title` | Slide heading; falls back to `CONFIG.title` when empty. |
| `description` | Descriptive text. Covers fall back to `CONFIG.subtitle`; on content slides it is supporting text when no board, explanation, or items take priority. |
| `items` | Array of supporting bullet strings on a content slide. |
| `topics` | Array of topic strings displayed on a cover slide. |
| `explanation` | Supporting text on a content slide with no stage board; takes priority over `items` and `description`. |
| `poll` | Key in `CONFIG.polls` to display on a content slide and apply automatic poll open/close behavior. |
| `pollResults` | `live` (default): updating bars, counts, and percentages. `hidden`: options without counts. `final`: entering the slide closes and locks the poll, and the stage displays its results. |
| `board` | Key in `CONFIG.boards` whose approved messages appear on the stage. |
| `exam` | Key in `CONFIG.exams` for the stage viewer. It occupies the primary column; a poll and supporting content can appear beside it. |
| `audiencePoll` | Override the phone poll with a poll key or `null`. When omitted, phones get `poll` unless `pollResults` is `final`. |
| `audienceBoard` | Override the phone's public message form with a board key or `null`. Defaults to `board`. |
| `audienceExam` | Override the phone viewer with an exam key or `null`. Defaults to `exam`; set it explicitly to keep an exam on phones during a text or results slide. |
| `questions` | Whether phones offer private questions. Defaults to `true` when the slide has no stage `board`, otherwise `false`. An `audienceBoard` alone does not change that default. |

[public/assets/slides.js](public/assets/slides.js) derives the audience surface
from these fields. A closing slide also enables the audience contact section.
Audience overrides choose what phones show; they do not open or close a poll.
An audience-only poll must already be open or be opened in the control room.

Entering a slide with `poll` opens that poll unless it is locked. Entering its
`final` slide, or pressing **Close** in the control room, closes and locks it.
Returning to an earlier slide does not reopen a locked poll; **Open** in the
control room clears the lock. Moving to an unrelated slide does not close a
previously opened poll.

### The eleven template slides

The table describes the default configuration. If points are enabled, phones
also show registration or the participant's current score on every slide.
Phone polls show answer controls; the result bars are on the stage.

| # / Slide ID | Stage | Phones |
| --- | --- | --- |
| 1. `cover` | Presentation title, subtitle, topics, audience QR code, and connected audience count. | Private question form. |
| 2. `poll-live` | Continent poll with live results and approved messages from the `region` board. | Continent vote and a public message form with a required author name. |
| 3. `poll-secret` | Age-range options with counts hidden, plus an explanation of voting and private questions. | Age-range vote and private question form. |
| 4. `poll-results` | Final age-range results; entering closes and locks the `age` poll. | Private question form; the age poll is no longer offered. |
| 5. `exam-1` | Abdominal CT viewer, live `exam-1` results, and approved discussion messages. | Abdominal CT viewer, diagnosis vote, and public discussion form with automatic publication by default. |
| 6. `exam-1-continued` | Three discussion bullets. | The abdominal CT viewer and `exam-1` poll remain available through audience overrides. Voting continues while the poll is open; board and private question forms are absent. |
| 7. `pause` | Break title and an invitation to ask the speaker questions. | Private question form. |
| 8. `exam-2` | Brain MR viewer and `exam-2` options with counts hidden. | Brain MR viewer, diagnosis vote, public discussion form requiring approval by default, and private question form. |
| 9. `exam-2-results` | Final `exam-2` results and approved discussion messages; entering closes and locks the poll. | Brain MR viewer and public discussion form; the diagnosis poll and private question form are absent. |
| 10. `cloudflare-hosting` | A plain-language guide to creating a Cloudflare account, preparing the template, protecting presenter access, publishing, and sharing the audience link. | Private question form. |
| 11. `closing` | Thank-you message, citation, presenter contact, and ranking when points are enabled and participants exist. | Presenter contact and private question form, plus the personal points card when enabled. |

## Stage toolbar

The bottom toolbar is available on every slide:

- **Previous / slide counter / next:** click the counter to open a menu above
  the toolbar, then select a numbered slide title to jump there.
- **Pace timer:** click to start or pause; double-click to reset to zero and
  ready. It starts automatically on the first move to a non-cover slide.
  Elapsed time excludes time spent paused. Drift compares elapsed time with the
  scheduled start of the current slide: more than 45 seconds ahead is **early**,
  more than 45 seconds behind is **late**, and the interval between is **on pace**.
- **Total time:** shows `timing.totalMinutes`. Its tooltip lists each slide's
  planned duration and start time.
- **Audience link:** opens `/participar/` in a new tab.
- **QR:** opens a large overlay containing the audience QR code and URL. Press
  Escape or click the overlay to close it.
- **Canvas:** when enabled, opens the configured URL in an iframe dialog. The
  iframe URL is assigned only on the first open. Close with Escape, the close
  button, or the dialog backdrop. Set the URL to a page the stage browser can
  reach and embed.
- **Settings:** opens the control room's Settings section in a new tab using
  the existing presenter session.
- **Fullscreen:** enter or exit browser fullscreen.

Keyboard shortcuts:

| Key | Action |
| --- | --- |
| Right arrow, Page Down, Space | Next slide. |
| Left arrow, Page Up | Previous slide. |
| Home / End | First / last slide. |
| `F` | Toggle fullscreen. |
| Up / Down on the slide counter | Open the slide menu. |
| Up / Down, Home / End in the menu | Move through slide choices. Enter or Space activates the focused choice. |
| Escape | Close the slide menu or an open dialog. |

Slide shortcuts yield to focused controls, open menus or dialogs, and the DICOM
viewer so those components can handle their own input. The pace timer belongs
to the stage page; it is not stored in the shared room state.

## Points system

Turn on **Points system** in the control room to show **Join the ranking** on
phones. Registration requires a name of 1–60 characters and an email of at most
120 characters. Participants can use **Change** to edit their registration.

**Email is the identity:** the server trims and lowercases it, then derives a
participant ID from its hash. Registering the same email on another device
restores the same participant, selections, and score; the latest submitted
name becomes the display name. Existing anonymous device votes migrate to that
participant. If the participant already has an answer to a poll, that answer
takes priority over the device's anonymous answer, which is removed to avoid
double counting.

Scoring rules:

- Each single-choice poll with a `correct` option awards one point for that
  answer. Wrong or unanswered polls award zero points; there is no speed bonus.
- Polls without `correct` are unscored. Both template diagnosis polls use
  `correct: 'neoplasia'`, giving a maximum of two points.
- Scores reflect current answers, including while a poll is open. Participants
  can change an answer until the poll closes. After closure, answers are locked
  unless the control room explicitly reopens the poll.
- Anonymous participants can vote but are never ranked. Registering links their
  eligible votes to their participant identity.
- Ranking sorts by score descending, then name alphabetically; equal scores
  share a rank. The closing stage shows up to 20 participants, the control room
  previews the top 10, and each registered phone shows its own score.

The control room offers three reset scopes, each with a confirmation:

| Action | Effect |
| --- | --- |
| **Reset** on one poll | Clears that poll's votes and updates scores. Keeps its current open/closed and locked state. |
| **Reset all polls** | Clears all votes and updates scores. Keeps poll open/closed states, registrations, messages, questions, and uploaded exams. |
| **Full reset** | Clears votes, board messages, private questions, participants, device registrations, and all stored uploads. Restores configured points and moderation defaults and the library exams. Polls return to their initial closed, unlocked state; the current slide is kept. |

## Messages

### Public boards

A public message requires an author name of 1–60 characters and text of 1–400
characters. The phone offers a posting form; the stage shows approved messages
with their authors when a slide includes that board.

- **Automatic moderation (`auto`):** new messages are approved immediately.
- **Manual moderation (`manual`):** new messages wait for approval in the
  control room before appearing on the stage.

The `region` and `exam-1` boards default to automatic publication; `exam-2`
defaults to manual approval. The control room can change the mode and approve,
reject, or delete individual messages. Each voter can have up to five pending
messages per board and must wait at least two seconds between public messages.

### Private questions

Private questions contain 1–400 characters and an optional name of up to 60
characters. Leave the name empty to appear as **Anonymous**. These questions
appear only in the control room, where the presenter can mark them answered,
reopen them, or delete them. Each voter can have up to five unanswered questions.
The slide's `questions` setting controls whether the phone offers this form.

## Interactive exams

### Built-in library

The bundled studies are served from `public/dicom-slide/exams/library/`:

| Config key | Study ID | Dataset and attribution |
| --- | --- | --- |
| `abdomen-ct` | `visible-human-abdomen-ct` | Visible Human Male abdominal CT. **Courtesy of the U.S. National Library of Medicine.** |
| `brain-mr` | `mri-dir-t1-mr` | MRI-DIR synthetic T1 MR, case `MRI-DIR-T1_1`, from The Cancer Imaging Archive. Licensed under CC BY 4.0; retain the dataset citation and acknowledgements in [DATA_LICENSES.md](DATA_LICENSES.md). |

The stage and phones each mount an interactive study viewer for the selected
exam. `audienceExam` can keep the viewer available on phones while the stage
moves to discussion or results. See [DATA_LICENSES.md](DATA_LICENSES.md) for
dataset provenance, transformations, attribution, and intended use.

### Upload a DICOM folder or ZIP from the stage

1. On a stage slide with an exam, select **Upload DICOM study** for a folder or
   **Choose ZIP** for an archive.
2. The importer converts the selected DICOM files in the browser and prepares
   the study, series manifests, and encoded image chunks. The progress display
   moves from **Converting…** to **Uploading…**.
3. The stage uploads the converted package to the Durable Object using the
   presenter session. Image chunks are base64 text in pieces of **at most
   1.5 MB** (`1.5 × 1024²` bytes). Metadata has separate limits: 256 KB for the
   study description and 2 MB per series manifest. The total encoded package
   is capped at **1 GB per exam** (`1024³` bytes).
4. Before publishing, the server verifies that every required part is present
   and strips patient/source identifier metadata through a field allowlist.
   It removes `studyInstanceUID`, removes manifest source metadata, and keeps
   only `importedLocally` and `dicomFileCount` from study source metadata.
   Study and series titles and image pixels are retained; this step does not
   redact identifying text in titles or burned into images.
5. Commit makes the upload the replacement for that exam key and broadcasts
   its descriptor. The stage and every phone displaying that exam load the new
   study. Versioned `/api/exams/` URLs serve the viewer assets with `Cache-Control:
   no-store`. Every request checks storage; uploaded exam assets bypass the
   Cloudflare edge cache.

In the control room's **Exams** section, **Remove uploaded study** deletes the
stored replacement and restores that exam's built-in library study. A new
successful upload also removes the previous stored replacement for that exam.
**Full reset** deletes all stored uploads, including incomplete uploads.
Removal, replacement, and full reset make subsequent requests for deleted assets
return 404. When upgrading from a deployment that used one-year immutable caching,
purge its Cloudflare cache. Copies already cached in browsers by that older
deployment cannot be remotely revoked and may remain until their original expiry;
the new policy prevents future responses from being cached.

### Convert your own studies for the library

Use the conversion and packaging tools in
[dicom-slides](https://github.com/ThalesMMS/dicom-slides) to prepare a reusable
study package. Follow that project's conversion instructions, place the
generated study directory under `public/dicom-slide/exams/library/`, and add a
`CONFIG.exams` entry with its `studyId` and `/dicom-slide/exams/library/.../study.js`
URL. Reference the exam key from `exam` or `audienceExam` on your slides. Record
the new dataset's source, license, and required attribution in
[DATA_LICENSES.md](DATA_LICENSES.md).

## Deploy

Cloudflare puts the presentation online so the audience can join from their
phones. It hosts the slides and runs the live voting and messaging together.

1. Create a [Cloudflare account](https://dash.cloudflare.com/sign-up), install
   the current LTS version of [Node.js](https://nodejs.org/), and download and
   unzip this project from GitHub if you have not already done so.
2. Open Terminal in the project folder. Run these commands one at a time to
   install the required tools and connect your Cloudflare account. The second
   command opens your browser so you can sign in and approve the connection:

   ```bash
   npm install
   npx wrangler login
   ```

3. In [wrangler.jsonc](wrangler.jsonc), set `name` to a name for your presentation,
   such as `my-presentation`. Use lowercase letters, numbers, and hyphens.
   Remove the development `PRESENTER_KEY` entry from `vars`, leaving `"vars": {}`.
   Then run the following command and enter a long, private password when asked.
   Cloudflare stores it as a secret called `PRESENTER_KEY`. If asked to create
   a Worker with your chosen name, accept:

   ```bash
   npx wrangler secret put PRESENTER_KEY
   ```

4. Publish the presentation:

   ```bash
   npm run deploy
   ```

   This uploads the Worker, Durable Object, and static assets together. Follow
   any prompts to choose your account or a `workers.dev` address. When it
   finishes, the command prints the presentation's web address.

5. Open that address with `/?k=YOUR_PRESENTER_KEY` for the stage, or
   `/regie/?k=YOUR_PRESENTER_KEY` for the control room. Replace the placeholder
   with your password (URL-encode it if it contains special characters).
   Share only the address ending in `/participar/`, or the audience QR code,
   with participants. Keep the password and presenter links private.
   This query-string login can expose the key in browser history, copied links,
   request logs, and referrer data. Do not bookmark or distribute these links.
   Rotate `PRESENTER_KEY` with `npx wrangler secret put PRESENTER_KEY` after each
   presentation and immediately after any suspected exposure; log in again with
   the replacement key. Treat existing presenter sessions as compromised too.

These steps follow Cloudflare's [publishing guide](https://developers.cloudflare.com/workers/get-started/guide/)
and [secret configuration guide](https://developers.cloudflare.com/workers/configuration/secrets/).

## Test

```bash
npm test
```

This runs the Node.js test files under `tests/` using the package's test script.

## Project structure

```text
web-presentation-template/
├── public/
│   ├── index.html                    Stage and toolbar
│   ├── participar/index.html         Audience phone interface
│   ├── regie/index.html              Control room
│   ├── presentation.config.js        Presentation content and defaults
│   ├── assets/
│   │   ├── slides.js                 Audience mapping and pace schedule
│   │   ├── stage-exam.js             Stage viewer and browser upload flow
│   │   ├── sync.js                   Shared WebSocket client and QR helpers
│   │   ├── qrcode.js                 QRCode.js
│   │   ├── styles.css                Shared and stage styles
│   │   ├── audience.css              Audience styles
│   │   └── regie.css                 Control room styles
│   └── dicom-slide/
│       ├── runtime/                  DICOM Slides viewer runtime
│       ├── importer/                 Browser DICOM importer
│       │   └── vendor/               CharLS and OpenJPEG WASM decoders
│       └── exams/library/
│           ├── visible-human-abdomen-ct/
│           └── mri-dir-t1-mr/
├── src/worker.js                     HTTP routes, authentication, and Room
├── tests/                            Configuration and Worker tests
├── LICENSES/                         Bundled license and dataset notices
├── DATA_LICENSES.md                  Dataset attribution and provenance
├── THIRD_PARTY_LICENSES.md           Third-party software notices
├── wrangler.jsonc                    Cloudflare deployment configuration
├── package.json                      Package metadata and commands
└── README.md
```

## Citation

The template's `CONFIG.citation.text` is:

> Santos, T. M. M. (2026). Interactive presentation template [Computer software]. https://github.com/ThalesMMS/web-presentation-template

The closing stage displays this text and `CONFIG.citation.url`. Dataset citations
are separate and are listed in [DATA_LICENSES.md](DATA_LICENSES.md).

## Contact

The default presenter is **Thales Matheus M. Santos**, Radiologist · developer.

- Email: [thalesmmsradio@gmail.com](mailto:thalesmmsradio@gmail.com)
- [LinkedIn](https://www.linkedin.com/in/thales-matheus-m-santos-974314287)
- [GitHub](https://github.com/ThalesMMS)

Change `CONFIG.presenter` to use your own details. Contact links appear on the
closing slide and the audience closing section.

## Licenses

- Original template code and documentation: **MIT**.
- Bundled third-party software: [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).
- Imaging datasets, including their attribution requirements:
  [DATA_LICENSES.md](DATA_LICENSES.md).

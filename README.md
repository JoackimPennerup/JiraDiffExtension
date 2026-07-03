# JiraDiffExtension

Browser extension for Chrome and Microsoft Edge that renders Jira issue history field changes as readable HTML diffs.

## What it does

- Scans Jira issue history items (`data-testid="issue-history.ui.history-items.generic-history-item.history-item"`).
- Looks for React props on history item DOM nodes (`__reactProps$...`) to recover old/new field values when Jira exposes them there.
- Falls back to reading the two large plaintext value blocks Jira renders in the history item.
- Converts Jira wiki-style markup and simple ADF JSON documents into HTML.
- Uses `@benedicte/html-diff` to display inserted and deleted HTML inline.
- Adds a per-change toggle so you can switch between Jira's original rendering and the readable diff.

## Development

```bash
npm install
npm run typecheck
npm run build
```

The unpacked extension is emitted to `dist/`.

## Loading in Chrome or Edge

1. Run `npm run build`.
2. Open `chrome://extensions` or `edge://extensions`.
3. Enable developer mode.
4. Choose **Load unpacked** and select the generated `dist/` folder.
5. Open a Jira issue with description history changes.

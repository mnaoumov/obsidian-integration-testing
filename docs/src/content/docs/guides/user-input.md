---
title: Simulating user input
description: Inject trusted keyboard and pointer events at the Chromium level, and wait for the effect to settle.
sidebar:
    order: 2
---

The `lib` bag every callback receives provides helpers that inject **trusted** input at the Chromium level —
the kind of event only the browser or the OS normally produces. On desktop they go through Electron's
`webContents.sendInputEvent`; on Android, through the WebView's own debugger. See
[On mobile](#on-mobile) for what changes there.

## Why trusted input matters

The in-page alternatives quietly give false results:

- `dispatchEvent(new KeyboardEvent(...))` and `new MouseEvent(...)` are untrusted (`isTrusted: false`), so
  CodeMirror ignores the keystroke and `:hover` never takes effect. Obsidian's own listeners gate on
  `e.isTrusted` too, so a dispatched click does not merely look different — it does **nothing at all**,
  while the test still passes whatever weaker assertion it makes.
- `execCommand('insertText')` mutates the selection **even when the editor is not focused**, which turns a
  real focus bug into a passing test.

The trusted helpers flow through the real input pipeline, so text lands **only if the editor genuinely
holds focus**, and `:hover` rules genuinely apply. The element and editor arguments are live renderer DOM
nodes — the callback already runs in the renderer, so nothing is serialized.

## The helpers

| Helper                                         | Purpose                                                                                                                                                                                                                          |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `typeIntoEditor({ editor, text })`             | Focuses `editor` (caret to end), types `text` as trusted key events, then polls until the document reflects it.                                                                                                                  |
| `pressKey({ key, modifiers })`                 | Presses `key` with optional `modifiers` as a trusted `keyDown`→`char`→`keyUp` on the DOM-focused element (fires `keydown`/`keypress`/`beforeinput`/`input`/`keyup`). Does **not** poll — pair with `waitUntil`. |
| `hoverElement({ element })`                    | Moves the pointer to `element`'s center, then polls until `element.matches(':hover')`.                                                                                                                                           |
| `unhoverElement({ element })`                  | Moves the pointer just outside `element`'s bounding box, then polls until it no longer matches `:hover`.                                                                                                                         |
| `clickElement({ element, button, modifiers })` | Clicks `element`'s center with optional `button` / `modifiers`, so Chromium synthesizes a real `click` (or `contextmenu`). Does **not** poll — pair with `waitUntil`.                                           |
| `moveMouse({ x, y })`                          | Low-level primitive: injects one trusted pointer move at the given web-contents DIP coordinates. Does **not** poll. **Desktop only.**                                                                                             |
| `clickMouse({ x, y, button, modifiers })`      | Low-level primitive: one trusted `mouseMove` → `mouseDown` → `mouseUp` at the given web-contents DIP coordinates. Does **not** poll.                                                                            |

```ts
// Type into the active editor — only succeeds if the editor truly holds focus.
const typed = await evalInObsidian({
  callback: async ({ app, lib: { typeIntoEditor }, obsidianModule }) => {
    const view = app.workspace.getActiveViewOfType(obsidianModule.MarkdownView);
    const editor = view?.editor;
    if (!editor) {
      return null;
    }

    await typeIntoEditor({ editor, text: 'Hello, world!' });
    return editor.getValue();
  }
});
```

Key presses use Obsidian's `Modifier` names, where `'Mod'` is Cmd on macOS and Ctrl everywhere else. A key
press has no universal effect, so pair it with `waitUntil` to await the outcome you expect:

```ts
await evalInObsidian({
  callback: async ({ app, lib: { pressKey, waitUntil }, obsidianModule }) => {
    const editor = app.workspace.getActiveViewOfType(obsidianModule.MarkdownView)?.editor;
    editor?.focus();

    pressKey({ key: 'Enter', modifiers: ['Shift'] }); // synchronous; soft line break
    await waitUntil({ predicate: () => (editor?.getValue().includes('\n') ?? false) });
  }
});
```

Hovering gives you the genuine hovered appearance — real theme `var()` values, real compositing:

```ts
await evalInObsidian({
  callback: async ({ lib: { hoverElement, unhoverElement } }) => {
    const bar = document.querySelector<HTMLElement>('.minimized-modal-bar');
    if (!bar) {
      return;
    }

    await hoverElement({ element: bar });
    // ...assert the hovered appearance...
    await unhoverElement({ element: bar });
  }
});
```

Clicking splits the same way hovering does. `clickElement({ element })` is the element-relative one — it
clicks the element's center. `clickMouse({ x, y })` is the coordinate primitive underneath it, for a
point that is **no element's center**: the markdown editor's margin, for instance, lies inside
`cm.scrollDOM` but outside `.cm-sizer`, so nothing you can query has a center on it. Both accept
`button` (`'left'`, `'middle'`, `'right'`) and `modifiers` in Obsidian's `Modifier` names — the same
mapping `pressKey` uses, so `'Mod'` cannot mean two different things — and both are synchronous, so pair
them with `waitUntil` to await the outcome:

```ts
await evalInObsidian({
  callback: async ({ app, lib: { clickElement, clickMouse, waitUntil }, obsidianModule }) => {
    const view = app.workspace.getActiveViewOfType(obsidianModule.MarkdownView);
    const action = view?.containerEl.querySelector<HTMLElement>('.view-action');
    const sizer = view?.editor.cm.scrollDOM.querySelector<HTMLElement>('.cm-sizer');
    if (!view || !action || !sizer) {
      return;
    }

    clickElement({ element: action }); // synchronous; a real trusted left click
    await waitUntil({ predicate: () => Boolean(document.querySelector('.menu')) });
    document.querySelector('.menu')?.remove();

    // The editor margin: inside `cm.scrollDOM`, outside `.cm-sizer` — reachable only by coordinates.
    const scrollRect = view.editor.cm.scrollDOM.getBoundingClientRect();
    const sizerRect = sizer.getBoundingClientRect();
    clickMouse({
      button: 'right',
      x: (scrollRect.left + sizerRect.left) / 2,
      y: sizerRect.top + 20 // just below the top edge of the text
    });
    await waitUntil({
      message: 'the margin context menu did not open',
      predicate: () => Boolean(document.querySelector('.menu'))
    });
  }
});
```

A right click opens a **real** context menu, and it stays open. A suite that drives one must close it —
`menu.hide()` from your own handler, or removing the leftover `.menu` element — before the next test, or
the menu still on screen swallows the click that test makes.

:::caution[Serialize focus- and pointer-dependent test files]
Trusted input targets the single shared window's **global** focus and pointer, so test files that depend
on either must not run in parallel against the one shared Obsidian instance — they race for focus, and a
`detachLeavesOfType('markdown')` in one file wipes another's editor. Run that Vitest project with
`fileParallelism: false` and `maxWorkers: 1`.
:::

## Wait for an async condition

`waitUntil({ predicate })` polls until an asynchronous effect settles — a view opens, a DOM node appears,
a setting applies. Because a callback is serialized with `toString()` and **cannot import modules**, it
cannot reuse a poll helper from a library; `waitUntil` is the injected replacement for the loop you would
otherwise hand-roll in every closure.

The `predicate` may be synchronous or asynchronous (it is `await`ed on each poll). It is checked
immediately, then re-checked every `intervalInMilliseconds` until it returns truthy or
`timeoutInMilliseconds` elapses, at which point the returned promise **rejects** (the error includes
`message` when given).

| Option                   | Purpose                                               | Default |
| ------------------------ | ----------------------------------------------------- | ------- |
| `predicate`              | Condition to poll; sync or async, awaited each check. | —       |
| `intervalInMilliseconds` | Delay between polls.                                  | `50`    |
| `timeoutInMilliseconds`  | Max time to wait before rejecting.                    | `5000`  |
| `message`                | Detail appended to the timeout error message.         | —       |

```ts
const value = await evalInObsidian({
  callback: async ({ app, lib: { waitUntil }, obsidianModule }) => {
    await waitUntil({
      message: 'no active Markdown view',
      predicate: () => Boolean(app.workspace.getActiveViewOfType(obsidianModule.MarkdownView))
    });
    return app.workspace.getActiveViewOfType(obsidianModule.MarkdownView)?.editor.getValue() ?? null;
  }
});
```

For waits longer than one eval may take, use
[`pollInObsidian`](/obsidian-integration-testing/guides/writing-tests/#wait-longer-than-one-eval-may-take)
instead.

## On mobile

These helpers work on Android as well, but not all of them, and not identically. **Every one of them returns
a promise — `await` it.** A missing `await` used to be harmless on desktop; on mobile the injection is a
round-trip to the test host, so without it your assertion runs before the input has landed.

| Helper                                              | On Android                                                                                                                                                    |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `clickElement` / `clickMouse` (default or `'left'`) | A **tap**.                                                                                                                                                     |
| `clickMouse({ button: 'right' })`                   | A **long-press** — the gesture that opens Obsidian Mobile's context menu.                                                                                      |
| `clickMouse({ button: 'middle' })`                  | **Throws.** Touch has no middle button.                                                                                                                        |
| `pressKey` / `typeIntoEditor`                       | Work. Named keys (`Enter`, `Escape`, `Tab`, `Backspace`, `Delete`, arrows) and single printable characters; any other multi-character name throws.             |
| `moveMouse` / `hoverElement` / `unhoverElement`     | **Throw.** Touch input has no hover state.                                                                                                                     |

The three that throw do so deliberately rather than doing nothing quietly: a hover that silently no-ops
would leave a test asserting against a state that never existed, which is precisely the false-confidence
problem trusted input exists to solve. Branch on `Platform.isDesktopApp` when a suite runs on both.

Coordinates on mobile are CSS pixels in the WebView's own viewport — the same numbers
`getBoundingClientRect()` reports — so there is no device-pixel-ratio conversion to do.

## Related

- [The `lib` bag](/obsidian-integration-testing/guides/lib/) — where these helpers come from, and how to
  add your own.
- [`Lib` API reference](/obsidian-integration-testing/api/eval-in-obsidian/Lib/)

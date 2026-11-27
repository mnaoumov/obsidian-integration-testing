---
title: Layout checks
description: Assert that a modal, view or settings tab has no horizontal overflow, no touch target under 44 px, and a focus ring on every Tab stop.
sidebar:
    order: 13
---

`assertLayout` checks one part of the Obsidian window and fails with every problem it found, one line each. `findLayoutProblems` runs the same checks and returns the list instead, for a test that asserts on it.

```ts
import { assertLayout } from 'obsidian-integration-testing';

await assertLayout({ root: '.modal.my-plugin-modal', focusRing: true });
```

`root` is required, so a check never passes by looking at nothing. A root that matches nothing fails, and so does a call that turns every check off.

## Overflow

On by default. Every element inside the root, the root itself and scroll panes included, is reported when `scrollWidth > clientWidth + 1`. Two shapes are skipped because they are not layout bugs:

- text cut with an ellipsis (`text-overflow: ellipsis`, or `white-space: nowrap` with `overflow: hidden`), which Obsidian uses for setting names and tabs;
- a visually hidden box: 1 px or less and clipped (the "screen reader only" pattern).

Leave out a block that scrolls on purpose with `overflow: { ignoreSelector: 'pre, table' }`. The selector is matched against the element and its ancestors.

## Touch targets

On by default when Obsidian runs its mobile layout (`Platform.isMobile`), off otherwise; pass `touchTargets: true` to check on desktop. Every visible element matching `selector` (buttons, links, form controls, `summary`, and the `button`, `tab` and `menuitem` roles by default) must be at least `minimumSizeInPixels` (44) wide and high, less half a pixel for rounding. An element with no box or with `visibility: hidden` is skipped, since it cannot be tapped.

## Focus rings

Off by default, because it presses Tab and moves focus. With `focusRing: true` the check focuses the first visible, enabled focusable element of the root (or `startSelector`) and presses Tab, with the trusted `pressKey`, up to `maximumStopCount` (20) times. At each stop it reads the element with focus and with focus taken away:

- a ring is a CHANGE of an outline or a box-shadow, so the resting box-shadow Obsidian gives every button does not count;
- the element, its `::before` and its `::after` are all compared, because Obsidian draws some rings on a pseudo-element;
- a range or color input draws its ring on a vendor pseudo-element no style read reaches, so for those the check compares two screenshots of the control, focused and blurred. That needs the optional `sharp` peer.

The walk ends when focus leaves the root, comes back to a stop it already visited, or runs out of presses. For a modal that must keep focus, pass `focusRing: { shouldStayInside: true }` and leaving is reported as a problem. `ignoreSelector` skips a control that is replaced on blur or shows focus some other way.

At most 10 problems of one kind are listed; the message says how many there were in all.

The checks are a port of `checkLayout` from [obsidian-plugin-dev-kit](https://github.com/Dimagious/obsidian-plugin-dev-kit) (MIT).

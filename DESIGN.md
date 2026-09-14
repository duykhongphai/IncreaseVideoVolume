---
name: LoudLift
description: Local-first media tools with dark, precise, task-focused controls.
colors:
  on-accent: "#ffffff"
  page-bg: "#0f1218"
  editor-canvas: "#0a0d12"
  editor-stage: "#080a0e"
  chrome: "#111620"
  panel: "#171c26"
  surface-raised: "#1e2532"
  control: "#202735"
  editor-divider: "#252e3c"
  border: "#2a3342"
  text-primary: "#e8edf5"
  text-muted: "#97a3b7"
  action-blue: "#2f6fe0"
  action-blue-deep: "#2559b8"
  focus-blue: "#7fabff"
  success: "#34c77b"
  warning: "#f5b84a"
  danger: "#ef5b6a"
  playhead: "#ff5267"
  mask-black: "#000000"
typography:
  headline:
    fontFamily: "Segoe UI, system-ui, -apple-system, Roboto, sans-serif"
    fontSize: "22px"
    fontWeight: 700
    lineHeight: "normal"
    letterSpacing: "normal"
  title:
    fontFamily: "Segoe UI, system-ui, -apple-system, Roboto, sans-serif"
    fontSize: "17px"
    fontWeight: 650
    lineHeight: "normal"
    letterSpacing: "normal"
  body:
    fontFamily: "Segoe UI, system-ui, -apple-system, Roboto, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  label:
    fontFamily: "Segoe UI, system-ui, -apple-system, Roboto, sans-serif"
    fontSize: "12px"
    fontWeight: 600
    lineHeight: "normal"
    letterSpacing: "normal"
  data:
    fontFamily: "Segoe UI, system-ui, -apple-system, Roboto, sans-serif"
    fontSize: "13px"
    fontWeight: 700
    lineHeight: "normal"
    letterSpacing: "normal"
rounded:
  xs: "4px"
  control-compact: "7px"
  sm: "8px"
  md: "10px"
  lg: "14px"
  pill: "999px"
spacing:
  xxs: "4px"
  xs: "6px"
  sm: "8px"
  md: "10px"
  lg: "12px"
  xl: "14px"
  xxl: "16px"
  section: "20px"
  panel: "24px"
components:
  button-primary:
    backgroundColor: "{colors.action-blue}"
    textColor: "{colors.on-accent}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "10px 16px"
  button-secondary:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.text-primary}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "10px 16px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.text-primary}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "10px 16px"
  button-danger:
    backgroundColor: "transparent"
    textColor: "{colors.danger}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "10px 16px"
  card:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.lg}"
    padding: "22px 24px"
  input:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.text-primary}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: "9px 10px"
  tab-active:
    backgroundColor: "{colors.action-blue}"
    textColor: "{colors.on-accent}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "8px 14px"
---

# Design System: LoudLift

## Overview

**Creative North Star: "The Local Precision Bench"**

LoudLift should feel like a dependable workbench that happens to be approachable: dark, quiet around the edges, and exact wherever media settings or time values matter. The interface uses a cool blue-black stack of surfaces, compact workhorse typography, and sparse saturated color so the user's file, progress, and editing state remain the focus.

The system is technical without becoming cryptic. Controls use familiar browser shapes and stroke icons, dense editing areas remain scan-friendly, and every gesture that changes an exact value has a visible numeric counterpart. Marketing ornament, glossy effects, and decorative color are outside this visual language; depth exists to clarify working layers.

**Key Characteristics:**

- Cool, tonal dark surfaces with crisp separators.
- Blue reserved for action, selection, and focus.
- Tabular numerals for time, loudness, percentages, and progress.
- Compact, rounded controls with plain-language labels and Lucide-style stroke icons.
- Semantic green, amber, and red used consistently for state and consequence.

## Colors

The palette is a cool blue-black work environment with a single electric-blue action family and high-clarity semantic signals.

### Primary

- **Signal Blue:** The main filled action, selected tab, selected timeline range, range accent, and active editing affordance.
- **Deep Signal Blue:** The darker end of progress gradients and restrained active depth.
- **Focus Blue:** Accent text, visible keyboard focus, resize-handle hover, and selection outlines on dark surfaces.

### Secondary

- **Saved Green:** Completion, saved state, available acceleration, and other successful status.
- **Caution Amber:** Re-encoding impact, degraded capability, and other warnings that need attention without implying failure.
- **Action Red:** Destructive controls, errors, and clipping warnings.
- **Playhead Red:** Reserved for the current-time playhead so it stays distinct from both selection blue and destructive red.

### Neutral

- **Page Black-Blue:** The default application field behind the main task flow.
- **Editor Canvas Black:** The dedicated editor's surrounding work area.
- **Stage Black:** The deepest viewport and media surround.
- **Chrome Blue-Black:** Toolbars, top bars, and status strips.
- **Panel Slate:** Primary cards and side panels.
- **Raised Slate:** Inputs, tabs, chips, and secondary controls.
- **Control Slate:** Compact editor controls and keyboard-key surfaces.
- **Divider Slate:** Fine boundaries inside dense editing regions.
- **Border Slate:** Standard component outlines and card boundaries.
- **Ice White:** Primary text on dark surfaces.
- **Muted Steel:** Secondary copy, labels, hints, and inactive state.
- **True White:** Text placed on the action blue.
- **Mask Black:** The literal rendered mask and media-black background; do not soften it into a decorative neutral.

### Named Rules

**The One Action Color Rule.** Blue carries interaction; do not introduce another decorative accent family.

**The Semantic Color Rule.** Green means successful or saved, amber means caution, and red means destructive, erroneous, clipped, or current-time playhead according to its dedicated timeline context.

## Typography

**Display Font:** Segoe UI (with system-ui, -apple-system, Roboto, sans-serif fallbacks)  
**Body Font:** Segoe UI (with system-ui, -apple-system, Roboto, sans-serif fallbacks)  
**Label/Mono Font:** Segoe UI with tabular numerals for data; no separate monospace family is established.

**Character:** A single system sans keeps the local utility fast and familiar. Hierarchy comes from weight, size, spacing, and surface placement rather than a display typeface.

### Hierarchy

- **Headline** (700, headline token): Brand and terminal-state headings; keep these rare.
- **Title** (650, title token): Main card headings in the guided workflow.
- **Body** (400, body token): Descriptions, instructions, and result summaries; explanatory copy commonly uses the documented 1.5 line height.
- **Label** (600, label token): Tabs, chips, field labels, toolbars, and compact controls.
- **Data** (700, data token): Time, duration, loudness, percentages, and other changing numeric readouts; apply `font-variant-numeric: tabular-nums`.

### Named Rules

**The Workhorse Type Rule.** Use weight and compact scale to establish hierarchy; do not add an ornamental display face to utility surfaces.

**The Stable Digits Rule.** Changing measurements and millisecond timecodes use tabular numerals so the interface does not jitter while values update.

## Layout

The guided main flow uses a centered column capped at 960px, 16px minimum side gutters, 24px outer vertical margin, and 20px between cards. Cards use generous 22px by 24px interior padding; compact subcontrols step down through the shared 6px to 16px spacing rhythm.

Dense tools may switch to a viewport-filling workbench with toolbars and resizable regions. Use tonal boundaries and explicit resize handles to keep the grid legible, and let the primary preview or data workspace own the flexible area. At narrower desktop widths, secondary rails may contract and toolbars may wrap; at mobile widths, stack work regions into a single document flow and remove drag-only splitters. The implemented responsive thresholds are 1040px for a compact editor, 800px for the editor stack, and 720px for the main workflow stack.

**The Precision Has a Home Rule.** Keep exact inputs adjacent to the preview, ruler, or setting they control; never bury numeric alternatives in a distant dialog.

## Elevation & Depth

LoudLift uses a hybrid of tonal layering and restrained structural shadow. Most controls and editor chrome are flat and separated by border or background step. A main workflow card may use the ambient card shadow, and the media stage may use a deeper shadow to distinguish the image plane from its scrolling viewport; ordinary controls do not float.

### Shadow Vocabulary

- **Ambient Card:** A broad, low-contrast shadow for the main workflow cards.
- **Media Stage:** A deeper shadow around the actual video plane inside the editor.
- **Active Status Ring:** A small translucent success ring around a current-state dot; this is state emphasis, not general elevation.

### Named Rules

**The Flat Controls Rule.** Buttons, inputs, chips, toolbars, and rails stay flat at rest; rely on tonal surfaces and crisp borders before adding shadow.

## Shapes

The system is gently rounded, not bubbly. Large workflow cards and drop zones use the broad large radius; buttons, fields, tabs, and nested panels use medium or small radii; compact editor controls use the tighter compact radius. Chips, progress tracks, step markers, playhead labels, and status dots may be fully pill-shaped or circular because their silhouette carries meaning.

Borders are usually one cool-slate pixel. Drop zones use a two-pixel dash, selection can use a brighter outline, and inactive media masks use a dashed edge. Rectangular media frames, timeline tracks, and panel dividers stay geometrically direct.

## Components

### Buttons

Buttons feel compact and dependable, with visible borders and a short tactile press.

- **Shape:** Gently rounded for the main flow and slightly tighter inside dense editors.
- **Primary:** Signal-blue fill with true-white text; reserve it for the next or most consequential safe action.
- **Hover / Focus:** Hover brightens modestly; active moves down one pixel; keyboard focus uses a two-pixel Focus Blue outline with a two-pixel offset.
- **Secondary / Ghost:** Raised Slate or transparent background with primary text and the standard border.
- **Danger:** Transparent surface with Action Red text and border; keep destructive actions visually explicit without making them the dominant filled color.
- **Icon buttons:** Square and compact in editor chrome, with a minimum 31px implemented control box and an accessible label.

### Chips

- **Style:** Fully rounded Raised Slate labels with a one-pixel border and compact label typography.
- **State:** Tint border and text with the relevant semantic color; keep backgrounds subtle so chips read as status, not primary action.

### Cards / Containers

- **Corner Style:** Broad but restrained large rounding.
- **Background:** Panel Slate over the Page Black-Blue field; nested values and controls rise one tonal step.
- **Shadow Strategy:** Use Ambient Card only for the guided workflow's main containers; editor panels remain flat.
- **Border:** One-pixel Border Slate.
- **Internal Padding:** Panel spacing for workflow cards; denser tool panels use the small-to-xl spacing scale.

### Inputs / Fields

- **Style:** Raised Slate or Control Slate background, Border Slate stroke, compact rounding, and primary text.
- **Focus:** Focus Blue border or the global two-pixel focus outline; composite unit fields use `:focus-within` so the whole control responds.
- **Data:** Numeric fields use bold tabular digits, retain visible units, and accept the precision implied by their labels.
- **Error / Disabled:** Error state uses Action Red; disabled groups reduce opacity while keeping their structure readable.

### Navigation

Top bars use Chrome Blue-Black with a single lower divider. The brand lockup pairs the Signal Blue rounded-square mark with the LoudLift name and one muted technical descriptor. Mode navigation uses a Raised Slate segmented container: inactive tabs are muted and the active tab is filled Signal Blue with white text. On mobile, horizontal modes may scroll rather than compress their labels.

### Precision Timeline

Timelines use a deeply recessed canvas, clearly differentiated major and minor ticks, tabular time labels, blue selected regions, subdued unselected regions, and a single red playhead. Transport and ruler zoom remain separate from media-preview zoom. Timeline bars and mask overlays must expose the same values in exact millisecond inputs whenever dragging is available.

### Resizable Divider

Resizable regions use a narrow dark gutter with a visible pill-shaped grip. Hover or drag introduces a subtle blue field and switches the grip to Focus Blue. Dividers are keyboard-focusable separators and support arrow-key resizing; they are removed when the layout stacks on small screens.

## Do's and Don'ts

### Do:

- **Do** preserve the cool blue-black surface ladder and use borders to separate dense working regions.
- **Do** reserve Signal Blue for action, selection, range accents, and focus-related emphasis.
- **Do** show exact units and tabular numeric values beside drag, range, zoom, or timeline gestures.
- **Do** use semantic green, amber, and red consistently, with the playhead's red confined to current-time indication.
- **Do** keep iconography as simple rounded stroke SVGs paired with accessible labels or visible text.

### Don't:

- **Don't** introduce bright gradients, glassmorphism, decorative glow, or multiple competing accent hues.
- **Don't** float ordinary controls with shadows; tonal contrast and one-pixel boundaries are the default depth system.
- **Don't** replace technical precision with gesture-only controls or rounded display values when the underlying model is millisecond-precise.
- **Don't** add a decorative typeface or use proportional digits for changing measurements.
- **Don't** turn every surface into a large rounded card; dense editor regions are flatter, tighter, and structurally divided.

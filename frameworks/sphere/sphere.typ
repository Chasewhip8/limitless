// Sphere document framework — public API.
// Import this file from main.typ; implementation lives in sphere/.
//
// Document skeleton
//   sphere-document(title:, date:, ..)[ … ]     — wraps everything; sets page, fonts, footer
//   sphere-cover(title:, date:, contacts:, ..)  — branded cover page
//   sphere-page(title, subtitle:, ..)[ … ]      — standard content page with heading
//   sphere-lint()                               — appendix page auditing sources and claims
//
// Layout (rows equalize card heights automatically)
//   sphere-grid(columns: n | tracks, ..cells)   — equal-height card grid; equal: false to opt out
//   sphere-two-column(left, right, ..)          — weighted split, equal heights by default
//   sphere-hero-split(narrative, visual, ..)    — 56/44 narrative-vs-visual split
//   sphere-section-stack(..cells)               — vertical stack with consistent gaps
//   sphere-inline-flow(items, gap:)             — wrapping row of pills/badges at natural width
//   sphere-bottom-band(title:, ..)[ … ]         — full-width takeaway/source band
//
// Cards and text
//   sphere-card(title:, kind:, source:, ..)[ … ]    — base card; kinds: base/note/decision/warning/code/source
//   sphere-callout / sphere-decision-note / sphere-code-card / sphere-quote
//   sphere-kpi(label, value, ..) + sphere-metric-strip(items)
//   sphere-badge / sphere-badge-row / sphere-status-pill / sphere-icon
//   sphere-section-heading / sphere-body / sphere-small / sphere-eyebrow
//
// Evidence (register sources once, cite everywhere)
//   sphere-source(id, label, ..)                — declare a source for the lint page
//   sphere-cite(id) / sphere-source-tag / sphere-source-note / sphere-source-card
//   sphere-assumption(label, value, source:) / sphere-disclaimer
//
// Data visuals (every component takes source: and registers a claim)
//   sphere-bar-chart(rows, ..) / sphere-column-chart(values, ..)
//   sphere-data-table(headers, rows, title:, ..) / sphere-table
//   sphere-comparison-matrix / sphere-competitive-table
//   sphere-flow(steps, ..) / sphere-system-diagram(layers, ..) / sphere-pillar
//   sphere-before-after-process(before, after, takeaway)
//   sphere-proof-grid(items) / sphere-proof-item / sphere-roadmap(phases) / sphere-phase
//   sphere-hero-visual / sphere-screenshot-card / sphere-isometric-panel
//   sphere-logo-grid / sphere-image-backed-card
//
// Page templates (opinionated single-page layouts)
//   sphere-overview-page / sphere-kpi-page / sphere-comparison-page
//   sphere-architecture-page / sphere-proof-grid-page / sphere-roadmap-page
//   sphere-contact-page

#import "sphere/theme.typ": *
#import "sphere/chrome.typ": *
#import "sphere/layout.typ": *
#import "sphere/evidence.typ": *
#import "sphere/cards.typ": *
#import "sphere/charts.typ": *
#import "sphere/comparison.typ": *
#import "sphere/diagrams.typ": *
#import "sphere/proof.typ": *
#import "sphere/media.typ": *
#import "sphere/roadmap.typ": *
#import "sphere/pages.typ": *

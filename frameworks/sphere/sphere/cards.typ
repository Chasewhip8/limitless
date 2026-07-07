// Sphere semantic card primitives. Import ../sphere.typ for the public API.
#import "theme.typ": *
#import "chrome.typ": *
#import "layout.typ": *
#import "evidence.typ": *

#let sphere-badge(label) = box(
  height: 12pt,
  fill: blue-100,
  stroke: 0.5pt + line,
  radius: 3pt,
  inset: (x: 5pt, y: 0pt),
)[
  #align(horizon)[#text(size: 6.2pt, weight: "bold", fill: blue-700)[#label]]
]

#let sphere-badge-row(labels, gap: 4pt) = sphere-inline-flow(
  labels.map(sphere-badge),
  gap: gap,
)

#let sphere-card(
  title: none,
  subtitle: none,
  accent: none,
  accent-rule: false,
  fill: none,
  inset: sphere-card-inset,
  kind: "base",
  source: none,
  height: auto,
  body,
) = {
  let resolved-fill = if fill != none {
    fill
  } else if kind == "note" {
    pale
  } else if kind == "decision" {
    white
  } else if kind == "warning" {
    warning-bg
  } else if kind == "code" {
    white-blue
  } else if kind == "source" {
    white-blue
  } else {
    white
  }
  let resolved-line = if kind == "warning" {
    warning
  } else if kind == "code" or kind == "source" {
    hairline
  } else {
    line
  }

  // The Decision badge belongs to the title, so the two render as one header
  // unit with a fixed gutter; everything else keeps the regular paragraph
  // rhythm of the document.
  let title-content = if title != none {
    [
      #text(size: if kind == "source" { 7.6pt } else { 9.2pt }, weight: "bold", fill: navy)[#title]
      #if subtitle != none [
        #linebreak()
        #text(size: 6.8pt, fill: muted)[#subtitle]
      ]
    ]
  } else {
    none
  }

  block(
    width: 100%,
    height: height,
    fill: resolved-fill,
    stroke: 0.6pt + resolved-line,
    radius: sphere.radius.card,
    inset: inset,
  )[
    #if kind == "decision" and title-content != none [
      #grid(
        columns: (1fr,),
        row-gutter: 5.5pt,
        sphere-badge("Decision"), title-content,
      )
      #v(0.34em)
    ] else if kind == "decision" [
      #sphere-badge("Decision")
      #v(0.35em)
    ] else if title-content != none [
      #title-content
      #v(0.34em)
    ]
    #if accent-rule and accent != none [
      #box(width: 18pt, height: 1.1pt, fill: accent)
      #v(0.34em)
    ]
    // Card bodies read as body copy by default; opt out with explicit #text.
    #set text(size: 8pt, fill: muted)
    #body
    #if source != none [
      #v(0.48em)
      #sphere-source-tag(source)
    ]
  ]
}

#let sphere-callout(title, fill: pale, body) = sphere-card(
  title: title,
  fill: fill,
  kind: "note",
)[
  #sphere-body(body)
]

#let sphere-decision-note(title, body) = sphere-card(title: title, kind: "decision")[#sphere-body(body)]

#let sphere-code-card(language: none, caption: none, body) = sphere-card(
  title: caption,
  subtitle: language,
  kind: "code",
)[
  #text(size: 7pt, fill: navy)[#body]
]

#let sphere-quote(body, attribution: none, accent: blue) = block(
  width: 100%,
  fill: white-blue,
  stroke: (left: 2.4pt + accent),
  inset: (x: 9pt, y: 7pt),
)[
  #text(size: 8pt, fill: muted, style: "italic")[#body]
  #if attribution != none [
    #v(0.4em)
    #text(size: 6.8pt, weight: "bold", fill: navy)[— #attribution]
  ]
]

#let sphere-icon(label, size: 22pt, fill: soft-blue-2, color: blue) = box(
  width: size,
  height: size,
  fill: fill,
  stroke: 0.6pt + line,
  radius: 0.25 * size,
)[
  #align(center + horizon)[#text(size: 0.32 * size, weight: "bold", fill: color)[#label]]
]

#let sphere-status-pill(status) = {
  let fill-color = if status == "signed" or status == "public" or status == "live" {
    success-bg
  } else if status == "warning" {
    warning-bg
  } else {
    blue-100
  }
  let text-color = if status == "signed" or status == "public" or status == "live" {
    success
  } else if status == "warning" {
    warning
  } else {
    blue-700
  }

  box(
    height: 12pt,
    fill: fill-color,
    stroke: 0.45pt + line,
    radius: sphere.radius.pill,
    inset: (x: 5pt, y: 0pt),
  )[
    #align(horizon)[#text(size: 5.9pt, weight: "bold", fill: text-color)[#status]]
  ]
}

#let sphere-kpi(
  label,
  value,
  detail: none,
  note: none,
  source: none,
  accent: blue-700,
  value-fill: blue,
  fill: white,
  height: auto,
) = block(
  width: 100%,
  height: height,
  fill: fill,
  stroke: 0.45pt + line,
  radius: sphere.radius.card,
  inset: (x: 9pt, y: 8pt),
)[
  #sphere-register-claim("kpi", label, source: source)
  #text(size: 6.7pt, fill: muted)[#label]
  #v(0.2em)
  #text(size: 18pt, weight: "bold", fill: value-fill)[#value]
  #if detail != none [
    #v(0.18em)
    #text(size: 6.7pt, weight: "bold", fill: accent)[#detail]
  ]
  #if note != none [
    #v(0.24em)
    #sphere-small(note)
  ]
  #if source != none [
    #v(0.28em)
    #sphere-source-tag(source)
  ]
]

#let sphere-metric-strip(items, gap: 8pt) = sphere-grid(
  columns: items.len(),
  gap: gap,
  ..items.map(item => sphere-kpi(
    item.at("label"),
    item.at("value"),
    detail: item.at("detail", default: none),
    note: item.at("note", default: none),
    source: item.at("source", default: none),
    accent: item.at("accent", default: blue-700),
    value-fill: item.at("value-fill", default: blue),
    fill: item.at("fill", default: white),
    height: item.at("height", default: auto),
  )),
)

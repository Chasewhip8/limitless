// Sphere media and visual primitives. Import ../sphere.typ for the public API.
#import "theme.typ": *
#import "layout.typ": *
#import "cards.typ": *

#let sphere-hero-visual(visual, anchor: "bottom-right", bleed: false, height: auto) = block(
  width: 100%,
  height: height,
  fill: pale,
  stroke: 0.45pt + line,
  radius: sphere.radius.card,
  clip: true,
  inset: if bleed { 0pt } else { 6pt },
)[
  #let alignment = if anchor == "bottom-right" {
    right + bottom
  } else if anchor == "bottom-left" {
    left + bottom
  } else {
    center + horizon
  }
  #align(alignment)[#visual]
]

#let sphere-screenshot-card(visual, caption: none, source: none, height: auto) = sphere-card(
  title: caption,
  kind: "base",
  source: source,
  height: height,
)[
  #block(width: 100%, fill: white-blue, stroke: 0.45pt + hairline, radius: 4pt, inset: 4pt)[#visual]
]

#let sphere-logo-pill(label, tone: "grayscale", brand: false) = box(
  fill: if brand or tone == "brand" { blue-100 } else { white-blue },
  stroke: 0.45pt + line,
  radius: sphere.radius.pill,
  inset: (x: 8pt, y: 4pt),
)[
  #text(size: 7pt, weight: "bold", fill: if brand or tone == "brand" { blue-700 } else { quiet })[#label]
]

#let sphere-logo-grid(logos, tone: "grayscale", brand: false, gap: 6pt) = sphere-inline-flow(
  logos.map(logo => sphere-logo-pill(logo, tone: tone, brand: brand)),
  gap: gap,
  leading: 6pt,
)

#let sphere-isometric-panel(visual, background: "pale-grid", height: auto) = block(
  width: 100%,
  height: height,
  fill: if background == "pale-grid" { pale } else { white-blue },
  stroke: 0.45pt + line,
  radius: sphere.radius.card,
  clip: true,
  inset: 6pt,
)[#align(center + horizon)[#visual]]

#let sphere-image-backed-card(
  visual,
  title,
  body,
  link: none,
  source: none,
  visual-height: 92pt,
  height: auto,
) = sphere-card(title: title, source: source, height: height)[
  #block(
    width: 100%,
    height: visual-height,
    fill: pale,
    radius: 4pt,
    clip: true,
    inset: 0pt,
  )[#align(center + horizon)[#visual]]
  #v(0.55em)
  #sphere-body(body)
  #if link != none [#v(0.35em)#text(size: 7pt, fill: blue)[#link]]
]

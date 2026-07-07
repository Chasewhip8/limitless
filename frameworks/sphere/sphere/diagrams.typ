// Sphere flow and system diagram primitives. Import ../sphere.typ for the public API.
#import "theme.typ": *
#import "chrome.typ": *
#import "layout.typ": *
#import "cards.typ": *
#import "evidence.typ": *

#let sphere-pillar(title, subtitle, body, icon: "", accent: blue) = grid(
  columns: (26pt, 1fr),
  gutter: 9pt,
  sphere-icon(icon, color: accent),
  block[
    #text(size: 7.2pt, weight: "bold", fill: blue-500)[#title]
    #linebreak()
    #text(size: 8.8pt, weight: "bold", fill: navy)[#subtitle]
    #v(0.12em)
    #text(size: 7pt, fill: muted)[#body]
  ],
)

// A flow step keeps its number in the header row so the body stays full
// width and never overflows at narrow column widths.
#let sphere-flow-step(step, index, numbered: true, height: auto) = {
  let kicker = step.at("kicker", default: step.at("subtitle", default: none))
  block(
    width: 100%,
    height: height,
    fill: step.at("fill", default: white),
    stroke: 0.6pt + line,
    radius: sphere.radius.card,
    inset: sphere-card-inset,
  )[
    #grid(
      columns: if numbered { (auto, 1fr) } else { (1fr,) },
      gutter: 7pt,
      align: horizon,
      ..if numbered { (sphere-icon(str(index + 1), size: 18pt, fill: blue-100, color: blue),) } else { () },
      [
        #text(size: 9.2pt, weight: "bold", fill: navy)[#step.at("title")]
        #if kicker != none [
          #linebreak()
          #text(size: 6.8pt, fill: muted)[#kicker]
        ]
      ],
    )
    #v(0.4em)
    #sphere-body(step.at("body", default: []))
  ]
}

#let sphere--flow-arrow(direction) = align(center + horizon)[
  #text(size: 10pt, fill: blue-300)[#if direction == "vertical" [↓] else [→]]
]

#let sphere-flow(
  steps,
  direction: "horizontal",
  numbered: true,
  connectors: true,
  source: none,
  title: none,
) = {
  let cards = steps.enumerate().map(pair => sphere-flow-step(pair.last(), pair.first(), numbered: numbered))

  [
    #sphere-register-claim("flow", if title == none { "Process flow" } else { title }, source: source)
    #if direction == "vertical" [
      #cards.join(sphere--flow-arrow("vertical"))
    ] else if connectors [
      #layout(size => {
        let arrow-width = 12pt
        let gap = 4pt
        let card-width = (size.width - (arrow-width + 2 * gap) * (steps.len() - 1)) / steps.len()
        let row-height = calc.max(..cards.map(card => measure(box(width: card-width, card)).height))
        let columns = ()
        let cells = ()
        for (index, card) in cards.enumerate() {
          columns.push(1fr)
          cells.push(sphere--stretch-cell(card, row-height))
          if index < cards.len() - 1 {
            columns.push(arrow-width)
            cells.push(sphere--flow-arrow("horizontal"))
          }
        }
        grid(columns: columns, column-gutter: gap, ..cells)
      })
    ] else [
      #sphere-grid(columns: steps.len(), gap: 8pt, ..cards)
    ]
    #if source != none [#v(0.35em)#sphere-source-tag(source)]
  ]
}

#let sphere-control-layer(title, controls: (), body: none) = sphere-card(
  title: title,
  kind: "note",
  accent-rule: true,
  accent: blue-300,
)[
  #if body != none [#sphere-body(body)#v(0.45em)]
  #sphere-badge-row(controls)
]

#let sphere-system-diagram(
  layers,
  nodes: (),
  controls: (),
  source: none,
  title: "System diagram",
  height: auto,
) = sphere-card(title: title, source: source, height: height)[
  #sphere-register-claim("system-diagram", title, source: source)
  #{
    layers
      .map(layer => block(
        width: 100%,
        fill: layer.at("fill", default: white-blue),
        stroke: 0.45pt + line,
        radius: 5pt,
        inset: (x: 8pt, y: 6pt),
      )[
        #grid(
          columns: (auto, 1fr),
          gutter: 8pt,
          align: horizon,
          text(size: 7.2pt, weight: "bold", fill: navy)[#layer.at("title", default: "Layer")],
          align(right)[#sphere-badge-row(layer.at("nodes", default: nodes))],
        )
      ])
      .join(v(0.5em))
  }
  #if controls.len() > 0 [
    #v(0.5em)
    #sphere-control-layer("Control overlay", controls: controls)
  ]
]

#let sphere-before-after-process(before, after, takeaway, source: none) = [
  #sphere-register-claim("before-after-process", "Before/after process", source: source)
  #sphere-two-column(
    sphere-card(title: before.at("title", default: "Before"), kind: "note")[
      #sphere-body(before.at("body", default: []))
    ],
    sphere-card(title: after.at("title", default: "After"), kind: "decision")[
      #sphere-body(after.at("body", default: []))
    ],
    left: 50%,
    right: 50%,
  )
  #v(0.65em)
  #sphere-bottom-band(title: "Takeaway", source: source)[#sphere-body(takeaway)]
]

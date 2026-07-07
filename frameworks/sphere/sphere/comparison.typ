// Sphere comparison primitives. Import ../sphere.typ for the public API.
#import "theme.typ": *
#import "chrome.typ": *
#import "cards.typ": *
#import "evidence.typ": *

#let sphere-comparison-matrix(
  left-title,
  right-title,
  rows,
  left-icon: none,
  right-icon: none,
  highlight: "right",
  source: none,
  title: none,
  height: auto,
) = sphere-card(title: title, source: source, height: height)[
  #sphere-register-claim(
    "comparison",
    if title == none { [#left-title vs #right-title] } else { title },
    source: source,
  )
  #table(
    columns: (0.72fr, 1fr, 1fr),
    stroke: 0.45pt + line,
    fill: (_, y) => if y == 0 { white-blue },
    inset: (x: 6pt, y: 6pt),
    table.header(
      [#text(size: 7pt, weight: "bold", fill: muted)[Dimension]],
      [#text(size: 7pt, weight: "bold", fill: if highlight == "left" { blue } else { muted })[
        #if left-icon != none [#left-icon #h(3pt)]#left-title
      ]],
      [#text(size: 7pt, weight: "bold", fill: if highlight == "right" { blue } else { muted })[
        #if right-icon != none [#right-icon #h(3pt)]#right-title
      ]],
    ),
    ..rows.map(row => (
      [#text(size: 7pt, weight: "bold", fill: navy)[#row.at("label")]],
      [#text(size: 7pt, fill: if highlight == "left" { blue-700 } else { muted })[
        #row.at("left")
      ]],
      [#text(
        size: 7pt,
        fill: if highlight == "right" { blue-700 } else { muted },
        weight: if highlight == "right" { "bold" } else { "regular" },
      )[#row.at("right")]],
    )).flatten(),
  )
]

#let sphere-competitive-table(
  columns,
  rows,
  highlight-column: none,
  source: none,
  title: "Competitive table",
  height: auto,
) = sphere-card(title: title, source: source, height: height)[
  #sphere-register-claim("competitive-table", title, source: source)
  #table(
    columns: (1fr,) * columns.len(),
    stroke: 0.35pt + hairline,
    fill: (_, y) => if y == 0 { white-blue },
    inset: (x: 6pt, y: 5pt),
    table.header(..columns.enumerate().map(pair => {
      let idx = pair.first()
      let col = pair.last()
      [#text(
        size: 7pt,
        weight: "bold",
        fill: if highlight-column == idx or highlight-column == col { blue } else { navy },
      )[#col]]
    })),
    ..rows.map(row => row.enumerate().map(pair => {
      let idx = pair.first()
      let cell = pair.last()
      let active = highlight-column == idx or highlight-column == columns.at(idx, default: none)
      [#text(
        size: 7pt,
        fill: if active { blue-700 } else { muted },
        weight: if active { "bold" } else { "regular" },
      )[#cell]]
    })).flatten(),
  )
]

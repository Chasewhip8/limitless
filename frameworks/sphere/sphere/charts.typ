// Sphere chart and table primitives. Import ../sphere.typ for the public API.
#import "theme.typ": *
#import "chrome.typ": *
#import "cards.typ": *
#import "evidence.typ": *

#let sphere-hbar-row(
  label,
  value,
  max,
  suffix: "",
  accent: blue,
  show-value: true,
  label-width: 86pt,
) = {
  let pct = value / max * 100%

  grid(
    columns: if show-value { (label-width, 1fr, 36pt) } else { (label-width, 1fr) },
    gutter: 8pt,
    align(horizon)[#sphere-small(label)],
    align(horizon)[
      #box(width: 100%, height: 8pt, fill: blue-100, radius: 4pt, clip: true)[
        #box(width: pct, height: 8pt, fill: accent, radius: 4pt)
      ]
    ],
    if show-value {
      align(right + horizon)[#text(size: 7pt, weight: "bold", fill: navy)[#value#suffix]]
    } else {
      none
    },
  )
}

#let sphere-bar-chart(
  rows,
  title: none,
  subtitle: none,
  max: auto,
  accent: blue,
  unit: none,
  source: none,
  show-values: true,
  label-width: 86pt,
  note: none,
  height: auto,
) = {
  let resolved-max = if max == auto {
    if rows.len() == 0 {
      1
    } else {
      let computed = calc.max(..rows.map(row => row.at("value")))
      if computed == 0 { 1 } else { computed }
    }
  } else {
    max
  }
  let suffix = if unit == none { "" } else { unit }

  sphere-card(title: title, subtitle: subtitle, source: source, height: height)[
    #sphere-register-claim("bar-chart", title, source: source)
    #{
      rows
        .map(row => sphere-hbar-row(
          row.at("label"),
          row.at("value"),
          resolved-max,
          suffix: row.at("suffix", default: suffix),
          accent: row.at("accent", default: accent),
          show-value: show-values,
          label-width: label-width,
        ))
        .join(v(0.48em))
    }
    #if note != none [
      #v(0.55em)
      #sphere-small(note)
    ]
  ]
}

#let sphere-column-chart(
  values,
  title: none,
  timeframe: none,
  max: auto,
  accent: blue,
  unit: none,
  source: none,
  show-values: false,
  note: none,
  height: auto,
  plot-height: 68pt,
) = {
  let resolved-max = if max == auto {
    if values.len() == 0 {
      1
    } else {
      let computed = calc.max(..values.map(item => item.at("value")))
      if computed == 0 { 1 } else { computed }
    }
  } else {
    max
  }

  sphere-card(title: title, subtitle: timeframe, source: source, height: height)[
    #sphere-register-claim("column-chart", title, source: source)
    #grid(
      columns: (1fr,) * values.len(),
      gutter: 5pt,
      ..values.map(item => {
        let bar-height = item.at("value") / resolved-max * (plot-height - 6pt)
        block(width: 100%)[
          // Track with clipped, bottom-anchored bar so bars sit flush.
          #block(width: 100%, height: plot-height, fill: blue-100, radius: 3pt, clip: true)[
            #place(bottom)[
              #block(
                width: 100%,
                height: bar-height,
                fill: item.at("accent", default: accent),
                radius: (top: 3pt),
              )
            ]
          ]
          #if show-values [
            #v(0.3em)
            #align(center)[
              #text(size: 6.4pt, weight: "bold", fill: navy)[
                #item.at("value")#if unit != none [#unit]
              ]
            ]
          ]
          #v(0.3em)
          #align(center)[#sphere-small(item.at("label"))]
        ]
      }),
    )
    #if note != none [
      #v(0.55em)
      #sphere-small(note)
    ]
  ]
}

#let sphere-table(headers, rows) = table(
  columns: (1fr,) * headers.len(),
  stroke: 0.45pt + line,
  fill: (_, y) => if y == 0 { white-blue },
  inset: (x: 6pt, y: 5pt),
  table.header(..headers.map(header => [
    #text(size: 7pt, weight: "bold", fill: navy)[#header]
  ])),
  ..rows.map(row => row.map(cell => [
    #text(size: 7pt, fill: muted)[#cell]
  ])).flatten(),
)

#let sphere-data-table(headers, rows, title: none, subtitle: none, source: none, height: auto) = {
  if title == none {
    [
      #sphere-register-claim("table", "Data table", source: source)
      #sphere-table(headers, rows)
      #if source != none [
        #v(0.35em)
        #sphere-source-tag(source)
      ]
    ]
  } else {
    sphere-card(title: title, subtitle: subtitle, source: source, height: height)[
      #sphere-register-claim("table", title, source: source)
      #sphere-table(headers, rows)
    ]
  }
}

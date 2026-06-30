// Sphere institutional document SDK.
// Keep reusable brand, layout, chart, table, and diagram primitives here; keep
// document-specific content in main.typ/showcase.typ until a pattern stabilizes.

#let sphere-font = "Inter"

// Sphere deck palette: blue is the active signal, grey is context, and warm colors
// are reserved for true warnings rather than default chart decoration.
#let navy = rgb("#0E2B3D")
#let deep-navy = navy
#let slate = rgb("#73879E")
#let muted = slate
#let quiet = rgb("#B9C7D6")
#let line = rgb("#D8E6F5")
#let faint = line
#let pale = rgb("#F6FAFE")
#let white-blue = rgb("#FBFDFF")
#let soft-blue = rgb("#DBEAFF")
#let soft-blue-2 = rgb("#EAF3FF")
#let blue = rgb("#0661F2")
#let electric-blue = blue
#let blue-700 = rgb("#1552C8")
#let blue-500 = rgb("#2970FF")
#let blue-300 = rgb("#8FB9FF")
#let blue-100 = rgb("#EFF6FF")
#let dark-bg = rgb("#0A1220")
#let dark-panel = rgb("#101B2D")
#let dark-panel-2 = rgb("#142840")
#let dark-line = rgb("#24435C")
#let dark-text = rgb("#EAF3FF")
#let dark-muted = rgb("#9FB4CB")
#let warning = rgb("#B7791F")
#let warning-bg = rgb("#FFF7E6")

#let sphere-page-margin = (left: 0.72in, right: 0.72in, top: 0.74in, bottom: 0.66in)
#let sphere-card-inset = (x: 10pt, y: 8pt)

#let sphere-background(variant: "page") = {
  if variant == "sphere-institutional" {
    image("assets/sphere-cover.png", width: 100%, height: 100%)
  } else if variant == "sphere-institutional-print" {
    image("assets/sphere-cover-print.png", width: 100%, height: 100%)
  } else {
    image("assets/sphere-page.png", width: 100%, height: 100%)
  }
}

#let sphere-dark-background() = block(width: 100%, height: 100%, fill: dark-bg)[]

#let sphere-page-frame(body) = [
  #box(width: 100%, height: 100%, inset: 0pt)[
    #body
  ]
]

#let sphere-logo(size: 18pt) = image("assets/sphere-logo.svg", height: size)

#let sphere-section-heading(body, fill: navy) = text(size: 10pt, weight: "bold", fill: fill)[#body]
#let sphere-body(body, fill: muted) = text(size: 8pt, fill: fill)[#body]
#let sphere-small(body, fill: muted) = text(size: 6.8pt, fill: fill)[#body]
#let sphere-eyebrow(body, fill: blue) = text(size: 6.6pt, weight: "bold", fill: fill)[#body]

#let sphere-rule(fill: line) = box(width: 100%, height: 0.6pt, fill: fill)

#let sphere-page-title(
  title,
  kicker: "Sphere Laboratories",
  subtitle: none,
  dark-mode: false,
) = {
  let primary = if dark-mode { dark-text } else { navy }
  let secondary = if dark-mode { dark-muted } else { slate }
  [
    #text(size: 21pt, fill: primary)[#kicker]
    #h(3pt)
    #text(size: 21pt, fill: secondary)[| #title]
    #if subtitle != none [
      #linebreak()
      #v(0.18em)
      #text(size: 8.6pt, fill: secondary)[#subtitle]
    ]
    #v(0.9em)
  ]
}

#let sphere-page(
  title,
  kicker: "Sphere Laboratories",
  subtitle: none,
  dark-mode: false,
  body,
) = {
  set page(background: if dark-mode { sphere-dark-background() } else { sphere-background(variant: "page") })
  sphere-page-frame[
    #sphere-page-title(title, kicker: kicker, subtitle: subtitle, dark-mode: dark-mode)
    #body
  ]
}

#let sphere-background-page(body) = {
  sphere-page("Document styles")[#body]
}

#let sphere-contact(contact) = [
  #text(size: 7pt, weight: "bold", fill: navy)[#contact.at("name", default: "")]
  #linebreak()
  #text(size: 7pt, weight: "bold", fill: navy)[#contact.at("role", default: "")]
  #v(0.42em)
  #text(size: 7pt, fill: muted)[Email: #contact.at("email", default: "")]
  #linebreak()
  #text(size: 7pt, fill: muted)[Telegram: #contact.at("telegram", default: "")]
]

#let sphere-cover-art(variant) = {
  none
}

#let sphere-cover(
  title: "Document Title",
  date: "January 2026",
  contacts: (),
  confidentiality: "[ Private & Confidential ]",
  company: "Sphere Laboratories, Inc",
  variant: "sphere-institutional",
) = {
  set page(background: sphere-background(variant: variant))
  sphere-page-frame[
    #sphere-logo()
    #v(2.45in)
    #text(size: 31pt, fill: navy)[#title]
    #linebreak()
    #text(size: 10pt, fill: navy)[#date]
    #v(0.58in)
    #grid(columns: contacts.map(_ => 1fr), gutter: 34pt, ..contacts.map(sphere-contact))
    #v(2.14in)
    #sphere-small(confidentiality)
    #linebreak()
    #sphere-small(company)
    #sphere-cover-art(variant)
  ]
}

#let sphere-card(
  title: none,
  subtitle: none,
  accent: none,
  accent-rule: false,
  fill: white,
  inset: sphere-card-inset,
  body,
) = block(
  width: 100%,
  fill: fill,
  stroke: 0.6pt + line,
  radius: 5pt,
  inset: inset,
)[
  #if title != none [
    #text(size: 9.2pt, weight: "bold", fill: navy)[#title]
    #if subtitle != none [
      #linebreak()
      #text(size: 6.8pt, fill: muted)[#subtitle]
    ]
    #v(0.34em)
  ]
  #if accent-rule and accent != none [
    #box(width: 18pt, height: 1.1pt, fill: accent)
    #v(0.34em)
  ]
  #body
]

#let sphere-dark-card(title: none, subtitle: none, accent: blue-300, body) = block(
  width: 100%,
  fill: dark-panel,
  stroke: 0.6pt + dark-line,
  radius: 5pt,
  inset: sphere-card-inset,
)[
  #if title != none [
    #text(size: 9.4pt, weight: "bold", fill: dark-text)[#title]
    #if subtitle != none [
      #linebreak()
      #text(size: 7pt, fill: dark-muted)[#subtitle]
    ]
    #v(0.36em)
  ]
  #body
]

#let sphere-callout(title, accent: blue, fill: pale, body) = sphere-card(
  title: title,
  accent: accent,
  fill: fill,
)[
  #sphere-body(body)
]

#let sphere-quote(body, accent: blue) = block(
  width: 100%,
  fill: white-blue,
  stroke: (left: 2.4pt + accent),
  inset: (x: 9pt, y: 7pt),
)[
  #text(size: 8pt, fill: muted)[#body]
]

#let sphere-icon(label, fill: soft-blue-2, color: blue) = box(
  width: 28pt,
  height: 28pt,
  fill: fill,
  stroke: 0.6pt + line,
  radius: 7pt,
)[
  #align(center + horizon)[#text(size: 9pt, weight: "bold", fill: color)[#label]]
]

#let sphere-badge(label, dark-mode: false) = {
  let badge-fill = if dark-mode { dark-panel-2 } else { blue-100 }
  let badge-line = if dark-mode { dark-line } else { line }
  let badge-text = if dark-mode { dark-text } else { blue-700 }
  box(
    fill: badge-fill,
    stroke: 0.5pt + badge-line,
    radius: 3pt,
    inset: (x: 5pt, y: 2.5pt),
  )[#text(size: 6.2pt, weight: "bold", fill: badge-text)[#label]]
}

#let sphere-kpi(
  label,
  value,
  detail: none,
  caption: none,
  accent: blue,
  fill: white,
) = block(
  width: 100%,
  fill: fill,
  stroke: 0.6pt + line,
  radius: 5pt,
  inset: (x: 9pt, y: 8pt),
)[
  #text(size: 6.7pt, fill: muted)[#label]
  #v(0.2em)
  #text(size: 18pt, weight: "bold", fill: blue)[#value]
  #if detail != none [
    #v(0.18em)
    #text(size: 6.7pt, weight: "bold", fill: blue-700)[#detail]
  ]
  #if caption != none [
    #v(0.24em)
    #sphere-small(caption)
  ]
]

#let sphere-metric-strip(items) = grid(
  columns: items.map(_ => 1fr),
  gutter: 8pt,
  ..items.map(item => sphere-kpi(
    item.at("label"),
    item.at("value"),
    detail: item.at("detail", default: none),
    caption: item.at("caption", default: none),
    accent: item.at("accent", default: blue),
    fill: item.at("fill", default: white),
  )),
)

#let sphere-hbar-row(label, value, max, suffix: "", accent: blue) = {
  let pct = value / max * 100%
  grid(
    columns: (86pt, 1fr, 36pt),
    gutter: 8pt,
    align(horizon)[#sphere-small(label)],
    align(horizon)[
      #box(width: 100%, height: 8pt, fill: blue-100, radius: 4pt)[
        #box(width: pct, height: 8pt, fill: accent, radius: 4pt)
      ]
    ],
    align(right + horizon)[#text(size: 7pt, weight: "bold", fill: navy)[#value#suffix]],
  )
}

#let sphere-bar-chart(title, rows, max: 100, accent: blue, note: none) = sphere-card(title: title, accent: none)[
  #for row in rows [
    #sphere-hbar-row(
      row.at("label"),
      row.at("value"),
      max,
      suffix: row.at("suffix", default: ""),
      accent: row.at("accent", default: accent),
    )
    #v(0.48em)
  ]
  #if note != none [
    #v(0.1em)
    #sphere-small(note)
  ]
]

#let sphere-column-chart(title, values, max: 100, accent: blue, note: none) = sphere-card(title: title, accent: none)[
  #grid(
    columns: values.map(_ => 1fr),
    gutter: 5pt,
    ..values.map(item => {
      let h = item.at("value") / max * 62pt
      block(width: 100%)[
        #box(height: 68pt, width: 100%, fill: blue-100, radius: 3pt)[
          #v(68pt - h)
          #box(height: h, width: 100%, fill: item.at("accent", default: accent), radius: 3pt)
        ]
        #v(0.35em)
        #align(center)[#sphere-small(item.at("label"))]
      ]
    }),
  )
  #if note != none [
    #v(0.45em)
    #sphere-small(note)
  ]
]

#let sphere-step-chart(title, steps, max: 100, accent: blue, note: none) = sphere-card(title: title, accent: none, inset: 9pt)[
  #grid(
    columns: steps.map(_ => 1fr),
    gutter: 0pt,
    ..steps.map(step => {
      let h = step.at("value") / max * 54pt
      block(width: 100%, inset: 0pt, stroke: 0.35pt + line, fill: white-blue)[
        #box(height: 70pt, width: 100%)[
          #v(70pt - h)
          #box(width: 100%, height: 2.4pt, fill: accent)
          #box(width: 100%, height: h, fill: soft-blue)
        ]
        #v(0.32em)
        #align(center)[#sphere-small(step.at("label"))]
      ]
    }),
  )
  #if note != none [
    #v(0.55em)
    #sphere-small(note)
  ]
]

#let sphere-data-table(headers, rows) = table(
  columns: headers.map(_ => 1fr),
  stroke: 0.45pt + line,
  inset: (x: 6pt, y: 5pt),
  table.header(..headers.map(header => [#text(size: 7pt, weight: "bold", fill: navy)[#header]])),
  ..rows.map(row => row.map(cell => [#text(size: 7pt, fill: muted)[#cell]])).flatten(),
)

#let sphere-comparison(title, left-title, right-title, rows) = sphere-card(title: title, accent: none)[
  #table(
    columns: (0.72fr, 1fr, 1fr),
    stroke: 0.45pt + line,
    inset: (x: 6pt, y: 6pt),
    table.header(
      [#text(size: 7pt, weight: "bold", fill: muted)[Dimension]],
      [#text(size: 7pt, weight: "bold", fill: muted)[#left-title]],
      [#text(size: 7pt, weight: "bold", fill: blue)[#right-title]],
    ),
    ..rows.map(row => (
      [#text(size: 7pt, weight: "bold", fill: navy)[#row.at("label")]],
      [#sphere-small(row.at("left"))],
      [#text(size: 7pt, weight: "bold", fill: blue-700)[#row.at("right")]],
    )).flatten(),
  )
]

#let sphere-pillar(title, subtitle, body, icon: "", accent: blue) = grid(
  columns: (34pt, 1fr),
  gutter: 10pt,
  sphere-icon(icon, color: accent),
  block[
    #text(size: 7.2pt, weight: "bold", fill: blue-500)[#title]
    #linebreak()
    #text(size: 8.8pt, weight: "bold", fill: navy)[#subtitle]
    #v(0.12em)
    #text(size: 7pt, fill: muted)[#body]
  ],
)

#let sphere-process-step(step) = sphere-card(
  title: step.at("title"),
  subtitle: step.at("kicker", default: none),
  accent: step.at("accent", default: blue),
  fill: step.at("fill", default: white),
)[
  #sphere-body(step.at("body", default: []))
]

#let sphere-process(steps) = grid(
  columns: steps.map(_ => 1fr),
  gutter: 8pt,
  ..steps.map(sphere-process-step),
)

#let sphere-proof-grid(items, columns: (1fr, 1fr, 1fr)) = grid(
  columns: columns,
  gutter: 8pt,
  ..items.map(item => sphere-card(
    title: item.at("title"),
    subtitle: item.at("subtitle", default: none),
    accent: item.at("accent", default: blue),
    fill: item.at("fill", default: white),
  )[
    #sphere-small(item.at("body", default: []))
  ]),
)

#let sphere-roadmap(phases) = grid(
  columns: phases.map(_ => 1fr),
  gutter: 10pt,
  ..phases.map(phase => block(width: 100%)[
    #sphere-icon(phase.at("icon", default: ""), fill: blue, color: white)
    #v(0.35em)
    #box(width: 100%, height: 0.8pt, fill: blue-300)
    #v(0.5em)
    #text(size: 9pt, weight: "bold", fill: navy)[#phase.at("title")]
    #linebreak()
    #text(size: 7.2pt, fill: muted)[#phase.at("subtitle", default: "")]
    #v(0.45em)
    #sphere-small(phase.at("body", default: []))
  ]),
)

#let sphere-dark-lane(title, body, badges: ()) = grid(
  columns: (72pt, 1fr, 96pt),
  gutter: 10pt,
  align(horizon)[#text(size: 9pt, weight: "bold", fill: dark-text)[#title]],
  align(horizon)[#text(size: 7pt, fill: dark-muted)[#body]],
  align(horizon)[#grid(columns: (1fr, 1fr), gutter: 4pt, ..badges.map(badge => sphere-badge(badge, dark-mode: true)))],
)

#let sphere-dark-matrix(title, rows) = sphere-dark-card(title: title)[
  #for row in rows [
    #grid(
      columns: (0.42fr, 1fr, 1fr),
      gutter: 10pt,
      [#text(size: 8pt, weight: "bold", fill: dark-text)[#row.at("label")]],
      [#text(size: 7pt, fill: dark-muted)[#row.at("market")]],
      [#text(size: 7pt, fill: blue-300)[#row.at("sphere")]],
    )
    #v(0.55em)
    #box(width: 100%, height: 0.45pt, fill: dark-line)
    #v(0.55em)
  ]
]

#let sphere-style-sample() = sphere-page("Typography")[
  #grid(
    columns: (1fr, 1fr),
    gutter: 18pt,
    [#block[
      #text(size: 17pt, weight: "bold", fill: navy)[Heading One]
      #v(0.65em)
      #text(size: 13pt, fill: muted)[Heading Two]
      #v(0.65em)
      #sphere-section-heading[Heading Three]
      #v(0.55em)
      #sphere-body[
        Body copy can include #strong[bold emphasis], #emph[italic emphasis], inline #raw("code"),
        and links such as #link("https://spherepay.co")[spherepay.co].
      ]
      #v(0.9em)
      #sphere-callout("Narrative callout")[
        Callouts hold key assumptions, investment theses, implementation notes, and decisions that need to stand apart.
      ]
    ]],
    [#block[
      #sphere-section-heading[Quoted evidence]
      #v(0.4em)
      #sphere-quote[
        “The strongest documents interleave narrative with the exact data required to evaluate the claim.”
      ]
      #v(0.9em)
      #sphere-section-heading[Inline formula]
      #v(0.35em)
      #sphere-body[
        Settlement cost can be modeled as $R = sum_(c in C) (v_c dot f_c)$ while keeping the investor-facing explanation plain.
      ]
    ]],
  )
]

#let sphere-product-card(product) = sphere-card(
  title: product.at("name", default: ""),
  subtitle: product.at("subtitle", default: none),
  accent: product.at("accent", default: blue),
)[
  #sphere-body(product.at("body", default: []))
  #if product.at("metrics", default: none) != none [
    #v(0.55em)
    #text(size: 6.7pt, weight: "bold", fill: navy)[#product.at("metrics")]
  ]
  #if product.at("url", default: none) != none [
    #v(0.55em)
    #text(size: 7pt, fill: blue)[#product.at("url")]
  ]
]

#let sphere-overview(
  title: "Overview",
  sphere-copy: [],
  sphere-url: "spherepay.co",
  products: (),
  team: [],
  backed-by: [],
) = sphere-page(title)[
  #grid(
    columns: (1fr, 1fr),
    gutter: 12pt,
    [#sphere-card(title: "Sphere Labs (“Sphere”)", accent: blue)[
      #sphere-body(sphere-copy)
      #v(0.55em)
      #text(size: 7pt, fill: blue)[#sphere-url]
    ]],
    [#sphere-card(title: "Institutional platform", accent: blue-300, fill: pale)[
      #sphere-body[
        Source-first documents combine narrative, metrics, diagrams, and evidence with one reusable brand system.
      ]
    ]],
  )
  #v(0.75em)
  #grid(columns: products.map(_ => 1fr), gutter: 10pt, ..products.map(sphere-product-card))
  #v(0.82em)
  #sphere-callout("Team and backing", accent: blue-300)[#team]
  #v(0.35em)
  #backed-by
]

#let sphere-document(title: "Document Title", date: "January 2026", variant: "sphere-institutional", body) = {
  set document(title: title)
  set page(width: 8.5in, height: 11in, margin: sphere-page-margin, background: sphere-background(variant: "page"))
  set text(font: sphere-font, size: 8pt, fill: navy)
  set par(leading: 0.54em)
  body
}

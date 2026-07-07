// Sphere page templates, linting, and document wrapper. Import ../sphere.typ for the public API.
#import "theme.typ": *
#import "chrome.typ": *
#import "layout.typ": *
#import "evidence.typ": *
#import "cards.typ": *
#import "charts.typ": *
#import "comparison.typ": *
#import "diagrams.typ": *
#import "proof.typ": *
#import "media.typ": *
#import "roadmap.typ": *

#let sphere-overview-page(
  title: "Overview",
  subtitle: none,
  thesis: none,
  cards: (),
  kpis: (),
  source: none,
  ..children,
) = sphere-page(title, subtitle: subtitle, source: source)[
  #if thesis != none [
    #sphere-card(title: "Thesis", kind: "decision")[#sphere-body(thesis)]
    #v(0.85em)
  ]
  #if kpis.len() > 0 [
    #sphere-metric-strip(kpis)
    #v(0.85em)
  ]
  #if cards.len() > 0 [
    #sphere-grid(
      columns: if cards.len() > 2 { 3 } else { 2 },
      gap: 10pt,
      ..cards.map(card => sphere-card(
        title: card.at("title", default: none),
        subtitle: card.at("subtitle", default: none),
        kind: card.at("kind", default: "base"),
        source: card.at("source", default: none),
      )[#sphere-body(card.at("body", default: []))]),
    )
    #v(0.85em)
  ]
  #children.pos().join()
]

#let sphere-kpi-page(
  title: "KPI dashboard",
  subtitle: none,
  kpis: (),
  charts: (),
  source: none,
  ..children,
) = sphere-page(title, subtitle: subtitle, source: source)[
  #if kpis.len() > 0 [
    #sphere-metric-strip(kpis)
    #v(0.85em)
  ]
  #if charts.len() > 0 [
    #sphere-grid(columns: if charts.len() > 1 { 2 } else { 1 }, gap: 12pt, ..charts)
    #v(0.85em)
  ]
  #children.pos().join()
]

#let sphere-comparison-page(
  title: "Comparison",
  subtitle: none,
  comparison: none,
  guidance: none,
  source: none,
  ..children,
) = sphere-page(title, subtitle: subtitle, source: source)[
  #if comparison != none [
    #comparison
    #v(0.85em)
  ]
  #if guidance != none [
    #sphere-two-column(
      children.pos().join(),
      sphere-decision-note("Decision note", guidance),
    )
  ] else [
    #children.pos().join()
  ]
]

#let sphere-architecture-page(
  title: "Architecture",
  subtitle: none,
  flow: none,
  controls: (),
  control-note: none,
  source: none,
  ..children,
) = sphere-page(title, subtitle: subtitle, source: source)[
  #if flow != none [
    #flow
    #v(0.95em)
  ]
  #if controls.len() > 0 [
    #sphere-two-column(
      children.pos().join(),
      sphere-control-layer("Control layer", controls: controls, body: control-note),
    )
  ] else [
    #children.pos().join()
  ]
]

#let sphere-proof-grid-page(
  title: "Proof grid",
  subtitle: none,
  items: (),
  columns: 3,
  guidance: none,
  source: none,
  ..children,
) = sphere-page(title, subtitle: subtitle, source: source)[
  #sphere-proof-grid(items, columns: columns)
  #v(0.85em)
  #if guidance != none [
    #sphere-bottom-band(title: "Proof-grid guidance")[#sphere-body(guidance)]
    #v(0.65em)
  ]
  #children.pos().join()
]

#let sphere-roadmap-page(
  title: "Roadmap",
  subtitle: none,
  phases: (),
  source: none,
  ..children,
) = sphere-page(title, subtitle: subtitle)[
  #sphere-roadmap(phases, source: source)
  #v(0.95em)
  #children.pos().join()
]

#let sphere-contact-page(
  title: "Contact",
  subtitle: none,
  contacts: (),
  ..children,
) = sphere-page(title, subtitle: subtitle)[
  #if contacts.len() > 0 [
    #sphere-grid(columns: contacts.len(), gap: 18pt, equal: false, ..contacts.map(sphere-contact))
    #v(0.9em)
  ]
  #children.pos().join()
]

#let sphere-lint() = sphere-page(
  "Document QA / lint",
  subtitle: [Practical production checks registered by Sphere components.],
)[
  #context {
    let claims = query(<sphere-claim>)
    let missing = claims.filter(item => not item.value.at("has_source", default: false))
    let sources = query(<sphere-source>)
    [
      #sphere-grid(
        columns: 2,
        gap: 12pt,
        sphere-card(
          title: "Evidence coverage",
          kind: if missing.len() == 0 { "decision" } else { "warning" },
        )[
          #sphere-body[
            Registered claim components: #claims.len()\
            Registered sources: #sources.len()\
            Missing component sources: #missing.len()
          ]
          #if missing.len() > 0 [
            #v(0.55em)
            #for item in missing [
              #sphere-small[
                • #item.value.at("kind", default: "claim"):
                #item.value.at("label", default: "Untitled")
              ]
              #linebreak()
            ]
          ]
        ],
        sphere-card(title: "Production checklist", kind: "source")[
          #sphere-small[
            Search for placeholders: #raw("xxxxx"), #raw("[COMPANY NAME]"),
            #raw("ASSESS FOR ACCURACY").\
            Keep card count per portrait page disciplined.\
            Verify low-priority labels remain readable and source notes sit outside visual mark areas.\
            Confirm every chart, table, and KPI cites a registered source.
          ]
        ],
      )
      #if missing.len() > 0 [
        #v(0.85em)
        #sphere-source-note(
          [
            Add #raw("source:") to KPI, chart, table, comparison, proof, roadmap, and assumption
            components before external distribution.
          ],
          title: "Required before production",
        )
      ]
    ]
  }
]

#let sphere-document(
  title: none,
  date: none,
  confidentiality: "[ Private & Confidential ]",
  frame: true,
  corner-marks: true,
  frame-inset: sphere-frame-inset,
  content-inset: sphere-content-inset,
  page-numbers: true,
  body,
) = {
  set document(title: if title == none { "Document Title" } else { title })
  set page(
    width: sphere-page-size.width,
    height: sphere-page-size.height,
    margin: content-inset,
    background: sphere-page-canvas(
      frame: frame,
      corner-marks: corner-marks,
      frame-inset: frame-inset,
    ),
    footer: if page-numbers { sphere-page-footer() } else { none },
  )
  set text(font: sphere-font, size: 8pt, fill: navy)
  set par(leading: 0.54em)
  sphere-doc-config.update((
    title: title,
    date: date,
    confidentiality: confidentiality,
    frame: frame,
    corner_marks: corner-marks,
    frame_inset: frame-inset,
    content_inset: content-inset,
  ))
  body
}

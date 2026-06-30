#import "../../frameworks/sphere/sphere.typ": *

#let document-title = "__SPHERE_DOCUMENT_TITLE__"
#let sphere-variant = "__SPHERE_VARIANT__"

#sphere-document(title: document-title, date: "January 2026", variant: sphere-variant)[
  #sphere-cover(
    title: document-title,
    date: "January 2026",
    variant: sphere-variant,
    contacts: (
      (
        name: "Arnold Lee",
        role: "Co-Founder & CEO",
        email: "arnold@spherepay.co",
        telegram: "@sphere_dirichlet",
      ),
      (
        name: "Sphere Labs",
        role: "Institutional Team",
        email: "partners@spherepay.co",
        telegram: "@spherepay",
      ),
    ),
  )

  #pagebreak()

  #sphere-page("Executive summary", subtitle: [Starter page using reusable Sphere components.])[
    #sphere-metric-strip((
      (label: "Processed volume", value: "USD 3.0B+", detail: "+23% avg MoM"),
      (label: "Committed pipeline", value: "USD 15B+", detail: "+4 net corridors", accent: blue-500),
      (label: "Institutional clients", value: "200+", detail: "60+ active countries", accent: blue-300),
    ))
    #v(0.9em)
    #grid(
      columns: (1.05fr, 0.95fr),
      gutter: 14pt,
      [#sphere-callout("Authoring model")[
        Edit #raw("main.typ") directly. Reuse #raw("sphere.typ") primitives for branded pages, KPI strips,
        charts, tables, process diagrams, and dark analytical sections.
      ]],
      [#sphere-process((
        (title: "Narrative", kicker: "01", body: [Start with the executive claim.]),
        (title: "Evidence", kicker: "02", body: [Support it with charts, tables, and assumptions.]),
        (title: "Decision", kicker: "03", body: [Close with next steps and risks.]),
      ))],
    )
  ]

  #pagebreak()

  #sphere-overview(
    sphere-copy: [
      Stablecoin payments orchestration: API for B2B cross-border institutional settlement
      (fiat in, stablecoin settlement, fiat out).
    ],
    products: (
      (
        name: "SpherePay",
        body: [Stablecoin payments orchestration for B2B cross-border institutional settlement.],
        metrics: [USD 3B+ volume · USD 15B+ pipeline · 400k+ txns · 200+ institutional clients],
        url: "spherepay.co",
      ),
      (
        name: "SphereNet",
        body: [Compliance-native permissioned L1 blockchain for regulated trade finance.],
        metrics: [USD 50B+ committed volume | 10 active deployments across 7 corridors],
        url: "sphere.net",
      ),
    ),
    team: [
      Team: 60+ people with leadership experience across compliance, banking, FX, infrastructure, and crypto.
    ],
  )

  #pagebreak()

  #sphere-page("Metrics and charts", subtitle: [All default chart components use the Sphere blue ramp.])[
    #grid(
      columns: (1fr, 1fr),
      gutter: 12pt,
      [#sphere-bar-chart("Pipeline by corridor", (
        (label: "US → LATAM", value: 82),
        (label: "EU → Africa", value: 64),
        (label: "APAC trade", value: 51),
        (label: "MENA", value: 39),
      ), max: 100)],
      [#sphere-column-chart("Monthly transaction index", (
        (label: "Jul", value: 38),
        (label: "Aug", value: 43),
        (label: "Sep", value: 51),
        (label: "Oct", value: 58),
        (label: "Nov", value: 73),
        (label: "Dec", value: 88),
      ), max: 100)],
    )
    #v(0.85em)
    #sphere-step-chart("Settlement speed improvement", (
      (label: "Legacy", value: 28),
      (label: "Optimized", value: 48),
      (label: "Sphere", value: 82),
    ), note: [Use stepped bands for simple before/after or maturity narratives.])
  ]
]

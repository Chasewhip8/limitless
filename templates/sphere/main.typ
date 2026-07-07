#import "sphere.typ": *

#let document-title = "Document Title"

#sphere-document(title: document-title, date: "January 2026")[
  #sphere-cover(
    title: document-title,
    date: "January 2026",
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
      (label: "Committed pipeline", value: "USD 15B+", detail: "+4 net corridors"),
      (label: "Institutional clients", value: "200+", detail: "60+ active countries"),
    ))
    #v(0.9em)
    #sphere-two-column(
      [#sphere-callout("Authoring model")[
        Edit #raw("main.typ") directly. Reuse #raw("sphere.typ") primitives for branded pages,
        KPI strips, charts, tables, flow diagrams, proof grids, and roadmaps. Cards placed in a
        #raw("sphere-grid") or #raw("sphere-two-column") stretch to matching heights automatically.
      ]],
      [#sphere-flow((
        (title: "Narrative", kicker: "01", body: [Start with the executive claim.]),
        (title: "Evidence", kicker: "02", body: [Support it with charts and tables.]),
        (title: "Decision", kicker: "03", body: [Close with next steps and risks.]),
      ), numbered: false)],
      left: 42%,
      right: 58%,
    )
  ]

  #pagebreak()

  #sphere-page("Overview", subtitle: [Compose pages from cards, grids, and semantic components.])[
    #sphere-grid(
      columns: 2,
      gap: 12pt,
      [#sphere-card(title: "Sphere Labs (“Sphere”)")[
        #sphere-body[
          Stablecoin payments orchestration: API for B2B cross-border institutional settlement
          (fiat in, stablecoin settlement, fiat out).
        ]
        #v(0.55em)
        #text(size: 7pt, fill: blue)[spherepay.co]
      ]],
      [#sphere-card(title: "Institutional platform", kind: "note")[
        #sphere-body[
          Source-first documents combine narrative, metrics, diagrams, and evidence with one reusable
          brand system.
        ]
      ]],
      [#sphere-card(title: "SpherePay")[
        #sphere-body[Stablecoin payments orchestration for B2B cross-border institutional settlement.]
        #v(0.55em)
        #text(size: 6.7pt, weight: "bold", fill: navy)[
          USD 3B+ volume · USD 15B+ pipeline · 400k+ txns · 200+ institutional clients
        ]
      ]],
      [#sphere-card(title: "SphereNet")[
        #sphere-body[Compliance-native permissioned L1 blockchain for regulated trade finance.]
        #v(0.55em)
        #text(size: 6.7pt, weight: "bold", fill: navy)[
          USD 50B+ committed volume | 10 active deployments across 7 corridors
        ]
      ]],
    )
    #v(0.82em)
    #sphere-callout("Team and backing")[
      Team: 60+ people with leadership experience across compliance, banking, FX, infrastructure,
      and crypto.
    ]
  ]

  #pagebreak()

  #sphere-page("Metrics and charts", subtitle: [Default chart scales can be automatic or explicit.])[
    #sphere-grid(
      columns: 2,
      gap: 12pt,
      sphere-bar-chart((
        (label: "US → LATAM", value: 82),
        (label: "EU → Africa", value: 64),
        (label: "APAC trade", value: 51),
        (label: "MENA", value: 39),
      ), title: "Pipeline by corridor", max: 100),
      sphere-column-chart((
        (label: "Jul", value: 38),
        (label: "Aug", value: 43),
        (label: "Sep", value: 51),
        (label: "Oct", value: 58),
        (label: "Nov", value: 73),
        (label: "Dec", value: 88),
      ), title: "Monthly transaction index"),
    )
  ]
]

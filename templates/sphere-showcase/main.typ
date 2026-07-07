#import "sphere.typ": *

// ---------------------------------------------------------------------------
// Sphere Institutional Overview — reference document for the Sphere framework.
// Every page is composed from sphere.typ components; copy the patterns you
// need into real documents. All figures are illustrative.
// ---------------------------------------------------------------------------

#let document-title = "Institutional Overview"
#let document-date = "January 2026"

// A mock product surface drawn with framework tokens. Real documents drop a
// screenshot into assets/ and pass image("assets/…") instead. Sections and
// rows are single grids with fixed gutters so spacing stays deterministic
// (block-level siblings would pick up paragraph spacing), and the frame sizes
// to its content so nothing ever clips.
#let mock-dashboard(height: auto, corridors: 4, chips: true) = block(
  width: 100%,
  height: height,
  fill: white,
  stroke: 0.45pt + line,
  radius: 4pt,
  clip: true,
  inset: 0pt,
)[
  #block(width: 100%, height: 16pt, fill: navy, inset: (x: 8pt, y: 0pt))[
    #align(horizon)[#text(size: 5.8pt, weight: "bold", fill: white)[SpherePay · Treasury Console]]
  ]
  #let chip-strip = grid(
    columns: (1fr, 1fr, 1fr),
    gutter: 5pt,
    ..(("Settled today", "USD 24.1M"), ("In flight", "USD 3.2M"), ("Corridors", "18 live")).map(
      pair => block(
        width: 100%,
        fill: white-blue,
        stroke: 0.4pt + hairline,
        radius: 3pt,
        inset: 5pt,
      )[
        #text(size: 5.4pt, fill: muted)[#pair.first()]
        #linebreak()
        #text(size: 8pt, weight: "bold", fill: blue)[#pair.last()]
      ],
    ),
  )
  #let corridor-panel = block(width: 100%, fill: pale, radius: 3pt, inset: 6pt)[
    #grid(
      columns: (34pt, 1fr),
      column-gutter: 5pt,
      row-gutter: 5pt,
      align: horizon,
      ..(
        ("USD → MXN", 92%, blue),
        ("EUR → NGN", 71%, blue-500),
        ("USD → PHP", 55%, blue-300),
        ("AED → INR", 38%, blue-300),
      )
        .slice(0, corridors)
        .map(row => (
          text(size: 5.2pt, fill: muted)[#row.at(0)],
          box(width: 100%, height: 4.5pt, fill: blue-100, radius: 2pt, clip: true)[
            #box(width: row.at(1), height: 4.5pt, fill: row.at(2), radius: 2pt)
          ],
        ))
        .flatten(),
    )
  ]
  #block(width: 100%, inset: 7pt)[
    #grid(
      columns: (1fr,),
      row-gutter: 5pt,
      ..if chips { (chip-strip,) } else { () },
      corridor-panel,
    )
  ]
]

#sphere-document(title: document-title, date: document-date)[
  #sphere-source("internal-metrics", "Sphere internal management metrics", date: "January 2026", status: "internal")
  #sphere-source("pipeline-model", "Sphere corridor pipeline model v4", date: "December 2025", status: "estimate")
  #sphere-source("partner-proof", "Partner and customer proof log", date: "January 2026", status: "internal")
  #sphere-source("industry-rails", "Published correspondent-banking settlement benchmarks", date: "November 2025", status: "public")

  #sphere-cover(
    title: document-title,
    date: document-date,
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

  // -------------------------------------------------------------------------
  // Executive summary
  // -------------------------------------------------------------------------
  #sphere-page(
    "Executive summary",
    subtitle: [Cross-border settlement infrastructure for regulated institutions.],
  )[
    #sphere-card(title: "Thesis", kind: "decision")[
      Cross-border payments into emerging corridors still settle over pre-funded correspondent
      accounts: slow, capital-intensive, and opaque. Sphere replaces that stack with stablecoin
      settlement wrapped in bank-grade compliance, so institutions move money in minutes without
      trapped working capital.
    ]
    #v(0.85em)
    #sphere-metric-strip((
      (label: "Processed volume, cumulative", value: "USD 3.0B+", detail: "+23% avg MoM", source: "internal-metrics"),
      (label: "Monthly settled volume", value: "USD 671M", detail: "December 2025", source: "internal-metrics"),
      (label: "Institutional clients", value: "214", detail: "across 60+ countries", source: "internal-metrics"),
      (label: "Committed pipeline", value: "USD 15B", detail: "next 24 months", source: "pipeline-model"),
    ))
    #v(0.9em)
    #sphere-two-column(
      [
        #sphere-section-heading[Why now]
        #v(0.45em)
        #sphere-body[
          Corridor banks continue to retreat from emerging-market clearing, while stablecoin
          float on regulated venues has passed the liquidity threshold institutional treasury
          desks require. The result is a narrow window where compliant settlement rails can win
          corridor share faster than incumbents can re-price.
        ]
        #v(0.6em)
        #sphere-body[
          Sphere operates two products against this window. #strong[SpherePay] is a payments
          orchestration API that routes fiat→stablecoin→fiat settlement across 18 live corridors.
          #strong[SphereNet] is a permissioned SVM network where regulated counterparties settle
          trade finance and treasury flows under enforceable policy.
        ]
        #v(0.75em)
        #sphere-quote(attribution: [Treasury lead, LATAM enterprise client])[
          Settlement that used to take four banking days now lands before our morning
          reconciliation run.
        ]
      ],
      sphere-column-chart(
        (
          (label: "Jul", value: 340),
          (label: "Aug", value: 385),
          (label: "Sep", value: 442),
          (label: "Oct", value: 505),
          (label: "Nov", value: 588),
          (label: "Dec", value: 671),
        ),
        title: "Monthly settled volume",
        timeframe: "H2 2025, USD millions",
        source: "internal-metrics",
        show-values: true,
      ),
    )
    #v(0.9em)
    #sphere-bottom-band(title: "How to read this document")[
      #sphere-body[
        Pages 3–7 carry the operating evidence: company, market, architecture, comparison, and
        proof. Page 8 sequences the roadmap against corridor demand, and page 9 states risks
        plainly. Every metric cites a registered source; Appendix B audits that coverage.
      ]
    ]
  ]

  #pagebreak()

  // -------------------------------------------------------------------------
  // Company overview
  // -------------------------------------------------------------------------
  #sphere-page(
    "Company",
    subtitle: [Two products, one compliance-native settlement stack.],
  )[
    #sphere-two-column(
      [#sphere-card(title: "Sphere Labs (“Sphere”)")[
        Sphere Labs builds settlement infrastructure for cross-border money movement. The company
        was founded in 2022 and employs 60+ people across compliance, banking operations, FX,
        and protocol engineering, with leadership drawn from Meta compliance, JP Morgan
        operations, Bank of America FX/PB, and Solana engineering.
        #v(0.55em)
        Sphere is regulated or registered in the jurisdictions where it operates and holds
        money-transmission coverage across its live corridors.
        #v(0.55em)
        #text(size: 7pt, fill: blue)[spherelabs.co]
      ]],
      sphere-screenshot-card(
        mock-dashboard(),
        caption: "SpherePay treasury console",
        source: "internal-metrics",
      ),
    )
    #v(0.8em)
    #sphere-grid(
      columns: 2,
      [#sphere-card(title: "SpherePay", subtitle: "Payments orchestration API")[
        Stablecoin middleware for B2B cross-border settlement: fiat in, stablecoin settlement,
        fiat out. Compliance checks, FX, liquidity routing, and reconciliation sit behind one
        integration.
        #v(0.5em)
        #text(size: 6.7pt, weight: "bold", fill: navy)[
          USD 3B+ volume · 400k+ transactions · 214 institutional clients · 18 corridors
        ]
        #v(0.5em)
        #text(size: 7pt, fill: blue)[spherepay.co]
      ]],
      [#sphere-card(title: "SphereNet", subtitle: "Permissioned settlement network")[
        A compliance-native SVM network for regulated institutions: trade finance, treasury, and
        settlement corridors where policy, audit, and privacy requirements are enforced at the
        protocol layer.
        #v(0.5em)
        #text(size: 6.7pt, weight: "bold", fill: navy)[
          USD 50B+ committed volume · 10 deployments · 7 corridors in design partnership
        ]
        #v(0.5em)
        #text(size: 7pt, fill: blue)[sphere.net]
      ]],
    )
    #v(0.8em)
    #sphere-card(title: "Backed and banked by")[
      Institutional backers and banking partners across the settlement path.
      #v(0.5em)
      #sphere-logo-grid((
        "Global bank partner",
        "Tier-1 liquidity desk",
        "Stablecoin issuer",
        "Compliance platform",
        "Regional clearing bank",
        "Infrastructure fund",
      ))
    ]
  ]

  #pagebreak()

  // -------------------------------------------------------------------------
  // Market and traction
  // -------------------------------------------------------------------------
  #sphere-kpi-page(
    title: "Market and traction",
    subtitle: [Corridor-level evidence, not aggregate promises.],
    kpis: (
      (label: "ARR run-rate", value: "USD 4M", detail: "contracted", source: "internal-metrics"),
      (label: "EOY 2026 target", value: "USD 15M", detail: "signed + weighted pipeline", source: "pipeline-model"),
      (label: "Blended take rate", value: "42 bps", detail: "trailing 90 days", source: "internal-metrics"),
    ),
    charts: (
      sphere-bar-chart(
        (
          (label: "US → LATAM", value: 4.2),
          (label: "EU → W. Africa", value: 3.1),
          (label: "GCC → S. Asia", value: 2.6),
          (label: "APAC intra-trade", value: 2.2),
          (label: "US → SE Asia", value: 1.7),
        ),
        title: "Committed pipeline by corridor",
        subtitle: "USD billions, next 24 months",
        unit: "B",
        source: "pipeline-model",
        note: [Weighted for contract stage; excludes corridors in diligence.],
      ),
      sphere-column-chart(
        (
          (label: "Q1", value: 18),
          (label: "Q2", value: 27),
          (label: "Q3", value: 41),
          (label: "Q4", value: 58),
        ),
        title: "Active institutional clients settling monthly",
        timeframe: "2025, month-end average per quarter",
        source: "internal-metrics",
        show-values: true,
        note: [Clients with at least one settled transaction in each month of the quarter.],
      ),
    ),
  )[
    #sphere-data-table(
      ("Segment", "2025 volume", "Take rate", "Net revenue", "YoY"),
      (
        ("Enterprise payouts", "USD 1.84B", "42 bps", "USD 7.7M", "↑ 174%"),
        ("Fintech partners", "USD 840M", "31 bps", "USD 2.6M", "↑ 96%"),
        ("Marketplaces", "USD 410M", "24 bps", "USD 1.0M", "↑ 38%"),
        ("Treasury / OTC", "USD 220M", "18 bps", "USD 0.4M", "new"),
      ),
      title: "Revenue by segment",
      subtitle: "Trailing twelve months",
      source: "internal-metrics",
    )
  ]

  #pagebreak()

  // -------------------------------------------------------------------------
  // Architecture
  // -------------------------------------------------------------------------
  #sphere-architecture-page(
    title: "Architecture",
    subtitle: [One integration; compliance enforced before value moves.],
    flow: sphere-flow(
      (
        (
          title: "Client API",
          kicker: "Intent",
          body: [Payment intents with compliance metadata, source of funds, and treasury instructions.],
        ),
        (
          title: "SpherePay core",
          kicker: "Settlement",
          body: [Policy checks, FX, stablecoin settlement, liquidity routing, reconciliation.],
          fill: pale,
        ),
        (
          title: "Local rails",
          kicker: "Payout",
          body: [Bank payout partners, beneficiary verification, statements, and reporting.],
        ),
      ),
      source: "internal-metrics",
    ),
    controls: ("KYC/KYB", "Sanctions", "Travel rule", "Liquidity", "Audit log"),
    control-note: [
      Controls execute inline with settlement: a transfer that fails policy never reaches the
      ledger, and every decision is written to the audit log with its evidence.
    ],
  )[
    #sphere-pillar(
      "Compliance",
      "Enforced before settlement",
      [KYC/KYB, sanctions screening, jurisdiction policy, and audit events are execution constraints, not reports.],
      icon: "C",
    )
    #v(0.6em)
    #sphere-pillar(
      "Liquidity",
      "Prefunding without trapped capital",
      [Quotes, spreads, rebalancing, and treasury windows stay visible to operators in real time.],
      icon: "L",
      accent: blue-500,
    )
    #v(0.75em)
    #sphere-system-diagram(
      (
        (title: "Product", nodes: ("Payments API", "FX engine", "Treasury")),
        (title: "Settlement", nodes: ("Stablecoin", "SphereNet", "Ledger")),
        (title: "Rails", nodes: ("Partner banks", "Local clearing", "Card payout")),
      ),
      source: "internal-metrics",
      title: "Stack overview",
    )
  ]

  #pagebreak()

  // -------------------------------------------------------------------------
  // Comparison and evidence
  // -------------------------------------------------------------------------
  #sphere-comparison-page(
    title: "Why Sphere wins corridors",
    subtitle: [Comparative proof against the correspondent stack.],
    comparison: sphere-comparison-matrix(
      "Correspondent banking",
      "Sphere settlement",
      (
        (
          label: "Working capital",
          left: [Pre-funded nostro accounts lock balances in every receive market.],
          right: [Just-in-time liquidity; no trapped balances across markets.],
        ),
        (
          label: "Settlement time",
          left: [2–5 banking days across EM corridors.],
          right: [Under 30 minutes fiat-to-fiat on live corridors.],
        ),
        (
          label: "Visibility",
          left: [Opaque status; reconciliation from fragmented statements.],
          right: [On-chain traceability plus finance-ready reporting.],
        ),
        (
          label: "Integration",
          left: [Bank-by-bank onboarding and local operating playbooks.],
          right: [One API and one counterparty agreement for the corridor set.],
        ),
      ),
      title: "Settlement model comparison",
      source: "industry-rails",
    ),
    guidance: [
      Prioritize corridors where volume and margin expand together
      #sphere-cite("pipeline-model"). A lower-margin corridor is still strategic when it unlocks
      regulated trade finance, anchor institutions, or liquidity depth.
      #v(0.6em)
      #sphere-assumption("Blended take rate", [42 bps across live corridors], source: "internal-metrics")
      #v(0.35em)
      #sphere-assumption("Corridor payback", [under 5 months at current volume ramp], source: "pipeline-model")
    ],
  )[
    #sphere-competitive-table(
      ("Capability", "Correspondent", "Fintech aggregator", "Sphere"),
      (
        ("Settlement", "Days", "Hours–days", "Minutes"),
        ("Compliance", "Bank-grade, manual", "Varies by market", "Bank-grade, inline"),
        ("Working capital", "Trapped", "Partially pooled", "Programmable"),
        ("Reconciliation", "Statements", "CSV exports", "API + ledger"),
      ),
      highlight-column: "Sphere",
      title: "Capability comparison",
      source: "industry-rails",
    )
    #v(0.7em)
    #sphere-code-card(language: "SpherePay API", caption: "Settlement in one call")[
      #raw(
        "route.settle({\n  fiat_in:  \"USD\",\n  asset:    \"USDC\",\n  fiat_out: \"MXN\",\n  policy:   \"enterprise-default\"\n})",
        block: true,
        lang: "js",
      )
    ]
    #v(0.7em)
    #sphere-source-note(
      [Comparative rows cite published benchmarks #sphere-cite("industry-rails"); Sphere figures come from settled production volume #sphere-cite("internal-metrics").],
      title: "Evidence note",
    )
  ]

  #pagebreak()

  // -------------------------------------------------------------------------
  // Proof
  // -------------------------------------------------------------------------
  #sphere-proof-grid-page(
    title: "Institutional proof",
    subtitle: [Signed, piloting, and pipeline engagements by corridor.],
    items: (
      sphere-proof-item(
        "Super-app payment engine",
        [Core payments engine for a leading super app, in collaboration with a sovereign wealth platform.],
        region: "UAE",
        status: "pilot",
        entity-type: "Super app",
        source: "partner-proof",
      ),
      sphere-proof-item(
        "RWA tokenization",
        [Tokenized mining assets and operations with a UK-based asset manager on SphereNet.],
        region: "UK",
        status: "pipeline",
        entity-type: "Asset manager",
        source: "partner-proof",
      ),
      sphere-proof-item(
        "Commodities settlement",
        [Real-time settlement and market infrastructure for a top-five commodity house.],
        region: "Global",
        status: "confidential",
        entity-type: "Commodity house",
        source: "partner-proof",
      ),
      sphere-proof-item(
        "Treasury credit",
        [Volatility-hedging credit lines secured against in-flight settlement balances.],
        region: "Canada",
        status: "pilot",
        entity-type: "Lender",
        source: "partner-proof",
      ),
      sphere-proof-item(
        "On/off ramp network",
        [Fiat–stablecoin infrastructure for retail and institutional access across six markets.],
        region: "E. Europe",
        status: "signed",
        entity-type: "PSP",
        source: "partner-proof",
      ),
      sphere-proof-item(
        "LATAM liquidity hub",
        [International trading flows anchoring a regional liquidity hub in São Paulo.],
        region: "Brazil",
        status: "pipeline",
        entity-type: "Trading firm",
        source: "partner-proof",
      ),
    ),
    guidance: [
      Keep proof cards short and current. Logos, headshots, or country marks belong here only when
      they add credibility; otherwise low-contrast text cards preserve the institutional tone.
    ],
  )

  #pagebreak()

  // -------------------------------------------------------------------------
  // Roadmap and operations
  // -------------------------------------------------------------------------
  #sphere-roadmap-page(
    title: "Roadmap",
    subtitle: [Sequenced against corridor demand, not feature ambition.],
    phases: (
      sphere-phase(
        1,
        "Foundation",
        subtitle: "Live production network — 2025",
        status: "live",
        bullets: (
          [18 corridors settling in production],
          [Compliant stablecoin controls],
          [SpherePay ↔ SphereNet integration],
        ),
      ),
      sphere-phase(
        2,
        "Enterprise scale",
        subtitle: "Compliance and privacy — H1 2026",
        bullets: (
          [Automated regulatory reporting],
          [Cross-jurisdiction policy engine],
          [Privacy-preserving settlement],
        ),
      ),
      sphere-phase(
        3,
        "Ecosystem",
        subtitle: "Tokenization and market access — H2 2026+",
        bullets: (
          [RWA tokenization framework],
          [White-label issuance],
          [Multi-institution treasury],
        ),
      ),
    ),
    source: "pipeline-model",
  )[
    #sphere-before-after-process(
      (
        title: "Corridor onboarding today",
        body: [
          Legal review, bank diligence, liquidity seeding, and compliance mapping run
          sequentially — a new corridor takes 10–14 weeks to first settlement.
        ],
      ),
      (
        title: "With the policy engine (H1 2026)",
        body: [
          Jurisdiction policy packs, pre-negotiated banking coverage, and automated liquidity
          templates run in parallel — target is first settlement inside 3 weeks.
        ],
      ),
      [
        Corridor onboarding time is the binding constraint on pipeline conversion; the roadmap
        exists to remove it #sphere-cite("pipeline-model").
      ],
      source: "pipeline-model",
    )
  ]

  #pagebreak()

  // -------------------------------------------------------------------------
  // Risk and disclosures
  // -------------------------------------------------------------------------
  #sphere-page(
    "Risk and disclosures",
    subtitle: [What we are watching, and what this document is not.],
  )[
    #sphere-grid(
      columns: 2,
      [#sphere-card(title: "Regulatory perimeter", kind: "warning")[
        Stablecoin settlement regulation is moving in every live jurisdiction. Sphere holds local
        counsel in each market and treats licensing as a product surface, but adverse rulings
        could pause individual corridors.
      ]],
      [#sphere-card(title: "Counterparty concentration", kind: "warning")[
        Two banking partners clear 55% of payout volume today. Coverage redundancy is
        contracted for H1 2026 and tracked weekly in the operating review.
      ]],
      [#sphere-card(title: "Liquidity depth")[
        Corridor growth is gated on stablecoin float and FX depth at settlement windows. Treasury
        maintains prefunding buffers sized to 1.6× peak daily volume per corridor.
      ]],
      [#sphere-card(title: "Execution density")[
        The roadmap concentrates policy, privacy, and tokenization work in two quarters.
        Sequencing is reviewed monthly against corridor demand and hiring reality.
      ]],
    )
    #v(0.85em)
    #sphere-disclaimer[
      This document contains illustrative figures and forward-looking statements prepared for
      discussion purposes only. It is not an offer of securities, a solicitation, or investment
      advice. Figures marked as estimates are unaudited.
    ]
  ]

  #pagebreak()

  // -------------------------------------------------------------------------
  // Contact
  // -------------------------------------------------------------------------
  #sphere-contact-page(
    title: "Contact",
    subtitle: [Institutional partnerships and corridor diligence.],
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
  )[
    #sphere-callout("Working session")[
      The fastest path to diligence is a 45-minute corridor review: bring one live corridor and
      its cost stack, and we will map the settlement path, compliance controls, and unit
      economics against it.
    ]
  ]

  #pagebreak()

  // -------------------------------------------------------------------------
  // Appendix A — typography and primitives
  // -------------------------------------------------------------------------
  #sphere-page(
    "Appendix A",
    subtitle: [Typography and primitives — the raw building blocks behind every page in this document.],
  )[
    #sphere-two-column(
      [
        #sphere-eyebrow[TYPOGRAPHY]
        #v(0.3em)
        #text(size: 17pt, weight: "bold", fill: navy)[Heading One]
        #v(0.55em)
        #text(size: 13pt, fill: muted)[Heading Two]
        #v(0.55em)
        #sphere-section-heading[Heading Three]
        #v(0.5em)
        #sphere-body[
          Body copy can include #strong[bold emphasis], #emph[italic emphasis], inline
          #raw("code"), and links such as #link("https://spherepay.co")[spherepay.co].
        ]
        #v(0.5em)
        #sphere-small[Small print for captions, sources, and footnotes.]
        #v(0.8em)
        #sphere-callout("Narrative callout")[
          Callouts hold key assumptions, theses, and implementation notes that need to stand
          apart from body copy.
        ]
        #v(0.8em)
        #sphere-decision-note(
          "Decision note",
          [Decision cards carry the recommendation itself — one per page, at most.],
        )
      ],
      [
        #sphere-section-heading[Evidence primitives]
        #v(0.4em)
        #sphere-quote(attribution: [Documentation principle])[
          The strongest documents interleave narrative with the exact data required to evaluate
          the claim.
        ]
        #v(0.7em)
        #sphere-body[
          Math stays available for cost models, where $v_c$ is corridor volume and $f_c$ the
          blended fee:
        ]
        #v(0.3em)
        #align(center)[$R = sum_(c in C) (v_c dot f_c)$]
        #v(0.55em)
        #sphere-grid(
          columns: (0.8fr, 1.2fr),
          gap: 8pt,
          sphere-isometric-panel(sphere-logo(size: 13pt)),
          sphere-screenshot-card(
            mock-dashboard(corridors: 3, chips: false),
            caption: "Screenshot card",
            source: "internal-metrics",
          ),
        )
        #v(0.7em)
        #sphere-section-heading[Status and badges]
        #v(0.4em)
        #sphere-inline-flow((
          sphere-status-pill("signed"),
          sphere-status-pill("pilot"),
          sphere-status-pill("pipeline"),
          sphere-status-pill("warning"),
          sphere-badge("KYC/KYB"),
          sphere-badge("Sanctions"),
          sphere-icon("S", size: 18pt),
        ), gap: 4pt)
        #v(0.7em)
        #sphere-code-card(language: "Typst", caption: "Composing a page")[
          #raw(
            "#sphere-page(\"Title\")[\n  #sphere-grid(columns: 2,\n    sphere-card(title: \"A\")[…],\n    sphere-card(title: \"B\")[…],\n  )\n]",
            block: true,
            lang: "typ",
          )
        ]
      ],
    )
  ]

  #pagebreak()

  // -------------------------------------------------------------------------
  // Appendix B — document QA
  // -------------------------------------------------------------------------
  #sphere-lint()
]

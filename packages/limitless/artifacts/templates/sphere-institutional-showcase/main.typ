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

  #sphere-page("How to read this", subtitle: [A complete institutional example that exercises the reusable Typst SDK.])[
    #grid(
      columns: (1.05fr, 0.95fr),
      gutter: 16pt,
      [#block[
        #sphere-section-heading[Source-first branded documents]
        #v(0.45em)
        #sphere-body[
          This document is a single editable Typst source file. It demonstrates the Sphere page chrome,
          typography, cards, KPI strips, generated charts, tables, process diagrams, proof grids, and dark analytical pages.
        ]
        #v(0.85em)
        #sphere-callout("Design cues preserved", accent: blue-500)[
          Use generous margins, large left-aligned headings, white-blue cards, short chart labels, and blue for the claim.
          Keep grey for context and reserve warm colors for actual warnings.
        ]
        #v(0.85em)
        #sphere-section-heading[Reusable primitives]
        #v(0.35em)
        #sphere-body[
          #raw("sphere.typ") now carries the document SDK: #raw("sphere-card"), #raw("sphere-kpi"),
          #raw("sphere-bar-chart"), #raw("sphere-column-chart"), #raw("sphere-step-chart"),
          #raw("sphere-comparison"), #raw("sphere-process"), proof grids, roadmap blocks, and dark-mode lanes.
        ]
      ]],
      [#block[
        #grid(columns: (1fr), gutter: 7pt,
          sphere-kpi("Processed volume", "USD 3.0B+", detail: "+23% avg MoM"),
          sphere-kpi("Committed pipeline", "USD 15B+", detail: "+4 net corridors", accent: blue-500),
          sphere-kpi("Institutional clients", "200+", detail: "60+ active countries", accent: blue-300),
        )
        #v(0.85em)
        #sphere-card(title: "Authoring model", accent: blue-300, fill: pale)[
          #sphere-body[
            Keep reusable layout and data-visualization patterns in #raw("sphere.typ"). Put document-specific copy and data arrays in
            #raw("main.typ") until a pattern is stable enough to promote.
          ]
        ]
      ]],
    )
  ]

  #pagebreak()

  #sphere-overview(
    sphere-copy: [
      Sphere Labs develops SpherePay, a B2B cross-border stablecoin payments API, and SphereNet,
      compliance-native settlement infrastructure for regulated institutions.
    ],
    sphere-url: "spherelabs.co",
    products: (
      (
        name: "SpherePay",
        subtitle: "Payments orchestration",
        body: [Stablecoin middleware and bank-message optimization for fast fiat-to-fiat settlement.],
        metrics: [USD 3B+ volume · USD 15B+ pipeline · 400k+ txns · 200+ institutional clients],
        url: "spherepay.co",
      ),
      (
        name: "SphereNet",
        subtitle: "Permissioned settlement network",
        body: [Compliance-native SVM network for regulated trade finance, treasury, and settlement corridors.],
        metrics: [USD 50B+ committed institutional volume · 10 active deployments · 7 corridors],
        url: "sphere.net",
        accent: blue-300,
      ),
    ),
    team: [
      Team: 60+ people with leadership experience across Meta compliance, JP Morgan operations, Bank of America FX/PB,
      Solana engineering, and banking-as-a-service infrastructure.
    ],
  )

  #pagebreak()

  #sphere-style-sample()

  #pagebreak()

  #sphere-page("KPI dashboard", subtitle: [Deck-inspired metrics with simple blue charts and source notes.])[
    #sphere-metric-strip((
      (label: "ARR run-rate", value: "USD 4M", detail: "pre-revenue contracts"),
      (label: "EOY target", value: "USD 15M", detail: "+275% plan", accent: blue-500),
      (label: "Transactions", value: "400k+", detail: "multi-corridor", accent: blue-300),
    ))
    #v(0.85em)
    #grid(
      columns: (1fr, 1fr),
      gutter: 12pt,
      [#sphere-bar-chart("Pipeline by corridor", (
        (label: "US → LATAM", value: 82),
        (label: "EU → Africa", value: 64),
        (label: "APAC trade", value: 51),
        (label: "MENA", value: 39),
      ), max: 100, note: [Horizontal bars work best for ranked corridor or segment comparisons.])],
      [#sphere-column-chart("Monthly transaction index", (
        (label: "Jul", value: 38),
        (label: "Aug", value: 43),
        (label: "Sep", value: 51),
        (label: "Oct", value: 58),
        (label: "Nov", value: 73),
        (label: "Dec", value: 88),
      ), max: 100, note: [Use columns for short time windows and keep axis copy out of the visual when the trend is obvious.])],
    )
    #v(0.85em)
    #sphere-step-chart("Measurable impact band", (
      (label: "Legacy rails", value: 30),
      (label: "Optimized ops", value: 52),
      (label: "Sphere rails", value: 82),
    ), note: [Stepped bands mirror the deck style: one strong blue top line, pale blue area, concise labels.])
  ]

  #pagebreak()

  #sphere-page("Tables and evidence", subtitle: [Use tables for comparative proof, not raw dumps.])[
    #grid(
      columns: (1.12fr, 0.88fr),
      gutter: 14pt,
      [#block[
        #sphere-comparison("Stablecoins vs correspondent banking", "Legacy rails", "Sphere model", (
          (label: "Capital", left: [Pre-funded accounts lock balances across markets.], right: [Move money globally without trapped working capital.]),
          (label: "Speed", left: [Settlement windows measured in days.], right: [Settlement windows measured in minutes or hours.]),
          (label: "Visibility", left: [Opaque status and fragmented reconciliation.], right: [On-chain traceability plus finance-ready reporting.]),
          (label: "Integration", left: [Multiple banks and local operating playbooks.], right: [One API for cross-border money movement.]),
        ))
        #v(0.75em)
        #sphere-card(title: "Structured table", accent: blue-300)[
          #sphere-data-table(
            ("Segment", "Volume", "Margin", "Trend"),
            (
              ("Enterprise", "USD 1.8B", "42 bps", "↑ 18%"),
              ("Fintech", "USD 840M", "31 bps", "↑ 11%"),
              ("Marketplaces", "USD 410M", "24 bps", "→ 2%"),
            ),
          )
        ]
      ]],
      [#block[
        #sphere-callout("Decision note", accent: blue-500)[
          Prioritize corridors where volume and margin both expand. A lower-margin corridor can still be strategic when it unlocks
          regulated trade finance, anchor institutions, or liquidity depth.
        ]
        #v(0.75em)
        #sphere-card(title: "Raw/code excerpts", accent: blue-300, fill: white-blue)[
          #raw("route.settle({\n  fiat_in: \"USD\",\n  asset: \"USDC\",\n  fiat_out: \"MXN\"\n})", block: true)
        ]
        #v(0.75em)
        #sphere-quote[
          Cite assumptions separately from chart labels. The visual should carry the claim; sources should make it auditable.
        ]
      ]],
    )
  ]

  #pagebreak()

  #sphere-page("Architecture", subtitle: [Process diagrams, pillar grids, and implementation notes.])[
    #sphere-process((
      (title: "Client API", kicker: "01", body: [Payment intents, compliance metadata, source-of-funds details, and treasury instructions.]),
      (title: "SpherePay", kicker: "02", body: [FX, stablecoin settlement, reconciliation, reporting, and liquidity routing.], accent: blue-500, fill: pale),
      (title: "Local rails", kicker: "03", body: [Bank payout partners, regulated corridors, beneficiary checks, and statements.], accent: blue-300),
    ))
    #v(0.95em)
    #grid(
      columns: (1fr, 1fr),
      gutter: 14pt,
      [#block[
        #sphere-pillar("Compliance", "Enforced before settlement", [KYC/KYB, sanctions, jurisdiction policy, and audit events become execution constraints.], icon: "C")
        #v(0.75em)
        #sphere-pillar("Liquidity", "Prefunding and routing controls", [Quotes, spreads, rebalancing, and treasury windows stay visible to operators.], icon: "L", accent: blue-500)
        #v(0.75em)
        #sphere-pillar("Settlement", "Fiat-in to fiat-out lifecycle", [Transaction state is explainable across product, finance, compliance, and partner reviews.], icon: "S", accent: blue-300)
      ]],
      [#sphere-callout("Where to use this page", accent: blue-300)[
        Architecture pages work best when they combine a simple flow with short operating implications. Avoid dense systems diagrams unless the reader needs implementation detail.
      ]],
    )
  ]

  #pagebreak()

  #sphere-page("Proof grid", subtitle: [Compact partnership, customer, use-case, or leadership evidence.])[
    #sphere-proof-grid((
      (title: "Payment Engine", subtitle: "UAE", body: [Core payments engine for a leading super app with sovereign wealth collaboration.]),
      (title: "RWA Tokenization", subtitle: "UK", body: [Mining assets and operations with a UK-based asset manager.], accent: blue-500),
      (title: "Commodities", subtitle: "Global", body: [Real-time settlement and market infrastructure support for a top commodity house.], accent: blue-300),
      (title: "Treasury Solution", subtitle: "Canada", body: [Volatility-hedging credit solutions for treasury assets.]),
      (title: "On/Off Ramp", subtitle: "Eastern Europe", body: [Fiat-crypto infrastructure for retail and institutional access.], accent: blue-500),
      (title: "Global Liquidity", subtitle: "Brazil", body: [International trading flows and LATAM liquidity hub positioning.], accent: blue-300),
    ))
    #v(0.85em)
    #sphere-card(title: "Proof-grid guidance", accent: blue-300, fill: pale)[
      #sphere-body[
        Keep proof cards short. Use logos, headshots, or country marks only when they add credibility; otherwise low-contrast text cards preserve the institutional tone.
      ]
    ]
  ]

  #pagebreak()

  #sphere-page("Analytical dark mode", dark-mode: true, subtitle: [Reserve navy pages for competitive landscapes and dense strategic analysis.])[
    #grid(
      columns: (0.72fr, 1.28fr),
      gutter: 14pt,
      [#sphere-dark-card(title: "Diverse ecosystem", subtitle: "Clear swim lanes")[
        #text(size: 7.2pt, fill: dark-muted)[
          Use dark pages sparingly for strategic analysis, ecosystem maps, and competitive matrices. The palette stays navy, blue, and slate—never rainbow.
        ]
      ]],
      [#sphere-dark-card(title: "Stablecoin ecosystem lanes")[
        #sphere-dark-lane("Issuers", [Mint, maintain, and burn stablecoins while managing reserves and price stability.], badges: ("Tether", "Circle"))
        #v(0.55em)
        #sphere-dark-lane("Network rails", [Infrastructure for issuing, moving, and settling stablecoin transactions at scale.], badges: ("Ethereum", "Solana"))
        #v(0.55em)
        #sphere-dark-lane("Liquidity", [Markets for price discovery, fiat on/off ramps, and treasury rebalancing.], badges: ("Binance", "Kraken"))
        #v(0.55em)
        #sphere-dark-lane("Custody", [Institutional storage, transfers, controls, and wallet integrations.], badges: ("Fireblocks", "BitGo"))
      ]],
    )
    #v(0.85em)
    #sphere-dark-matrix("Competitive comparison matrix", (
      (label: "UX", market: [Gasless or abstracted flows are becoming table stakes.], sphere: [Gasless UX with enshrined relayers and institutional controls.]),
      (label: "Neutrality", market: [Corporate chains often inherit platform incentives.], sphere: [Open, permissioned infrastructure with multi-issuer aggregation.]),
      (label: "Economics", market: [Value accrues primarily to issuers or platform operators.], sphere: [Builder upside through tokenized value accrual and shared governance.]),
    ))
  ]

  #pagebreak()

  #sphere-page("Roadmap", subtitle: [Three-phase timeline with crisp bullets and a final authoring note.])[
    #sphere-roadmap((
      (icon: "1", title: "Phase 1: Foundation", subtitle: "Live Production Network", body: [Live network reliability; compliant stablecoin controls; SpherePay integration; developer toolkit.]),
      (icon: "2", title: "Phase 2: Enterprise Scale", subtitle: "Advanced Compliance & Privacy", body: [Automated reporting; cross-jurisdiction policy; zero-knowledge verification; privacy-preserving transactions.]),
      (icon: "3", title: "Phase 3: Ecosystem Expansion", subtitle: "Asset Tokenization & Market Access", body: [RWA tokenization framework; white-label issuance; multi-institution treasury; settlement corridors.]),
    ))
    #v(0.95em)
    #grid(
      columns: (1fr, 1fr),
      gutter: 14pt,
      [#sphere-callout("Composable final page", accent: blue-500)[
        A production document can mix timelines, tables, charts, prose, callouts, and branded sections while keeping the design system centralized.
      ]],
      [#sphere-callout("Next author action", accent: blue-300)[
        Replace placeholder metrics with live assumptions, add source notes, and embed generated screenshots in #raw("assets/") when native Typst charts are not expressive enough.
      ]],
    )
  ]
]

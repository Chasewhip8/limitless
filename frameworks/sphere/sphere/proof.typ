// Sphere proof-grid primitives. Import ../sphere.typ for the public API.
#import "theme.typ": *
#import "chrome.typ": *
#import "layout.typ": *
#import "cards.typ": *
#import "evidence.typ": *

#let sphere-proof-item(
  title,
  body,
  region: none,
  logo: none,
  flag: none,
  status: "public",
  entity-type: none,
  source: none,
) = (
  title: title,
  body: body,
  region: region,
  logo: logo,
  flag: flag,
  status: status,
  entity-type: entity-type,
  source: source,
)

#let sphere-proof-card(
  title,
  region: none,
  logo: none,
  flag: none,
  status: none,
  entity-type: none,
  source: none,
  fill: white,
  height: auto,
  body,
) = sphere-card(title: title, fill: fill, source: source, height: height)[
  #sphere-register-claim("proof", title, source: source)
  #grid(
    columns: (1fr, auto),
    gutter: 6pt,
    align: horizon,
    sphere-inline-flow((
      ..if region != none { (sphere-badge(region),) } else { () },
      ..if entity-type != none { (sphere-badge(entity-type),) } else { () },
      ..if status != none { (sphere-status-pill(status),) } else { () },
    ), gap: 3pt),
    [#if logo != none [#text(size: 6.5pt, weight: "bold", fill: quiet)[#logo]]],
  )
  #if flag != none [#v(0.25em)#text(size: 7pt, fill: muted)[#flag]]
  #v(0.45em)
  #sphere-small(body)
]

#let sphere-proof-grid(
  items,
  columns: 3,
  gap: 8pt,
  show-logos: true,
  show-region: true,
  show-status: true,
) = sphere-grid(
  columns: columns,
  gap: gap,
  ..items.map(item => sphere-proof-card(
    item.at("title"),
    region: if show-region { item.at("region", default: item.at("subtitle", default: none)) } else { none },
    logo: if show-logos { item.at("logo", default: none) } else { none },
    flag: item.at("flag", default: none),
    status: if show-status { item.at("status", default: none) } else { none },
    entity-type: item.at("entity-type", default: none),
    source: item.at("source", default: none),
    fill: item.at("fill", default: white),
    height: item.at("height", default: auto),
  )[#item.at("body", default: [])]),
)

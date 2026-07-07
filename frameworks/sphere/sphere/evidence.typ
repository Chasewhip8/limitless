// Sphere evidence and source primitives. Import ../sphere.typ for the public API.
#import "theme.typ": *
#import "chrome.typ": *

#let sphere-register-claim(kind, label, source: none) = [
  #metadata((
    kind: kind,
    label: label,
    has_source: source != none,
  )) <sphere-claim>
]

#let sphere-source(id, label, url: none, date: none, status: "verified") = [
  #metadata((id: id, label: label, url: url, date: date, status: status)) <sphere-source>
]

#let sphere-cite(id) = box(text(size: 6.6pt, weight: "bold", fill: blue-700)[[#id]])

#let sphere-source-tag(source) = {
  if source != none {
    text(size: 6.4pt, fill: muted)[Source: #source]
  }
}

#let sphere-source-note(body, title: none) = block(
  width: 100%,
  fill: white-blue,
  stroke: 0.45pt + hairline,
  radius: 4pt,
  inset: (x: 7pt, y: 5pt),
)[
  #if title != none [
    #text(size: 6.6pt, weight: "bold", fill: navy)[#title]
    #h(5pt)
  ]
  #text(size: 6.4pt, fill: muted)[#body]
]

#let sphere-source-card(title, status: none, source: none, body) = block(
  width: 100%,
  fill: white-blue,
  stroke: 0.45pt + hairline,
  radius: sphere.radius.card,
  inset: sphere-card-inset,
)[
  #text(size: 7.6pt, weight: "bold", fill: navy)[#title]
  #if status != none [
    #linebreak()
    #text(size: 6.8pt, fill: muted)[#status]
  ]
  #v(0.34em)
  #body
  #if source != none [
    #v(0.48em)
    #sphere-source-tag(source)
  ]
]

#let sphere-assumption(label, value, source: none) = [
  #sphere-register-claim("assumption", label, source: source)
  #grid(
    columns: (0.55fr, 1fr),
    gutter: 8pt,
    [#text(size: 6.8pt, weight: "bold", fill: navy)[#label]],
    [#text(size: 6.8pt, fill: muted)[#value #if source != none [#h(3pt)#sphere-cite(source)]]],
  )
]

#let sphere-disclaimer(body) = sphere-source-card("Disclaimer")[#sphere-small(body)]

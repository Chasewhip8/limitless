// Sphere page chrome and base page helpers. Import ../sphere.typ for the public API.
#import "theme.typ": *

#let sphere-page-background() = image("../assets/page.png", width: 100%, height: 100%)
#let sphere-cover-background() = image("../assets/cover.png", width: 100%, height: 100%)

#let sphere-crop-mark(x, y, fill) = [
  #place(top + left, dx: x - 5.5pt, dy: y - 0.6pt)[
    #box(width: 11pt, height: 1.2pt, fill: fill)
  ]
  #place(top + left, dx: x - 0.6pt, dy: y - 5.5pt)[
    #box(width: 1.2pt, height: 11pt, fill: fill)
  ]
]

#let sphere-frame-chrome(
  frame: true,
  corner-marks: true,
  frame-inset: sphere-frame-inset,
) = {
  let frame-stroke = if sphere.frame.dash {
    (paint: sphere.frame.stroke, thickness: 0.55pt, dash: "dashed")
  } else {
    0.55pt + sphere.frame.stroke
  }
  let inner-width = sphere-page-size.width - 2 * frame-inset
  let inner-height = sphere-page-size.height - 2 * frame-inset

  [
    #if frame [
      #place(top + left, dx: frame-inset, dy: frame-inset)[
        #rect(width: inner-width, height: inner-height, stroke: frame-stroke)
      ]
    ]
    #if corner-marks [
      #sphere-crop-mark(frame-inset, frame-inset, black)
      #sphere-crop-mark(sphere-page-size.width - frame-inset, frame-inset, black)
      #sphere-crop-mark(frame-inset, sphere-page-size.height - frame-inset, black)
      #sphere-crop-mark(
        sphere-page-size.width - frame-inset,
        sphere-page-size.height - frame-inset,
        black,
      )
    ]
  ]
}

#let sphere-page-canvas(
  cover: false,
  frame: true,
  corner-marks: true,
  frame-inset: sphere-frame-inset,
) = {
  if frame and corner-marks and frame-inset == sphere-frame-inset {
    if cover { sphere-cover-background() } else { sphere-page-background() }
  } else if frame or corner-marks {
    [
      #rect(width: 100%, height: 100%, fill: white)
      #sphere-frame-chrome(frame: frame, corner-marks: corner-marks, frame-inset: frame-inset)
    ]
  } else {
    rect(width: 100%, height: 100%, fill: white)
  }
}

#let sphere-page-frame(body) = block(width: 100%, height: 100%, inset: 0pt)[#body]

#let sphere-logo(size: 18pt) = image("../assets/sphere-logo.svg", height: size)

#let sphere-section-heading(body, fill: navy) = text(size: 10pt, weight: "bold", fill: fill)[#body]
#let sphere-body(body, fill: muted) = text(size: 8pt, fill: fill)[#body]
#let sphere-small(body, fill: muted) = text(size: 6.8pt, fill: fill)[#body]
#let sphere-eyebrow(body, fill: blue) = text(size: 6.6pt, weight: "bold", fill: fill)[#body]

#let sphere-rule(fill: line) = box(width: 100%, height: 0.6pt, fill: fill)

#let sphere-page-title(
  title,
  kicker: "Sphere Laboratories",
  subtitle: none,
) = [
  #if kicker != none [
    #text(size: 21pt, fill: navy)[#kicker]
    #h(3pt)
    #text(size: 21pt, fill: slate)[|]
    #h(3pt)
  ]
  #text(size: 21pt, fill: if kicker == none { navy } else { slate })[#title]
  #if subtitle != none [
    #linebreak()
    #v(0.18em)
    #text(size: 8.6pt, fill: slate)[#subtitle]
  ]
  #v(0.9em)
]

#let sphere-footer(confidentiality: auto, company: "Sphere Laboratories, Inc") = context {
  let cfg = sphere-doc-config.get()
  let resolved-confidentiality = sphere-resolve(confidentiality, cfg.confidentiality)

  grid(
    columns: (1fr, 1fr),
    align: horizon,
    text(size: 6.4pt, fill: muted)[#resolved-confidentiality],
    align(right)[#text(size: 6.4pt, fill: muted)[#company]],
  )
}

// Running footer for content pages: confidentiality left, page number right.
#let sphere-page-footer() = context {
  let cfg = sphere-doc-config.get()
  let page-number = counter(page).get().first()
  let padded = if page-number < 10 { "0" + str(page-number) } else { str(page-number) }
  grid(
    columns: (1fr, 1fr),
    align: horizon,
    text(size: 6.2pt, fill: quiet)[#cfg.confidentiality],
    align(right)[#text(size: 6.2pt, fill: quiet)[#padded]],
  )
}

#let sphere-page(
  title,
  kicker: "Sphere Laboratories",
  subtitle: none,
  source: none,
  footer: none,
  frame: auto,
  corner-marks: auto,
  frame-inset: auto,
  content-inset: auto,
  body,
) = context {
  let cfg = sphere-doc-config.get()
  let resolved-frame = sphere-resolve(frame, cfg.frame)
  let resolved-corner-marks = sphere-resolve(corner-marks, cfg.corner_marks)
  let resolved-frame-inset = sphere-resolve(frame-inset, cfg.frame_inset)
  let resolved-content-inset = sphere-resolve(content-inset, cfg.content_inset)

  set page(
    margin: resolved-content-inset,
    background: sphere-page-canvas(
      frame: resolved-frame,
      corner-marks: resolved-corner-marks,
      frame-inset: resolved-frame-inset,
    ),
  )

  [
    #sphere-page-title(title, kicker: kicker, subtitle: subtitle)
    #body
    #if source != none [
      #v(0.75em)
      #block(
        width: 100%,
        fill: white-blue,
        stroke: 0.45pt + hairline,
        radius: 4pt,
        inset: (x: 7pt, y: 5pt),
      )[#text(size: 6.4pt, fill: muted)[Source: #source]]
    ]
    #if footer != none [
      #v(0.8em)
      #footer
    ]
  ]
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

#let sphere-cover(
  title: auto,
  date: auto,
  contacts: (),
  confidentiality: auto,
  company: "Sphere Laboratories, Inc",
  frame: auto,
  corner-marks: auto,
  frame-inset: auto,
) = context {
  let cfg = sphere-doc-config.get()
  let resolved-title = sphere-resolve(title, cfg.title)
  let resolved-date = sphere-resolve(date, cfg.date)
  let resolved-confidentiality = sphere-resolve(confidentiality, cfg.confidentiality)
  let resolved-frame = sphere-resolve(frame, cfg.frame)
  let resolved-corner-marks = sphere-resolve(corner-marks, cfg.corner_marks)
  let resolved-frame-inset = sphere-resolve(frame-inset, cfg.frame_inset)
  let display-title = if resolved-title == none { "Document Title" } else { resolved-title }

  set page(
    footer: none,
    background: sphere-page-canvas(
      cover: true,
      frame: resolved-frame,
      corner-marks: resolved-corner-marks,
      frame-inset: resolved-frame-inset,
    ),
  )

  // Weighted spacers keep the title block anchored around the upper-middle of
  // the page no matter how many contacts or lines the cover carries.
  sphere-page-frame[
    #grid(
      columns: (1fr,),
      rows: (auto, 8fr, auto, 6fr, auto),
      sphere-logo(),
      [],
      [
        #text(size: 31pt, fill: navy)[#display-title]
        #if resolved-date != none [
          #v(0.55em)
          #text(size: 10pt, fill: slate)[#resolved-date]
        ]
        #if contacts.len() > 0 [
          #v(0.52in)
          #grid(columns: (1fr,) * contacts.len(), gutter: 34pt, ..contacts.map(sphere-contact))
        ]
      ],
      [],
      [
        #sphere-small(resolved-confidentiality)
        #linebreak()
        #sphere-small(company)
      ],
    )
  ]
}
